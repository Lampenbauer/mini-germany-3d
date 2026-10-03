/**
 * The sky's recording: the air traffic of the last five days, recorded
 * by a keeper as it polls and replayed by the app when the clock is set
 * into the past – the harbour's archive (ais-archive.ts) for the
 * aircraft, on the same hour files (archive-hours.ts).
 *
 * What differs is the source. aisstream pushes a message per fix and the
 * keeper records what it hears; adsb.fi answers a poll with every
 * aircraft in a circle, and the keeper polls ONE circle that covers every
 * city (adsbCoverQuery – adsb.fi allows one request a second for all of
 * them together, so a circle per city every few seconds is out of reach)
 * every AIRCRAFT_KEEPER_INTERVAL_MS and records, per city, the fixes
 * that moved on since the last poll. That interval is the recording's
 * resolution: the live sky is polled every few seconds and interpolated
 * between fixes, the replay interpolates between fixes ten seconds
 * apart, which at cruise is a straight two kilometres and on final a
 * gentle chord through the turn. The live per-city polls (the endpoint's
 * other job) do not record: two writers on one file would double its
 * density while a city is watched and leave the rest thin.
 *
 * Two line shapes, both JSON, one per line:
 *   [hex, unix ms, lat, lon, altGeomM, altBaroM, gsKn, trackDeg,
 *    headingDeg, verticalRateMps, rollDeg, onGround]           a fix
 *   {"hex":…,"callsign":…,"registration":…,"typeCode":…,
 *    "description":…,"category":…,"squawk":…,"source":…}       the
 *                                     aircraft's static data, whenever
 *                                     it changes (and once per snapshot)
 *
 * The replay renders the way the live traffic does: the app hands the
 * layer the aircraft as of the simulated moment and that moment as its
 * clock, and the layer samples AIRCRAFT_PLAYBACK_DELAY_MS behind it,
 * between the recorded fixes. Where the recording says nothing – a day
 * before it began, a minute the keeper missed – the sky is empty;
 * nothing is invented.
 */

import {
  HourArchiveClient,
  archiveOldestKept,
  archiveHourKey,
  lastFixAtOrBefore,
  parseArchiveChunk as parseChunk,
  replayWanted,
  type ArchiveHourStatus,
  type ArchiveStore,
} from './archive-hours.ts'
import {
  ADSB_MAX_DIST_NM,
  AIRCRAFT_EXPIRE_MS,
  AIRCRAFT_PLAYBACK_DELAY_MS,
  aircraftStateList,
  mergeAdsbAircraft,
  withinQuery,
  type AdsbQuery,
  type AdsbRawAircraft,
  type AdsbRawResponse,
  type Aircraft,
  type AircraftState,
  type AircraftTrackPoint,
} from './aircraft-extract.ts'

/**
 * How often the keeper polls the cover circle – the recording's
 * resolution, see above. Mirror of MG3D_AIRCRAFT_KEEPER_INTERVAL_SECONDS.
 */
export const AIRCRAFT_KEEPER_INTERVAL_MS = 10_000

/** The sky switches to the recording at the same edge the harbour does. */
export function aircraftReplayWanted(simMs: number, nowMs: number): boolean {
  return replayWanted(simMs, nowMs)
}

/**
 * One recorded fix: [hex, unix ms, lat, lon, altGeomM, altBaroM, gsKn,
 * trackDeg, headingDeg, verticalRateMps, rollDeg, onGround] – the
 * record's kinematics as of that moment, nulls as in the record.
 */
export type AircraftArchiveFix = [
  string,
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  boolean,
]

/** An aircraft's static data as the archive keeps it – the fields no fix carries. */
export interface AircraftArchiveStatic {
  hex: string
  callsign: string
  registration: string
  typeCode: string
  description: string
  category: string
  squawk: string
  source: Aircraft['source']
}

export type AircraftArchiveLine = AircraftArchiveFix | AircraftArchiveStatic

// ---------------------------------------------------------------------------
// The cover circle – the twin of mg3d_aircraft_cover_query in aircraft.php
// ---------------------------------------------------------------------------

const METERS_PER_NM = 1852

