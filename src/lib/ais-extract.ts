/**
 * Extraction and state keeping for aisstream.io messages: folds the raw
 * WebSocket JSON (PositionReport, StandardClassBPositionReport,
 * ShipStaticData, StaticDataReport) into one vessel record per MMSI –
 * latest fields for the list, plus a short position TRACK per vessel.
 *
 * The track exists because the app does not render AIS live: it plays
 * the fleet back AIS_PLAYBACK_DELAY_MS behind the wall clock and
 * interpolates BETWEEN recorded fixes (playbackSample). aisstream
 * delivers a ship under way only about every 60 s – extrapolating ahead
 * of the newest fix therefore stalled ships for minutes and teleported
 * them when the correction landed; with the delay, the next fix has
 * almost always arrived before the playback needs it. The track is
 * pruned after ten minutes; what it drops, the archive keeps for five
 * days (ais-archive.ts), and a clock set into the past plays that back
 * the same way, the same delay behind the simulated moment.
 *
 * Used by the Vite dev middleware (vite.config.ts) and the unit tests;
 * in production server/api/ais.php does the same job in PHP – the parity
 * test (scripts/test-ais-parity.mjs) holds both to the same fixtures.
 */

import { curvePoint, followsCourse } from './track-curve.ts'

/**
 * One recorded fix: [unix ms, lat, lon, sogKn, cogDeg, headingDeg] –
 * kinematics as of that moment, nulls as in the vessel record. Compact
 * tuples keep the JSON payload small (the track ships with every poll).
 */
export type AisTrackPoint = [number, number, number, number | null, number | null, number | null]

/**
 * How far an AIS message's own time may lie from the keeper's clock to
 * be the fix's time: behind it by the delay a message takes through
 * aisstream and the keeper's own windows, ahead of it by nothing but
 * clock skew. Outside the window the receive time stands in, as it did
 * before messages carried their time at all.
 */
export const AIS_MESSAGE_TIME_BEHIND_MS = 10 * 60_000
export const AIS_MESSAGE_TIME_AHEAD_MS = 5_000

/**
 * The time aisstream stamps a message with ("2026-08-27 11:15:39.673431615
 * +0000 UTC"), as unix ms; null for anything else. Mirror of
 * mg3d_ais_message_time in server/api/ais.php.
 */
export function aisMessageTimeMs(timeUtc: unknown): number | null {
  if (typeof timeUtc !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? \+0000 UTC$/.exec(timeUtc)
  if (!m) return null
  const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms)
}

/**
 * When a fix was made: the message's own time where it is within the
 * window of the keeper's clock, the keeper's clock otherwise. The
 * receive time was the fix's time before, and the time a message took
 * to arrive – a second here, twenty there – became a change of speed
 * between one fix and the next.
 */
export function aisFixTimeMs(raw: AisRawMessage, nowMs: number): number {
  const stamped = aisMessageTimeMs(raw.MetaData?.time_utc)
  if (stamped === null) return nowMs
  if (stamped > nowMs + AIS_MESSAGE_TIME_AHEAD_MS) return nowMs
  if (stamped < nowMs - AIS_MESSAGE_TIME_BEHIND_MS) return nowMs
  return stamped
}

/** One tracked vessel, merged from its position and static reports. */
export interface AisVessel {
  mmsi: number
  /** Trimmed ship name; '' until any report carried one. */
  name: string
  lat: number
  lon: number
  /** Speed over ground in knots (AIS "not available" 102.3 → null). */
  sogKn: number | null
  /** Course over ground in degrees (AIS "not available" 360 → null). */
  cogDeg: number | null
  /** True heading in degrees (AIS "not available" 511 → null). */
  headingDeg: number | null
  /**
   * The course over the ground of her last fix UNDER WAY (SOG of
   * AIS_UNDER_WAY_SOG_KN and more), kept while she lies still. A moored
   * ship's own COG is what her GNSS makes of its drift, or "not
   * available"; without a heading – the inland barges carry no gyro –
   * this is the course she came in on, and the playback lays her along
   * it (playbackSample). Null until she has been heard moving.
   */
  lastCourseDeg: number | null
  /** AIS navigational status (0 under way, 5 moored, …), null unknown. */
  navStatus: number | null
  /** AIS ship type code (60s passenger, 70s cargo, …), 0 = unknown. */
  typeCode: number
  lengthM: number | null
  widthM: number | null
  /** Maximum static draught in m, from ShipStaticData; null unreported. */
  draughtM: number | null
  /** Unix ms of the last message that carried coordinates. */
  positionAt: number
  /** Recent fixes, oldest first – the playback interpolates these. */
  track: AisTrackPoint[]
}

