#!/usr/bin/env node
/**
 * Erzeugt src/data/schedule.json mit echten Abfahrtszeiten aus einem
 * GTFS-Feed (Standard: der freie Deutschland-Nahverkehrsfeed von gtfs.de).
 *
 *   npm run data:gtfs
 *
 * Umgebungsvariablen:
 *   GTFS_URL   – GTFS-Zip-URL (Standard: https://download.gtfs.de/germany/nv_free/latest.zip)
 *                Alternativ kann hier der offizielle VVW-Feed genutzt werden
 *                (Registrierung: https://www.verkehrsverbund-warnow.de/service/open-data.html)
 *   GTFS_FILE  – lokaler Pfad zu einer bereits heruntergeladenen GTFS-Zip
 *
 * Die App nutzt aus schedule.json die Abfahrtszeiten am Startpunkt jeder
 * Linie/Richtung; die Fahrzeit zwischen den Halten wird weiterhin aus der
 * Routengeometrie abgeleitet. Attribution beachten (gtfs.de / DELFI).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../src/data/schedule.json')
const CACHE_DIR = resolve(__dirname, '.cache')
const GTFS_URL = process.env.GTFS_URL || 'https://download.gtfs.de/germany/nv_free/latest.zip'

// Grobe Bounding-Box Rostock zum Filtern der Haltestellen
const BBOX = { minLon: 11.95, maxLon: 12.35, minLat: 53.95, maxLat: 54.22 }
const TRAM_LINE_IDS = new Set(['1', '2', '3', '4', '5', '6', '7'])

/** Minimaler CSV-Parser (RFC-4180-genug für GTFS). */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  const header = rows.shift().map((h) => h.replace(/^﻿/, '').trim())
  return rows.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])))
}

function timeToSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number)
  return h * 3600 + m * 60 + (s || 0)
}

async function loadZip() {
  if (process.env.GTFS_FILE) {
    console.log(`Lese lokale GTFS-Datei ${process.env.GTFS_FILE}`)
    return readFileSync(process.env.GTFS_FILE)
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  const cachePath = resolve(CACHE_DIR, 'gtfs.zip')
  if (existsSync(cachePath)) {
    console.log(`Nutze Cache ${cachePath} (löschen für frischen Download)`)
    return readFileSync(cachePath)
  }
  console.log(`Lade ${GTFS_URL} … (das kann einige Minuten dauern)`)
  const response = await fetch(GTFS_URL, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download fehlgeschlagen: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(cachePath, buffer)
  console.log(`${(buffer.length / 1e6).toFixed(1)} MB heruntergeladen`)
  return buffer
}

async function main() {
  const zipBuffer = await loadZip()
  const files = unzipSync(new Uint8Array(zipBuffer))
  const read = (name) => {
    if (!files[name]) throw new Error(`${name} fehlt im GTFS-Feed`)
    return parseCsv(new TextDecoder('utf-8').decode(files[name]))
  }

  console.log('Parse stops.txt / routes.txt / trips.txt …')
  const stopsInRostock = new Set(
    read('stops.txt')
      .filter((s) => {
        const lon = Number(s.stop_lon)
        const lat = Number(s.stop_lat)
        return lon > BBOX.minLon && lon < BBOX.maxLon && lat > BBOX.minLat && lat < BBOX.maxLat
      })
      .map((s) => s.stop_id),
  )
  console.log(`${stopsInRostock.size} Haltestellen im Rostocker Stadtgebiet`)

  // Tram-Routen (route_type 0) mit passender Liniennummer
  const routes = read('routes.txt').filter(
    (r) => r.route_type === '0' && TRAM_LINE_IDS.has(r.route_short_name),
  )
  const routeById = new Map(routes.map((r) => [r.route_id, r]))
  console.log(`${routes.length} Tram-Routen-Kandidaten (route_type=0)`)

  const trips = read('trips.txt').filter((t) => routeById.has(t.route_id))
  const tripById = new Map(trips.map((t) => [t.trip_id, t]))

  // Erste Abfahrt + Rostock-Zugehörigkeit je Trip aus stop_times ermitteln
  console.log('Parse stop_times.txt … (größte Datei, bitte warten)')
  const firstDeparture = new Map() // trip_id → {seq, dep}
  const tripTouchesRostock = new Set()
  for (const st of read('stop_times.txt')) {
    const trip = tripById.get(st.trip_id)
    if (!trip) continue
    if (stopsInRostock.has(st.stop_id)) tripTouchesRostock.add(st.trip_id)
    const seq = Number(st.stop_sequence)
    const cur = firstDeparture.get(st.trip_id)
    if (!cur || seq < cur.seq) {
      firstDeparture.set(st.trip_id, { seq, dep: st.departure_time })
    }
  }

  const rostockTrips = trips.filter((t) => tripTouchesRostock.has(t.trip_id))
  if (rostockTrips.length === 0) {
    throw new Error(
      'Keine Rostocker Tram-Fahrten im Feed gefunden. ' +
        'Prüfe GTFS_URL – ggf. den offiziellen VVW-Feed verwenden.',
    )
  }

  // Verkehrsreichsten Service (typischer Werktag) wählen
  const tripsPerService = new Map()
  for (const t of rostockTrips) {
    tripsPerService.set(t.service_id, (tripsPerService.get(t.service_id) || 0) + 1)
  }
  const [serviceId] = [...tripsPerService.entries()].sort((a, b) => b[1] - a[1])[0]
  console.log(`Gewählter service_id: ${serviceId} (${tripsPerService.get(serviceId)} Fahrten)`)

  const lines = {}
  for (const trip of rostockTrips) {
    if (trip.service_id !== serviceId) continue
    const route = routeById.get(trip.route_id)
    const lineId = route.route_short_name
    const direction = trip.direction_id === '1' ? '1' : '0'
    const first = firstDeparture.get(trip.trip_id)
    if (!first?.dep) continue
    const sec = timeToSeconds(first.dep)
    lines[lineId] ??= {}
    lines[lineId][direction] ??= { departures: [] }
    lines[lineId][direction].departures.push(sec)
  }
  for (const line of Object.values(lines)) {
    for (const dir of Object.values(line)) {
      dir.departures = [...new Set(dir.departures)].sort((a, b) => a - b)
    }
  }

  const schedule = {
    meta: {
      source: 'gtfs',
      generated: new Date().toISOString().slice(0, 10),
      serviceId,
      attribution:
        'Fahrplandaten aus GTFS (gtfs.de / DELFI bzw. VVW). Nutzungsbedingungen der Quelle beachten.',
      note:
        'direction_id des Feeds muss nicht mit der Richtungs-Orientierung der Routengeometrie übereinstimmen – bei Bedarf in der App prüfen/tauschen.',
    },
    lines,
  }

  writeFileSync(OUT, JSON.stringify(schedule, null, 2) + '\n', 'utf8')
  const summary = Object.entries(lines)
    .map(([id, dirs]) => `${id}: ${Object.values(dirs).reduce((n, d) => n + d.departures.length, 0)} Abfahrten`)
    .join(', ')
  console.log(`\n✅ ${OUT} geschrieben – ${summary}`)
}

main().catch((err) => {
  console.error('❌ Fehler:', err.message)
  process.exit(1)
})
