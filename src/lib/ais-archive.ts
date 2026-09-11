/**
 * The AIS archive: the harbour traffic of the last three days, recorded
 * by the keeper as it listens and replayed by the app when the clock is
 * set into the past.
 *
 * The live path already plays the fleet back – AIS_PLAYBACK_DELAY_MS
 * behind the wall clock, between recorded fixes (ais-extract.ts) – but
 * its tracks are pruned after ten minutes. The archive is those tracks
 * kept: one file per city and UTC hour (`<slug>/2026-09-11T09.ndjson`),
 * a line per fix as it was heard, written by the dev middleware
 * (vite.config.ts) and by its PHP twin in server/api/ais.php – the
 * parity script scripts/test-ais-archive-parity.mjs holds both to the
 * same output. Each hour file opens with a snapshot of every ship alive
 * at that moment (her static data and her last fix), so an hour can be
 * read on its own: a ship moored since the morning is placed by the
 * snapshot, not by scanning back through the night.
 *
 * Two line shapes, both JSON, one per line:
 *   [mmsi, unix ms, lat, lon, sogKn, cogDeg, headingDeg, navStatus]  a fix
 *   {"mmsi":…,"name":…,"typeCode":…,"lengthM":…,"widthM":…,"draughtM":…}
 *                                     the vessel's static data, whenever
 *                                     it changes (and once per snapshot)
 *
 * The replay renders the same way the live fleet does: the app hands the
 * layer the fleet as of the simulated moment and that moment as its
 * clock, and the layer samples AIS_PLAYBACK_DELAY_MS behind it. The
 * delay is kept on purpose – it is what makes the two sources meet: a
 * clock that runs into the past from the present, or stands paused
 * until the present has moved on, hands the picture over between them
 * without a jump. Where the recording says nothing – a day before the
 * archive began, an hour the keeper did not hear – the harbour is
 * empty; nothing is invented (see aisReplayWanted for the rule).
 */

import {
  AIS_EXPIRE_MS,
  AIS_PLAYBACK_DELAY_MS,
  aisStateVessels,
  mergeAisMessage,
  type AisRawMessage,
  type AisState,
  type AisTrackPoint,
  type AisVessel,
} from './ais-extract.ts'
import { containsLonLat, type BoundingBox } from './city.ts'

/**
 * How long the recording is kept: three days, the two the calendar
 * offers behind today plus today itself. Mirror of MRT_AIS_ARCHIVE_KEEP_HOURS.
 */
export const AIS_ARCHIVE_KEEP_HOURS = 72
export const AIS_ARCHIVE_HOUR_MS = 3_600_000
/**
 * A simulated moment this far behind the real clock is replayed from the
 * archive; anything nearer, and the future, is the live fleet. The live
 * picture is rendered AIS_PLAYBACK_DELAY_MS behind the real clock and the
 * replay the same span behind the simulated one, so at the edge both show
 * the same moment – the margin only has to cover the tail poll below.
 */
export const AIS_REPLAY_EDGE_MS = 60_000
/** How often the hour still being written is asked for its new lines. */
export const AIS_ARCHIVE_TAIL_POLL_MS = 20_000
/**
 * The keeper stamps a fix as it hears it, so a window that runs across
 * the hour boundary still adds seconds to the hour just closed. An hour
 * counts as closed – complete, cacheable – this long after its end.
 * Mirror of MRT_AIS_ARCHIVE_SETTLE_SECONDS.
 */
export const AIS_ARCHIVE_SETTLE_MS = 60_000
/** A failed fetch is tried again after this long. */
const AIS_ARCHIVE_RETRY_MS = 30_000
/**
 * How far ahead of the simulated moment the hours are fetched, at
 * least – ten simulated minutes, or ten real seconds of the clock's own
 * pace when the time-lapse runs faster than that (×120 covers two hours
 * in a minute; a file fetched a second before it is needed is late). The
 * pace is read off consecutive calls and capped at the fastest time-lapse
 * the app offers (?speed=600), so a clock scrubbed hours ahead in one
 * move reads as a fast clock, not as an absurd one.
 */
const AIS_ARCHIVE_PREFETCH_MS = 10 * 60_000
const AIS_ARCHIVE_PREFETCH_LEAD_MS = 10_000
const AIS_ARCHIVE_MAX_PACE = 600

/** One recorded fix: [mmsi, unix ms, lat, lon, sogKn, cogDeg, headingDeg, navStatus]. */
export type AisArchiveFix = [
  number,
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
]

