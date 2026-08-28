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
 * almost always arrived before the playback needs it.
 *
 * Used by the Vite dev middleware (vite.config.ts) and the unit tests;
 * in production server/api/ais.php does the same job in PHP – the parity
 * test (scripts/test-ais-parity.mjs) holds both to the same fixtures.
 */

/**
 * One recorded fix: [unix ms, lat, lon, sogKn, cogDeg, headingDeg] –
 * kinematics as of that moment, nulls as in the vessel record. Compact
 * tuples keep the JSON payload small (the track ships with every poll).
 */
export type AisTrackPoint = [number, number, number, number | null, number | null, number | null]

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
  /** AIS navigational status (0 under way, 5 moored, …), null unknown. */
  navStatus: number | null
  /** AIS ship type code (60s passenger, 70s cargo, …), 0 = unknown. */
  typeCode: number
  lengthM: number | null
  widthM: number | null
  /** Unix ms of the last message that carried coordinates. */
  positionAt: number
  /** Recent fixes, oldest first – the playback interpolates these. */
  track: AisTrackPoint[]
}

/** Vessels drop out of the LIST after this long without a position. */
export const AIS_EXPIRE_MS = 30 * 60_000

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
 * has already pruned.
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

function dimensions(dim: RawDimension | undefined): { length: number | null; width: number | null } {
  const length = (dim?.A ?? 0) + (dim?.B ?? 0)
  const width = (dim?.C ?? 0) + (dim?.D ?? 0)
  return { length: length > 0 ? length : null, width: width > 0 ? width : null }
}

/**
 * Folds one raw message into the state. Unknown message types and the
 * SubscriptionConfirmation contribute nothing; any message carrying
 * coordinates refreshes the vessel's position timestamp.
 */
export function mergeAisMessage(state: AisState, raw: AisRawMessage, nowMs: number): void {
  const meta = raw.MetaData
  const mmsi = meta?.MMSI
  if (!mmsi) return

  const vessel: AisVessel = state.get(mmsi) ?? {
    mmsi,
    name: '',
    lat: NaN,
    lon: NaN,
    sogKn: null,
    cogDeg: null,
    headingDeg: null,
    navStatus: null,
    typeCode: 0,
    lengthM: null,
    widthM: null,
    positionAt: 0,
    track: [],
  }

  // Position: the message payload is authoritative (full precision), the
  // MetaData copy fills in for static reports – it carries the last known
  // position either way.
  const report = raw.Message?.PositionReport ?? raw.Message?.StandardClassBPositionReport
  const lat = report?.Latitude ?? meta?.latitude
  const lon = report?.Longitude ?? meta?.longitude
  const hasFix = typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90
  if (hasFix) {
    vessel.lat = lat
    vessel.lon = lon
    vessel.positionAt = nowMs
  }
  if (report) {
    vessel.sogKn = sog(report.Sog)
    vessel.cogDeg = cog(report.Cog)
    vessel.headingDeg = heading(report.TrueHeading)
    if ('NavigationalStatus' in report) {
      const status = (report as { NavigationalStatus?: number }).NavigationalStatus
      vessel.navStatus = status ?? vessel.navStatus
    }
  }
  if (hasFix) {
    // Record AFTER the kinematics update, so a MetaData-only fix (static
    // report) carries the last known speed and course, not stale nulls.
    vessel.track.push([nowMs, vessel.lat, vessel.lon, vessel.sogKn, vessel.cogDeg, vessel.headingDeg])
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

function pointSample(p: AisTrackPoint): AisPlaybackSample {
  return { lon: p[2], lat: p[1], bearingDeg: p[5] ?? p[4] ?? 0, underWay: false }
}

/**
 * The vessel as the playback shows it at `renderMs` (wall clock minus
 * AIS_PLAYBACK_DELAY_MS): linear interpolation between the two recorded
 * fixes around that instant. Outside the track the position CLAMPS to
 * the nearest end – never extrapolates. A ship whose data dries up
 * therefore waits at her last reported spot instead of sailing on over
 * a quay, and moves again the moment the next fix arrives.
 */
export function playbackSample(vessel: AisVessel, renderMs: number): AisPlaybackSample {
  const track: AisTrackPoint[] =
    vessel.track.length > 0
      ? vessel.track
      : [[vessel.positionAt, vessel.lat, vessel.lon, vessel.sogKn, vessel.cogDeg, vessel.headingDeg]]
  const last = track[track.length - 1]
  if (renderMs <= track[0][0]) return pointSample(track[0])
  if (renderMs >= last[0]) return pointSample(last)

  let i = 0
  while (i + 1 < track.length && track[i + 1][0] <= renderMs) i++
  const p0 = track[i]
  const p1 = track[i + 1]
  const dtMs = p1[0] - p0[0]
  const u = dtMs > 0 ? (renderMs - p0[0]) / dtMs : 1
  const lat = p0[1] + (p1[1] - p0[1]) * u
  const lon = p0[2] + (p1[2] - p0[2]) * u

  const northM = (p1[1] - p0[1]) * METERS_PER_DEGREE_LATITUDE
  const eastM = (p1[2] - p0[2]) * METERS_PER_DEGREE_LATITUDE * Math.cos((p0[1] * Math.PI) / 180)
  const meters = Math.hypot(northM, eastM)
  // ~0.3 kn over the segment – below is berth wobble, not movement.
  const underWay = dtMs > 0 && meters / (dtMs / 1000) >= 0.15

  // Bearing: ease the reported heading (course as fallback) along the
  // shortest arc; without either, a segment long enough to trust gives
  // its own azimuth.
  const h0 = p0[5] ?? p0[4]
  const h1 = p1[5] ?? p1[4]
  let bearingDeg: number
  if (h0 !== null && h1 !== null) {
    const dh = ((h1 - h0 + 540) % 360) - 180
    bearingDeg = (h0 + dh * u + 360) % 360
  } else if (meters > 5) {
    bearingDeg = ((Math.atan2(eastM, northM) * 180) / Math.PI + 360) % 360
  } else {
    bearingDeg = h1 ?? h0 ?? 0
  }
  return { lon, lat, bearingDeg, underWay }
}
