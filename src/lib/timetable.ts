/**
 * Timetable engine: generates trips and, from them, computes the position
 * of every tram at a point in time.
 *
 * By default a realistic interval timetable is synthesized (RSAG runs every
 * 10 minutes during the day). If a schedule.json generated from real GTFS
 * data exists (npm run data:gtfs), its departure times are used instead.
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
 * Synthetic headways per transit mode in case schedule.json provides no real
 * departures. Buses run less often than trams; the ferries shuttle back and
 * forth frequently during the day (Kabutzenhof every 15 min, Hohe Düne
 * similar).
 */
export const DEFAULT_SERVICE_BY_MODE: Record<TransitMode, HeadwaySpan[]> = {
  tram: DEFAULT_SERVICE,
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

/** Stable simulation trip id (also used for GTFS-Realtime matching). */
export function simTripId(lineId: string, direction: 0 | 1, departureSec: number): string {
  return `${lineId}-${direction}-${Math.round(departureSec / 60)}`
}

export function buildTripsForDirection(
  line: PreparedLine,
  direction: 0 | 1,
  departures: number[],
  opts: TimetableOptions,
): Trip[] {
  const dir = line.directions[direction]
  const speed = opts.cruiseSpeedByMode?.[line.mode] ?? opts.cruiseSpeedMps
  const offsets = stopOffsets(dir, speed, opts.dwellSeconds)
  return departures.map((dep) => ({
    id: simTripId(line.id, direction, dep),
    lineId: line.id,
    direction,
    stopTimes: offsets.map((o, stopIndex) => ({
      stopIndex,
      arrival: dep + o.arrival,
      departure: dep + o.departure,
    })),
  }))
}

/**
 * Optional real departure times from schedule.json:
 * { lines: { [lineId]: { [direction]: { departures, tripIds? } } } }
 * tripIds (parallel to departures) are the feed's GTFS trip_ids – they
 * connect the simulation trips to GTFS-Realtime TripUpdates.
 */
export interface ScheduleJson {
  meta?: { source?: string; serviceDate?: string }
  lines?: Record<string, Record<string, { departures: number[]; tripIds?: string[] }>>
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
        if (gtfsTripId) map.set(gtfsTripId, simTripId(lineId, direction, dep))
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
  const defaultDepartures = new Map<TransitMode, number[]>()
  const fallbackDepartures = (mode: TransitMode): number[] => {
    let deps = defaultDepartures.get(mode)
    if (!deps) {
      deps = departuresFromService(opts.service ?? DEFAULT_SERVICE_BY_MODE[mode])
      defaultDepartures.set(mode, deps)
    }
    return deps
  }

  for (const line of network.lines) {
    for (const direction of [0, 1] as const) {
      const real = schedule?.lines?.[line.id]?.[String(direction)]?.departures
      const departures =
        real && real.length > 0
          ? [...real].sort((a, b) => a - b)
          : fallbackDepartures(line.mode)
      trips.push(...buildTripsForDirection(line, direction, departures, opts))
    }
  }
  return trips
}

export type TramStatus = 'dwell' | 'moving'

export interface TramState {
  tripId: string
  lineId: string
  direction: 0 | 1
  /** Distance along the direction path in meters. */
  distance: number
  lon: number
  lat: number
  bearing: number
  status: TramStatus
  /** Index of the next stop (in direction of travel). */
  nextStopIndex: number
}

/** State of a trip at time tSec, or null if not underway. */
export function tripStateAt(
  trip: Trip,
  dir: PreparedDirection,
  tSec: number,
): TramState | null {
  const st = trip.stopTimes
  const first = st[0]
  const last = st[st.length - 1]
  if (tSec < first.departure || tSec > last.arrival) return null

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

/** All active trams at time tSec. */
export function activeTramStates(
  trips: Trip[],
  network: PreparedNetwork,
  tSec: number,
): TramState[] {
  const states: TramState[] = []
  for (const trip of trips) {
    const line = network.lineById.get(trip.lineId)
    if (!line) continue
    const state = tripStateAt(trip, line.directions[trip.direction], tSec)
    if (state) states.push(state)
  }
  return states
}
