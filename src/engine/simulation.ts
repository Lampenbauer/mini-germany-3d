/**
 * Bindeglied zwischen Uhr, Fahrplan und Karte: liefert pro Frame den
 * Zustand aller aktiven Straßenbahnen als anzeigefertige Snapshots.
 */

import { SimClock } from '@/lib/clock'
import { activeTramStates, buildAllTrips } from '@/lib/timetable'
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
}

export class Simulation {
  readonly network: PreparedNetwork
  readonly clock: SimClock
  private trips: Trip[]

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
  }

  get tripCount(): number {
    return this.trips.length
  }

  /** Snapshots aller aktiven Bahnen zur aktuellen Simulationszeit. */
  snapshots(): TramSnapshot[] {
    return this.snapshotsAt(this.clock.secondsOfDay())
  }

  snapshotsAt(tSec: number): TramSnapshot[] {
    const states = activeTramStates(this.trips, this.network, tSec)
    return states.map((s) => {
      const line = this.network.lineById.get(s.lineId)!
      const dir = line.directions[s.direction]
      return {
        id: s.tripId,
        lineId: s.lineId,
        lineName: line.name,
        color: line.color,
        direction: s.direction,
        lon: s.lon,
        lat: s.lat,
        bearing: s.bearing,
        status: s.status,
        nextStopName: dir.stops[s.nextStopIndex]?.name ?? dir.to,
        destination: dir.to,
        origin: dir.from,
      }
    })
  }
}
