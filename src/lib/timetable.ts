/**
 * Fahrplan-Engine: erzeugt Fahrten (Trips) und berechnet daraus die Position
 * jeder Straßenbahn zu einem Zeitpunkt.
 *
 * Standardmäßig wird ein realistischer Taktfahrplan synthetisiert (RSAG fährt
 * tagsüber im 10-Minuten-Takt). Liegt eine aus echten GTFS-Daten erzeugte
 * schedule.json vor (npm run data:gtfs), werden deren Abfahrtszeiten genutzt.
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
  /** Ankunft in Sekunden seit Mitternacht (Europe/Berlin). */
  arrival: number
  /** Abfahrt in Sekunden seit Mitternacht. */
  departure: number
}

export interface Trip {
  id: string
  lineId: string
  direction: 0 | 1
  stopTimes: StopTime[]
}

/** Taktzeitfenster in Minuten seit Mitternacht. */
export interface HeadwaySpan {
  startMin: number
  endMin: number
  headwayMin: number
}

/** Angelehnt an den RSAG-Werktagstakt. */
export const DEFAULT_SERVICE: HeadwaySpan[] = [
  { startMin: 4 * 60 + 30, endMin: 6 * 60, headwayMin: 20 },
  { startMin: 6 * 60, endMin: 19 * 60, headwayMin: 10 },
  { startMin: 19 * 60, endMin: 21 * 60, headwayMin: 15 },
  { startMin: 21 * 60, endMin: 24 * 60, headwayMin: 20 },
]

/**
 * Synthetische Takte pro Verkehrsmittel, falls schedule.json keine echten
 * Abfahrten liefert. Busse fahren seltener als Trams, die Fähren pendeln
 * tagsüber in dichter Folge (Kabutzenhof alle 15 min, Hohe Düne ähnlich).
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
  /** Modus-spezifische Reisegeschwindigkeit (m/s); fehlend = cruiseSpeedMps. */
  cruiseSpeedByMode?: Partial<Record<TransitMode, number>>
}

/** Abfahrtszeiten (Sekunden seit Mitternacht) aus einem Taktschema. */
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
 * Fahrzeit-Offsets (Ankunft/Abfahrt relativ zur Startabfahrt) für eine
 * Richtung, abgeleitet aus den Haltestellen-Distanzen.
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

/** Stabile Fahrt-ID der Simulation (auch fürs GTFS-Realtime-Matching). */
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
 * Optionale echte Abfahrtszeiten aus schedule.json:
 * { lines: { [lineId]: { [direction]: { departures, tripIds? } } } }
 * tripIds (parallel zu departures) sind die GTFS-trip_ids des Feeds –
 * sie verbinden die Simulations-Fahrten mit GTFS-Realtime-TripUpdates.
 */
export interface ScheduleJson {
  meta?: { source?: string; serviceDate?: string }
  lines?: Record<string, Record<string, { departures: number[]; tripIds?: string[] }>>
}

/** Abbildung GTFS-trip_id → Simulations-Fahrt-ID aus schedule.json. */
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
  /** Distanz entlang des Richtungs-Pfads in Metern. */
  distance: number
  lon: number
  lat: number
  bearing: number
  status: TramStatus
  /** Index der nächsten Haltestelle (in Fahrtrichtung). */
  nextStopIndex: number
}

/** Zustand einer Fahrt zum Zeitpunkt tSec, oder null wenn nicht unterwegs. */
export function tripStateAt(
  trip: Trip,
  dir: PreparedDirection,
  tSec: number,
): TramState | null {
  const st = trip.stopTimes
  const first = st[0]
  const last = st[st.length - 1]
  if (tSec < first.departure || tSec > last.arrival) return null

  // Segment suchen, in dem tSec liegt
  for (let i = 0; i < st.length; i++) {
    const cur = st[i]

    // An einer Haltestelle (Ankunft <= t <= Abfahrt)
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

    // Zwischen dieser und der nächsten Haltestelle
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

/** Alle aktiven Straßenbahnen zum Zeitpunkt tSec. */
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