/** Great-circle distance in metres, as aircraft-extract.ts computes it. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a))
}

/**
 * The one circle the keeper polls: centred between the outermost city
 * circles, reaching the far edge of the furthest one. adsb.fi answers
 * for at most ADSB_MAX_DIST_NM; the radius is not clamped to it here,
 * so a city that would fall outside is noticed (tests/aircraft-archive
 * pins the current cover under the cap) rather than silently left out
 * of the recording. Ten-thousandths, rounded as PHP rounds them.
 */
export function adsbCoverQuery(queries: readonly AdsbQuery[]): AdsbQuery {
  if (queries.length === 0) return { lat: 0, lon: 0, distNm: 0 }
  let south = Infinity
  let north = -Infinity
  let west = Infinity
  let east = -Infinity
  for (const query of queries) {
    south = Math.min(south, query.lat)
    north = Math.max(north, query.lat)
    west = Math.min(west, query.lon)
    east = Math.max(east, query.lon)
  }
  const tenThousandths = (value: number) => Math.floor(value * 10_000 + 0.5) / 10_000
  const lat = tenThousandths((south + north) / 2)
  const lon = tenThousandths((west + east) / 2)
  let distNm = 0
  for (const query of queries) {
    distNm = Math.max(distNm, haversineMeters(lat, lon, query.lat, query.lon) / METERS_PER_NM + query.distNm)
  }
  return { lat, lon, distNm: Math.ceil(distNm) }
}

/** Whether the cover circle is one adsb.fi will answer for. */
export function coverWithinLimit(cover: AdsbQuery): boolean {
  return cover.distNm <= ADSB_MAX_DIST_NM
}

// ---------------------------------------------------------------------------
// Writing – the twin of mg3d_aircraft_archive_record in aircraft.php
// ---------------------------------------------------------------------------

export interface AircraftArchiveCity {
  slug: string
  /** The circle the city's sky is served from (adsbQuery of its box). */
  query: AdsbQuery
}

function staticOf(aircraft: Aircraft): AircraftArchiveStatic {
  return {
    hex: aircraft.hex,
    callsign: aircraft.callsign,
    registration: aircraft.registration,
    typeCode: aircraft.typeCode,
    description: aircraft.description,
    category: aircraft.category,
    squawk: aircraft.squawk,
    source: aircraft.source,
  }
}

/** The aircraft's last fix as a line – the record's own fields are that fix. */
function fixOf(aircraft: Aircraft): AircraftArchiveFix {
  return [
    aircraft.hex,
    aircraft.positionAt,
    aircraft.lat,
    aircraft.lon,
    aircraft.altGeomM,
    aircraft.altBaroM,
    aircraft.gsKn,
    aircraft.trackDeg,
    aircraft.headingDeg,
    aircraft.verticalRateMps,
    aircraft.rollDeg,
    aircraft.onGround,
  ]
}

function staticSignature(aircraft: Aircraft): string {
  return JSON.stringify(staticOf(aircraft))
}

/**
 * The lines an hour file opens with: every aircraft with a fresh position
 * inside the city's circle, sorted by address, its static data and its
 * last fix. Also what the tests and the parity script build their
 * expectations from.
 */
export function aircraftArchiveSnapshot(state: AircraftState, nowMs: number, query: AdsbQuery): string {
  let text = ''
  for (const aircraft of aircraftStateList(state, nowMs)) {
    if (!withinQuery(aircraft.lat, aircraft.lon, query)) continue
    text += `${JSON.stringify(staticOf(aircraft))}\n${JSON.stringify(fixOf(aircraft))}\n`
  }
  return text
}

