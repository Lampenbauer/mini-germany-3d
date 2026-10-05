#!/usr/bin/env node
/**
 * Generates src/cities/<slug>/schedule.json with real departure times
 * from a GTFS feed (default: the free Germany-wide feed from gtfs.de).
 *
 *   npm run data:gtfs -- --city rostock     (no --city: every city)
 *
 * Environment variables:
 *   CITY       – the city, like --city
 *   NETWORK_OUT / SCHEDULE_OUT – alternative network.json to read and
 *                schedule.json to write (one city only)
 *   GTFS_URL   – GTFS zip URL (default: https://download.gtfs.de/germany/free/latest.zip,
 *                the FULL Germany feed – the smaller nv_free local-transit
 *                split excludes rail and thus the S-Bahn).
 *                Alternatively the official VVW feed can be used here
 *                (registration: https://www.verkehrsverbund-warnow.de/service/open-data.html)
 *   GTFS_FILE  – local path to an already downloaded GTFS zip
 *   SERVICE_DAY_LOG – a file the chosen service day is appended to, one
 *                line per city (the nightly run puts them in its commit)
 *
 * From schedule.json the app uses the departure times at the starting point
 * of each line/direction; travel time between stops is still derived from
 * the route geometry. Mind the attribution (gtfs.de / DELFI).
 *
 * The schedule is one service day – the busiest of the next three weeks,
 * a typical weekday (see the choice below). Which date that was is
 * printed and logged, not written into the file: it moves with the
 * calendar while the departures do not, and the nightly refresh only
 * tests, builds and deploys when a city's data changed (ci.yml's
 * "Anything new?"). Written into the file, the date alone set the whole
 * pipeline going almost every night (found when the night's diff for
 * four cities was that one line).
 *
 * Implementation note: stop_times.txt of the Germany feed is several
 * gigabytes uncompressed – the file is therefore streamed line by line over
 * the byte buffer instead of being decoded as a single string, and ONCE
 * for every requested city (see main): the scan is the cost of a run,
 * a city more is a few seconds.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { TRANSIT_MODES } from '../src/lib/transit-mode.ts'
import {
  cityInsidePredicate,
  cityPaths,
  loadCity,
  networkInsidePredicate,
  requestedCitySlugs,
} from './lib/city.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(__dirname, '.cache')
// Full feed, not nv_free: gtfs.de sorts S-Bahn schedules into the
// regional-rail split, so the local-transit feed alone has no trains.
const GTFS_URL = process.env.GTFS_URL || 'https://download.gtfs.de/germany/free/latest.zip'

// The rectangle that decides which stops are the city's stops is
// deliberately the bare city limits (city.cityBounds), NOT the padded
// boundingBox the rest of the project uses: a trip's departure time and
// geometry anchors are read at its first/last stop INSIDE this rectangle
// (see the stop_times scan), and the network is cut at the same limits
// (data:update). With the padding the first stop of a regional train
// would be a station in the next town, and the train would leave the
// map's last station twenty minutes early. Every stop of the network lies
// inside the city rectangle; the check in main() says so when one day one
// does not.

// GTFS route_types per mode of transport (basic and extended types)
const ROUTE_TYPES = {
  tram: new Set(['0', '900']),
  subway: new Set(['1', '400', '401', '402']),
  // 2 rail, 106 regional rail, 109 suburban railway – feeds label
  // S-Bahn lines inconsistently; false positives (an "S1" elsewhere in
  // Germany) are eliminated by the stop-BBOX filter below.
  train: new Set(['2', '106', '109']),
  bus: new Set(['3', '700', '704']),
  ferry: new Set(['4', '1000', '1200']),
}

/**
 * The route_type values a city's mode is looked up under: what its
 * definition names (gtfs.routeTypes), else the defaults above. Feeds
 * classify a Stadtbahn as they please – Cologne's KVB is a tram to the
 * feed, Hannover's ÜSTRA an underground – and the map keeps the mode the
 * city itself uses for it.
 */
export function routeTypesForCity(city) {
  const types = {}
  for (const [mode, set] of Object.entries(ROUTE_TYPES)) {
    const own = city.gtfs.routeTypes?.[mode]
    types[mode] = own ? new Set(own) : set
  }
  return types
}

// Ferry routes that match no pier name are held onto and assigned to a
// network ferry line later via their terminal coordinates (the gtfs.de
// feed carries the Rostock Warnow ferries as "FÄ1"/"FÄ2" with an EMPTY
// route_long_name, so name matching alone cannot find them).
const FERRY_PENDING = '\u0000pending-ferry'

// Some feeds collapse the legs of an S-Bahn into ONE route with the bare
// short name "S" (no headsigns either). Its trips are told apart by the
// branch stations they serve OUTSIDE the city (city.gtfs.trainBranches):
// trips of such routes are held as pending and classified during the
// stop_times scan; unclassifiable ones are dropped.
const TRAIN_PENDING = String.fromCharCode(0) + 'pending-train'

// Note: a pre-filter via agency.txt would be tempting (a "line 22" exists in
// dozens of cities) but fails on the feed's operator names (an operator is
// not necessarily listed under its city's name). The reliable city filter
// therefore remains matching the stops against the BBOX; agency.txt is
// only read for diagnostic output.

// Only these files are extracted from the zip (saves gigabytes of RAM)
const NEEDED_FILES = new Set([
  'agency.txt',
  'routes.txt',
  'trips.txt',
  'stops.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
])
const OPTIONAL_FILES = new Set(['agency.txt', 'calendar.txt', 'calendar_dates.txt'])

