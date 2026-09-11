/**
 * Timetable engine: generates trips and, from them, computes the position
 * of every tram at a point in time.
 *
 * By default a realistic interval timetable is synthesized (a tram every
 * 10 minutes during the day, modeled after the Rostock RSAG service). If a
 * schedule.json generated from real GTFS data exists (npm run data:gtfs),
 * its departure times are used instead.
 */

import { sampleAtDistance } from '@/lib/geo'
import type {
  PreparedDirection,
  PreparedLine,
  PreparedNetwork,
  TransitMode,
} from '@/data/network-types'

export interface StopTime {
  /** Index in direction.stops */
  stopIndex: number
  /** Arrival in seconds since midnight (Europe/Berlin). */
  arrival: number
  /** Departure in seconds since midnight. */
  departure: number
}

export interface Trip {
  id: string
  lineId: string
  direction: 0 | 1
  stopTimes: StopTime[]
  /**
   * Set for short workings (trips serving only part of the route): display
   * names of the actually served first/last stop. Full-route trips keep the
   * line's terminus names.
   */
  origin?: string
  destination?: string
}

/** Headway time window in minutes since midnight. */
export interface HeadwaySpan {
  startMin: number
  endMin: number
  headwayMin: number
}

/** Modeled after the RSAG weekday schedule. */
export const DEFAULT_SERVICE: HeadwaySpan[] = [
  { startMin: 4 * 60 + 30, endMin: 6 * 60, headwayMin: 20 },
  { startMin: 6 * 60, endMin: 19 * 60, headwayMin: 10 },
  { startMin: 19 * 60, endMin: 21 * 60, headwayMin: 15 },
  { startMin: 21 * 60, endMin: 24 * 60, headwayMin: 20 },
]

/**
 * Synthetic headways per transit mode, used only when no schedule.json is
 * available at all (development without data, broken fetch). With a real
 * timetable present, lines the feed does not serve stay off the map instead
 * of running on an invented headway. Buses run less often than trams; the
 * ferries shuttle back and forth frequently during the day (Kabutzenhof
 * every 15 min, Hohe Düne similar).
 */
export const DEFAULT_SERVICE_BY_MODE: Record<TransitMode, HeadwaySpan[]> = {
  tram: DEFAULT_SERVICE,
  // Subway fallback: a plain 10-minute service through the day.
  subway: [{ startMin: 4 * 60 + 30, endMin: 24 * 60, headwayMin: 10 }],
  // S-Bahn fallback: each of the three lines every 30 min ≈ the real
  // 7.5–15 min combined headway on the shared Warnemünde corridor.
  train: [{ startMin: 4 * 60 + 30, endMin: 24 * 60, headwayMin: 30 }],
  bus: [
    { startMin: 5 * 60, endMin: 6 * 60, headwayMin: 30 },
    { startMin: 6 * 60, endMin: 19 * 60, headwayMin: 20 },
    { startMin: 19 * 60, endMin: 23 * 60, headwayMin: 30 },
  ],
  ferry: [{ startMin: 6 * 60, endMin: 21 * 60, headwayMin: 15 }],
}

export interface TimetableOptions {
  cruiseSpeedMps: number
  dwellSeconds: number
  service?: HeadwaySpan[]
  /** Mode-specific travel speed (m/s); missing = cruiseSpeedMps. */
  cruiseSpeedByMode?: Partial<Record<TransitMode, number>>
  /**
   * Turnaround time at the terminus in seconds (vehicle stays at its final
   * stop this long after arrival). Runtime-only – does not affect the
   * generated stop times. Missing = 0.
   */
  terminalLingerSeconds?: number
}

/** Departure times (seconds since midnight) from a headway scheme. */
export function departuresFromService(service: HeadwaySpan[]): number[] {
  const deps: number[] = []
  for (const span of service) {
    for (let m = span.startMin; m < span.endMin; m += span.headwayMin) {
      deps.push(m * 60)
    }
  }
  return [...new Set(deps)].sort((a, b) => a - b)
}

