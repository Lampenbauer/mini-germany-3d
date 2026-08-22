/**
 * Link between clock, timetable, and map: delivers the state of all active
 * vehicles per frame as display-ready snapshots.
 */

import { SimClock } from '@/lib/clock'
import { heightAtDistance } from '@/lib/geo'
import { buildAllTrips, buildRealtimeTripIdMap, DAY_SECONDS, tripStateAt } from '@/lib/timetable'
import type { ScheduleJson, TimetableOptions, Trip } from '@/lib/timetable'
import { isInTunnel } from '@/lib/tunnels'
import type { PreparedNetwork, TransitMode, VehicleDimensions } from '@/data/network-types'
import { config } from '@/config'

export interface VehicleSnapshot {
  id: string
  lineId: string
  lineName: string
  color: string
  /** Transit mode of the line (tram, bus, or ferry). */
  mode: TransitMode
  /** Vehicle dimensions for the 3D box in meters. */
  vehicle: VehicleDimensions
  direction: 0 | 1
  lon: number
  lat: number
  bearing: number
  status: 'dwell' | 'moving'
  /**
   * Terrain height in meters NHN at the current position, interpolated
   * from the direction's per-vertex DGM heights; undefined when the
   * direction carries no height data (the map then samples the 3D tiles).
   */
  nhn?: number
  /** true while the vehicle is inside a tunnel/underground route section. */
  inTunnel: boolean
  nextStopName: string
  destination: string
  origin: string
  /** Current delay in seconds (from GTFS-Realtime; 0 = on schedule). */
  delaySeconds: number
  /** true if this trip is currently overlaid by GTFS-Realtime data. */
  realtime: boolean
}

/** One stop of an active trip (see tripProgress). */
export interface TripStop {
  name: string
  /**
   * Predicted arrival in seconds since midnight (Europe/Berlin), with the
   * trip's current GTFS-RT delay already applied.
   */
  arrivalSec: number
  lon: number
  lat: number
  /** Terrain height in meters NHN at the stop, when the dataset has one. */
  nhn?: number
  /** The vehicle has already departed this stop. */
  passed: boolean
}

/** All stops of an active trip plus the vehicle's position among them. */
export interface TripProgress {
  stops: TripStop[]
  /**
   * Position on the stop sequence: the integer part is the index of the
   * last stop reached, the fraction the travel progress toward the next
   * one (1.5 = halfway between stops[1] and stops[2]). Exactly k while
   * dwelling at stop k.
   */
  position: number
}

export class Simulation {
  readonly network: PreparedNetwork
  readonly clock: SimClock
  /** GTFS trip_id → simulation trip id (for GTFS-Realtime matching). */
  readonly realtimeTripIdMap: ReadonlyMap<string, string>
  private trips: Trip[]
  private tripById: Map<string, Trip>
  private realtimeDelays = new Map<string, number>()

  constructor(
    network: PreparedNetwork,
    clock: SimClock = new SimClock(),
    schedule?: ScheduleJson,
    options?: Partial<TimetableOptions>,
  ) {
    this.network = network
    this.clock = clock
    const opts: TimetableOptions = {
      cruiseSpeedMps: options?.cruiseSpeedMps ?? config.simulation.cruiseSpeedMps,
      dwellSeconds: options?.dwellSeconds ?? config.simulation.dwellSeconds,
      service: options?.service,
      // An explicitly set speed applies to all modes (tests); otherwise
      // buses/ferries travel at their more realistic default speeds.
      cruiseSpeedByMode:
        options?.cruiseSpeedByMode ??
        (options?.cruiseSpeedMps != null ? undefined : config.simulation.cruiseSpeedByMode),
    }
    this.trips = buildAllTrips(network, opts, schedule)
    this.tripById = new Map(this.trips.map((trip) => [trip.id, trip]))
    this.realtimeTripIdMap = buildRealtimeTripIdMap(schedule)
  }

  get tripCount(): number {
    return this.trips.length
  }