/** Vessels drop out of the LIST after this long without a position. */
export const AIS_EXPIRE_MS = 30 * 60_000

/**
 * The speed from which a fix's course over the ground is a course. GNSS
 * drift at a berth reads as a few tenths of a knot with a course that
 * points anywhere; from half a knot the receiver has real motion to
 * derive a direction from. The lights' "moving" reads the same number
 * (VesselLayer).
 */
export const AIS_UNDER_WAY_SOG_KN = 0.5

/**
 * How long a vessel's record survives in the STATE beyond its last
 * position. Static data (name, type, dimensions) arrives only every six
 * minutes and is expensive to re-learn through short listen windows – a
 * ferry that leaves for Gedser and returns two hours later must come
 * back as the 170 m BERLIN, not as a nameless 12 m default hull.
 */
export const AIS_STATIC_KEEP_MS = 48 * 3600_000

/**
 * How far behind the wall clock the app renders the fleet. Four minutes
 * covers aisstream's ~60 s per-ship cadence plus the poll pipeline
 * (8 s state flush + 10 s client poll) several times over, so even a
 * ship that skips three reports in a row is still played back between
 * two known fixes rather than waiting at the last one. The cost is only
 * that the harbor runs four minutes late – nobody watching the map can
 * tell, and the motion is what sells it. It has to stay well under
 * AIS_TRACK_KEEP_MS, or the playback would be reading points the state
 * has already pruned. The replay of the archive keeps the same delay
 * behind the simulated clock, on purpose: it is what lets the two
 * sources hand over without a jump (see ais-archive.ts).
 */
export const AIS_PLAYBACK_DELAY_MS = 240_000
/** Track points older than this are pruned from the state. */
export const AIS_TRACK_KEEP_MS = 10 * 60_000
/** Hard cap per vessel – a runaway-transmitter backstop. */
export const AIS_TRACK_MAX_POINTS = 40

interface RawDimension {
  A?: number
  B?: number
  C?: number
  D?: number
}

/** The subset of the aisstream message the extraction reads. */
export interface AisRawMessage {
  MessageType?: string
  MetaData?: {
    MMSI?: number
    ShipName?: string
    latitude?: number
    longitude?: number
    time_utc?: string
  }
  Message?: {
    PositionReport?: {
      Latitude?: number
      Longitude?: number
      Sog?: number
      Cog?: number
      TrueHeading?: number
      NavigationalStatus?: number
    }
    StandardClassBPositionReport?: {
      Latitude?: number
      Longitude?: number
      Sog?: number
      Cog?: number
      TrueHeading?: number
    }
    ShipStaticData?: {
      Name?: string
      Type?: number
      Dimension?: RawDimension
      MaximumStaticDraught?: number
    }
    StaticDataReport?: {
      ReportA?: { Name?: string; Valid?: boolean }
      ReportB?: { ShipType?: number; Dimension?: RawDimension; Valid?: boolean }
    }
  }
}

export type AisState = Map<number, AisVessel>

/** AIS sentinel values for "not available", mapped to null. */
function sog(value: number | undefined): number | null {
  return value === undefined || value >= 102.3 ? null : value
}
function cog(value: number | undefined): number | null {
  return value === undefined || value >= 360 ? null : value
}
function heading(value: number | undefined): number | null {
  return value === undefined || value >= 511 ? null : value
}
/** Whether a fix's speed makes its course a course; an unreported speed is given the benefit. */
function underWaySog(sogKn: number | null): boolean {
  return sogKn === null || sogKn >= AIS_UNDER_WAY_SOG_KN
}

function dimensions(dim: RawDimension | undefined): { length: number | null; width: number | null } {
  const length = (dim?.A ?? 0) + (dim?.B ?? 0)
  const width = (dim?.C ?? 0) + (dim?.D ?? 0)
  return { length: length > 0 ? length : null, width: width > 0 ? width : null }
}