// ---------------------------------------------------------------------------
// CSV streaming over Uint8Array (without holding the file as a single string)
// ---------------------------------------------------------------------------

/** Yields the lines of a UTF-8 file, decoded chunk by chunk. */
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

/** Splits a CSV line; uses the fast path when no quotes are present. */
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

/**
 * A field that stands on its own. V8 hands a substring of thirteen
 * characters and more out as a slice of the string it was cut from –
 * here the decoded 8 MB chunk of the file – and a stored slice keeps
 * that whole chunk alive: every stop id of a city held 40 MB of
 * stops.txt for the run, thirteen cities half a gigabyte. Concatenating
 * and slicing again lands on a fresh flat copy of the field alone.
 */
function own(field) {
  return field.length < 13 ? field : (' ' + field).slice(1)
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Iterates a GTFS CSV file and calls `onRow(get)` for each row, where
 * `get('column')` returns the field value. Returning false aborts.
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

/** Great-circle distance between two [lon, lat] points, in meters. */
const metersBetween = ([lonA, latA], [lonB, latB]) => {
  const cosLat = Math.cos((latA * Math.PI) / 180)
  return Math.hypot((lonB - lonA) * cosLat * 111320, (latB - latA) * 110540)
}

function timeToSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number)
  return h * 3600 + m * 60 + (s || 0)
}

/**
 * Stop and headsign names as they are compared: lower-case, the city's
 * prefix the feed puts in front of them ("Rostock, Hbf") stripped, and
 * everything but letters and digits collapsed into spaces.
 */
const makeNormalizeName = (strip) => {
  const prefix = strip
    ? new RegExp(strip.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',?\\s*', 'g')
    : null
  return (s) => {
    let text = s.toLowerCase()
    if (prefix) text = text.replace(prefix, '')
    return text.replace(/[^a-zäöüß0-9]+/g, ' ').trim()
  }
}

