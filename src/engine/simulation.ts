/**
 * Link between clock, timetable, and map: delivers the state of all active
 * vehicles per frame as display-ready snapshots.
 */

import { SimClock } from '@/lib/clock'
import { heightAtDistance } from '@/lib/geo'
import { buildAllTrips, buildRealtimeTripIdMap, tripStateAt } from '@/lib/timetable'
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

export class Simulation {
  readonly network: PreparedNetwork
  readonly clock: SimClock
  /** GTFS trip_id → simulation trip id (for GTFS-Realtime matching). */
  readonly realtimeTripIdMap: ReadonlyMap<string, string>
  private trips: Trip[]
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
