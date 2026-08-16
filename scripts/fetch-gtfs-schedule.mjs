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
const NEEDED_FILES = new Set([
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
])
const OPTIONAL_FILES = new Set(['calendar.txt', 'calendar_dates.txt'])

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
    if (!files[name] && !OPTIONAL_FILES.has(name)) {
      throw new Error(`${name} fehlt im GTFS-Feed`)
    }
  }

  // ---- stops.txt: Haltestellen im Rostocker Stadtgebiet --------------------
  const rostockStopCoords = new Map() // stop_id → [lon, lat]
  const rostockStopNames = new Map() // stop_id → Name (für Diagnose)
  scanCsv(files['stops.txt'], (get) => {
    const lon = Number(get('stop_lon'))
    const lat = Number(get('stop_lat'))
    if (lon > BBOX.minLon && lon < BBOX.maxLon && lat > BBOX.minLat && lat < BBOX.maxLat) {
      rostockStopCoords.set(get('stop_id'), [lon, lat])
      rostockStopNames.set(get('stop_id'), get('stop_name'))
    }
  })
  const stopsInRostock = rostockStopCoords
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
  const tripInfo = new Map() // trip_id → {lineId, rawDir, serviceId, headsign}
  let tripsWithDirectionId = 0
  scanCsv(files['trips.txt'], (get) => {
    const lineId = routeLine.get(get('route_id'))
    if (!lineId) return
    const rawDir = get('direction_id')
    if (rawDir === '0' || rawDir === '1') tripsWithDirectionId++
    tripInfo.set(get('trip_id'), {
      lineId,
      rawDir,
      serviceId: get('service_id'),
      headsign: get('trip_headsign'),
    })
  })
  console.log(`${tripInfo.size} Kandidaten-Fahrten (${tripsWithDirectionId} mit direction_id)`)

  // ---- stop_times.txt: erste Abfahrt, erster/letzter Halt + Rostock-Bezug --
  console.log('Streame stop_times.txt … (größte Datei, bitte warten)')
  const firstDeparture = new Map() // trip_id → {seq, dep, stopId}
  const lastStop = new Map() // trip_id → {seq, stopId}
  const tripTouchesRostock = new Set()
  let rows = 0
  scanCsv(files['stop_times.txt'], (get) => {
    rows++
    if (rows % 10_000_000 === 0) console.log(`  … ${rows / 1e6} Mio. Zeilen`)
    const tripId = get('trip_id')
    if (!tripInfo.has(tripId)) return
    const stopId = get('stop_id')
    if (stopsInRostock.has(stopId)) tripTouchesRostock.add(tripId)
    const seq = Number(get('stop_sequence'))
    const cur = firstDeparture.get(tripId)
    if (!cur || seq < cur.seq) {
      firstDeparture.set(tripId, { seq, dep: get('departure_time'), stopId })
    }
    const last = lastStop.get(tripId)
    if (!last || seq > last.seq) {
      lastStop.set(tripId, { seq, stopId })
    }
  })
  console.log(`${rows} stop_times-Zeilen verarbeitet, ${tripTouchesRostock.size} Rostocker Fahrten`)

  if (tripTouchesRostock.size === 0) {
    throw new Error(
      'Keine Rostocker Tram-Fahrten im Feed gefunden. ' +
        'Prüfe GTFS_URL – ggf. den offiziellen VVW-Feed verwenden.',
    )
  }

  // ---- Betriebstag wählen und ALLE dort aktiven Services einbeziehen -------
  // Wichtig: Feeds verteilen die Fahrten einer Linie (sogar die beiden
  // Richtungen!) oft auf mehrere service_ids. Eine einzelne service_id zu
  // wählen verliert daher Fahrten – stattdessen wird ein konkreter
  // Betriebstag gewählt und jede an diesem Datum aktive service_id zählt.
  const calendarServices = new Map() // service_id → {days:[so..sa], start, end}
  if (files['calendar.txt']) {
    scanCsv(files['calendar.txt'], (get) => {
      calendarServices.set(get('service_id'), {
        days: [
          get('sunday') === '1',
          get('monday') === '1',
          get('tuesday') === '1',
          get('wednesday') === '1',
          get('thursday') === '1',
          get('friday') === '1',
          get('saturday') === '1',
        ],
        start: get('start_date'),
        end: get('end_date'),
      })
    })
  }
  const calendarExceptions = new Map() // `${service_id}|${date}` → '1' | '2'
  if (files['calendar_dates.txt']) {
    scanCsv(files['calendar_dates.txt'], (get) => {
      calendarExceptions.set(`${get('service_id')}|${get('date')}`, get('exception_type'))
    })
  }

  const isServiceActiveOn = (serviceId, dateStr, weekday) => {
    const exception = calendarExceptions.get(`${serviceId}|${dateStr}`)
    if (exception === '2') return false
    if (exception === '1') return true
    const cal = calendarServices.get(serviceId)
    if (!cal) return false
    return dateStr >= cal.start && dateStr <= cal.end && cal.days[weekday]
  }

  const rostockServiceIds = new Set(
    [...tripTouchesRostock].map((tripId) => tripInfo.get(tripId).serviceId),
  )

  let activeServiceIds
  let serviceDate = null
  if (calendarServices.size > 0 || calendarExceptions.size > 0) {
    // Die nächsten 21 Tage durchprobieren; Tag mit den meisten aktiven
    // Rostocker Tram-Fahrten gewinnt (bei Gleichstand der frühere Tag).
    let best = { count: -1, date: null, services: new Set() }
    for (let offset = 0; offset < 21; offset++) {
      const day = new Date(Date.now() + offset * 86400_000)
      const dateStr =
        String(day.getFullYear()) +
        String(day.getMonth() + 1).padStart(2, '0') +
        String(day.getDate()).padStart(2, '0')
      const weekday = day.getDay()
      const services = new Set(
        [...rostockServiceIds].filter((id) => isServiceActiveOn(id, dateStr, weekday)),
      )
      let count = 0
      for (const tripId of tripTouchesRostock) {
        if (services.has(tripInfo.get(tripId).serviceId)) count++
      }
      if (count > best.count) best = { count, date: dateStr, services }
    }
    activeServiceIds = best.services
    serviceDate = best.date
    console.log(
      `Gewählter Betriebstag: ${serviceDate} (${best.count} Fahrten, ${activeServiceIds.size} aktive Services)`,
    )
  } else {
    // Fallback ohne Kalenderdaten: verkehrsreichste einzelne service_id
    const tripsPerService = new Map()
    for (const tripId of tripTouchesRostock) {
      const info = tripInfo.get(tripId)
      tripsPerService.set(info.serviceId, (tripsPerService.get(info.serviceId) || 0) + 1)
    }
    const [serviceId] = [...tripsPerService.entries()].sort((a, b) => b[1] - a[1])[0]
    activeServiceIds = new Set([serviceId])
    console.warn(
      `⚠ Keine Kalenderdaten im Feed – nutze verkehrsreichste service_id ${serviceId}`,
    )
  }

  // ---- Richtungszuordnung: GTFS-Fahrt ↔ Netz-Richtung ----------------------
  // Ziel: jede Fahrt der Richtung 0 oder 1 aus network.json zuordnen.
  //
  // Primär über die FAHRTRICHTUNG entlang der Linien-Geometrie: Start- und
  // Endhalt der Fahrt werden auf den Pfad der Richtung 0 projiziert – wächst
  // die Distanz, fährt die Bahn in Richtung 0, sonst in Richtung 1. Das ist
  // auch bei Kurzfahrten und Baustellen-Endpunkten korrekt (ein Vergleich mit
  // dem nächstgelegenen Endterminus wäre es nicht: endet eine Fahrt
  // baustellenbedingt in der Stadtmitte, liegt sie fast immer näher am
  // "falschen" Terminus). Sekundär: trip_headsign.
  const dirTargets = {}
  try {
    const network = JSON.parse(readFileSync(NETWORK_JSON, 'utf8'))
    for (const line of network.lines) {
      const d0 = line.directions[0]
      const d1 = line.directions[1]
      const cum = [0]
      for (let i = 1; i < d0.path.length; i++) {
        const [lon1, lat1] = d0.path[i - 1]
        const [lon2, lat2] = d0.path[i]
        const cosLat = Math.cos((lat1 * Math.PI) / 180)
        cum.push(
          cum[i - 1] +
            Math.hypot((lon2 - lon1) * cosLat * 111320, (lat2 - lat1) * 110540),
        )
      }
      dirTargets[line.id] = {
        to0: normalizeName(d0.to),
        to1: normalizeName(d1?.to ?? d0.from),
        path: d0.path,
        cum,
      }
    }
  } catch {
    console.warn('⚠ network.json nicht lesbar – Richtungs-Heuristik eingeschränkt')
  }

  /** Distanz des nächstgelegenen Streckenpunkts entlang des Pfads (Meter). */
  const projectOntoPath = (path, cum, [plon, plat]) => {
    let best = Infinity
    let bestAlong = 0
    const cosLat = Math.cos((plat * Math.PI) / 180)
    for (let i = 0; i < path.length - 1; i++) {
      const [alon, alat] = path[i]
      const [blon, blat] = path[i + 1]
      const bx = (blon - alon) * cosLat
      const by = blat - alat
      const px = (plon - alon) * cosLat
      const py = plat - alat
      const lenSq = bx * bx + by * by
      const t = lenSq > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / lenSq)) : 0
      const dx = px - t * bx
      const dy = py - t * by
      const dSq = dx * dx + dy * dy
      if (dSq < best) {
        best = dSq
        bestAlong = cum[i] + (cum[i + 1] - cum[i]) * t
      }
    }
    return bestAlong
  }

  const nameMatches = (headsign, target) => {
    if (!headsign || !target || headsign.length < 5) return false
    return headsign.includes(target) || target.includes(headsign)
  }

  const classifyStats = {} // lineId → {path:0, headsign:0, skipped:0}

  /** Klassifiziert eine Fahrt als Richtung '0' | '1' | null (nicht eindeutig). */
  const classifyTrip = (tripId, info) => {
    const targets = dirTargets[info.lineId]
    if (!targets) return null
    const stats = (classifyStats[info.lineId] ??= { path: 0, headsign: 0, skipped: 0 })

    // 1) Fahrtrichtung entlang der Linien-Geometrie
    const firstCoord = rostockStopCoords.get(firstDeparture.get(tripId)?.stopId)
    const lastCoord = rostockStopCoords.get(lastStop.get(tripId)?.stopId)
    if (firstCoord && lastCoord && targets.path) {
      const a = projectOntoPath(targets.path, targets.cum, firstCoord)
      const b = projectOntoPath(targets.path, targets.cum, lastCoord)
      // Mindestens ~400 m Strecke, damit die Richtung eindeutig ist
      if (Math.abs(b - a) > 400) {
        stats.path++
        return b > a ? '0' : '1'
      }
    }

    // 2) Headsign-Namen vergleichen
    const hs = normalizeName(info.headsign ?? '')
    const m0 = nameMatches(hs, targets.to0)
    const m1 = nameMatches(hs, targets.to1)
    if (m0 !== m1) {
      stats.headsign++
      return m0 ? '0' : '1'
    }

    stats.skipped++
    return null
  }

  const useDirectionId = tripsWithDirectionId > 0

  // Bei vorhandener direction_id: prüfen, ob sie zur Netz-Orientierung passt
  // (Stimmen über die koordinatenbasierte Klassifikation sammeln).
  let directionIdSwapped = false
  if (useDirectionId) {
    let identity = 0
    let swapped = 0
    for (const tripId of tripTouchesRostock) {
      const info = tripInfo.get(tripId)
      if (!activeServiceIds.has(info.serviceId)) continue
      const cls = classifyTrip(tripId, info)
      if (cls === null || (info.rawDir !== '0' && info.rawDir !== '1')) continue
      if (cls === info.rawDir) identity++
      else swapped++
    }
    directionIdSwapped = swapped > identity
  }

  // ---- schedule.json schreiben ---------------------------------------------
  const lines = {}
  let unclassified = 0
  for (const tripId of tripTouchesRostock) {
    const info = tripInfo.get(tripId)
    if (!activeServiceIds.has(info.serviceId)) continue
    const first = firstDeparture.get(tripId)
    if (!first?.dep) continue

    let direction
    if (useDirectionId && (info.rawDir === '0' || info.rawDir === '1')) {
      direction = directionIdSwapped ? (info.rawDir === '0' ? '1' : '0') : info.rawDir
    } else {
      direction = classifyTrip(tripId, info)
    }
    if (direction === null || direction === undefined) {
      unclassified++
      continue
    }

    const sec = timeToSeconds(first.dep)
    lines[info.lineId] ??= {}
    lines[info.lineId][direction] ??= { pairs: [] }
    lines[info.lineId][direction].pairs.push({ sec, tripId })
  }
  // Sortieren, pro Abfahrtszeit deduplizieren und die GTFS-trip_ids parallel
  // ablegen (werden zur Laufzeit für das GTFS-Realtime-Matching gebraucht).
  for (const line of Object.values(lines)) {
    for (const dir of Object.values(line)) {
      const seen = new Set()
      const unique = dir.pairs
        .sort((a, b) => a.sec - b.sec)
        .filter((p) => (seen.has(p.sec) ? false : (seen.add(p.sec), true)))
      dir.departures = unique.map((p) => p.sec)
      dir.tripIds = unique.map((p) => p.tripId)
      delete dir.pairs
    }
  }
  if (unclassified > 0) {
    console.warn(`⚠ ${unclassified} Fahrten ohne eindeutige Richtung übersprungen`)
  }

  // Klassifikations-Übersicht (Detail-Diagnose mit GTFS_DEBUG=1)
  for (const [lineId, stats] of Object.entries(classifyStats)) {
    console.log(
      `  Linie ${lineId}: ${stats.path}× per Fahrtrichtung, ${stats.headsign}× per Headsign, ${stats.skipped}× übersprungen`,
    )
  }
  if (process.env.GTFS_DEBUG) {
    const endpoints = {} // lineId → dir → Map<"von → nach", count>
    for (const tripId of tripTouchesRostock) {
      const info = tripInfo.get(tripId)
      if (!activeServiceIds.has(info.serviceId)) continue
      const direction = classifyTrip(tripId, info)
      const from = rostockStopNames.get(firstDeparture.get(tripId)?.stopId) ?? '?'
      const to = rostockStopNames.get(lastStop.get(tripId)?.stopId) ?? '?'
      const key = `${from} → ${to}`
      endpoints[info.lineId] ??= {}
      const dirMap = (endpoints[info.lineId][direction ?? 'übersprungen'] ??= new Map())
      dirMap.set(key, (dirMap.get(key) ?? 0) + 1)
    }
    for (const [lineId, dirs] of Object.entries(endpoints)) {
      console.log(`  [DEBUG] Linie ${lineId}:`)
      for (const [dir, dirMap] of Object.entries(dirs)) {
        const top = [...dirMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        console.log(`    Richtung ${dir}:`)
        for (const [key, count] of top) console.log(`      ${count}× ${key}`)
      }
    }
  }

  const linesWithoutData = Object.keys(dirTargets).filter((id) => !lines[id])
  const noteParts = [
    useDirectionId
      ? `Richtungen aus direction_id übernommen${directionIdSwapped ? ' (global getauscht)' : ''}.`
      : 'Feed ohne direction_id – Richtungen über Endhaltestellen-Koordinaten/Headsigns zugeordnet.',
  ]
  if (unclassified > 0) noteParts.push(`${unclassified} Fahrten ohne eindeutige Richtung übersprungen.`)
  if (linesWithoutData.length > 0) {
    noteParts.push(
      `Keine GTFS-Abfahrten für Linie(n) ${linesWithoutData.join(', ')} – dort gilt der synthetische Takt.`,
    )
  }

  const schedule = {
    meta: {
      source: 'gtfs',
      generated: new Date().toISOString().slice(0, 10),
      serviceDate,
      serviceCount: activeServiceIds.size,
      attribution:
        'Fahrplandaten aus GTFS (gtfs.de / DELFI bzw. VVW). Nutzungsbedingungen der Quelle beachten.',
      note: noteParts.join(' '),
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