/**
 * Folds one raw message into the state. Unknown message types and the
 * SubscriptionConfirmation contribute nothing; any message carrying
 * coordinates refreshes the vessel's position timestamp – with the
 * message's own time (aisFixTimeMs). A message older than the fix
 * already held is late, not news: its position and kinematics are
 * left alone, its static data taken.
 */
export function mergeAisMessage(state: AisState, raw: AisRawMessage, nowMs: number): void {
  const meta = raw.MetaData
  const mmsi = meta?.MMSI
  if (!mmsi) return
  const fixMs = aisFixTimeMs(raw, nowMs)

  const vessel: AisVessel = state.get(mmsi) ?? {
    mmsi,
    name: '',
    lat: NaN,
    lon: NaN,
    sogKn: null,
    cogDeg: null,
    headingDeg: null,
    lastCourseDeg: null,
    navStatus: null,
    typeCode: 0,
    lengthM: null,
    widthM: null,
    draughtM: null,
    positionAt: 0,
    track: [],
  }

  // Position: the message payload is authoritative (full precision), the
  // MetaData copy fills in for static reports – it carries the last known
  // position either way.
  const report = raw.Message?.PositionReport ?? raw.Message?.StandardClassBPositionReport
  const lat = report?.Latitude ?? meta?.latitude
  const lon = report?.Longitude ?? meta?.longitude
  const hasFix =
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Math.abs(lat) <= 90 &&
    fixMs >= vessel.positionAt
  if (hasFix) {
    vessel.lat = lat
    vessel.lon = lon
    vessel.positionAt = fixMs
  }
  if (report && fixMs >= vessel.positionAt) {
    vessel.sogKn = sog(report.Sog)
    vessel.cogDeg = cog(report.Cog)
    vessel.headingDeg = heading(report.TrueHeading)
    if (vessel.cogDeg !== null && underWaySog(vessel.sogKn)) vessel.lastCourseDeg = vessel.cogDeg
    if ('NavigationalStatus' in report) {
      const status = (report as { NavigationalStatus?: number }).NavigationalStatus
      vessel.navStatus = status ?? vessel.navStatus
    }
  }
  if (hasFix) {
    // Record AFTER the kinematics update, so a MetaData-only fix (static
    // report) carries the last known speed and course, not stale nulls –
    // and the playback knows it by them (isStaticCopy).
    vessel.track.push([fixMs, vessel.lat, vessel.lon, vessel.sogKn, vessel.cogDeg, vessel.headingDeg])
    vessel.track = vessel.track
      .filter((p) => nowMs - p[0] <= AIS_TRACK_KEEP_MS)
      .slice(-AIS_TRACK_MAX_POINTS)
  }

  // Static data: name, type, dimensions – whichever report carries them.
  const staticData = raw.Message?.ShipStaticData
  const partReport = raw.Message?.StaticDataReport
  const staticName = staticData?.Name ?? (partReport?.ReportA?.Valid ? partReport.ReportA.Name : undefined)
  const metaName = (meta?.ShipName ?? '').trim()
  vessel.name = (staticName ?? '').trim() || vessel.name || metaName
  const typeCode = staticData?.Type ?? (partReport?.ReportB?.Valid ? partReport.ReportB.ShipType : undefined)
  if (typeCode) vessel.typeCode = typeCode
  const dim = dimensions(staticData?.Dimension ?? (partReport?.ReportB?.Valid ? partReport.ReportB.Dimension : undefined))
  if (dim.length !== null) vessel.lengthM = dim.length
  if (dim.width !== null) vessel.widthM = dim.width
  // Draught rides with the name and dimensions – only the full static
  // report carries it, and 0 is AIS for "not reported", not a value.
  const draught = staticData?.MaximumStaticDraught
  if (typeof draught === 'number' && draught > 0) vessel.draughtM = draught

  if (Number.isFinite(vessel.lat)) state.set(mmsi, vessel)
}

/**
 * The state as a serializable vessel list: only vessels with a fresh
 * position are listed, sorted by MMSI so the dev middleware, the PHP
 * twin, and the fixtures all agree on the order byte for byte. Records
 * whose position merely went stale stay in the state as memory – their
 * static data survives until AIS_STATIC_KEEP_MS closes the book.
 */