/** A finite number from the feed, or null – as mergeAdsbResponse reads seen_pos. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class AircraftArchiveWriter {
  private readonly store: ArchiveStore
  private readonly cities: readonly AircraftArchiveCity[]

  // No parameter properties: the parity script runs this module through
  // Node's type stripping, which erases types only.
  constructor(store: ArchiveStore, cities: readonly AircraftArchiveCity[]) {
    this.store = store
    this.cities = cities
  }

  /**
   * Folds one poll's answer into the state (mergeAdsbAircraft per entry,
   * stamped as mergeAdsbResponse stamps it) and records what it changed:
   * per aircraft the fix it carried when that is newer than the last, and
   * the static data when that is new – into every city whose circle holds
   * the aircraft. A city whose hour file does not exist yet gets the
   * snapshot instead – taken after the whole answer is merged, so it
   * already holds every aircraft's newest fix, and the answer's own lines
   * are not written twice – and its files older than the retention go.
   */
  record(state: AircraftState, raw: AdsbRawResponse, nowMs: number): void {
    const changed: { aircraft: Aircraft; lines: string }[] = []
    for (const entry of Array.isArray(raw.ac) ? raw.ac : []) {
      if (typeof entry !== 'object' || entry === null) continue
      const hex = hexOf(entry)
      if (hex === null) continue
      const before = state.get(hex)
      const beforePositionAt = before?.positionAt ?? 0
      const beforeStatic = before ? staticSignature(before) : null
      const seenPos = num(entry.seen_pos) ?? 0
      mergeAdsbAircraft(state, entry, nowMs - Math.floor(seenPos * 1000 + 0.5))
      const aircraft = state.get(hex)
      if (!aircraft) continue
      let lines = ''
      if (staticSignature(aircraft) !== beforeStatic) lines += `${JSON.stringify(staticOf(aircraft))}\n`
      if (aircraft.positionAt !== beforePositionAt) lines += `${JSON.stringify(fixOf(aircraft))}\n`
      if (lines !== '') changed.push({ aircraft, lines })
    }
    if (changed.length === 0) return

    const hourKey = archiveHourKey(nowMs)
    for (const city of this.cities) {
      let text = ''
      for (const { aircraft, lines } of changed) {
        if (withinQuery(aircraft.lat, aircraft.lon, city.query)) text += lines
      }
      if (text === '') continue
      if (this.store.has(city.slug, hourKey)) {
        this.store.append(city.slug, hourKey, text)
        continue
      }
      this.store.prune(city.slug, archiveOldestKept(nowMs))
      this.store.append(city.slug, hourKey, aircraftArchiveSnapshot(state, nowMs, city.query))
    }
  }
}