/**
 * The same headway scheme shifted by half a headway – used for the return
 * direction of shuttle services. The Warnow ferries are a single vessel
 * going back and forth: identical departure minutes on both banks would put
 * two boats on the water at once, offset departures put one (as long as the
 * crossing takes less than half the headway).
 */
export function interleavedService(service: HeadwaySpan[]): HeadwaySpan[] {
  return service.map((span) => ({ ...span, startMin: span.startMin + span.headwayMin / 2 }))
}

/**
 * Travel-time offsets (arrival/departure relative to the initial departure)
 * for a direction, derived from the stop distances.
 */
export function stopOffsets(
  dir: PreparedDirection,
  cruiseSpeedMps: number,
  dwellSeconds: number,
): { arrival: number; departure: number }[] {
  const offsets: { arrival: number; departure: number }[] = []
  let t = 0
  for (let i = 0; i < dir.stops.length; i++) {
    if (i === 0) {
      offsets.push({ arrival: 0, departure: 0 })
      continue
    }
    const segment = dir.stops[i].dist - dir.stops[i - 1].dist
    t += segment / cruiseSpeedMps
    const arrival = Math.round(t)
    const isLast = i === dir.stops.length - 1
    if (!isLast) t += dwellSeconds
    offsets.push({ arrival, departure: isLast ? arrival : Math.round(t) })
  }
  return offsets
}

/**
 * Along-route section a short working serves, as [start, end] meters on the
 * direction's path (from the GTFS extraction). null/undefined = full route.
 */
export type TripSpan = readonly [number, number] | null

/**
 * Validates a raw span from schedule.json (plain JSON arrays carry no tuple
 * type). Anything but a two-number array means "full route".
 */
export function normalizeSpan(raw: readonly number[] | null | undefined): TripSpan {
  return raw && raw.length === 2 ? [raw[0], raw[1]] : null
}

/** Stable simulation trip id (also used for GTFS-Realtime matching). */
export function simTripId(
  lineId: string,
  direction: 0 | 1,
  departureSec: number,
  span?: TripSpan,
): string {
  const base = `${lineId}-${direction}-${Math.round(departureSec / 60)}`
  // Short workings can depart at the same minute as a full-route trip –
  // the span keeps their ids distinct.
  return span ? `${base}-s${span[0]}-${span[1]}` : base
}

/**
 * Projection slack when mapping span endpoints onto network stops: GTFS
 * platform coordinates land a few dozen meters off the OSM path, so stops
 * up to this far outside the span still count as served. Kept tight on
 * purpose – overshooting would put vehicles on sections their trip never
 * serves (with rural bus stops ~1 km apart, "nearest stop" overshot by
 * 500+ m).
 */
const SPAN_SNAP_TOLERANCE = 150

/**
 * Range of stop indices inside [span[0], span[1]] (± tolerance), or null
 * when fewer than two stops fall inside.
 */
function servedStopRange(
  dir: PreparedDirection,
  span: readonly [number, number],
): [number, number] | null {
  let first = -1
  let last = -1
  for (let i = 0; i < dir.stops.length; i++) {
    const dist = dir.stops[i].dist
    if (dist < span[0] - SPAN_SNAP_TOLERANCE) continue
    if (dist > span[1] + SPAN_SNAP_TOLERANCE) break
    if (first === -1) first = i
    last = i
  }
  return first !== -1 && last - first >= 1 ? [first, last] : null
}