export function aisStateVessels(state: AisState, nowMs: number): AisVessel[] {
  const vessels: AisVessel[] = []
  for (const [mmsi, vessel] of state) {
    const age = nowMs - vessel.positionAt
    if (age > AIS_STATIC_KEEP_MS) {
      state.delete(mmsi)
      continue
    }
    if (age > AIS_EXPIRE_MS) continue
    vessels.push(vessel)
  }
  return vessels.sort((a, b) => a.mmsi - b.mmsi)
}

const METERS_PER_DEGREE_LATITUDE = 111_320

/** What the playback knows about a vessel at one rendered instant. */
export interface AisPlaybackSample {
  lon: number
  lat: number
  bearingDeg: number
  /** True while the sample sits inside a segment with real movement –
   *  the layer's render pacing keys on this, stable across ticks. */
  underWay: boolean
}

/**
 * The bearing a fix states on its own: the heading, or the course over
 * the ground of a fix under way. A course at rest is drift, not a
 * direction, and says nothing here.
 */
function fixBearing(p: AisTrackPoint): number | null {
  return p[5] ?? (underWaySog(p[3]) ? p[4] : null)
}

/**
 * Which way a ship at rest lies: along the course she last held under
 * way, failing that along whatever course her fixes report at rest (a
 * receiver that froze its last course is right more often than not),
 * failing that north – the one direction that is a guess and nothing
 * else.
 */
function restingBearing(vessel: AisVessel, driftCogDeg: number | null): number {
  return vessel.lastCourseDeg ?? driftCogDeg ?? 0
}

function pointSample(vessel: AisVessel, p: AisTrackPoint): AisPlaybackSample {
  return { lon: p[2], lat: p[1], bearingDeg: fixBearing(p) ?? restingBearing(vessel, p[4]), underWay: false }
}

/**
 * Whether a fix is a static report's copy of a fix under way. A message
 * without a position of its own – the static data above all – carries in
 * its MetaData the last position aisstream knows, and mergeAisMessage
 * records it at the message's own time with the speed and courses of the
 * fix before it, to the last decimal. For a ship at rest that is where
 * she is, and the copy keeps her listed between position reports, which
 * aisstream passes on rarely for a ship at a berth. For one under way the
 * position is as old as the report it came in – the fixture's SELENE
 * reported herself 125 m on five seconds after her static data – and the
 * courses are those of the fix before: played as a fix, the copy stood
 * her still and sent her on at twice her speed after, or held her bow on
 * a course minutes old (the SOLAR ran along the Elbe for four minutes
 * with her bow 30–40° off her track). The repeated kinematics give it
 * away: in three hours of Hamburg's recording 741 of the 752 fixes
 * repeating a fix under way stood on MetaData's rounded position; the
 * other eleven, reports that happened to repeat, are played as the
 * points on her way they are (playedTrack). Read from the kinematics at
 * `at`: 3 in a track point, 4 in a line of the archive.
 */
export function isStaticCopy(
  fix: readonly (number | null)[],
  before: readonly (number | null)[],
  at = 3,
): boolean {
  const sogKn = before[at]
  return (
    sogKn !== null &&
    sogKn >= AIS_UNDER_WAY_SOG_KN &&
    fix[at] === sogKn &&
    fix[at + 1] === before[at + 1] &&
    fix[at + 2] === before[at + 2]
  )
}

/**
 * How far a copy has to stand from the point before it to say anything
 * new: MetaData rounds a position to five decimals, up to a metre.
 */
const COPY_SAME_SPOT_M = 3

function metersBetween(a: AisTrackPoint, b: AisTrackPoint): number {
  const northM = (b[1] - a[1]) * METERS_PER_DEGREE_LATITUDE
  const eastM = (b[2] - a[2]) * METERS_PER_DEGREE_LATITUDE * Math.cos((a[1] * Math.PI) / 180)
  return Math.hypot(northM, eastM)
}

function azimuthDeg(a: AisTrackPoint, b: AisTrackPoint): number {
  const northM = (b[1] - a[1]) * METERS_PER_DEGREE_LATITUDE
  const eastM = (b[2] - a[2]) * METERS_PER_DEGREE_LATITUDE * Math.cos((a[1] * Math.PI) / 180)
  return ((Math.atan2(eastM, northM) * 180) / Math.PI + 360) % 360
}

