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
   * Acceleration and braking rate between stops in m/s² (see
   * profileDistance); missing = constant speed, the shape the tests'
   * hand-built trips have.
   */
  accel?: number
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
   * Acceleration and braking rate per mode in m/s² (see profileDistance);
   * missing = a vehicle at constant speed between its stops.
   */
  accelerationByMode?: Partial<Record<TransitMode, number>>
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

/**
 * One point of a trip's own timetable: where it is on the direction's
 * path (meters) and when the feed has it there (arrival and departure in
 * seconds after the trip's departure from its first stop). A trip's
 * points come from the GTFS stop_times (schedule.json `patterns`); the
 * network's stops take their times from them (stopTimesFromTimePoints).
 */
export interface TimePoint {
  dist: number
  arrival: number
  departure: number
}

/**
 * A pattern as schedule.json writes it – [dist, arrival, departure, …],
 * flat, the way the GTFS step lays it out – read back into points.
 * Anything malformed means "no timetable points" (the cruise speed then).
 */
export function timePointsFromPattern(
  flat: readonly number[] | null | undefined,
): TimePoint[] | null {
  if (!flat || flat.length < 6 || flat.length % 3 !== 0) return null
  const points: TimePoint[] = []
  for (let i = 0; i < flat.length; i += 3) {
    const dist = flat[i]
    const arrival = flat[i + 1]
    const departure = flat[i + 2]
    if (!Number.isFinite(dist) || !Number.isFinite(arrival) || !Number.isFinite(departure)) return null
    const prev = points[points.length - 1]
    if (prev && (dist <= prev.dist || arrival < prev.departure)) return null
    points.push({ dist, arrival, departure: Math.max(arrival, departure) })
  }
  // A pattern at an impossible pace has no real times behind it: the
  // free feed repeats a trip's first time at every stop for some
  // operators, and a trip run on that would cross the city in seconds
  const first = points[0]
  const end = points[points.length - 1]
  const seconds = end.arrival - first.departure
  if (seconds <= 0 || (end.dist - first.dist) / seconds > MAX_TIME_POINT_MPS) return null
  return points
}

/**
 * The fastest a pattern may run over its whole length, in m/s (160 km/h
 * on average); the GTFS step rejects the same (MAX_PATTERN_MPS).
 */
export const MAX_TIME_POINT_MPS = 45

/**
 * A network stop this close to one of the trip's time points takes that
 * point's times: the GTFS platform coordinates land a few dozen meters
 * off the OSM path (the span projection allows the same slack).
 */
export const TIME_POINT_SNAP_M = 150

/** The least a vehicle is under way between two stops, in seconds. */
const MIN_RUN_SECONDS = 5

/**
 * The stop times of the served stops `first`..`last` from the trip's own
 * time points: a stop at a time point takes its arrival and departure,
 * one between two points is passed at the time the distance says, one
 * outside every point is reached at the cruise speed from the nearest.
 * The feed has no dwell at most stops (arrival equals departure), so the
 * vehicle is shown standing `dwellSeconds` before every departure – the
 * stop is a stop – as long as the run from the stop before keeps
 * MIN_RUN_SECONDS. The trip departs its first served stop at `dep`.
 */
export function stopTimesFromTimePoints(
  dir: PreparedDirection,
  first: number,
  last: number,
  dep: number,
  points: readonly TimePoint[],
  cruiseSpeedMps: number,
  dwellSeconds: number,
): StopTime[] {
  // Relative to the trip's departure until the end – absolute times and
  // offsets must not meet in one comparison
  const offsets: { arrival: number; departure: number }[] = []
  for (let i = first; i <= last; i++) {
    const d = dir.stops[i].dist
    let arrival: number
    let departure: number
    // The nearest point, and whether it is this stop's own
    let nearest = 0
    for (let k = 1; k < points.length; k++) {
      if (Math.abs(points[k].dist - d) < Math.abs(points[nearest].dist - d)) nearest = k
    }
    if (Math.abs(points[nearest].dist - d) <= TIME_POINT_SNAP_M) {
      arrival = points[nearest].arrival
      departure = points[nearest].departure
    } else if (d < points[0].dist) {
      arrival = departure = points[0].arrival - (points[0].dist - d) / cruiseSpeedMps
    } else if (d > points[points.length - 1].dist) {
      const end = points[points.length - 1]
      arrival = departure = end.departure + (d - end.dist) / cruiseSpeedMps
    } else {
      let j = 0
      while (j + 1 < points.length && points[j + 1].dist <= d) j++
      const a = points[j]
      const b = points[j + 1]
      const t = (d - a.dist) / (b.dist - a.dist)
      arrival = departure = a.departure + (b.arrival - a.departure) * t
    }
    // A stop is a stop: the vehicle stands dwellSeconds before it leaves
    // – not at the ends, where the trip begins with its departure and
    // ends with its arrival
    if (i !== first && i !== last && departure - arrival < dwellSeconds) {
      arrival = departure - dwellSeconds
    }
    const prev = offsets[offsets.length - 1]
    if (prev) {
      // Never back in time, and under way between the two for a moment
      arrival = Math.max(arrival, prev.departure + MIN_RUN_SECONDS)
      departure = Math.max(departure, arrival)
    }
    if (i === first) arrival = departure = 0
    if (i === last) departure = arrival
    offsets.push({ arrival: Math.round(arrival), departure: Math.round(departure) })
  }
  return offsets.map((offset, k) => ({
    stopIndex: first + k,
    arrival: dep + offset.arrival,
    departure: dep + offset.departure,
  }))
}

