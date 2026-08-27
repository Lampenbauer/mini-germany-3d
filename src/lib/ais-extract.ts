/**
 * Extraction and state keeping for aisstream.io messages: folds the raw
 * WebSocket JSON (PositionReport, StandardClassBPositionReport,
 * ShipStaticData, StaticDataReport) into one vessel record per MMSI.
 *
 * Used by the Vite dev middleware (vite.config.ts) and the unit tests;
 * in production server/api/ais.php does the same job in PHP – the parity
 * test (scripts/test-ais-parity.mjs) holds both to the same fixtures.
 */

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
}

/** Vessels drop out after this long without any position-carrying message. */
export const AIS_EXPIRE_MS = 30 * 60_000

/** Dead reckoning stops extrapolating beyond this data age. */
export const AIS_RECKON_CAP_MS = 90_000

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
  }

  // Position: the message payload is authoritative (full precision), the
  // MetaData copy fills in for static reports – it carries the last known
  // position either way.
  const report = raw.Message?.PositionReport ?? raw.Message?.StandardClassBPositionReport
  const lat = report?.Latitude ?? meta?.latitude
  const lon = report?.Longitude ?? meta?.longitude
  if (typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 90) {
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
 * The state as a serializable vessel list: expired entries dropped,
 * sorted by MMSI so the dev middleware, the PHP twin, and the fixtures
 * all agree on the order byte for byte.
 */
export function aisStateVessels(state: AisState, nowMs: number): AisVessel[] {
  const vessels: AisVessel[] = []
  for (const [mmsi, vessel] of state) {
    if (nowMs - vessel.positionAt > AIS_EXPIRE_MS) {
      state.delete(mmsi)
      continue
    }
    vessels.push(vessel)
  }
  return vessels.sort((a, b) => a.mmsi - b.mmsi)
}

const METERS_PER_DEGREE_LATITUDE = 111_320
const KNOTS_TO_METERS_PER_SECOND = 0.514444

/**
 * Position and bearing of a vessel at `nowMs`, moved along its course at
 * its reported speed – AIS fixes arrive every 2 s to 3 min, the frames in
 * between interpolate. Extrapolation is capped (AIS_RECKON_CAP_MS): stale
 * data freezes in place instead of sailing off the chart.
 */
export function deadReckon(
  vessel: AisVessel,
  nowMs: number,
): { lon: number; lat: number; bearingDeg: number } {
  const bearingDeg = vessel.headingDeg ?? vessel.cogDeg ?? 0
  const speed = vessel.sogKn ?? 0
  if (speed < 0.3 || vessel.cogDeg === null) {
    return { lon: vessel.lon, lat: vessel.lat, bearingDeg }
  }
  const dtSec = Math.max(0, Math.min(nowMs - vessel.positionAt, AIS_RECKON_CAP_MS)) / 1000
  const meters = speed * KNOTS_TO_METERS_PER_SECOND * dtSec
  const courseRad = (vessel.cogDeg * Math.PI) / 180
  const lat = vessel.lat + (meters * Math.cos(courseRad)) / METERS_PER_DEGREE_LATITUDE
  const lon =
    vessel.lon +
    (meters * Math.sin(courseRad)) /
      (METERS_PER_DEGREE_LATITUDE * Math.cos((vessel.lat * Math.PI) / 180))
  return { lon, lat, bearingDeg }
}