export function buildTripsForDirection(
  line: PreparedLine,
  direction: 0 | 1,
  departures: number[],
  opts: TimetableOptions,
  spans?: readonly (TripSpan | undefined)[],
): Trip[] {
  const dir = line.directions[direction]
  const speed = opts.cruiseSpeedByMode?.[line.mode] ?? opts.cruiseSpeedMps
  const offsets = stopOffsets(dir, speed, opts.dwellSeconds)
  return departures.map((dep, tripIndex) => {
    // Short working: only the stops between the span endpoints are served.
    let span = spans?.[tripIndex] ?? null
    let first = 0
    let last = dir.stops.length - 1
    const range = span ? servedStopRange(dir, span) : null
    if (span && !range) {
      // Degenerate span (fewer than two stops inside) – treat as a full trip
      span = null
    } else if (range) {
      ;[first, last] = range
    }
    const stopTimes: StopTime[] = []
    for (let i = first; i <= last; i++) {
      // Shift so the trip departs its real first stop at `dep`. The first
      // stop gets no leading dwell, the last no trailing one (trip ends).
      const arrival = i === first ? dep : dep + offsets[i].arrival - offsets[first].departure
      const departure =
        i === first ? dep : i === last ? arrival : dep + offsets[i].departure - offsets[first].departure
      stopTimes.push({ stopIndex: i, arrival, departure })
    }
    const trip: Trip = {
      id: simTripId(line.id, direction, dep, span),
      lineId: line.id,
      direction,
      stopTimes,
    }
    if (span) {
      trip.origin = dir.stops[first].name
      trip.destination = dir.stops[last].name
    }
    return trip
  })
}

/**
 * Optional real departure times from schedule.json:
 * { lines: { [lineId]: { [direction]: { departures, tripIds?, spans? } } } }
 * tripIds (parallel to departures) are the feed's GTFS trip_ids – they
 * connect the simulation trips to GTFS-Realtime TripUpdates. spans (also
 * parallel) mark short workings: [start, end] meters along the direction's
 * path, null for full-route trips.
 */
export interface ScheduleJson {
  meta?: { source?: string; serviceCount?: number }
  lines?: Record<
    string,
    Record<string, { departures: number[]; tripIds?: string[]; spans?: (number[] | null)[] }>
  >
}

/** Mapping GTFS trip_id → simulation trip id from schedule.json. */
export function buildRealtimeTripIdMap(schedule?: ScheduleJson): Map<string, string> {
  const map = new Map<string, string>()
  if (!schedule?.lines) return map
  for (const [lineId, dirs] of Object.entries(schedule.lines)) {
    for (const [dirKey, data] of Object.entries(dirs)) {
      if (!data.tripIds) continue
      const direction = dirKey === '1' ? 1 : 0
      data.departures.forEach((dep, i) => {
        const gtfsTripId = data.tripIds![i]
        if (gtfsTripId)
          map.set(gtfsTripId, simTripId(lineId, direction, dep, normalizeSpan(data.spans?.[i])))
      })
    }
  }
  return map
}

export function buildAllTrips(
  network: PreparedNetwork,
  opts: TimetableOptions,
  schedule?: ScheduleJson,
): Trip[] {
  const trips: Trip[] = []
  const defaultDepartures = new Map<string, number[]>()
  const fallbackDepartures = (mode: TransitMode, direction: 0 | 1): number[] => {
    const service = opts.service ?? DEFAULT_SERVICE_BY_MODE[mode]
    // Ferries are single vessels shuttling between two piers – the return
    // direction departs offset by half the headway so only one boat is on
    // the water at a time (see interleavedService).
    const interleave = mode === 'ferry' && direction === 1
    const key = `${mode}:${interleave ? 1 : 0}`
    let deps = defaultDepartures.get(key)
    if (!deps) {
      deps = departuresFromService(interleave ? interleavedService(service) : service)
      defaultDepartures.set(key, deps)
    }
    return deps
  }

  // The synthetic headway only fills in when there is no timetable at all.
  // With a real feed, a line without departures genuinely does not run that
  // day (e.g. line 2 while the 2026 Werftdreieck track works suspend it) and
  // must not be simulated onto the map.
  const hasSchedule = schedule?.lines != null && Object.keys(schedule.lines).length > 0

  for (const line of network.lines) {
    for (const direction of [0, 1] as const) {
      const real = schedule?.lines?.[line.id]?.[String(direction)]
      if (real && real.departures.length > 0) {
        // Sort departures and spans together (parallel arrays)
        const order = real.departures
          .map((dep, i) => ({ dep, span: normalizeSpan(real.spans?.[i]) }))
          .sort((a, b) => a.dep - b.dep)
        trips.push(
          ...buildTripsForDirection(
            line,
            direction,
            order.map((o) => o.dep),
            opts,
            order.map((o) => o.span),
          ),
        )
      } else if (!hasSchedule) {
        trips.push(
          ...buildTripsForDirection(line, direction, fallbackDepartures(line.mode, direction), opts),
        )
      }
    }
  }
  return trips
}

