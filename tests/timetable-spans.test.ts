import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import {
  DEFAULT_SERVICE_BY_MODE,
  buildAllTrips,
  buildRealtimeTripIdMap,
  buildTripsForDirection,
  departuresFromService,
  interleavedService,
  tripStateAt,
  type TimetableOptions,
} from '@/lib/timetable'
import { testMultiModalNetworkJson, testNetworkJson } from './fixtures'

/**
 * Short workings (GTFS trips serving only part of the route) and the
 * single-vessel ferry fallback. Both guard against the same failure mode:
 * more simulated vehicles on a section than the timetable puts there – the
 * old code ran every trip across the full route, which bunched phantom
 * vehicles near the terminus, and departed synthetic ferries from both
 * banks simultaneously (two boats where Rostock has one).
 */

const network = prepareNetwork(testNetworkJson)
const line = network.lines[0]
const opts: TimetableOptions = { cruiseSpeedMps: 10, dwellSeconds: 30 }
const dep = 8 * 3600

// Stops Alpha/Beta/Gamma sit at ~0 / ~1000 / ~2000 m along the test line.

describe('short workings (trip spans)', () => {
  it('serves only the stops inside the span, starting at the real first stop', () => {
    const [trip] = buildTripsForDirection(line, 0, [dep], opts, [[950, 2050]])
    const dir = line.directions[0]

    // The span endpoints snap to Beta and Gamma
    expect(trip.stopTimes.map((st) => st.stopIndex)).toEqual([1, 2])
    expect(trip.origin).toBe('Beta')
    expect(trip.destination).toBe('Gamma')
    // The id carries the span so it cannot collide with a same-minute full trip
    expect(trip.id).toContain('-s950-2050')

    // Departs Beta at `dep` – never appears at Alpha
    const atDep = tripStateAt(trip, dir, dep)
    expect(atDep?.status).toBe('dwell')
    expect(atDep?.distance).toBeCloseTo(dir.stops[1].dist, 0)
    expect(tripStateAt(trip, dir, dep - 1)).toBeNull()

    // Travels the ~1000 m Beta → Gamma in ~100 s, then the trip ends
    const last = trip.stopTimes[trip.stopTimes.length - 1]
    expect(last.arrival - dep).toBeGreaterThan(90)
    expect(last.arrival - dep).toBeLessThan(110)
    expect(tripStateAt(trip, dir, last.arrival + 1)).toBeNull()
  })

  it('treats a span that collapses onto a single stop as a full trip', () => {
    const [trip] = buildTripsForDirection(line, 0, [dep], opts, [[0, 100]])
    expect(trip.stopTimes.map((st) => st.stopIndex)).toEqual([0, 1, 2])
    expect(trip.id).not.toContain('-s')
    expect(trip.origin).toBeUndefined()
  })

  it('keeps departures and spans paired when sorting schedule entries', () => {
    const schedule = {
      lines: { T: { '0': { departures: [200, 100], spans: [[950, 2050], null] } } },
    }
    const trips = buildAllTrips(network, opts, schedule).filter((t) => t.direction === 0)
    expect(trips).toHaveLength(2)
    // Sorted by departure: the full trip (dep 100) first, the span stays
    // attached to its departure (dep 200).
    expect(trips[0].stopTimes[0].departure).toBe(100)
    expect(trips[0].stopTimes).toHaveLength(3)
    expect(trips[1].stopTimes[0].departure).toBe(200)
    expect(trips[1].stopTimes).toHaveLength(2)
  })

  it('builds GTFS-Realtime trip ids consistent with the simulation trips', () => {
    const schedule = {
      lines: {
        T: {
          '0': {
            departures: [100, 200],
            tripIds: ['gtfs-a', 'gtfs-b'],
            spans: [null, [950, 2050]],
          },
        },
      },
    }
    const map = buildRealtimeTripIdMap(schedule)
    const tripIds = new Set(buildAllTrips(network, opts, schedule).map((t) => t.id))
    expect(map.size).toBe(2)
    for (const simId of map.values()) {
      expect(tripIds.has(simId)).toBe(true)
    }
    expect(map.get('gtfs-b')).toContain('-s950-2050')
  })
})

describe('single-vessel ferry fallback', () => {
  const multiModal = prepareNetwork(testMultiModalNetworkJson)
  const ferryOpts: TimetableOptions = {
    cruiseSpeedMps: 8.3,
    dwellSeconds: 25,
    cruiseSpeedByMode: { tram: 8.3, bus: 6.9, ferry: 3.0 },
  }

  it('departs the return direction offset by half the headway', () => {
    const base = departuresFromService(DEFAULT_SERVICE_BY_MODE.ferry)
    const shifted = departuresFromService(interleavedService(DEFAULT_SERVICE_BY_MODE.ferry))
    expect(shifted).toHaveLength(base.length)
    expect(shifted[0] - base[0]).toBe(7.5 * 60)

    const trips = buildAllTrips(multiModal, ferryOpts)
    const dir0 = trips.filter((t) => t.lineId === 'F1' && t.direction === 0)
    const dir1 = trips.filter((t) => t.lineId === 'F1' && t.direction === 1)
    expect(dir0[0].stopTimes[0].departure).toBe(base[0])
    expect(dir1[0].stopTimes[0].departure).toBe(base[0] + 7.5 * 60)
  })

  it('puts at most one ferry on the water at any time of day', () => {
    const trips = buildAllTrips(multiModal, ferryOpts).filter((t) => t.lineId === 'F1')
    const ferry = multiModal.lineById.get('F1')!
    let maxActive = 0
    for (let t = 5 * 3600; t <= 22 * 3600; t += 30) {
      let active = 0
      for (const trip of trips) {
        if (tripStateAt(trip, ferry.directions[trip.direction], t)) active++
      }
      maxActive = Math.max(maxActive, active)
    }
    expect(maxActive).toBe(1)
  })
})
