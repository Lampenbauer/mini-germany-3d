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
 *
 * Implementierungshinweis: stop_times.txt des Deutschland-Feeds ist
 * dekomprimiert mehrere Gigabyte groß – die Datei wird daher zeilenweise
 * über dem Byte-Puffer gestreamt statt als ein String dekodiert.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../src/data/schedule.json')
const NETWORK_JSON = resolve(__dirname, '../src/data/network.json')
const CACHE_DIR = resolve(__dirname, '.cache')
const GTFS_URL = process.env.GTFS_URL || 'https://download.gtfs.de/germany/nv_free/latest.zip'

// Grobe Bounding-Box Rostock zum Filtern der Haltestellen
const BBOX = { minLon: 11.95, maxLon: 12.35, minLat: 53.95, maxLat: 54.22 }
const TRAM_LINE_IDS = new Set(['1', '2', '3', '4', '5', '6', '7'])

// Nur diese Dateien werden aus dem Zip entpackt (spart Gigabytes an RAM)
const NEEDED_FILES = new Set(['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt'])

// ---------------------------------------------------------------------------
// CSV-Streaming über Uint8Array (ohne die Datei als einen String zu halten)
// ---------------------------------------------------------------------------

/** Liefert die Zeilen einer UTF-8-Datei, chunkweise dekodiert. */
function* iterateLines(u8, chunkSize = 8 << 20) {
  const decoder = new TextDecoder('utf-8')
  let carry = ''
  for (let off = 0; off < u8.length; off += chunkSize) {
    const chunk = decoder.decode(u8.subarray(off, Math.min(off + chunkSize, u8.length)), {
      stream: true,
    })
    const parts = (carry + chunk).split('\n')
    carry = parts.pop()
    for (const line of parts) {
      yield line.endsWith('\r') ? line.slice(0, -1) : line
    }
  }
  const last = carry + decoder.decode()
  if (last) yield last.endsWith('\r') ? last.slice(0, -1) : last
}

/** Zerlegt eine CSV-Zeile; nutzt den schnellen Pfad, wenn keine Quotes vorkommen. */
function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',')
  const fields = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
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
      fields.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Iteriert eine GTFS-CSV-Datei und ruft für jede Zeile `onRow(get)` auf,
 * wobei `get('spalte')` den Feldwert liefert. Rückgabewert false bricht ab.
 */
function scanCsv(u8, onRow) {
  let header = null
  let index = null
  for (const line of iterateLines(u8)) {
    if (line === '') continue
    if (!header) {
      header = splitCsvLine(stripBom(line)).map((h) => h.trim())
      index = new Map(header.map((h, i) => [h, i]))
      continue
    }
    const fields = splitCsvLine(line)
    const get = (col) => {
      const i = index.get(col)
      return i === undefined ? '' : (fields[i] ?? '')
    }
    if (onRow(get) === false) return
  }
}

function timeToSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number)
  return h * 3600 + m * 60 + (s || 0)
}