export type VehicleStatus = 'dwell' | 'moving'

export interface VehicleState {
  tripId: string
  lineId: string
  direction: 0 | 1
  /** Distance along the direction path in meters. */
  distance: number
  lon: number
  lat: number
  bearing: number
  status: VehicleStatus
  /** Index of the next stop (in direction of travel). */
  nextStopIndex: number
}

export const DAY_SECONDS = 24 * 3600

/**
 * State of a trip at time tSec, or null if not underway.
 * terminalLingerSec keeps the vehicle standing at its final stop that long
 * after the trip's last arrival (turnaround time at the terminus).
 */
export function tripStateAt(
  trip: Trip,
  dir: PreparedDirection,
  tSec: number,
  terminalLingerSec = 0,
): VehicleState | null {
  const st = trip.stopTimes
  const first = st[0]
  const last = st[st.length - 1]
  const tripEnd = last.arrival + terminalLingerSec
  if (tSec < first.departure || tSec > tripEnd) {
    // GTFS encodes after-midnight service as times past 24:00 (the Fledermaus
    // night buses depart at up to ~28:00). The clock only ever yields 0–24 h,
    // so probe the same time of day on the following service day.
    if (tSec + DAY_SECONDS >= first.departure && tSec + DAY_SECONDS <= tripEnd) {
      tSec += DAY_SECONDS
    } else {
      return null
    }
  }

  // Terminal layover: standing at the final stop after the last arrival
  // (the next stop is the terminus itself – the trip goes nowhere else).
  if (tSec >= last.arrival) {
    const dist = dir.stops[last.stopIndex].dist
    const sample = sampleAtDistance(dir.path, dir.cum, dist)
    return {
      tripId: trip.id,
      lineId: trip.lineId,
      direction: trip.direction,
      distance: dist,
      lon: sample.lon,
      lat: sample.lat,
      bearing: sample.bearing,
      status: 'dwell',
      nextStopIndex: last.stopIndex,
    }
  }

  // Find the segment containing tSec
  for (let i = 0; i < st.length; i++) {
    const cur = st[i]

    // At a stop (arrival <= t <= departure)
    if (tSec >= cur.arrival && tSec <= cur.departure) {
      const dist = dir.stops[cur.stopIndex].dist
      const sample = sampleAtDistance(dir.path, dir.cum, dist)
      return {
        tripId: trip.id,
        lineId: trip.lineId,
        direction: trip.direction,
        distance: dist,
        lon: sample.lon,
        lat: sample.lat,
        bearing: sample.bearing,
        status: 'dwell',
        nextStopIndex: Math.min(cur.stopIndex + 1, dir.stops.length - 1),
      }
    }

    // Between this stop and the next one
    const next = st[i + 1]
    if (next && tSec > cur.departure && tSec < next.arrival) {
      const t = (tSec - cur.departure) / (next.arrival - cur.departure)
      const d0 = dir.stops[cur.stopIndex].dist
      const d1 = dir.stops[next.stopIndex].dist
      const dist = d0 + (d1 - d0) * t
      const sample = sampleAtDistance(dir.path, dir.cum, dist)
      return {
        tripId: trip.id,
        lineId: trip.lineId,
        direction: trip.direction,
        distance: dist,
        lon: sample.lon,
        lat: sample.lat,
        bearing: sample.bearing,
        status: 'moving',
        nextStopIndex: next.stopIndex,
      }
    }
  }
  return null
}

/** All active vehicles at time tSec. */
export function activeVehicleStates(
  trips: Trip[],
  network: PreparedNetwork,
  tSec: number,
): VehicleState[] {
  const states: VehicleState[] = []
  for (const trip of trips) {
    const line = network.lineById.get(trip.lineId)
    if (!line) continue
    const state = tripStateAt(trip, line.directions[trip.direction], tSec)
    if (state) states.push(state)
  }
  return states
}
