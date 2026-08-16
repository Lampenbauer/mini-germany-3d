import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { mapDelaysToSimTrips } from '@/lib/realtime'
import { extractGtfsDelays } from '@/lib/rt-extract'
import { buildRealtimeTripIdMap, simTripId } from '@/lib/timetable'
import { testNetworkJson } from './fixtures'

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime

/** Builds a real (encoded + decoded) GTFS-RT feed. */
function makeFeed(entities: object[]) {
  const message = FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: '2.0', timestamp: 1700000000 },
    entity: entities,
  })
  // Round trip through the protobuf encoding – just like on the server
  return FeedMessage.decode(FeedMessage.encode(message).finish())
}

describe('buildRealtimeTripIdMap', () => {
  it('maps GTFS trip_ids to simulation trip IDs', () => {
    const map = buildRealtimeTripIdMap({
      lines: {
        T: {
          '0': { departures: [28800, 30600], tripIds: ['gtfs-a', 'gtfs-b'] },
          '1': { departures: [29700], tripIds: ['gtfs-c'] },
        },
      },
    })
    expect(map.get('gtfs-a')).toBe(simTripId('T', 0, 28800))
    expect(map.get('gtfs-b')).toBe(simTripId('T', 0, 30600))
    expect(map.get('gtfs-c')).toBe(simTripId('T', 1, 29700))
  })

  it('is empty without tripIds (old schedule.json format)', () => {
    expect(buildRealtimeTripIdMap({ lines: { T: { '0': { departures: [100] } } } }).size).toBe(0)
    expect(buildRealtimeTripIdMap(undefined).size).toBe(0)
  })
})

describe('extractGtfsDelays (server-side filtering)', () => {
  const tripIds = new Set(['gtfs-a', 'gtfs-b'])

  it('uses trip_update.delay when present', () => {
    const feed = makeFeed([
      { id: '1', tripUpdate: { trip: { tripId: 'gtfs-a' }, delay: 180 } },
    ])
    expect(extractGtfsDelays(feed, tripIds)).toEqual({ 'gtfs-a': 180 })
  })

  it('falls back to the first stop-time delay (departure before arrival)', () => {
    const feed = makeFeed([
      {
        id: '1',
        tripUpdate: {
          trip: { tripId: 'gtfs-b' },
          stopTimeUpdate: [
            { stopSequence: 3, departure: { delay: 120 }, arrival: { delay: 90 } },
          ],
        },
      },
    ])
    expect(extractGtfsDelays(feed, tripIds)).toEqual({ 'gtfs-b': 120 })
  })

  it('ignores unknown trips, entities without a TripUpdate, and entities without delay info', () => {
    const feed = makeFeed([
      { id: '1', tripUpdate: { trip: { tripId: 'unbekannt' }, delay: 300 } },
      { id: '2', vehicle: { position: { latitude: 54, longitude: 12 } } },
      { id: '3', tripUpdate: { trip: { tripId: 'gtfs-a' } } }, // no delay info
    ])
    expect(extractGtfsDelays(feed, tripIds)).toEqual({})
  })

  it('also handles early running (negative delays)', () => {
    const feed = makeFeed([
      { id: '1', tripUpdate: { trip: { tripId: 'gtfs-a' }, delay: -90 } },
    ])
    expect(extractGtfsDelays(feed, tripIds)).toEqual({ 'gtfs-a': -90 })
  })
})

describe('mapDelaysToSimTrips (client)', () => {
  it('assigns filtered GTFS delays to the simulation trips', () => {
    const tripIdMap = new Map([
      ['gtfs-a', 'T-0-480'],
      ['gtfs-b', 'T-0-510'],
    ])
    const delays = mapDelaysToSimTrips(
      { timestamp: 0, total: 5, delays: { 'gtfs-a': 120, 'gtfs-b': -60, fremd: 30 } },
      tripIdMap,
    )
    expect(delays.get('T-0-480')).toBe(120)
    expect(delays.get('T-0-510')).toBe(-60)
    expect(delays.size).toBe(2)
  })

  it('discards invalid values', () => {
    const tripIdMap = new Map([['gtfs-a', 'T-0-480']])
    const delays = mapDelaysToSimTrips(
      {
        timestamp: 0,
        total: 1,
        delays: { 'gtfs-a': Number.NaN } as unknown as Record<string, number>,
      },
      tripIdMap,
    )
    expect(delays.size).toBe(0)
  })
})

describe('Simulation with realtime delays', () => {
  const network = prepareNetwork(testNetworkJson)
  const schedule = {
    lines: { T: { '0': { departures: [28800], tripIds: ['gtfs-a'] } } },
  }

  it('shifts the position of a delayed trip', () => {
    const sim = new Simulation(network, new SimClock(), schedule)
    const tripId = sim.realtimeTripIdMap.get('gtfs-a')!
    expect(tripId).toBe(simTripId('T', 0, 28800))

    const undelayed = sim.snapshotsAt(28900).find((s) => s.id === tripId)!
    expect(undelayed.realtime).toBe(false)
    expect(undelayed.delaySeconds).toBe(0)

    sim.setRealtimeDelays(new Map([[tripId, 300]]))

    // With a 300 s delay the train has not yet departed at 08:01:40 …
    expect(sim.snapshotsAt(28900).find((s) => s.id === tripId)).toBeUndefined()

    // … and at 08:06:40 it is where it would have been on schedule at 08:01:40.
    const delayed = sim.snapshotsAt(29200).find((s) => s.id === tripId)!
    expect(delayed.realtime).toBe(true)
    expect(delayed.delaySeconds).toBe(300)
    expect(delayed.lon).toBeCloseTo(undelayed.lon, 8)
    expect(delayed.lat).toBeCloseTo(undelayed.lat, 8)
  })

  it('an empty delay map restores scheduled operation', () => {
    const sim = new Simulation(network, new SimClock(), schedule)
    const tripId = sim.realtimeTripIdMap.get('gtfs-a')!
    sim.setRealtimeDelays(new Map([[tripId, 300]]))
    sim.setRealtimeDelays(new Map())
    const snap = sim.snapshotsAt(28900).find((s) => s.id === tripId)!
    expect(snap.realtime).toBe(false)
    expect(snap.delaySeconds).toBe(0)
  })
})