/** The address an entry is filed under, as mergeAdsbAircraft reads it; null where it takes nothing. */
function hexOf(entry: AdsbRawAircraft): string | null {
  const hex = typeof entry.hex === 'string' ? entry.hex.trim().toLowerCase() : ''
  return /^~?[0-9a-f]{6}$/.test(hex) ? hex : null
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The lines of the sky's recording in a chunk of an hour file – see archive-hours.ts. */
export function parseAircraftArchiveChunk(bytes: Uint8Array): { lines: AircraftArchiveLine[]; consumed: number } {
  return parseChunk(bytes, isAircraftArchiveLine)
}

export function isAircraftArchiveLine(line: unknown): line is AircraftArchiveLine {
  return isFix(line) || isStatic(line)
}

function isFix(line: unknown): line is AircraftArchiveFix {
  return (
    Array.isArray(line) &&
    line.length === 12 &&
    typeof line[0] === 'string' &&
    typeof line[1] === 'number' &&
    typeof line[2] === 'number' &&
    typeof line[3] === 'number'
  )
}

function isStatic(line: unknown): line is AircraftArchiveStatic {
  return (
    typeof line === 'object' &&
    line !== null &&
    !Array.isArray(line) &&
    typeof (line as AircraftArchiveStatic).hex === 'string'
  )
}

interface ReplayAircraft {
  static: AircraftArchiveStatic | null
  /** Sorted by time, no two at the same instant. */
  fixes: AircraftArchiveFix[]
}

/**
 * The recording in memory, per aircraft, answering with the traffic as
 * of a moment. Lines go in in file order – hours in order, each hour's
 * snapshot first – so a fix is almost always appended; the snapshot that
 * opens an hour repeats the last fix of the hour before, and a repeat is
 * dropped by its time stamp.
 */
export class AircraftReplay {
  private readonly aircraft = new Map<string, ReplayAircraft>()

  clear(): void {
    this.aircraft.clear()
  }

  add(lines: readonly AircraftArchiveLine[]): void {
    for (const line of lines) {
      const hex = Array.isArray(line) ? line[0] : line.hex
      let entry = this.aircraft.get(hex)
      if (!entry) {
        entry = { static: null, fixes: [] }
        this.aircraft.set(hex, entry)
      }
      if (!Array.isArray(line)) {
        entry.static = line
        continue
      }
      const fixes = entry.fixes
      const last = fixes[fixes.length - 1]
      if (!last || line[1] > last[1]) {
        fixes.push(line)
        continue
      }
      const at = lastFixAtOrBefore(fixes, line[1])
      if (at >= 0 && fixes[at][1] === line[1]) continue
      fixes.splice(at + 1, 0, line)
    }
  }

  /**
   * The traffic as of `atMs`, in the shape the live poll delivers it:
   * every aircraft with a fix in the AIRCRAFT_EXPIRE_MS before that
   * moment, its fields those of that last fix, its track the fixes
   * around the instant the layer samples (AIRCRAFT_PLAYBACK_DELAY_MS
   * behind): from the one at or before it to the one after the last
   * fix before `atMs` – one fix past the moment, because the recording
   * is coarser than the delay and the sampler interpolates between the
   * fix before its instant and the one after. An aircraft whose first
   * fix lies after `atMs` is not in the sky yet.
   */
  aircraftAt(atMs: number): Aircraft[] {
    const renderMs = atMs - AIRCRAFT_PLAYBACK_DELAY_MS
    const list: Aircraft[] = []
    for (const [hex, entry] of this.aircraft) {
      const fixes = entry.fixes
      const at = lastFixAtOrBefore(fixes, atMs)
      if (at < 0 || atMs - fixes[at][1] > AIRCRAFT_EXPIRE_MS) continue
      const from = Math.max(0, lastFixAtOrBefore(fixes, renderMs))
      const to = Math.min(fixes.length - 1, at + 1)
      const track: AircraftTrackPoint[] = []
      for (let i = from; i <= to; i++) {
        const fix = fixes[i]
        track.push([fix[1], fix[2], fix[3], fix[4] ?? fix[5], fix[6], fix[7], fix[9], fix[8], fix[4] !== null])
      }
      const fix = fixes[at]
      const statics = entry.static
      list.push({
        hex,
        callsign: statics?.callsign ?? '',
        registration: statics?.registration ?? '',
        typeCode: statics?.typeCode ?? '',
        description: statics?.description ?? '',
        category: statics?.category ?? '',
        lat: fix[2],
        lon: fix[3],
        altGeomM: fix[4],
        altBaroM: fix[5],
        onGround: fix[11],
        gsKn: fix[6],
        trackDeg: fix[7],
        headingDeg: fix[8],
        verticalRateMps: fix[9],
        rollDeg: fix[10],
        squawk: statics?.squawk ?? '',
        source: statics?.source ?? 'other',
        positionAt: fix[1],
        track,
      })
    }
    return list.sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0))
  }
}

// ---------------------------------------------------------------------------
// The client – the shared one, answering with aircraft
// ---------------------------------------------------------------------------

export type AircraftArchiveHourStatus = ArchiveHourStatus

export interface AircraftArchiveClientOptions {
  fetch?: typeof fetch
}

/**
 * Keeps the hours around the simulated moment loaded from the aircraft
 * endpoint (HourArchiveClient in archive-hours.ts does the fetching) and
 * answers with the traffic as of that moment.
 */
export class AircraftArchiveClient {
  private readonly client: HourArchiveClient<AircraftArchiveLine>
  private readonly replay = new AircraftReplay()

  constructor(url: string, options: AircraftArchiveClientOptions = {}) {
    this.client = new HourArchiveClient<AircraftArchiveLine>(url, {
      isLine: isAircraftArchiveLine,
      replay: this.replay,
      playbackDelayMs: AIRCRAFT_PLAYBACK_DELAY_MS,
      fetch: options.fetch,
    })
  }

  /** Keeps the hours the moment needs on hand – every simulation tick. */
  follow(simMs: number, nowMs = Date.now()): void {
    this.client.follow(simMs, nowMs)
  }

  /** Whether the hour of the moment has been answered for, so that `aircraftAt` says something. */
  ready(simMs: number): boolean {
    return this.client.ready(simMs)
  }

  /** The traffic as of the moment, from whatever hours are loaded. */
  aircraftAt(simMs: number): Aircraft[] {
    return this.replay.aircraftAt(simMs)
  }

  /** Which hours are held and how – for the debug API and the tests. */
  status(): AircraftArchiveHourStatus[] {
    return this.client.status()
  }

  stop(): void {
    this.client.stop()
  }
}