const playedTracks = new WeakMap<readonly AisTrackPoint[], readonly AisTrackPoint[]>()

/**
 * The track as the playback plays it, worked out once per track – the
 * wake samples one twenty times a tick. A static report's copy of a fix
 * under way (isStaticCopy) that stands where the point before it stood
 * says only that she was heard, and is left out. One that stands
 * somewhere new carries a report aisstream had and this keeper never
 * got: its position is real, its time is not. It is played as a point on
 * her way, at its share of the distance between the fixes either side
 * of it (never later than its own stamp, after which it cannot have been
 * made), with no speed or course of its own – the curve passes it along
 * the line from the point before to the point after. A copy beyond the
 * last fix keeps its stamp until the next fix comes in. Over Hamburg's
 * morning that left the fewest ships under way standing still – 26.6 %
 * of the samples (27.0 % with the copies as fixes, 29.1 % without them)
 * – and held the bow within 20° of the track the most: 89.8 % (89.1 %,
 * 88.9 %).
 */
function playedTrack(track: readonly AisTrackPoint[]): readonly AisTrackPoint[] {
  const known = playedTracks.get(track)
  if (known) return known
  let played: readonly AisTrackPoint[] = track
  if (track.some((p, i) => i > 0 && isStaticCopy(p, track[i - 1]))) {
    // The fixes, and the copies that stand somewhere new as waypoints
    const points: { p: AisTrackPoint; waypoint: boolean }[] = []
    for (let i = 0; i < track.length; i++) {
      const p = track[i]
      if (i === 0 || !isStaticCopy(p, track[i - 1])) points.push({ p, waypoint: false })
      else if (metersBetween(track[i - 1], p) >= COPY_SAME_SPOT_M) points.push({ p, waypoint: true })
    }
    const out: AisTrackPoint[] = []
    for (let j = 0; j < points.length; j++) {
      const { p, waypoint } = points[j]
      if (!waypoint) {
        out.push(p)
        continue
      }
      // The fixes either side; the first point is always a fix
      let a = j - 1
      while (points[a].waypoint) a--
      let b = j + 1
      while (b < points.length && points[b].waypoint) b++
      let t = p[0]
      if (b < points.length) {
        let total = 0
        let upTo = 0
        for (let k = a; k < b; k++) {
          const m = metersBetween(points[k].p, points[k + 1].p)
          total += m
          if (k < j) upTo += m
        }
        const tA = points[a].p[0]
        if (total > 0) t = Math.min(t, tA + ((points[b].p[0] - tA) * upTo) / total)
      }
      const previous = out[out.length - 1]
      const next = points[j + 1]?.p ?? p
      out.push([Math.max(t, previous[0] + 1), p[1], p[2], null, azimuthDeg(previous, next), null])
    }
    played = out
  }
  playedTracks.set(track, played)
  return played
}

/** The signed angle from `fromDeg` to `toDeg`, −180 to 180. */
function turnDeg(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180
}

/** `fromDeg` eased toward `toDeg` along the shortest arc, `u` of the way. */
function easeDeg(fromDeg: number, toDeg: number, u: number): number {
  return (fromDeg + turnDeg(fromDeg, toDeg) * u + 360) % 360
}

/**
 * The vessel as the playback shows it at `renderMs` (wall clock minus
 * AIS_PLAYBACK_DELAY_MS): along the curve between the two recorded
 * fixes around that instant, with the course over the ground at each
 * fix as its tangent (see lib/track-curve.ts – a straight chord turned
 * every bend into a polygon). Outside the track the position CLAMPS to
 * the nearest end – never extrapolates. A ship whose data dries up
 * therefore waits at her last reported spot instead of sailing on over
 * a quay, and moves again the moment the next fix arrives. A static
 * report's copy of a fix under way is played as what it is (playedTrack).
 */
