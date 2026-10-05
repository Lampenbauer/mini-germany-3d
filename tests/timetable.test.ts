import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import {
  buildAllTrips,
  buildTripsForDirection,
  departuresFromService,
  profileDistance,
  stopOffsets,
  stopTimesFromTimePoints,
  timePointsFromPattern,
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

describe('profileDistance (acceleration and braking between stops)', () => {
  it('runs at constant speed without a rate, and covers the run either way', () => {
    expect(profileDistance(1000, 100, 50, undefined)).toBe(500)
    expect(profileDistance(1000, 100, 0, 1)).toBe(0)
    expect(profileDistance(1000, 100, 100, 1)).toBeCloseTo(1000, 6)
    expect(profileDistance(1000, 100, 50, 1)).toBeCloseTo(500, 6)
  })

  it('pulls away gently and arrives gently', () => {
    // 1000 m in 100 s at 1 m/s²: the first seconds cover ½at², the
    // average speed is reached only once the vehicle is rolling
    expect(profileDistance(1000, 100, 2, 1)).toBeCloseTo(2, 6)
    expect(profileDistance(1000, 100, 10, 1)).toBeLessThan(100)
    expect(profileDistance(1000, 100, 98, 1)).toBeCloseTo(998, 6)
    // Monotonic throughout
    let last = 0
    for (let t = 1; t <= 100; t++) {
      const d = profileDistance(1000, 100, t, 1)
      expect(d).toBeGreaterThan(last)
      last = d
    }
  })

  it('peaks halfway where the run is too short for a cruise speed', () => {
    // 100 m in 30 s at 0.3 m/s²: a·T² = 270 < 4L = 400, so no cruise
    // speed is reached – a triangle at 4L/T² = 0.44 m/s² that peaks halfway
    expect(profileDistance(100, 30, 15, 0.3)).toBeCloseTo(50, 6)
    expect(profileDistance(100, 30, 30, 0.3)).toBeCloseTo(100, 6)
    expect(profileDistance(100, 30, 5, 0.3)).toBeCloseTo(0.5 * (400 / 900) * 25, 6)
    // At 1 m/s² the same run has a short cruise in the middle
    expect(profileDistance(100, 30, 15, 1)).toBeCloseTo(50, 6)
    expect(profileDistance(100, 30, 5, 1)).toBeGreaterThan(0.5 * (400 / 900) * 25)
  })
})

describe('time points from the feed (schedule.json patterns)', () => {
  const dir = line.directions[0]
  const d = (i: number) => dir.stops[i].dist

  it('reads a flat pattern back and rejects a malformed one', () => {
    expect(timePointsFromPattern([0, 0, 0, 1000, 120, 150])).toEqual([
      { dist: 0, arrival: 0, departure: 0 },
      { dist: 1000, arrival: 120, departure: 150 },
    ])
    expect(timePointsFromPattern(null)).toBeNull()
    expect(timePointsFromPattern([0, 0, 0, 1000, 120])).toBeNull()
    // Distances and times have to run forward
    expect(timePointsFromPattern([0, 0, 0, 1000, 120, 150, 900, 200, 200])).toBeNull()
    expect(timePointsFromPattern([0, 0, 0, 1000, 120, 150, 2000, 100, 100])).toBeNull()
    // The first stop's time at every stop (the free feed's Bremen), or
    // a pace no city trip runs at, is no timetable
    expect(timePointsFromPattern([0, 0, 0, 1000, 0, 0, 2000, 0, 0])).toBeNull()
    expect(timePointsFromPattern([0, 0, 0, 5000, 60, 60])).toBeNull()
  })

  it('gives every stop the feed’s own times, standing before each departure', () => {
    const points = [
      { dist: d(0), arrival: 0, departure: 0 },
      { dist: d(1), arrival: 200, departure: 200 },
      { dist: d(2), arrival: 420, departure: 420 },
    ]
    const dep = 8 * 3600
    const times = stopTimesFromTimePoints(dir, 0, 2, dep, points, 10, 25)
    expect(times.map((t) => t.stopIndex)).toEqual([0, 1, 2])
    expect(times[0]).toEqual({ stopIndex: 0, arrival: dep, departure: dep })
    // The feed has arrival equal departure: the vehicle stands the dwell
    // before it leaves at the feed's time
    expect(times[1]).toEqual({ stopIndex: 1, arrival: dep + 175, departure: dep + 200 })
    // The trip ends with its last arrival, as the feed has it
    expect(times[2]).toEqual({ stopIndex: 2, arrival: dep + 420, departure: dep + 420 })
  })

  it('passes a stop between two points at the time its distance says, and reaches one outside them at the cruise speed', () => {
    // Only the first and the last stop are the feed's; the middle stop is
    // passed proportionally, 100 s into a 200 s run over 2000 m if it lies halfway
    const points = [
      { dist: d(0), arrival: 0, departure: 0 },
      { dist: d(2), arrival: 400, departure: 400 },
    ]
    const dep = 1000
    const times = stopTimesFromTimePoints(dir, 0, 2, dep, points, 10, 25)
    const share = (d(1) - d(0)) / (d(2) - d(0))
    expect(times[1].departure).toBe(dep + Math.round(400 * share))
    expect(times[1].departure - times[1].arrival).toBe(25)
    // A stop past the last point: at 10 m/s from it
    const short = [
      { dist: d(0), arrival: 0, departure: 0 },
      { dist: d(1), arrival: 200, departure: 200 },
    ]
    const beyond = stopTimesFromTimePoints(dir, 0, 2, dep, short, 10, 25)
    expect(beyond[2].arrival).toBe(dep + 200 + Math.round((d(2) - d(1)) / 10))
  })

  it('builds the trips from the schedule’s patterns and falls back to the cruise speed without one', () => {
    const schedule = {
      lines: {
        T: {
          '0': {
            departures: [100, 200],
            patterns: [[d(0), 0, 0, d(1), 300, 300, d(2), 600, 600]],
            patternIds: [0, null],
          },
        },
      },
    }
    const trips = buildAllTrips(network, opts, schedule)
    expect(trips).toHaveLength(2)
    expect(trips[0].stopTimes[2].arrival).toBe(100 + 600)
    // The second trip has no pattern: the distance over the cruise speed, as before
    const synthetic = stopOffsets(line.directions[0], 10, 30)
    expect(trips[1].stopTimes[2].arrival).toBe(200 + synthetic[2].arrival)
  })
})