/** The feed's zip, read once per run however many cities follow. */
async function loadZip() {
  if (process.env.GTFS_FILE) {
    console.log(`Reading local GTFS file ${process.env.GTFS_FILE}`)
    return readFileSync(process.env.GTFS_FILE)
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  const cachePath = resolve(CACHE_DIR, 'gtfs.zip')
  if (existsSync(cachePath)) {
    console.log(`Using cache ${cachePath} (delete it for a fresh download)`)
    return readFileSync(cachePath)
  }
  console.log(`Downloading ${GTFS_URL} … (this can take a few minutes)`)
  const response = await fetch(GTFS_URL, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(cachePath, buffer)
  console.log(`Downloaded ${(buffer.length / 1e6).toFixed(1)} MB`)
  return buffer
}

/** A warning the run's log shows – as an annotation under GitHub Actions. */
function warn(message) {
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `⚠ ${message}`)
}

/**
 * One run for every requested city over ONE pass of the feed. The feed
 * is unpacked once and stop_times.txt – 2.2 GB, 38 million rows, the
 * whole of Germany – is streamed once, with every city's trips picked
 * out of the same rows: each city prepares its candidate trips first
 * (prepareCity), the scan hands each row to the cities that have its
 * trip, and the schedule is written per city afterwards (finishCity).
 * Before that the script ran per city from the top, thirteen
 * unpackings and thirteen scans of the same file – 47 seconds a city on
 * the CI runner, ten minutes a night for one minute's work.
 *
 * A city that fails (no trips in the feed, a network.json missing)
 * keeps its previous schedule and is reported; the run fails only when
 * every city did – a feed that serves nobody.
 */
async function main() {
  const cities = requestedCitySlugs().map((slug) => ({
    slug,
    city: loadCity(slug),
    paths: cityPaths(slug),
  }))
  let zipBuffer = await loadZip()
  console.log('Extracting required GTFS files …')
  const files = unzipSync(new Uint8Array(zipBuffer), {
    filter: (file) => NEEDED_FILES.has(file.name),
  })
  zipBuffer = null // 280 MB the scan has no use for
  for (const name of NEEDED_FILES) {
    if (!files[name] && !OPTIONAL_FILES.has(name)) {
      throw new Error(`${name} is missing from the GTFS feed`)
    }
  }

  const calendar = readCalendar(files)

  const failed = []
  const collectors = []
  for (const { slug, city, paths } of cities) {
    if (cities.length > 1) console.log(`\n══════ ${city.name} (${slug}) ══════`)
    try {
      collectors.push(prepareCity(city, paths, files))
    } catch (err) {
      failed.push(slug)
      warn(`${slug}: GTFS refresh failed – keeping the previous schedule. ${err.message}`)
    }
  }

  let tripRecords = null
  if (collectors.length > 0) {
    console.log('\nScanning trips.txt …')
    tripRecords = scanTrips(files['trips.txt'], collectors)
    console.log('\nStreaming stop_times.txt … (largest file, please wait)')
    scanStopTimes(files['stop_times.txt'], collectors)
  }
  // The scan is what the file was held for – let it go before the
  // cities' own work, which allocates plenty of its own
  delete files['stop_times.txt']

  for (const collector of collectors) {
    const { slug, city } = collector
    if (cities.length > 1) console.log(`\n══════ ${city.name} (${slug}) ══════`)
    try {
      finishCity(collector, calendar, tripRecords)
    } catch (err) {
      failed.push(slug)
      warn(`${slug}: GTFS refresh failed – keeping the previous schedule. ${err.message}`)
    }
  }

  if (failed.length === cities.length) {
    throw new Error(`GTFS refresh failed for every city (${failed.join(', ')})`)
  }
}

/**
 * Everything a city needs before the feed's trips are scanned: its lines
 * from network.json, its stops, the feed's candidate routes for those
 * lines, and the empty maps the two scans fill.
 */
function prepareCity(city, paths, files) {
  const OUT = process.env.SCHEDULE_OUT ? resolve(process.env.SCHEDULE_OUT) : paths.schedule
  const NETWORK_JSON = process.env.NETWORK_OUT ? resolve(process.env.NETWORK_OUT) : paths.network
  // Two areas: a trip belongs to the city when it serves a stop inside the
  // city limits (a line 5 of the next town's operator that never enters
  // Kiel is not Kiel's line 5, however the numbers collide); its departure
  // anchors at its first stop inside the area the network is cut to
  // (city.json `network.clip` – Kiel's routes run out to Laboe), where the
  // route on the map really starts.
  const insideCity = cityInsidePredicate(city)
  const insideArea = networkInsidePredicate(city)
  const normalizeName = makeNormalizeName(city.gtfs.nameStrip)
  const trainBranchProbes = city.gtfs.trainBranches.map((branch) => ({
    lineId: branch.lineId,
    pattern: new RegExp(branch.pattern),
  }))
  // The lines (including their mode of transport) come from network.json –
  // this GTFS script looks up the matching schedules for exactly these lines.
  const networkJson = JSON.parse(readFileSync(NETWORK_JSON, 'utf8'))
  const networkLines = new Map() // lineId → mode
  const ferryTargets = new Map() // lineId → normalized pier names
  for (const line of networkJson.lines) {
    const mode = line.mode ?? 'tram'
    networkLines.set(line.id, mode)
    if (mode === 'ferry') {
      const d = line.directions[0]
      ferryTargets.set(line.id, [d.from, d.to].map(normalizeName).filter(Boolean))
    }
  }
  console.log(
    `network.json: ${networkLines.size} lines (` +
      TRANSIT_MODES
        .map((m) => `${[...networkLines.values()].filter((v) => v === m).length}× ${m}`)
        .join(', ') +
      ')',
  )

  // ---- stops.txt: stops within the network area -----------------------------
  const cityStopCoords = new Map() // stop_id → [lon, lat], every stop in the area
  const cityStopNames = new Map() // stop_id → name (for diagnostics)
  const limitsStops = new Set() // the area stops that lie inside the city limits
  const trainProbeStops = new Map() // stop_id → lineId (S-Bahn branch, OUTSIDE bbox)
  scanCsv(files['stops.txt'], (get) => {
    const name = get('stop_name')
    for (const probe of trainBranchProbes) {
      if (probe.pattern.test(name)) trainProbeStops.set(own(get('stop_id')), probe.lineId)
    }
    const lon = Number(get('stop_lon'))
    const lat = Number(get('stop_lat'))
    if (insideArea(lon, lat)) {
      const stopId = own(get('stop_id'))
      cityStopCoords.set(stopId, [lon, lat])
      cityStopNames.set(stopId, own(name))
      if (insideCity(lon, lat)) limitsStops.add(stopId)
    }
  })
  const stopsInCity = cityStopCoords
  console.log(`${stopsInCity.size} stops inside the ${city.name} network area`)
  // A network stop outside the rectangle means its line's departure time
  // is read one or more stops down the route – say so rather than let the
  // schedule quietly drift.
  const networkStopsOutside = Object.entries(networkJson.stops ?? {}).filter(
    ([, stop]) => !insideArea(stop.coord[0], stop.coord[1]),
  )
  if (networkStopsOutside.length > 0) {
    console.warn(
      `⚠ ${networkStopsOutside.length} network stops lie outside the ${city.name} network area ` +
        `(${networkStopsOutside
          .slice(0, 5)
          .map(([id, stop]) => `${stop.name} [${id}]`)
          .join(', ')}${networkStopsOutside.length > 5 ? ', …' : ''}) – ` +
        'their lines depart at the first stop inside it.',
    )
  }

  // ---- agency.txt (optional): diagnostic output only -----------------------
  const agencyNames = new Map() // agency_id → name
  if (files['agency.txt']) {
    scanCsv(files['agency.txt'], (get) => {
      agencyNames.set(get('agency_id'), get('agency_name'))
    })
  }

  // ---- routes.txt: routes for the network lines (tram, bus, ferry) ---------
  // Trams/buses are matched via the line number (route_short_name), ferries
  // via that too where the feed numbers them like the network does (Kiel's
  // F1/F2), else via the pier names in route_long_name (Rostock's ferries
  // carry feed-dependent short names). Bus IDs with the collision prefix
  // "B" match their number.
  // Deliberately Germany-wide: the city relevance is established later via
  // the stop coordinates (BBOX filter of the stop_times).
  const routeLine = new Map() // route_id → lineId
  const routeAgency = new Map() // route_id → agency_id (diagnostics)
  const routeTypes = routeTypesForCity(city)
  scanCsv(files['routes.txt'], (get) => {
    const type = get('route_type')
    const short = get('route_short_name')
    for (const [lineId, mode] of networkLines) {
      if (!routeTypes[mode].has(type)) continue
      if (mode === 'ferry') {
        const names = normalizeName(`${short} ${get('route_long_name')}`)
        const targets = ferryTargets.get(lineId) ?? []
        if (
          short === lineId ||
          (targets.length > 0 && targets.some((t) => t.length >= 5 && names.includes(t)))
        ) {
          routeLine.set(get('route_id'), lineId)
          routeAgency.set(get('route_id'), get('agency_id'))
          break
        }
      } else if (
        short === lineId ||
        (mode === 'bus' && lineId.startsWith('B') && short === lineId.slice(1))
      ) {
        routeLine.set(get('route_id'), lineId)
        routeAgency.set(get('route_id'), get('agency_id'))
        break
      }
    }
    if (
      !routeLine.has(get('route_id')) &&
      routeTypes.ferry.has(type) &&
      ferryTargets.size > 0
    ) {
      routeLine.set(get('route_id'), FERRY_PENDING)
      routeAgency.set(get('route_id'), get('agency_id'))
    }
    // S-Bahn routes whose short name carries no line number ("S"): held as
    // pending, classified per trip via the branch stations they serve.
    if (
      !routeLine.has(get('route_id')) &&
      routeTypes.train.has(type) &&
      /^S[0-9]{0,2}$/.test(short) &&
      trainBranchProbes.length > 0 &&
      [...networkLines.values()].includes('train')
    ) {
      routeLine.set(get('route_id'), TRAIN_PENDING)
      routeAgency.set(get('route_id'), get('agency_id'))
    }
  })
  console.log(
    `${routeLine.size} candidate routes (Germany-wide – the city filter follows via the stops)`,
  )

  // Trips of loop-prone lines keep every stop: a ferry loop (Kiel's F2
  // sails Reventlou → Dietrichsdorf → Wellingdorf → Reventlou) is split
  // at its turning point into the two directions the map has, a ring
  // line's round (Berlin's S41) runs the ring in one direction – see
  // classifyLoopTrip. Only those lines, so the memory stays small.
  const ringLines = new Set()
  for (const line of networkJson.lines) {
    const path = line.directions[0]?.path
    if (path && path.length > 2 && metersBetween(path[0], path[path.length - 1]) < 150) ringLines.add(line.id)
  }
  const loopProne = (lineId) =>
    lineId === FERRY_PENDING || networkLines.get(lineId) === 'ferry' || ringLines.has(lineId)

  return {
    slug: city.slug,
    city,
    OUT,
    networkJson,
    networkLines,
    normalizeName,
    cityStopCoords,
    cityStopNames,
    limitsStops,
    trainProbeStops,
    agencyNames,
    routeAgency,
    routeLine,
    ringLines,
    loopProne,
    // Filled by the trips scan
    tripLine: new Map(), // trip_id → lineId, the candidate trips
    tripsWithDirectionId: 0,
    // Filled by the stop_times scan
    firstCityStop: new Map(), // trip_id → {seq, dep, stopId}
    lastCityStop: new Map(), // trip_id → {seq, stopId}
    loopTripStops: new Map(), // trip_id → [{seq, stopId, dep}]
    tripTouchesCity: new Set(),
    tripBranchLine: new Map(), // trip_id → lineId (pending S-Bahn trips)
  }
}

/**
 * ---- trips.txt: the trips of every city's candidate routes ---------------
 * One pass, one record per trip whatever the number of cities that hold
 * it as a candidate (a line number is matched Germany-wide, so most of a
 * city's candidates are other cities' lines): the record is shared, the
 * city keeps only which of its lines the trip is. A city's own copy of
 * the records was 90 MB a city, 1.2 GB for the thirteen.
 */
function scanTrips(trips, collectors) {
  const records = new Map() // trip_id → {routeId, rawDir, serviceId, headsign}
  scanCsv(trips, (get) => {
    const routeId = get('route_id')
    let tripId = null
    let record = null
    for (const collector of collectors) {
      const lineId = collector.routeLine.get(routeId)
      if (!lineId) continue
      if (!record) {
        tripId = own(get('trip_id'))
        record = {
          routeId: own(routeId),
          rawDir: get('direction_id'),
          serviceId: own(get('service_id')),
          headsign: own(get('trip_headsign')),
        }
        records.set(tripId, record)
      }
      collector.tripLine.set(tripId, lineId)
      if (record.rawDir === '0' || record.rawDir === '1') collector.tripsWithDirectionId++
    }
  })
  for (const { city, tripLine, tripsWithDirectionId } of collectors) {
    console.log(
      `  ${city.name}: ${tripLine.size} candidate trips (${tripsWithDirectionId} with direction_id)`,
    )
  }
  return records
}

/** The feed's calendar, read once: which service runs on which day. */
function readCalendar(files) {
  const calendarServices = new Map() // service_id → {days:[sun..sat], start, end}
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
  return { calendarServices, calendarExceptions }
}

/**
 * ---- stop_times.txt: first/last stop WITHIN each city's bbox ------------
 * Departure times and geometry anchors deliberately use the in-box
 * portion of a trip, not its true origin: lines cut at the city limits
 * (a regional train that really starts in the next town, ~40 minutes
 * earlier) must depart the network at their LOCAL time. For trips fully
 * inside the box (every city line) both are identical.
 *
 * One pass for every city: a row is looked up once, in an index of
 * every city's candidate trips, and handed to the cities that hold its
 * trip – a line number is matched Germany-wide, so a trip of "line 5" is
 * a candidate of several cities until their stops tell it apart.
 */
function scanStopTimes(stopTimes, collectors) {
  const owners = new Map() // trip_id → collector, or the collectors sharing it
  for (const collector of collectors) {
    for (const tripId of collector.tripLine.keys()) {
      const held = owners.get(tripId)
      if (!held) owners.set(tripId, collector)
      else if (Array.isArray(held)) held.push(collector)
      else owners.set(tripId, [held, collector])
    }
  }
  let rows = 0
  scanCsv(stopTimes, (get) => {
    rows++
    if (rows % 10_000_000 === 0) console.log(`  … ${rows / 1e6} million rows`)
    const held = owners.get(get('trip_id'))
    if (!held) return
    const tripId = own(get('trip_id'))
    if (Array.isArray(held)) {
      for (const collector of held) noteStopTime(collector, tripId, get)
    } else {
      noteStopTime(held, tripId, get)
    }
  })
  console.log(`Processed ${rows} stop_times rows`)
  for (const { city, tripTouchesCity } of collectors) {
    console.log(`  ${tripTouchesCity.size} ${city.name} trips`)
  }
}

/** One stop_times row of one of the city's candidate trips. */
function noteStopTime(collector, tripId, get) {
  const {
    tripLine,
    trainProbeStops,
    tripBranchLine,
    cityStopCoords: stopsInCity,
    limitsStops,
    tripTouchesCity,
    loopProne,
    loopTripStops,
    firstCityStop,
    lastCityStop,
  } = collector
  const lineId = tripLine.get(tripId)
  const stopId = own(get('stop_id'))
  // Branch classification for pending S-Bahn trips – their probe
  // stations lie OUTSIDE the bbox, so check before the city filter.
  if (lineId === TRAIN_PENDING) {
    const branchLine = trainProbeStops.get(stopId)
    if (branchLine) tripBranchLine.set(tripId, branchLine)
  }
  if (!stopsInCity.has(stopId)) return
  if (limitsStops.has(stopId)) tripTouchesCity.add(tripId)
  const seq = Number(get('stop_sequence'))
  if (loopProne(lineId)) {
    let list = loopTripStops.get(tripId)
    if (!list) loopTripStops.set(tripId, (list = []))
    list.push({ seq, stopId, dep: get('departure_time') })
  }
  const cur = firstCityStop.get(tripId)
  if (!cur || seq < cur.seq) {
    firstCityStop.set(tripId, { seq, dep: get('departure_time'), stopId })
  }
  const last = lastCityStop.get(tripId)
  if (!last || seq > last.seq) {
    lastCityStop.set(tripId, { seq, stopId })
  }
}

/** The schedule of one city, from what the scan collected for it. */
function finishCity(collector, calendar, tripRecords) {
  const {
    city,
    OUT,
    networkJson,
    networkLines,
    normalizeName,
    cityStopCoords,
    cityStopNames,
    agencyNames,
    routeAgency,
    tripLine,
    tripsWithDirectionId,
    ringLines,
    loopProne,
    firstCityStop,
    lastCityStop,
    loopTripStops,
    tripTouchesCity,
    tripBranchLine,
  } = collector

  // The city's trips with everything known about them – only the ones
  // that touch the city, which is all the code below ever asks for
  const tripInfo = new Map() // trip_id → {lineId, routeId, rawDir, serviceId, headsign}
  for (const tripId of tripTouchesCity) {
    tripInfo.set(tripId, { lineId: tripLine.get(tripId), ...tripRecords.get(tripId) })
  }

  // ---- Resolve pending ferry routes via terminal coordinates ---------------
  // A ferry trip belongs to a network ferry line when its first and last
  // stop each lie within 400 m of the line's two piers (in either order).
  {
    const ferryPiers = []
    for (const line of networkJson.lines) {
      if ((line.mode ?? 'tram') !== 'ferry') continue
      const stops = line.directions[0].stops
      const first = networkJson.stops[stops[0]]?.coord
      const last = networkJson.stops[stops[stops.length - 1]]?.coord
      if (first && last) ferryPiers.push({ lineId: line.id, first, last })
    }
    const resolvedPerLine = new Map()
    for (const tripId of [...tripTouchesCity]) {
      const info = tripInfo.get(tripId)
      if (info.lineId !== FERRY_PENDING) continue
      const from = cityStopCoords.get(firstCityStop.get(tripId)?.stopId)
      const to = cityStopCoords.get(lastCityStop.get(tripId)?.stopId)
      let assigned = null
      if (from && to) {
        for (const pier of ferryPiers) {
          const forward =
            metersBetween(from, pier.first) < 400 && metersBetween(to, pier.last) < 400
          const reverse =
            metersBetween(from, pier.last) < 400 && metersBetween(to, pier.first) < 400
          if (forward || reverse) {
            assigned = pier.lineId
            break
          }
        }
      }
      if (assigned) {
        info.lineId = assigned
        resolvedPerLine.set(assigned, (resolvedPerLine.get(assigned) ?? 0) + 1)
      } else {
        // Some other ferry that happens to touch the bounding box
        tripTouchesCity.delete(tripId)
        tripInfo.delete(tripId)
      }
    }
    for (const [lineId, count] of [...resolvedPerLine.entries()].sort()) {
      console.log(`  Ferry line ${lineId}: ${count} trips matched via pier coordinates`)
    }
  }

  // ---- Resolve pending S-Bahn trips via their branch stations --------------
  {
    const resolvedPerLine = new Map()
    let droppedTrainTrips = 0
    for (const tripId of [...tripTouchesCity]) {
      const info = tripInfo.get(tripId)
      if (info.lineId !== TRAIN_PENDING) continue
      const branchLine = tripBranchLine.get(tripId)
      if (branchLine && networkLines.has(branchLine)) {
        info.lineId = branchLine
        resolvedPerLine.set(branchLine, (resolvedPerLine.get(branchLine) ?? 0) + 1)
      } else {
        // No branch station served (e.g. a short working entirely inside
        // the box) – the line number cannot be told, so stay honest and
        // drop the trip rather than guessing.
        droppedTrainTrips++
        tripTouchesCity.delete(tripId)
        tripInfo.delete(tripId)
      }
    }
    for (const [lineId, count] of [...resolvedPerLine.entries()].sort()) {
      console.log(`  S-Bahn line ${lineId}: ${count} trips matched via branch stations`)
    }
    if (droppedTrainTrips > 0) {
      console.warn(`  ⚠ ${droppedTrainTrips} S-Bahn trips without an identifiable branch dropped`)
    }
  }

  if (tripTouchesCity.size === 0) {
    throw new Error(
      `No ${city.name} trips found in the feed. ` +
        'Check GTFS_URL – or use the transport association\'s own feed via GTFS_FILE.',
    )
  }

  // ---- Pick a service day and include ALL services active on it ------------
  // Important: feeds often spread a line's trips (even the two directions!)
  // across multiple service_ids. Picking a single service_id therefore loses
  // trips – instead a concrete service day is chosen and every service_id
  // active on that date counts.
  const { calendarServices, calendarExceptions } = calendar

  const isServiceActiveOn = (serviceId, dateStr, weekday) => {
    const exception = calendarExceptions.get(`${serviceId}|${dateStr}`)
    if (exception === '2') return false
    if (exception === '1') return true
    const cal = calendarServices.get(serviceId)
    if (!cal) return false
    return dateStr >= cal.start && dateStr <= cal.end && cal.days[weekday]
  }

  const cityServiceIds = new Set(
    [...tripTouchesCity].map((tripId) => tripInfo.get(tripId).serviceId),
  )

  let activeServiceIds
  let serviceDate = null
  if (calendarServices.size > 0 || calendarExceptions.size > 0) {
    // Try the next 21 days; the day with the most active city trips wins
    // (ties go to the earlier day).
    let best = { count: -1, date: null, services: new Set() }
    for (let offset = 0; offset < 21; offset++) {
      const day = new Date(Date.now() + offset * 86400_000)
      const dateStr =
        String(day.getFullYear()) +
        String(day.getMonth() + 1).padStart(2, '0') +
        String(day.getDate()).padStart(2, '0')
      const weekday = day.getDay()
      const services = new Set(
        [...cityServiceIds].filter((id) => isServiceActiveOn(id, dateStr, weekday)),
      )
      let count = 0
      for (const tripId of tripTouchesCity) {
        if (services.has(tripInfo.get(tripId).serviceId)) count++
      }
      if (count > best.count) best = { count, date: dateStr, services }
    }
    activeServiceIds = best.services
    serviceDate = best.date
    console.log(
      `Chosen service day: ${serviceDate} (${best.count} trips, ${activeServiceIds.size} active services)`,
    )
    if (process.env.SERVICE_DAY_LOG) {
      appendFileSync(process.env.SERVICE_DAY_LOG, `${city.slug}: ${serviceDate} (${best.count} trips)\n`)
    }
  } else {
    // Fallback without calendar data: the single busiest service_id
    const tripsPerService = new Map()
    for (const tripId of tripTouchesCity) {
      const info = tripInfo.get(tripId)
      tripsPerService.set(info.serviceId, (tripsPerService.get(info.serviceId) || 0) + 1)
    }
    const [serviceId] = [...tripsPerService.entries()].sort((a, b) => b[1] - a[1])[0]
    activeServiceIds = new Set([serviceId])
    console.warn(
      `⚠ No calendar data in the feed – using the busiest service_id ${serviceId}`,
    )
  }

  // ---- Diagnostics: which operators are behind the city's trips? -----------
  // More than one operator per line suggests a number collision
  // (e.g. a city bus and a regional bus with the same number in the city area).
  {
    const lineAgencies = new Map() // lineId → Map<agencyName, count>
    for (const tripId of tripTouchesCity) {
      const info = tripInfo.get(tripId)
      const name =
        agencyNames.get(routeAgency.get(info.routeId) ?? '') ||
        routeAgency.get(info.routeId) ||
        'unknown'
      const perLine = lineAgencies.get(info.lineId) ?? new Map()
      perLine.set(name, (perLine.get(name) ?? 0) + 1)
      lineAgencies.set(info.lineId, perLine)
    }
    for (const [lineId, perLine] of [...lineAgencies.entries()].sort()) {
      const parts = [...perLine.entries()].map(([n, c]) => `${n} (${c})`)
      const marker = perLine.size > 1 ? '⚠' : ' '
      console.log(`  ${marker} Line ${lineId}: ${parts.join(', ')}`)
    }
  }

  // ---- Direction assignment: GTFS trip ↔ network direction -----------------
  // Goal: assign each trip to direction 0 or 1 from network.json.
  //
  // Primarily via the TRAVEL DIRECTION along the line geometry: the trip's
  // first and last stop are projected onto the path of direction 0 – if the
  // distance grows, the vehicle travels in direction 0, otherwise in
  // direction 1. This is correct even for short workings and
  // construction-site termini (comparing against the nearest terminus would
  // not be: if a trip ends in the city center due to construction, it is
  // almost always closer to the "wrong" terminus). Secondary: trip_headsign.
  const dirTargets = {}
  try {
    const cumulativeMeters = (path) => {
      const cum = [0]
      for (let i = 1; i < path.length; i++) {
        const [lon1, lat1] = path[i - 1]
        const [lon2, lat2] = path[i]
        const cosLat = Math.cos((lat1 * Math.PI) / 180)
        cum.push(
          cum[i - 1] +
            Math.hypot((lon2 - lon1) * cosLat * 111320, (lat2 - lat1) * 110540),
        )
      }
      return cum
    }
    for (const line of networkJson.lines) {
      const d0 = line.directions[0]
      const d1 = line.directions[1]
      const cum = cumulativeMeters(d0.path)
      // Direction 1 geometry for span projection: its own path if the line
      // has one, otherwise the mirrored direction 0 (as prepareNetwork does).
      const path1 = d1?.path ?? [...d0.path].reverse()
      dirTargets[line.id] = {
        to0: normalizeName(d0.to),
        to1: normalizeName(d1?.to ?? d0.from),
        path: d0.path,
        cum,
        geo1: { path: path1, cum: cumulativeMeters(path1) },
      }
    }
  } catch {
    console.warn('⚠ network.json not readable – direction heuristic limited')
  }

  /** Along-path distance of the nearest point on the path (meters). */
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

  /** Classifies a trip as direction '0' | '1' | null (ambiguous). */
  const classifyTrip = (tripId, info) => {
    const targets = dirTargets[info.lineId]
    if (!targets) return null
    const stats = (classifyStats[info.lineId] ??= { path: 0, headsign: 0, skipped: 0 })

    // 1) Travel direction along the line geometry
    const firstCoord = cityStopCoords.get(firstCityStop.get(tripId)?.stopId)
    const lastCoord = cityStopCoords.get(lastCityStop.get(tripId)?.stopId)
    if (firstCoord && lastCoord && targets.path) {
      const a = projectOntoPath(targets.path, targets.cum, firstCoord)
      const b = projectOntoPath(targets.path, targets.cum, lastCoord)
      // Enough route between the projections so the direction is
      // unambiguous: ~400 m, but capped at 40 % of the line length – a
      // harbor ferry crossing can be shorter than 400 m in total.
      const total = targets.cum[targets.cum.length - 1]
      if (Math.abs(b - a) > Math.min(400, total * 0.4)) {
        stats.path++
        return b > a ? '0' : '1'
      }
    }

    // 2) Compare headsign names
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

  /**
   * Along-route section [startMeters, endMeters] a trip serves on its
   * direction's path, or null for (effectively) the full route. Short
   * workings (Verstärker) start/end mid-route – without the span the
   * simulation would run them across the entire line and bunch phantom
   * vehicles near the terminus (observed: line 5 trips departing
   * Hamburger Straße/Platz der Jugend rendered as extra full-route trams).
   */
  const computeTripSpan = (tripId, info, direction) => {
    const targets = dirTargets[info.lineId]
    if (!targets) return null
    const geo = direction === '1' ? targets.geo1 : { path: targets.path, cum: targets.cum }
    if (!geo?.path || geo.path.length < 2) return null
    const firstCoord = cityStopCoords.get(firstCityStop.get(tripId)?.stopId)
    const lastCoord = cityStopCoords.get(lastCityStop.get(tripId)?.stopId)
    if (!firstCoord || !lastCoord) return null
    const start = projectOntoPath(geo.path, geo.cum, firstCoord)
    const end = projectOntoPath(geo.path, geo.cum, lastCoord)
    const total = geo.cum[geo.cum.length - 1]
    // Projection disagrees with the classified direction – stay conservative
    if (!(end - start > 400)) return null
    // Covers (almost) the whole line – no span needed
    if (start < 250 && end > total - 250) return null
    return [Math.round(start), Math.round(end)]
  }

  /**
   * A trip that ends where it began. On a ring line (the path itself is
   * closed – Berlin's S41/S42) it is one round in the sense the trip runs
   * it, read off a stop a quarter of the way in. On a ferry line it is
   * two directions of the map's line: out to the pier farthest from the
   * start, back from there. The departures are returned, or null for a
   * trip that is no loop.
   */
  const classifyLoopTrip = (tripId, info) => {
    const targets = dirTargets[info.lineId]
    const stopsOfTrip = loopTripStops.get(tripId)
    if (!targets?.path || !stopsOfTrip || stopsOfTrip.length < 3) return null
    const sorted = [...stopsOfTrip].sort((a, b) => a.seq - b.seq)
    const first = cityStopCoords.get(sorted[0].stopId)
    const last = cityStopCoords.get(sorted[sorted.length - 1].stopId)
    if (!first || !last || metersBetween(first, last) > 100) return null
    if (!sorted[0].dep) return null
    const stats = (classifyStats[info.lineId] ??= { path: 0, headsign: 0, skipped: 0 })
    if (ringLines.has(info.lineId)) {
      const quarter = cityStopCoords.get(sorted[Math.floor(sorted.length / 4)].stopId)
      if (!quarter) return null
      const start = projectOntoPath(targets.path, targets.cum, first)
      const along = projectOntoPath(targets.path, targets.cum, quarter)
      const total = targets.cum[targets.cum.length - 1]
      // Distance run from the start, going the way of the path
      const run = (along - start + total) % total
      stats.path++
      return [{ direction: run < total / 2 ? '0' : '1', sec: timeToSeconds(sorted[0].dep) }]
    }
    let turn = null
    let farthest = 0
    for (const stop of sorted) {
      const coord = cityStopCoords.get(stop.stopId)
      const meters = coord ? metersBetween(first, coord) : 0
      if (meters > farthest) {
        farthest = meters
        turn = stop
      }
    }
    if (!turn?.dep) return null
    const a = projectOntoPath(targets.path, targets.cum, first)
    const b = projectOntoPath(targets.path, targets.cum, cityStopCoords.get(turn.stopId))
    const out = b > a ? '0' : '1'
    stats.path += 2
    return [
      { direction: out, sec: timeToSeconds(sorted[0].dep) },
      { direction: out === '0' ? '1' : '0', sec: timeToSeconds(turn.dep) },
    ]
  }

  const useDirectionId = tripsWithDirectionId > 0

  // If direction_id is present: check whether it matches the network's
  // orientation (collect votes via the coordinate-based classification).
  let directionIdSwapped = false
  if (useDirectionId) {
    let identity = 0
    let swapped = 0
    for (const tripId of tripTouchesCity) {
      const info = tripInfo.get(tripId)
      if (!activeServiceIds.has(info.serviceId)) continue
      const cls = classifyTrip(tripId, info)
      if (cls === null || (info.rawDir !== '0' && info.rawDir !== '1')) continue
      if (cls === info.rawDir) identity++
      else swapped++
    }
    directionIdSwapped = swapped > identity
  }

  // ---- Write schedule.json --------------------------------------------------
  const lines = {}
  let unclassified = 0
  for (const tripId of tripTouchesCity) {
    const info = tripInfo.get(tripId)
    if (!activeServiceIds.has(info.serviceId)) continue
    const first = firstCityStop.get(tripId)
    if (!first?.dep) continue

    const loop = loopProne(info.lineId) ? classifyLoopTrip(tripId, info) : null
    if (loop) {
      for (const leg of loop) {
        lines[info.lineId] ??= {}
        lines[info.lineId][leg.direction] ??= { pairs: [] }
        lines[info.lineId][leg.direction].pairs.push({ sec: leg.sec, tripId, span: null })
      }
      continue
    }

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
    const span = computeTripSpan(tripId, info, direction)
    lines[info.lineId] ??= {}
    lines[info.lineId][direction] ??= { pairs: [] }
    lines[info.lineId][direction].pairs.push({ sec, tripId, span })
  }
  // Sort, deduplicate per departure time + served section, and store the
  // GTFS trip_ids in parallel (needed at runtime for GTFS-Realtime
  // matching). The span is part of the key: a full-route trip and a short
  // working can legitimately depart at the same second. A 50 m grid absorbs
  // projection jitter between duplicated feed entries of the same trip.
  for (const line of Object.values(lines)) {
    for (const dir of Object.values(line)) {
      const spanKey = (p) =>
        p.span ? `${Math.round(p.span[0] / 50)}:${Math.round(p.span[1] / 50)}` : 'full'
      const seen = new Set()
      const unique = dir.pairs
        .sort((a, b) => a.sec - b.sec || (a.span?.[0] ?? -1) - (b.span?.[0] ?? -1))
        .filter((p) => {
          const key = `${p.sec}|${spanKey(p)}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      dir.departures = unique.map((p) => p.sec)
      dir.tripIds = unique.map((p) => p.tripId)
      // Only written when the direction has short workings at all
      if (unique.some((p) => p.span)) dir.spans = unique.map((p) => p.span ?? null)
      delete dir.pairs
    }
  }
  if (unclassified > 0) {
    console.warn(`⚠ Skipped ${unclassified} trips without a clear direction`)
  }

  // Classification overview (detailed diagnostics with GTFS_DEBUG=1)
  for (const [lineId, stats] of Object.entries(classifyStats)) {
    console.log(
      `  Line ${lineId}: ${stats.path}× by travel direction, ${stats.headsign}× by headsign, ${stats.skipped}× skipped`,
    )
  }
  if (process.env.GTFS_DEBUG) {
    const endpoints = {} // lineId → dir → Map<"from → to", count>
    for (const tripId of tripTouchesCity) {
      const info = tripInfo.get(tripId)
      if (!activeServiceIds.has(info.serviceId)) continue
      const direction = classifyTrip(tripId, info)
      const from = cityStopNames.get(firstCityStop.get(tripId)?.stopId) ?? '?'
      const to = cityStopNames.get(lastCityStop.get(tripId)?.stopId) ?? '?'
      const key = `${from} → ${to}`
      endpoints[info.lineId] ??= {}
      const dirMap = (endpoints[info.lineId][direction ?? 'skipped'] ??= new Map())
      dirMap.set(key, (dirMap.get(key) ?? 0) + 1)
    }
    for (const [lineId, dirs] of Object.entries(endpoints)) {
      console.log(`  [DEBUG] Line ${lineId}:`)
      for (const [dir, dirMap] of Object.entries(dirs)) {
        const top = [...dirMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        console.log(`    Direction ${dir}:`)
        for (const [key, count] of top) console.log(`      ${count}× ${key}`)
      }
    }
  }

  const linesWithoutData = Object.keys(dirTargets).filter((id) => !lines[id])
  const noteParts = [
    useDirectionId
      ? `Directions taken from direction_id${directionIdSwapped ? ' (globally swapped)' : ''}.`
      : 'Feed without direction_id – directions assigned via terminal stop coordinates/headsigns.',
  ]
  if (unclassified > 0) noteParts.push(`Skipped ${unclassified} trips without a clear direction.`)
  if (linesWithoutData.length > 0) {
    noteParts.push(
      `No GTFS departures for line(s) ${linesWithoutData.join(', ')} – they stay off the map (not running that day).`,
    )
  }

  const schedule = {
    meta: {
      source: 'gtfs',
      serviceCount: activeServiceIds.size,
      attribution:
        'Timetable data from GTFS (gtfs.de / DELFI or VVW). Observe the source’s terms of use.',
      note: noteParts.join(' '),
    },
    lines,
  }

  writeFileSync(OUT, JSON.stringify(schedule, null, 2) + '\n', 'utf8')
  const summary = Object.entries(lines)
    .map(
      ([id, dirs]) =>
        `${id}: ${Object.values(dirs).reduce((n, d) => n + d.departures.length, 0)} departures`,
    )
    .join(', ')
  console.log(`\n✅ Wrote ${OUT} – ${summary}`)
}

// Only run as a CLI – the tests import routeTypesForCity without pulling
// a 280 MB feed over the wire.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
