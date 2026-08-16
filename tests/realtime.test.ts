import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { extractDelays } from '@/lib/realtime'
import { buildRealtimeTripIdMap, simTripId } from '@/lib/timetable'
import { testNetworkJson } from './fixtures'

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime

/** Baut einen echten (encodierten + decodierten) GTFS-RT-Feed. */
function makeFeed(entities: object[]) {
  const message = FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: '2.0', timestamp: 1700000000 },
    entity: entities,
  })
  // Roundtrip über die Protobuf-Encodierung – wie im Browser
  return FeedMessage.decode(FeedMessage.encode(message).finish())
}

describe('buildRealtimeTripIdMap', () => {
  it('bildet GTFS-trip_ids auf Simulations-Fahrt-IDs ab', () => {
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

  it('ist leer ohne tripIds (altes schedule.json-Format)', () => {
    expect(buildRealtimeTripIdMap({ lines: { T: { '0': { departures: [100] } } } }).size).toBe(0)
    expect(buildRealtimeTripIdMap(undefined).size).toBe(0)
  })
})

describe('extractDelays', () => {
  const tripIdMap = new Map([
    ['gtfs-a', 'T-0-480'],
    ['gtfs-b', 'T-0-510'],
  ])

  it('nutzt trip_update.delay, wenn vorhanden', () => {
    const feed = makeFeed([
      { id: '1', tripUpdate: { trip: { tripId: 'gtfs-a' }, delay: 180 } },
    ])
    const delays = extractDelays(feed, tripIdMap)
    expect(delays.get('T-0-480')).toBe(180)
  })

  it('fällt auf die erste Stop-Time-Verspätung zurück', () => {
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
    expect(extractDelays(feed, tripIdMap).get('T-0-510')).toBe(120)
  })

  it('ignoriert Fahrten ohne Zuordnung und Entities ohne TripUpdate', () => {
    const feed = makeFeed([
      { id: '1', tripUpdate: { trip: { tripId: 'unbekannt' }, delay: 300 } },
      { id: '2', vehicle: { position: { latitude: 54, longitude: 12 } } },
      { id: '3', tripUpdate: { trip: { tripId: 'gtfs-a' } } }, // keine Delay-Info
    ])
    expect(extractDelays(feed, tripIdMap).size).toBe(0)
  })

  it('verarbeitet auch Verfrühungen (negative Delays)', () => {
    const feed = makeFeed([
      { id: '1', tripUpdate: { trip: { tripId: 'gtfs-a' }, delay: -90 } },
    ])
    expect(extractDelays(feed, tripIdMap).get('T-0-480')).toBe(-90)
  })
})

describe('Simulation mit Realtime-Verspätungen', () => {
  const network = prepareNetwork(testNetworkJson)
  const schedule = {
    lines: { T: { '0': { departures: [28800], tripIds: ['gtfs-a'] } } },
  }

  it('verschiebt die Position einer verspäteten Fahrt', () => {
    const sim = new Simulation(network, new SimClock(), schedule)
    const tripId = sim.realtimeTripIdMap.get('gtfs-a')!
    expect(tripId).toBe(simTripId('T', 0, 28800))

    const undelayed = sim.snapshotsAt(28900).find((s) => s.id === tripId)!
    expect(undelayed.realtime).toBe(false)
    expect(undelayed.delaySeconds).toBe(0)

    sim.setRealtimeDelays(new Map([[tripId, 300]]))

    // Mit 300 s Verspätung ist die Bahn um 08:01:40 noch nicht abgefahren …
    expect(sim.snapshotsAt(28900).find((s) => s.id === tripId)).toBeUndefined()

    // … und um 08:06:40 dort, wo sie planmäßig um 08:01:40 gewesen wäre.
    const delayed = sim.snapshotsAt(29200).find((s) => s.id === tripId)!
    expect(delayed.realtime).toBe(true)
    expect(delayed.delaySeconds).toBe(300)
    expect(delayed.lon).toBeCloseTo(undelayed.lon, 8)
    expect(delayed.lat).toBeCloseTo(undelayed.lat, 8)
  })

  it('leere Delay-Map stellt den Planbetrieb wieder her', () => {
    const sim = new Simulation(network, new SimClock(), schedule)
    const tripId = sim.realtimeTripIdMap.get('gtfs-a')!
    sim.setRealtimeDelays(new Map([[tripId, 300]]))
    sim.setRealtimeDelays(new Map())
    const snap = sim.snapshotsAt(28900).find((s) => s.id === tripId)!
    expect(snap.realtime).toBe(false)
    expect(snap.delaySeconds).toBe(0)
  })
})
