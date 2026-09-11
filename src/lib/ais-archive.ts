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
 *
 * The hour files, the edge that sends the clock to the recording, the
 * chunk reader and the client that keeps the hours loaded are shared
 * with the sky's recording (aircraft-archive.ts) and live in
 * archive-hours.ts; this module is the harbour's line shapes, writer
 * and replay on top of them.
 */

import {
  ARCHIVE_HOUR_MS,
  ARCHIVE_KEEP_HOURS,
  ARCHIVE_SETTLE_MS,
  ARCHIVE_TAIL_POLL_MS,
  HourArchiveClient,
  REPLAY_EDGE_MS,
  archiveOldestKept,
  archiveHourKey,
  lastFixAtOrBefore,
  parseArchiveChunk as parseChunk,
  replayWanted,
  type ArchiveHourStatus,
  type ArchiveStore,
} from './archive-hours.ts'
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

export {
  archiveFileName,
  archiveHourIsOpen,
  archiveHourKey,
  archiveHourStart,
  isArchiveHourKey,
} from './archive-hours.ts'

/** The shared hour-file rules under the harbour's names – see archive-hours.ts. */
export const AIS_ARCHIVE_KEEP_HOURS = ARCHIVE_KEEP_HOURS
export const AIS_ARCHIVE_HOUR_MS = ARCHIVE_HOUR_MS
export const AIS_REPLAY_EDGE_MS = REPLAY_EDGE_MS
export const AIS_ARCHIVE_TAIL_POLL_MS = ARCHIVE_TAIL_POLL_MS
export const AIS_ARCHIVE_SETTLE_MS = ARCHIVE_SETTLE_MS
/**
 * How far behind the sampled instant a replayed ship's track reaches:
 * the wake reads her track WAKE_LIFE_S back from there (map/Wake.ts),
 * and the fix before that can be a minute older still.
 */
export const AIS_REPLAY_TRACK_LOOKBACK_MS = 90_000

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

/**
 * Whether the simulated moment is replayed from the archive rather than
 * shown live – the edge both recordings share (replayWanted).
 */
export function aisReplayWanted(simMs: number, nowMs: number): boolean {
  return replayWanted(simMs, nowMs)
}

// ---------------------------------------------------------------------------
// Writing – the twin of mg3d_ais_archive_record in server/api/ais.php
// ---------------------------------------------------------------------------

/** Where the writer keeps its files; the file system in dev, a stub in the tests. */
export type AisArchiveStore = ArchiveStore

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
      this.store.prune(city.slug, archiveOldestKept(nowMs))
      this.store.append(city.slug, hourKey, archiveSnapshot(state, nowMs, city.box))
    }
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The lines of the harbour's recording in a chunk of an hour file – see archive-hours.ts. */
export function parseArchiveChunk(bytes: Uint8Array): { lines: AisArchiveLine[]; consumed: number } {
  return parseChunk(bytes, isArchiveLine)
}

function isArchiveLine(line: unknown): line is AisArchiveLine {
  return isFix(line) || isStatic(line)
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
   * and kinematics those of that last fix, her track the fixes from
   * AIS_REPLAY_TRACK_LOOKBACK_MS before the one the layer will sample
   * (AIS_PLAYBACK_DELAY_MS behind) up to it – the live state holds ten
   * minutes, the wake wants the minute before the sampled instant. A
   * ship whose first fix lies after `atMs` is not in the harbour yet.
   */
  vesselsAt(atMs: number, exclude?: ReadonlySet<number>): AisVessel[] {
    const renderMs = atMs - AIS_PLAYBACK_DELAY_MS - AIS_REPLAY_TRACK_LOOKBACK_MS
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
// The client – the shared one, answering with ships
// ---------------------------------------------------------------------------

export type AisArchiveHourStatus = ArchiveHourStatus

export interface AisArchiveClientOptions {
  /** Ships not to replay – the ferries the map runs from a timetable. */
  exclude?: ReadonlySet<number>
  fetch?: typeof fetch
}

/**
 * Keeps the hours around the simulated moment loaded from the AIS
 * endpoint (HourArchiveClient in archive-hours.ts does the fetching) and
 * answers with the fleet as of that moment.
 */
export class AisArchiveClient {
  private readonly client: HourArchiveClient<AisArchiveLine>
  private readonly replay = new AisReplay()
  private readonly exclude: ReadonlySet<number> | undefined

  constructor(url: string, options: AisArchiveClientOptions = {}) {
    this.exclude = options.exclude
    this.client = new HourArchiveClient<AisArchiveLine>(url, {
      isLine: isArchiveLine,
      replay: this.replay,
      playbackDelayMs: AIS_PLAYBACK_DELAY_MS,
      fetch: options.fetch,
    })
  }

  /** Keeps the hours the moment needs on hand – every simulation tick. */
  follow(simMs: number, nowMs = Date.now()): void {
    this.client.follow(simMs, nowMs)
  }

  /** Whether the hour of the moment has been answered for, so that `vesselsAt` says something. */
  ready(simMs: number): boolean {
    return this.client.ready(simMs)
  }

  /** The fleet as of the moment, from whatever hours are loaded. */
  vesselsAt(simMs: number): AisVessel[] {
    return this.replay.vesselsAt(simMs, this.exclude)
  }

  /** Which hours are held and how – for the debug API and the tests. */
  status(): AisArchiveHourStatus[] {
    return this.client.status()
  }

  stop(): void {
    this.client.stop()
  }
}
