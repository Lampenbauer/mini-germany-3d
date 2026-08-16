/**
 * Bindeglied zwischen Uhr, Fahrplan und Karte: liefert pro Frame den
 * Zustand aller aktiven Straßenbahnen als anzeigefertige Snapshots.
 */

import { SimClock } from '@/lib/clock'
import { buildAllTrips, buildRealtimeTripIdMap, tripStateAt } from '@/lib/timetable'
import type { ScheduleJson, TimetableOptions, Trip } from '@/lib/timetable'
import type { PreparedNetwork } from '@/data/network-types'
import { config } from '@/config'

export interface TramSnapshot {
  id: string
  lineId: string
  lineName: string
  color: string
  direction: 0 | 1
  lon: number
  lat: number
  bearing: number
  status: 'dwell' | 'moving'
  nextStopName: string
  destination: string
  origin: string
  /** Aktuelle Verspätung in Sekunden (aus GTFS-Realtime; 0 = planmäßig). */
  delaySeconds: number
  /** true, wenn diese Fahrt gerade von GTFS-Realtime-Daten überlagert wird. */
  realtime: boolean
}

export class Simulation {
  readonly network: PreparedNetwork
  readonly clock: SimClock
  /** GTFS-trip_id → Simulations-Fahrt-ID (für GTFS-Realtime-Matching). */
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
    }
    this.trips = buildAllTrips(network, opts, schedule)
    this.realtimeTripIdMap = buildRealtimeTripIdMap(schedule)
  }

  get tripCount(): number {
    return this.trips.length
  }

  /** Aktive Verspätungen (Simulations-Fahrt-ID → Sekunden) setzen. */
  setRealtimeDelays(delays: Map<string, number>): void {
    this.realtimeDelays = delays
  }

  get realtimeDelayCount(): number {
    return this.realtimeDelays.size
  }

  /** Snapshots aller aktiven Bahnen zur aktuellen Simulationszeit. */
  snapshots(): TramSnapshot[] {
    return this.snapshotsAt(this.clock.secondsOfDay())
  }

  snapshotsAt(tSec: number): TramSnapshot[] {
    const snapshots: TramSnapshot[] = []
    for (const trip of this.trips) {
      const line = this.network.lineById.get(trip.lineId)
      if (!line) continue
      const dir = line.directions[trip.direction]

      // Verspätete Fahrten laufen um die Verspätung zeitversetzt: Die Bahn
      // ist dort, wo sie planmäßig vor `delay` Sekunden gewesen wäre.
      const delay = this.realtimeDelays.get(trip.id) ?? 0
      const state = tripStateAt(trip, dir, tSec - delay)
      if (!state) continue

      snapshots.push({
        id: trip.id,
        lineId: trip.lineId,
        lineName: line.name,
        color: line.color,
        direction: trip.direction,
        lon: state.lon,
        lat: state.lat,
        bearing: state.bearing,
        status: state.status,
        nextStopName: dir.stops[state.nextStopIndex]?.name ?? dir.to,
        destination: dir.to,
        origin: dir.from,
        delaySeconds: delay,
        realtime: this.realtimeDelays.has(trip.id),
      })
    }
    return snapshots
  }
}