/** A vessel's static data as the archive keeps it – the fields no fix carries. */
export interface AisArchiveStatic {
  mmsi: number
  name: string
  typeCode: number
  lengthM: number | null
  widthM: number | null
  draughtM: number | null
}

export type AisArchiveLine = AisArchiveFix | AisArchiveStatic

const HOUR_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/

/** The hour file a moment belongs to, as its name: UTC "YYYY-MM-DDTHH". */
export function archiveHourKey(ms: number): string {
  return new Date(Math.floor(ms / AIS_ARCHIVE_HOUR_MS) * AIS_ARCHIVE_HOUR_MS).toISOString().slice(0, 13)
}

/** The start of a named hour in unix ms, null for anything that is not an hour name. */
export function archiveHourStart(key: string): number | null {
  if (!HOUR_KEY_PATTERN.test(key)) return null
  const ms = Date.parse(`${key}:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

export function isArchiveHourKey(key: string): boolean {
  return archiveHourStart(key) !== null
}

/** The name of a city's hour file under the archive directory. */
export function archiveFileName(slug: string, hourKey: string): string {
  return `${slug}/${hourKey}.ndjson`
}

/**
 * Whether a named hour may still be written to – the file is refetched
 * for its tail while it is, and cached once it is not.
 */
export function archiveHourIsOpen(key: string, nowMs: number): boolean {
  const start = archiveHourStart(key)
  return start !== null && start + AIS_ARCHIVE_HOUR_MS + AIS_ARCHIVE_SETTLE_MS > nowMs
}

/**
 * Whether the simulated moment is replayed from the archive rather than
 * shown live – see AIS_REPLAY_EDGE_MS.
 */
export function aisReplayWanted(simMs: number, nowMs: number): boolean {
  return simMs < nowMs - AIS_REPLAY_EDGE_MS
}

// ---------------------------------------------------------------------------
// Writing – the twin of mrt_ais_archive_record in server/api/ais.php
// ---------------------------------------------------------------------------

/** Where the writer keeps its files; the file system in dev, a stub in the tests. */
export interface AisArchiveStore {
  /** Whether the hour file exists – a missing one gets the snapshot first. */
  has(slug: string, hourKey: string): boolean
  append(slug: string, hourKey: string, text: string): void
  /** Deletes the city's hour files named before `oldestKept`. */
  prune(slug: string, oldestKept: string): void
}

export interface AisArchiveCity {
  slug: string
  box: BoundingBox
}

function staticOf(vessel: AisVessel): AisArchiveStatic {
  return {
    mmsi: vessel.mmsi,
    name: vessel.name,
    typeCode: vessel.typeCode,
    lengthM: vessel.lengthM,
    widthM: vessel.widthM,
    draughtM: vessel.draughtM,
  }
}

/**
 * The vessel's last fix as a line. The track's last point is that fix as
 * it was heard; the record's own fields stand in for a record without a
 * track (written before tracks existed).
 */
function fixOf(vessel: AisVessel): AisArchiveFix {
  const last = vessel.track[vessel.track.length - 1]
  if (last && last[0] === vessel.positionAt) {
    return [vessel.mmsi, last[0], last[1], last[2], last[3], last[4], last[5], vessel.navStatus]
  }
  return [
    vessel.mmsi,
    vessel.positionAt,
    vessel.lat,
    vessel.lon,
    vessel.sogKn,
    vessel.cogDeg,
    vessel.headingDeg,
    vessel.navStatus,
  ]
}

function staticSignature(vessel: AisVessel): string {
  return JSON.stringify(staticOf(vessel))
}

/**
 * The lines an hour file opens with: every ship with a fresh position
 * inside the box, sorted by MMSI, her static data and her last fix. Also
 * what the tests and the parity script build their expectations from.
 */
export function archiveSnapshot(state: AisState, nowMs: number, box: BoundingBox): string {
  let text = ''
  for (const vessel of aisStateVessels(state, nowMs)) {
    if (!containsLonLat(box, vessel.lon, vessel.lat)) continue
    text += `${JSON.stringify(staticOf(vessel))}\n${JSON.stringify(fixOf(vessel))}\n`
  }
  return text
}

export class AisArchiveWriter {
  private readonly store: AisArchiveStore
  private readonly cities: readonly AisArchiveCity[]

  // No parameter properties here or below: the parity script runs this
  // module through Node's type stripping, which erases types only.
  constructor(store: AisArchiveStore, cities: readonly AisArchiveCity[]) {
    this.store = store
    this.cities = cities
  }

  /**
   * Folds one message into the state (mergeAisMessage) and records what
   * it changed: the fix it carried, and the static data when that is
   * new. A city whose hour file does not exist yet gets the snapshot
   * instead – taken after the merge, so it already holds this ship and
   * this fix – and its files older than the retention go.
   */
  record(state: AisState, raw: AisRawMessage, nowMs: number): void {
    const mmsi = raw.MetaData?.MMSI
    if (!mmsi) return
    const before = state.get(mmsi)
    const beforePositionAt = before?.positionAt ?? 0
    const beforeStatic = before ? staticSignature(before) : null
    mergeAisMessage(state, raw, nowMs)
    const vessel = state.get(mmsi)
    if (!vessel) return

    let lines = ''
    if (staticSignature(vessel) !== beforeStatic) lines += `${JSON.stringify(staticOf(vessel))}\n`
    if (vessel.positionAt !== beforePositionAt) lines += `${JSON.stringify(fixOf(vessel))}\n`
    if (lines === '') return

    const hourKey = archiveHourKey(nowMs)
    for (const city of this.cities) {
      if (!containsLonLat(city.box, vessel.lon, vessel.lat)) continue
      if (this.store.has(city.slug, hourKey)) {
        this.store.append(city.slug, hourKey, lines)
        continue
      }
      this.store.prune(city.slug, archiveHourKey(nowMs - AIS_ARCHIVE_KEEP_HOURS * AIS_ARCHIVE_HOUR_MS))
      this.store.append(city.slug, hourKey, archiveSnapshot(state, nowMs, city.box))
    }
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The whole lines in a chunk of an hour file, and how many of its bytes
 * they took: a chunk fetched from a file still being written can end
 * mid-line, and that tail waits for the next fetch (which starts where
 * this one stopped). A line that does not parse is skipped – one corrupt
 * line must not cost the hour.
 */
export function parseArchiveChunk(bytes: Uint8Array): { lines: AisArchiveLine[]; consumed: number } {
  let end = bytes.length - 1
  while (end >= 0 && bytes[end] !== 0x0a) end--
  const consumed = end + 1
  const lines: AisArchiveLine[] = []
  if (consumed === 0) return { lines, consumed }
  for (const text of new TextDecoder().decode(bytes.subarray(0, consumed)).split('\n')) {
    if (text === '') continue
    try {
      const line = JSON.parse(text) as unknown
      if (isFix(line) || isStatic(line)) lines.push(line)
    } catch {
      // skipped, see above
    }
  }
  return { lines, consumed }
}

function isFix(line: unknown): line is AisArchiveFix {
  return (
    Array.isArray(line) &&
    line.length === 8 &&
    typeof line[0] === 'number' &&
    typeof line[1] === 'number' &&
    typeof line[2] === 'number' &&
    typeof line[3] === 'number'
  )
}

function isStatic(line: unknown): line is AisArchiveStatic {
  return (
    typeof line === 'object' &&
    line !== null &&
    !Array.isArray(line) &&
    typeof (line as AisArchiveStatic).mmsi === 'number'
  )
}

interface ReplayVessel {
  static: AisArchiveStatic | null
  /** Sorted by time, no two at the same instant. */
  fixes: AisArchiveFix[]
}

/** The index of the last fix at or before `atMs`, −1 when there is none. */
function lastFixAtOrBefore(fixes: AisArchiveFix[], atMs: number): number {
  let low = 0
  let high = fixes.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (fixes[mid][1] <= atMs) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * The recording in memory, per vessel, answering with the fleet as of a
 * moment. Lines go in in file order – hours in order, each hour's
 * snapshot first – so a fix is almost always appended; the snapshot that
 * opens an hour repeats the last fix of the hour before, and a repeat is
 * dropped by its time stamp.
 */
export class AisReplay {
  private readonly vessels = new Map<number, ReplayVessel>()

  clear(): void {
    this.vessels.clear()
  }

  add(lines: readonly AisArchiveLine[]): void {
    for (const line of lines) {
      const mmsi = Array.isArray(line) ? line[0] : line.mmsi
      let vessel = this.vessels.get(mmsi)
      if (!vessel) {
        vessel = { static: null, fixes: [] }
        this.vessels.set(mmsi, vessel)
      }
      if (!Array.isArray(line)) {
        vessel.static = line
        continue
      }
      const fixes = vessel.fixes
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
   * The fleet as of `atMs`, in the shape the live poll delivers it: every
   * ship with a fix in the AIS_EXPIRE_MS before that moment, her position
   * and kinematics those of that last fix, her track the fixes from the
   * one the layer will sample (AIS_PLAYBACK_DELAY_MS behind) up to it –
   * which is exactly what the live state holds at any moment. A ship
   * whose first fix lies after `atMs` is not in the harbour yet.
   */
  vesselsAt(atMs: number, exclude?: ReadonlySet<number>): AisVessel[] {
    const renderMs = atMs - AIS_PLAYBACK_DELAY_MS
    const fleet: AisVessel[] = []
    for (const [mmsi, vessel] of this.vessels) {
      if (exclude?.has(mmsi)) continue
      const fixes = vessel.fixes
      const at = lastFixAtOrBefore(fixes, atMs)
      if (at < 0 || atMs - fixes[at][1] > AIS_EXPIRE_MS) continue
      const from = Math.max(0, lastFixAtOrBefore(fixes, renderMs))
      const track: AisTrackPoint[] = []
      for (let i = from; i <= at; i++) {
        const fix = fixes[i]
        track.push([fix[1], fix[2], fix[3], fix[4], fix[5], fix[6]])
      }
      const fix = fixes[at]
      const statics = vessel.static
      fleet.push({
        mmsi,
        name: statics?.name ?? '',
        lat: fix[2],
        lon: fix[3],
        sogKn: fix[4],
        cogDeg: fix[5],
        headingDeg: fix[6],
        navStatus: fix[7],
        typeCode: statics?.typeCode ?? 0,
        lengthM: statics?.lengthM ?? null,
        widthM: statics?.widthM ?? null,
        draughtM: statics?.draughtM ?? null,
        positionAt: fix[1],
        track,
      })
    }
    return fleet.sort((a, b) => a.mmsi - b.mmsi)
  }
}

// ---------------------------------------------------------------------------
// The client – keeps the hours around the simulated moment loaded
// ---------------------------------------------------------------------------

type HourStatus = 'loading' | 'loaded' | 'absent' | 'failed'

interface HourEntry {
  key: string
  status: HourStatus
  /** Whether any answer has come for this hour – a tail refresh is
   *  'loading' again, but the hour is still there to replay. */
  answered: boolean
  lines: AisArchiveLine[]
  /** Bytes of the file read so far – where the next tail fetch starts. */
  consumed: number
  /** When the last fetch started, for the tail poll and the retry. */
  fetchedAt: number
  /** Bumped when the entry is dropped, so a late answer finds nobody. */
  generation: number
}

export interface AisArchiveHourStatus {
  key: string
  status: HourStatus
  lines: number
}

export interface AisArchiveClientOptions {
  /** Ships not to replay – the ferries the map runs from a timetable. */
  exclude?: ReadonlySet<number>
  fetch?: typeof fetch
}

/**
 * Fetches the hour files around the simulated moment from the archive
 * endpoint and answers with the fleet as of that moment. Pull-driven:
 * `follow` is called every simulation tick with the moment, and does
 * nothing until an hour boundary is crossed or the hour still being
 * written is due for its tail. Hours out of reach are dropped; closed
 * hours come back from the browser cache, the endpoint marks them so.
 */
export class AisArchiveClient {
  private readonly url: string
  private readonly hours = new Map<string, HourEntry>()
  private readonly replay = new AisReplay()
  private readonly exclude: ReadonlySet<number> | undefined
  private readonly fetchImpl: typeof fetch
  private lastFollow: { simMs: number; nowMs: number } | null = null
  private stopped = false

  constructor(url: string, options: AisArchiveClientOptions = {}) {
    this.url = url
    this.exclude = options.exclude
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** Keeps the hours the moment needs on hand – see the class comment. */
  follow(simMs: number, nowMs = Date.now()): void {
    if (this.stopped) return
    // The clock's pace, from the last two calls: what the prefetch lead
    // is measured in. A clock standing still or scrubbed back counts as
    // real pace.
    let pace = 1
    if (this.lastFollow && nowMs > this.lastFollow.nowMs) {
      pace = (simMs - this.lastFollow.simMs) / (nowMs - this.lastFollow.nowMs)
      pace = Math.min(AIS_ARCHIVE_MAX_PACE, Math.max(1, pace))
    }
    this.lastFollow = { simMs, nowMs }
    const lead = Math.max(AIS_ARCHIVE_PREFETCH_MS, pace * AIS_ARCHIVE_PREFETCH_LEAD_MS)
    // Every hour from the one the sampling reaches back into to the one
    // the lead reaches ahead – two in the usual case, three around a
    // boundary or under a fast time-lapse
    const wanted = new Set<string>()
    const firstHour = Math.floor((simMs - AIS_PLAYBACK_DELAY_MS) / AIS_ARCHIVE_HOUR_MS)
    const lastHour = Math.floor((simMs + lead) / AIS_ARCHIVE_HOUR_MS)
    for (let hour = firstHour; hour <= lastHour; hour++) {
      wanted.add(archiveHourKey(hour * AIS_ARCHIVE_HOUR_MS))
    }

    let dropped = false
    for (const [key, entry] of this.hours) {
      if (wanted.has(key)) continue
      entry.generation++
      this.hours.delete(key)
      dropped = true
    }
    if (dropped) this.rebuild()

    for (const key of wanted) {
      const entry = this.hours.get(key)
      if (!entry) {
        const fresh: HourEntry = {
          key,
          status: 'loading',
          answered: false,
          lines: [],
          consumed: 0,
          fetchedAt: nowMs,
          generation: 0,
        }
        this.hours.set(key, fresh)
        void this.load(fresh, nowMs)
        continue
      }
      if (entry.status === 'loading') continue
      const open = archiveHourIsOpen(key, nowMs)
      const due =
        entry.status === 'failed'
          ? nowMs - entry.fetchedAt >= AIS_ARCHIVE_RETRY_MS
          : open && nowMs - entry.fetchedAt >= AIS_ARCHIVE_TAIL_POLL_MS
      if (due) void this.load(entry, nowMs)
    }
  }

  /**
   * Whether the hour of the moment has been answered for – loaded, absent
   * or failed – so that `vesselsAt` says something. Until then the caller
   * keeps whatever it was showing: a harbour blinking empty for the length
   * of a fetch would be worse than the live picture standing a moment
   * longer, at the edge the two are the same picture anyway.
   */
  ready(simMs: number): boolean {
    return this.hours.get(archiveHourKey(simMs))?.answered === true
  }

  /** The fleet as of the moment, from whatever hours are loaded. */
  vesselsAt(simMs: number): AisVessel[] {
    return this.replay.vesselsAt(simMs, this.exclude)
  }

  /** Which hours are held and how – for the debug API and the tests. */
  status(): AisArchiveHourStatus[] {
    return [...this.hours.values()]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((entry) => ({ key: entry.key, status: entry.status, lines: entry.lines.length }))
  }

  stop(): void {
    this.stopped = true
    for (const entry of this.hours.values()) entry.generation++
    this.hours.clear()
    this.replay.clear()
  }

  private async load(entry: HourEntry, nowMs: number): Promise<void> {
    const generation = entry.generation
    // From where the last fetch stopped – also after a failed tail, whose
    // lines are still held; only a fresh or an absent hour starts at 0.
    const from = entry.consumed
    entry.status = 'loading'
    entry.fetchedAt = nowMs
    let status: HourStatus = 'failed'
    let bytes: Uint8Array | null = null
    try {
      // A tail is never cached; a whole hour may be, the endpoint decides.
      const response = await this.fetchImpl(
        from > 0 ? `${this.url}&hour=${entry.key}&from=${from}` : `${this.url}&hour=${entry.key}`,
        { cache: from > 0 ? 'no-store' : 'default' },
      )
      if (response.status === 404) {
        status = 'absent'
      } else if (response.status === 416) {
        // Nothing beyond what is held – the file has not grown
        status = 'loaded'
      } else if (response.ok) {
        bytes = new Uint8Array(await response.arrayBuffer())
        status = 'loaded'
      }
    } catch {
      // failed – retried after AIS_ARCHIVE_RETRY_MS
    }
    if (this.stopped || entry.generation !== generation) return
    entry.status = status
    entry.answered = true
    if (status === 'absent') {
      entry.lines = []
      entry.consumed = 0
      this.rebuild()
      return
    }
    if (bytes === null) return
    const { lines, consumed } = parseArchiveChunk(bytes)
    if (from === 0) {
      entry.lines = lines
      entry.consumed = consumed
      this.rebuild()
    } else {
      entry.lines.push(...lines)
      entry.consumed = from + consumed
      this.replay.add(lines)
    }
  }

  /** The replay from scratch, hours in order – after a drop or a whole hour landing. */
  private rebuild(): void {
    this.replay.clear()
    for (const entry of [...this.hours.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (entry.status === 'loaded') this.replay.add(entry.lines)
    }
  }
}