export function playbackSample(vessel: AisVessel, renderMs: number): AisPlaybackSample {
  const track: readonly AisTrackPoint[] =
    vessel.track.length > 0
      ? playedTrack(vessel.track)
      : [[vessel.positionAt, vessel.lat, vessel.lon, vessel.sogKn, vessel.cogDeg, vessel.headingDeg]]
  const last = track[track.length - 1]
  if (renderMs <= track[0][0]) return pointSample(vessel, track[0])
  if (renderMs >= last[0]) return pointSample(vessel, last)

  let i = 0
  while (i + 1 < track.length && track[i + 1][0] <= renderMs) i++
  const p0 = track[i]
  const p1 = track[i + 1]
  const dtMs = p1[0] - p0[0]
  const u = dtMs > 0 ? (renderMs - p0[0]) / dtMs : 1

  const metersPerDegreeLongitude = METERS_PER_DEGREE_LATITUDE * Math.cos((p0[1] * Math.PI) / 180)
  const northM = (p1[1] - p0[1]) * METERS_PER_DEGREE_LATITUDE
  const eastM = (p1[2] - p0[2]) * metersPerDegreeLongitude
  const meters = Math.hypot(northM, eastM)
  // ~0.3 kn over the segment – below is berth wobble, not movement.
  const underWay = dtMs > 0 && meters / (dtMs / 1000) >= 0.15
  // The curve through the two fixes along their courses; a segment of
  // berth wobble is a chord, there is no course in it
  const fromDeg = underWay && underWaySog(p0[3]) ? p0[4] : null
  const toDeg = underWay && underWaySog(p1[3]) ? p1[4] : null
  const curve = curvePoint(eastM, northM, fromDeg, toDeg, u)
  const lat = p0[1] + curve.northM / METERS_PER_DEGREE_LATITUDE
  const lon = p0[2] + curve.eastM / metersPerDegreeLongitude

  // Bearing. A segment long enough to trust lies along the drawn motion,
  // the curve's tangent, turned at each fix by the angle between the
  // motion there and what the fix states – a heading's crab, a course
  // the curve could not take (one pointing back) – and eased between the
  // two. Eased from one fix to the next instead, a course or a heading
  // set the hull across the motion wherever the curve turned early or
  // late: either is the bow's direction at its own fix and nowhere else
  // (the KAEPP'N BRASS, six minutes unheard through a turn of 72°, ran
  // 28° off her track). Where both fixes report a heading, though, the
  // curve is her path only while she makes a metre a second, bow first,
  // along both courses she reported; otherwise – pivoting on the spot,
  // worked sideways or astern, turning round between two fixes – the
  // gyro is the truth at either end. That, a segment too short to give
  // a direction, and a curve that would turn her the long way round
  // from what one fix states to what the other does ease what the fixes
  // state along the shortest arc; a ship lying still lies as she came in.
  const h0 = fixBearing(p0)
  const h1 = fixBearing(p1)
  const gyro = p0[5] !== null && p1[5] !== null
  let bearingDeg: number | null = null
  if (meters > 5) {
    const tangent0 = curvePoint(eastM, northM, fromDeg, toDeg, 0).tangentDeg
    const tangent1 = curvePoint(eastM, northM, fromDeg, toDeg, 1).tangentDeg
    const off0 = h0 === null ? 0 : turnDeg(tangent0, h0)
    const off1 = h1 === null ? 0 : turnDeg(tangent1, h1)
    const offTurn = turnDeg(off0, off1)
    // Bow first: under way the gyro stands 2° off the course over the
    // ground on the median and within 12° nine times in ten (Hamburg)
    const alongCurve =
      !gyro ||
      (meters / (dtMs / 1000) >= 1 &&
        followsCourse(eastM, northM, fromDeg) &&
        followsCourse(eastM, northM, toDeg) &&
        Math.abs(off0) <= 45 &&
        Math.abs(off1) <= 45)
    // The tangent stays within a right angle of the chord, so this is
    // the whole turn the curve gives her (a ship backing out of a turn
    // went 313° round where her gyro said 47°)
    const longWay =
      h0 !== null && h1 !== null && Math.abs(turnDeg(tangent0, tangent1) + offTurn - turnDeg(h0, h1)) > 1
    if (alongCurve && !longWay) bearingDeg = (curve.tangentDeg + off0 + offTurn * u + 360) % 360
  }
  if (bearingDeg === null) {
    bearingDeg =
      h0 !== null && h1 !== null ? easeDeg(h0, h1, u) : (h1 ?? h0 ?? restingBearing(vessel, p1[4] ?? p0[4]))
  }
  return { lon, lat, bearingDeg, underWay }
}