const normalizeName = (s) =>
  s
    .toLowerCase()
    .replace(/rostock,?\s*/g, '')
    .replace(/[^a-zäöüß0-9]+/g, ' ')
    .trim()

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
  console.log('Entpacke benötigte GTFS-Dateien …')
  const files = unzipSync(new Uint8Array(zipBuffer), {
    filter: (file) => NEEDED_FILES.has(file.name),
  })
  for (const name of NEEDED_FILES) {
    if (!files[name]) throw new Error(`${name} fehlt im GTFS-Feed`)
  }

  // ---- stops.txt: Haltestellen im Rostocker Stadtgebiet --------------------
  const stopsInRostock = new Set()
  scanCsv(files['stops.txt'], (get) => {
    const lon = Number(get('stop_lon'))
    const lat = Number(get('stop_lat'))
    if (lon > BBOX.minLon && lon < BBOX.maxLon && lat > BBOX.minLat && lat < BBOX.maxLat) {
      stopsInRostock.add(get('stop_id'))
    }
  })
  console.log(`${stopsInRostock.size} Haltestellen im Rostocker Stadtgebiet`)

  // ---- routes.txt: Tram-Routen (route_type 0) mit passender Liniennummer ---
  const routeLine = new Map() // route_id → Liniennummer
  scanCsv(files['routes.txt'], (get) => {
    if (get('route_type') === '0' && TRAM_LINE_IDS.has(get('route_short_name'))) {
      routeLine.set(get('route_id'), get('route_short_name'))
    }
  })
  console.log(`${routeLine.size} Tram-Routen-Kandidaten (route_type=0, deutschlandweit)`)

  // ---- trips.txt: nur Fahrten der Kandidaten-Routen ------------------------
  const tripInfo = new Map() // trip_id → {lineId, directionId, serviceId, headsign}
  scanCsv(files['trips.txt'], (get) => {
    const lineId = routeLine.get(get('route_id'))
    if (!lineId) return
    tripInfo.set(get('trip_id'), {
      lineId,
      directionId: get('direction_id') === '1' ? '1' : '0',
      serviceId: get('service_id'),
      headsign: get('trip_headsign'),
    })
  })
  console.log(`${tripInfo.size} Kandidaten-Fahrten`)

  // ---- stop_times.txt: erste Abfahrt + Rostock-Bezug je Fahrt (Streaming) --
  console.log('Streame stop_times.txt … (größte Datei, bitte warten)')
  const firstDeparture = new Map() // trip_id → {seq, dep}
  const tripTouchesRostock = new Set()
  let rows = 0
  scanCsv(files['stop_times.txt'], (get) => {
    rows++
    if (rows % 10_000_000 === 0) console.log(`  … ${rows / 1e6} Mio. Zeilen`)
    const tripId = get('trip_id')
    if (!tripInfo.has(tripId)) return
    if (stopsInRostock.has(get('stop_id'))) tripTouchesRostock.add(tripId)
    const seq = Number(get('stop_sequence'))
    const cur = firstDeparture.get(tripId)
    if (!cur || seq < cur.seq) {
      firstDeparture.set(tripId, { seq, dep: get('departure_time') })
    }
  })
  console.log(`${rows} stop_times-Zeilen verarbeitet, ${tripTouchesRostock.size} Rostocker Fahrten`)

  if (tripTouchesRostock.size === 0) {
    throw new Error(
      'Keine Rostocker Tram-Fahrten im Feed gefunden. ' +
        'Prüfe GTFS_URL – ggf. den offiziellen VVW-Feed verwenden.',
    )
  }

  // ---- Verkehrsreichsten Service (typischer Werktag) wählen ----------------
  const tripsPerService = new Map()
  for (const tripId of tripTouchesRostock) {
    const info = tripInfo.get(tripId)
    tripsPerService.set(info.serviceId, (tripsPerService.get(info.serviceId) || 0) + 1)
  }
  const [serviceId] = [...tripsPerService.entries()].sort((a, b) => b[1] - a[1])[0]
  console.log(`Gewählter service_id: ${serviceId} (${tripsPerService.get(serviceId)} Fahrten)`)

  // ---- Richtungszuordnung: GTFS direction_id ↔ Netz-Richtung ---------------
  // Heuristik über trip_headsign vs. Zielhaltestelle in network.json
  let dirTargets = {}
  try {
    const network = JSON.parse(readFileSync(NETWORK_JSON, 'utf8'))
    for (const line of network.lines) {
      const d0 = line.directions[0]
      dirTargets[line.id] = {
        to0: normalizeName(d0.to),
        to1: normalizeName(line.directions[1]?.to ?? d0.from),
      }
    }
  } catch {
    console.warn('⚠ network.json nicht lesbar – Richtungs-Heuristik übersprungen')
  }

  // headsign-Stimmen sammeln: score[lineId][gtfsDir][netzDir]
  const votes = {}
  for (const tripId of tripTouchesRostock) {
    const info = tripInfo.get(tripId)
    if (info.serviceId !== serviceId) continue
    const targets = dirTargets[info.lineId]
    if (!targets || !info.headsign) continue
    const hs = normalizeName(info.headsign)
    votes[info.lineId] ??= { 0: { 0: 0, 1: 0 }, 1: { 0: 0, 1: 0 } }
    if (targets.to0 && hs.includes(targets.to0)) votes[info.lineId][info.directionId][0]++
    if (targets.to1 && hs.includes(targets.to1)) votes[info.lineId][info.directionId][1]++
  }

  /** Liefert die Netz-Richtung ('0'|'1') für eine GTFS-direction_id. */
  const mapDirection = (lineId, gtfsDir) => {
    const v = votes[lineId]
    if (!v) return gtfsDir
    const identity = v[0][0] + v[1][1]
    const swapped = v[0][1] + v[1][0]
    if (swapped > identity) return gtfsDir === '0' ? '1' : '0'
    return gtfsDir
  }

  // ---- schedule.json schreiben ---------------------------------------------
  const lines = {}
  for (const tripId of tripTouchesRostock) {
    const info = tripInfo.get(tripId)
    if (info.serviceId !== serviceId) continue
    const first = firstDeparture.get(tripId)
    if (!first?.dep) continue
    const direction = mapDirection(info.lineId, info.directionId)
    const sec = timeToSeconds(first.dep)
    lines[info.lineId] ??= {}
    lines[info.lineId][direction] ??= { departures: [] }
    lines[info.lineId][direction].departures.push(sec)
  }
  for (const line of Object.values(lines)) {
    for (const dir of Object.values(line)) {
      dir.departures = [...new Set(dir.departures)].sort((a, b) => a - b)
    }
  }

  const swappedLines = Object.keys(votes).filter((id) => mapDirection(id, '0') === '1')
  const schedule = {
    meta: {
      source: 'gtfs',
      generated: new Date().toISOString().slice(0, 10),
      serviceId,
      attribution:
        'Fahrplandaten aus GTFS (gtfs.de / DELFI bzw. VVW). Nutzungsbedingungen der Quelle beachten.',
      note:
        swappedLines.length > 0
          ? `direction_id per Headsign-Heuristik getauscht für Linie(n): ${swappedLines.join(', ')}`
          : 'direction_id unverändert übernommen (Headsign-Heuristik ohne Tausch).',
    },
    lines,
  }

  writeFileSync(OUT, JSON.stringify(schedule, null, 2) + '\n', 'utf8')
  const summary = Object.entries(lines)
    .map(
      ([id, dirs]) =>
        `${id}: ${Object.values(dirs).reduce((n, d) => n + d.departures.length, 0)} Abfahrten`,
    )
    .join(', ')
  console.log(`\n✅ ${OUT} geschrieben – ${summary}`)
}

main().catch((err) => {
  console.error('❌ Fehler:', err.message)
  process.exit(1)
})