  /** Set active delays (simulation trip id → seconds). */
  setRealtimeDelays(delays: Map<string, number>): void {
    this.realtimeDelays = delays
  }

  get realtimeDelayCount(): number {
    return this.realtimeDelays.size
  }

  /** Snapshots of all active vehicles at the current simulation time. */
  snapshots(): VehicleSnapshot[] {
    return this.snapshotsAt(this.clock.secondsOfDay())
  }

  /**
   * All stops of an active trip with predicted arrival times (scheduled
   * arrivals shifted by the trip's current GTFS-RT delay) plus the
   * vehicle's current position on the stop sequence. null for unknown or
   * currently inactive trips.
   */
  tripProgress(tripId: string, tSec = this.clock.secondsOfDay()): TripProgress | null {
    const trip = this.tripById.get(tripId)
    if (!trip) return null
    const line = this.network.lineById.get(trip.lineId)
    if (!line) return null
    const dir = line.directions[trip.direction]

    // Same time frame as snapshotsAt: a delayed trip runs `delay` seconds
    // behind its schedule, and after-midnight service is encoded past 24:00.
    const delay = this.realtimeDelays.get(trip.id) ?? 0
    let effective = tSec - delay
    const first = trip.stopTimes[0]
    const last = trip.stopTimes[trip.stopTimes.length - 1]
    if (
      (effective < first.departure || effective > last.arrival) &&
      effective + DAY_SECONDS >= first.departure &&
      effective + DAY_SECONDS <= last.arrival
    ) {
      effective += DAY_SECONDS
    }
    if (effective < first.departure || effective > last.arrival) return null

    // Parallel arrays keep the position index aligned with the stop list
    const entries = trip.stopTimes
      .map((stopTime) => ({ stopTime, stop: dir.stops[stopTime.stopIndex] }))
      .filter((entry) => entry.stop !== undefined)
    const stops: TripStop[] = entries.map(({ stopTime, stop }) => ({
      name: stop.name,
      arrivalSec: (stopTime.arrival + delay) % DAY_SECONDS,
      lon: stop.coord[0],
      lat: stop.coord[1],
      nhn: stop.nhn,
      passed: effective > stopTime.departure,
    }))

    let position = 0
    for (let i = 0; i < entries.length; i++) {
      const cur = entries[i].stopTime
      // Dwelling at stop i
      if (effective >= cur.arrival && effective <= cur.departure) {
        position = i
        break
      }
      // Traveling between stop i and stop i+1
      const next = entries[i + 1]?.stopTime
      if (next && effective > cur.departure && effective < next.arrival) {
        position = i + (effective - cur.departure) / (next.arrival - cur.departure)
        break
      }
    }
    return { stops, position }
  }

  snapshotsAt(tSec: number): VehicleSnapshot[] {
    const snapshots: VehicleSnapshot[] = []
    for (const trip of this.trips) {
      const line = this.network.lineById.get(trip.lineId)
      if (!line) continue
      const dir = line.directions[trip.direction]

      // Delayed trips run time-shifted by the delay: the tram is where it
      // would have been on schedule `delay` seconds ago.
      const delay = this.realtimeDelays.get(trip.id) ?? 0
      const state = tripStateAt(trip, dir, tSec - delay)
      if (!state) continue

      snapshots.push({
        id: trip.id,
        lineId: trip.lineId,
        lineName: line.name,
        color: line.color,
        mode: line.mode,
        vehicle: line.vehicle,
        direction: trip.direction,
        lon: state.lon,
        lat: state.lat,
        bearing: state.bearing,
        status: state.status,
        nhn: dir.heights ? heightAtDistance(dir.heights, dir.cum, state.distance) : undefined,
        inTunnel: dir.tunnels.length > 0 && isInTunnel(dir.tunnels, state.distance),
        nextStopName: dir.stops[state.nextStopIndex]?.name ?? dir.to,
        destination: trip.destination ?? dir.to,
        origin: trip.origin ?? dir.from,
        delaySeconds: delay,
        realtime: this.realtimeDelays.has(trip.id),
      })
    }
    return snapshots
  }
}
