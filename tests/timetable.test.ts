import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import {
  buildAllTrips,
  buildTripsForDirection,
  departuresFromService,
  stopOffsets,
  tripStateAt,
  type TimetableOptions,
} from '@/lib/timetable'
import { testNetworkJson } from './fixtures'

const network = prepareNetwork(testNetworkJson)
const line = network.lines[0]
const opts: TimetableOptions = { cruiseSpeedMps: 10, dwellSeconds: 30 }

describe('departuresFromService', () => {
  it('generates departures at the given headway', () => {
    const deps = departuresFromService([{ startMin: 360, endMin: 420, headwayMin: 10 }])
    expect(deps).toEqual([21600, 22200, 22800, 23400, 24000, 24600])
  })

  it('removes duplicates at service-window boundaries', () => {
    const deps = departuresFromService([
      { startMin: 360, endMin: 380, headwayMin: 10 },
      { startMin: 370, endMin: 390, headwayMin: 10 },
    ])
    expect(deps).toEqual([21600, 22200, 22800])
  })
})

describe('stopOffsets', () => {
  it('derives travel times from distance and speed', () => {
    const offsets = stopOffsets(line.directions[0], 10, 30)
    expect(offsets).toHaveLength(3)
    expect(offsets[0]).toEqual({ arrival: 0, departure: 0 })
    // ~1000 m at 10 m/s ≈ 100 s, then 30 s dwell time
    expect(offsets[1].arrival).toBeGreaterThan(90)
    expect(offsets[1].arrival).toBeLessThan(110)
    expect(offsets[1].departure).toBe(offsets[1].arrival + 30)
    // Last stop: no more dwell time
    expect(offsets[2].departure).toBe(offsets[2].arrival)
  })
})

describe('buildTripsForDirection / tripStateAt', () => {
  const dep = 8 * 3600
  const [trip] = buildTripsForDirection(line, 0, [dep], opts)
  const dir = line.directions[0]

  it('starts as a dwell at the first stop', () => {
    const state = tripStateAt(trip, dir, dep)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('dwell')
    expect(state!.distance).toBeCloseTo(0, 0)
    expect(state!.nextStopIndex).toBe(1)
  })

  it('is moving between two stops and interpolates the distance', () => {
    const midTime = dep + 50 // half of the ~100 s travel time to the second stop
    const state = tripStateAt(trip, dir, midTime)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('moving')
    expect(state!.distance).toBeGreaterThan(300)
    expect(state!.distance).toBeLessThan(700)
    expect(state!.bearing).toBeCloseTo(0, 0) // heading north
    expect(state!.nextStopIndex).toBe(1)
  })

  it('dwells at the intermediate stop', () => {
    const arrivalB = trip.stopTimes[1].arrival
    const state = tripStateAt(trip, dir, arrivalB + 10)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('dwell')
    expect(state!.nextStopIndex).toBe(2)
  })

  it('is not active before departure or after arrival', () => {
    expect(tripStateAt(trip, dir, dep - 1)).toBeNull()
    const lastArrival = trip.stopTimes[2].arrival
    expect(tripStateAt(trip, dir, lastArrival + 1)).toBeNull()
  })
})

describe('after-midnight trips (GTFS times past 24:00)', () => {
  const dir = line.directions[0]
  // 02:00 on the following calendar day, encoded as 26:00 (Fledermaus style)
  const [nightTrip] = buildTripsForDirection(line, 0, [26 * 3600], opts)

  it('is active at the wrapped early-morning clock time', () => {
    const state = tripStateAt(nightTrip, dir, 2 * 3600 + 50)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('moving')
  })

  it('stays inactive at other times of day', () => {
    expect(tripStateAt(nightTrip, dir, 2 * 3600 - 60)).toBeNull()
    expect(tripStateAt(nightTrip, dir, 12 * 3600)).toBeNull()
  })

  it('keeps a midnight-spanning trip active past the day wrap', () => {
    const [lateTrip] = buildTripsForDirection(line, 0, [24 * 3600 - 60], opts)
    const state = tripStateAt(lateTrip, dir, 120) // 00:02, trip departed 23:59
    expect(state).not.toBeNull()
  })
})

describe('Opposite direction (mirrored)', () => {
  it('runs from the last stop to the first', () => {
    const dir1 = line.directions[1]
    expect(dir1.from).toBe('Gamma')
    expect(dir1.to).toBe('Alpha')
    expect(dir1.stops[0].name).toBe('Gamma')
    expect(dir1.stops[2].name).toBe('Alpha')
    // Distances increase monotonically in the opposite direction too
    expect(dir1.stops[1].dist).toBeGreaterThan(dir1.stops[0].dist)
    expect(dir1.stops[2].dist).toBeGreaterThan(dir1.stops[1].dist)

    const [trip] = buildTripsForDirection(line, 1, [1000], opts)
    const state = tripStateAt(trip, dir1, 1050)
    expect(state).not.toBeNull()
    expect(state!.bearing).toBeCloseTo(180, 0) // heading south
  })
})

describe('buildAllTrips', () => {
  it('generates trips for both directions', () => {
    const trips = buildAllTrips(network, opts)
    expect(trips.length).toBeGreaterThan(0)
    expect(trips.some((t) => t.direction === 0)).toBe(true)
    expect(trips.some((t) => t.direction === 1)).toBe(true)
  })

  it('keeps lines without departures off the map when a real timetable exists', () => {
    // Line 2 during the Werftdreieck works: the feed has other lines but none
    // for this one – no synthetic fallback may be invented for it.
    const schedule = { lines: { T: { '0': { departures: [8 * 3600] } } } }
    const trips = buildAllTrips(network, opts, schedule)
    expect(trips).toHaveLength(1)
    expect(trips[0].direction).toBe(0)
  })

  it('uses real departure times from schedule.json when available', () => {
    const schedule = {
      lines: { T: { '0': { departures: [100, 200] } } },
    }
    const trips = buildAllTrips(network, opts, schedule)
    const dir0 = trips.filter((t) => t.direction === 0)
    expect(dir0).toHaveLength(2)
    expect(dir0[0].stopTimes[0].departure).toBe(100)
    expect(dir0[1].stopTimes[0].departure).toBe(200)
    // Direction 1 has no departures in the feed and therefore does not run –
    // real data is never mixed with synthetic trips.
    expect(trips.filter((t) => t.direction === 1)).toHaveLength(0)
  })
})
