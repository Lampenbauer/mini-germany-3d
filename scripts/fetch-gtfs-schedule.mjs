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
  const rostockStopCoords = new Map() // stop_id → [lon, lat]
  scanCsv(files['stops.txt'], (get) => {
    const lon = Number(get('stop_lon'))
    const lat = Number(get('stop_lat'))
    if (lon > BBOX.minLon && lon < BBOX.maxLon && lat > BBOX.minLat && lat < BBOX.maxLat) {
      rostockStopCoords.set(get('stop_id'), [lon, lat])
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

  // ---- stop_times.txt: erste Abfahrt, letzter Halt + Rostock-Bezug ---------
  console.log('Streame stop_times.txt … (größte Datei, bitte warten)')
  const firstDeparture = new Map() // trip_id → {seq, dep}
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
      firstDeparture.set(tripId, { seq, dep: get('departure_time') })
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

  // ---- Verkehrsreichsten Service (typischer Werktag) wählen ----------------
  const tripsPerService = new Map()
  for (const tripId of tripTouchesRostock) {
    const info = tripInfo.get(tripId)
    tripsPerService.set(info.serviceId, (tripsPerService.get(info.serviceId) || 0) + 1)
  }
  const [serviceId] = [...tripsPerService.entries()].sort((a, b) => b[1] - a[1])[0]
  console.log(`Gewählter service_id: ${serviceId} (${tripsPerService.get(serviceId)} Fahrten)`)

  // ---- Richtungszuordnung: GTFS-Fahrt ↔ Netz-Richtung ----------------------
  // Ziel: jede Fahrt der Richtung 0 oder 1 aus network.json zuordnen.
  // Primär über die Koordinate der Endhaltestelle (robust, auch bei
  // Kurzfahrten), sekundär über trip_headsign. Falls der Feed eine
  // direction_id führt, dient sie als globale Zuordnung mit Tausch-Heuristik.
  const dirTargets = {}
  try {
    const network = JSON.parse(readFileSync(NETWORK_JSON, 'utf8'))
    for (const line of network.lines) {
      const d0 = line.directions[0]
      const d1 = line.directions[1]
      const stopCoord = (dir) => {
        const stopId = dir?.stops?.[dir.stops.length - 1]
        return stopId ? network.stops[stopId]?.coord : undefined
      }
      dirTargets[line.id] = {
        to0: normalizeName(d0.to),
        to1: normalizeName(d1?.to ?? d0.from),
        term0: stopCoord(d0) ?? d0.path[d0.path.length - 1],
        term1: stopCoord(d1) ?? d0.path[0],
      }
    }
  } catch {
    console.warn('⚠ network.json nicht lesbar – Richtungs-Heuristik eingeschränkt')
  }

  const distMeters = ([lon1, lat1], [lon2, lat2]) => {
    const cosLat = Math.cos((lat1 * Math.PI) / 180)
    const dx = (lon2 - lon1) * cosLat * 111320
    const dy = (lat2 - lat1) * 110540
    return Math.hypot(dx, dy)
  }

  const nameMatches = (headsign, target) => {
    if (!headsign || !target || headsign.length < 5) return false
    return headsign.includes(target) || target.includes(headsign)
  }

  /** Klassifiziert eine Fahrt als Richtung '0' | '1' | null (nicht eindeutig). */
  const classifyTrip = (tripId, info) => {
    const targets = dirTargets[info.lineId]
    if (!targets) return null

    // 1) Endhaltestellen-Koordinate vergleichen
    const last = lastStop.get(tripId)
    const lastCoord = last ? rostockStopCoords.get(last.stopId) : undefined
    if (lastCoord && targets.term0 && targets.term1) {
      const d0 = distMeters(lastCoord, targets.term0)
      const d1 = distMeters(lastCoord, targets.term1)
      if (Math.abs(d0 - d1) > 300) return d0 < d1 ? '0' : '1'
    }

    // 2) Headsign-Namen vergleichen
    const hs = normalizeName(info.headsign ?? '')
    const m0 = nameMatches(hs, targets.to0)
    const m1 = nameMatches(hs, targets.to1)
    if (m0 !== m1) return m0 ? '0' : '1'

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
      if (info.serviceId !== serviceId) continue
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
    if (info.serviceId !== serviceId) continue
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
    lines[info.lineId][direction] ??= { departures: [] }
    lines[info.lineId][direction].departures.push(sec)
  }
  for (const line of Object.values(lines)) {
    for (const dir of Object.values(line)) {
      dir.departures = [...new Set(dir.departures)].sort((a, b) => a - b)
    }
  }
  if (unclassified > 0) {
    console.warn(`⚠ ${unclassified} Fahrten ohne eindeutige Richtung übersprungen`)
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
      serviceId,
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