export function buildTripsForDirection(
  line: PreparedLine,
  direction: 0 | 1,
  departures: number[],
  opts: TimetableOptions,
  spans?: readonly (TripSpan | undefined)[],
  timePoints?: readonly (readonly TimePoint[] | null | undefined)[],
): Trip[] {
  const dir = line.directions[direction]
  const speed = opts.cruiseSpeedByMode?.[line.mode] ?? opts.cruiseSpeedMps
  const accel = opts.accelerationByMode?.[line.mode]
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
    const points = timePoints?.[tripIndex]
    let stopTimes: StopTime[]
    if (points && points.length >= 2) {
      // The trip's own timetable, from the feed
      stopTimes = stopTimesFromTimePoints(dir, first, last, dep, points, speed, opts.dwellSeconds)
    } else {
      stopTimes = []
      for (let i = first; i <= last; i++) {
        // Shift so the trip departs its real first stop at `dep`. The first
        // stop gets no leading dwell, the last no trailing one (trip ends).
        const arrival = i === first ? dep : dep + offsets[i].arrival - offsets[first].departure
        const departure =
          i === first ? dep : i === last ? arrival : dep + offsets[i].departure - offsets[first].departure
        stopTimes.push({ stopIndex: i, arrival, departure })
      }
    }
    const trip: Trip = {
      id: simTripId(line.id, direction, dep, span),
      lineId: line.id,
      direction,
      stopTimes,
    }
    if (accel !== undefined) trip.accel = accel
    if (span) {
      trip.origin = dir.stops[first].name
      trip.destination = dir.stops[last].name
    }
    return trip
  })
}

/**
 * Optional real departure times from schedule.json:
 * { lines: { [lineId]: { [direction]: { departures, tripIds?, spans?, patterns?, patternIds? } } } }
 * tripIds (parallel to departures) are the feed's GTFS trip_ids – they
 * connect the simulation trips to GTFS-Realtime TripUpdates. spans (also
 * parallel) mark short workings: [start, end] meters along the direction's
 * path, null for full-route trips. patterns are the trips' own timetables
 * – [dist, arrival, departure, …] flat per pattern, see TimePoint – and
 * patternIds (parallel to departures) say which pattern a trip runs, null
 * for a trip without one (a ring's round, a ferry loop's leg).
 */
export interface ScheduleJson {
  meta?: { source?: string; serviceCount?: number }
  lines?: Record<
    string,
    Record<
      string,
      {
        departures: number[]
        tripIds?: string[]
        spans?: (number[] | null)[]
        patterns?: number[][]
        patternIds?: (number | null)[]
      }
    >
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
        // Sort departures, spans and patterns together (parallel arrays)
        const patterns = (real.patterns ?? []).map(timePointsFromPattern)
        const order = real.departures
          .map((dep, i) => ({
            dep,
            span: normalizeSpan(real.spans?.[i]),
            points: patterns[real.patternIds?.[i] ?? -1] ?? null,
          }))
          .sort((a, b) => a.dep - b.dep)
        trips.push(
          ...buildTripsForDirection(
            line,
            direction,
            order.map((o) => o.dep),
            opts,
            order.map((o) => o.span),
            order.map((o) => o.points),
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
 * How far a vehicle has come `t` seconds into a run of `length` meters
 * that takes `duration` seconds, accelerating and braking at `accel`
 * m/s²: a trapezoid – up to the cruise speed the run's time allows, along
 * at it, down again – or, where the run is too short to reach any cruise
 * speed at that rate, a triangle that peaks halfway. Without a rate (or
 * a run of no time) the speed is constant, which is what it was before:
 * a tram that left its stop at 30 km/h and arrived at 30 km/h.
 */
export function profileDistance(
  length: number,
  duration: number,
  t: number,
  accel: number | undefined,
): number {
  if (length <= 0 || duration <= 0) return 0
  const u = Math.min(1, Math.max(0, t / duration))
  if (!(accel !== undefined && accel > 0)) return length * u
  const time = u * duration
  const disc = accel * accel * duration * duration - 4 * accel * length
  let rampSeconds: number
  let rate: number
  if (disc >= 0) {
    // Trapezoid: the smaller root is the cruise speed, reached in v/a
    const cruise = (accel * duration - Math.sqrt(disc)) / 2
    rampSeconds = cruise / accel
    rate = accel
  } else {
    // Triangle: no cruise, the peak at half time
    rampSeconds = duration / 2
    rate = (4 * length) / (duration * duration)
  }
  if (time <= rampSeconds) return 0.5 * rate * time * time
  if (time >= duration - rampSeconds) {
    const left = duration - time
    return length - 0.5 * rate * left * left
  }
  return 0.5 * rate * rampSeconds * rampSeconds + rate * rampSeconds * (time - rampSeconds)
}

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
      const d0 = dir.stops[cur.stopIndex].dist
      const d1 = dir.stops[next.stopIndex].dist
      const dist =
        d0 + profileDistance(d1 - d0, next.arrival - cur.departure, tSec - cur.departure, trip.accel)
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
