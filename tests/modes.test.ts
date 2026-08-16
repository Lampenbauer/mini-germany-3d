import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { prepareNetwork } from '@/data/network'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import {
  buildAllTrips,
  DEFAULT_SERVICE_BY_MODE,
  departuresFromService,
} from '@/lib/timetable'
import { testMultiModalNetworkJson, testNetworkJson } from './fixtures'

describe('prepareNetwork with transport modes', () => {
  const network = prepareNetwork(testMultiModalNetworkJson)

  it('missing mode is interpreted as tram (old network.json)', () => {
    const tram = network.lineById.get('T')!
    expect(tram.mode).toBe('tram')
    expect(tram.vehicle).toEqual(config.vehicles.tram)
  })

  it('bus gets the default bus dimensions', () => {
    const bus = network.lineById.get('22')!
    expect(bus.mode).toBe('bus')
    expect(bus.vehicle).toEqual(config.vehicles.bus)
  })

  it('ferry keeps its custom dimensions', () => {
    const ferry = network.lineById.get('F1')!
    expect(ferry.mode).toBe('ferry')
    expect(ferry.vehicle).toEqual({ length: 19.9, width: 6.6, height: 3.5 })
  })
})

describe('Headways and speeds per transport mode', () => {
  const network = prepareNetwork(testMultiModalNetworkJson)

  it('without schedule.json the mode default headway applies', () => {
    const trips = buildAllTrips(network, {
      cruiseSpeedMps: 8.3,
      dwellSeconds: 25,
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const perLine = (id: string) => trips.filter((t) => t.lineId === id).length
    // 2 directions × departures of the respective mode's headway
    expect(perLine('T')).toBe(2 * departuresFromService(DEFAULT_SERVICE_BY_MODE.tram).length)
    expect(perLine('22')).toBe(2 * departuresFromService(DEFAULT_SERVICE_BY_MODE.bus).length)
    expect(perLine('F1')).toBe(2 * departuresFromService(DEFAULT_SERVICE_BY_MODE.ferry).length)
  })

  it('with mode-specific speed the ferry travels slower than the tram', () => {
    const trips = buildAllTrips(network, {
      cruiseSpeedMps: 8.3,
      dwellSeconds: 25,
      cruiseSpeedByMode: { tram: 8.3, bus: 6.9, ferry: 3.0 },
    })
    const tramTrip = trips.find((t) => t.lineId === 'T' && t.direction === 0)!
    const ferryTrip = trips.find((t) => t.lineId === 'F1' && t.direction === 0)!
    const travel = (trip: typeof tramTrip) =>
      trip.stopTimes[trip.stopTimes.length - 1].arrival - trip.stopTimes[0].departure
    // Tram: ~2000 m at 8.3 m/s (+ dwell time) · Ferry: ~590 m at 3.0 m/s
    expect(travel(tramTrip)).toBeGreaterThan(200)
    // The ferry needs about 196 s for ~590 m – far more than at tram speed (~71 s)
    expect(travel(ferryTrip)).toBeGreaterThan(150)
    expect(travel(ferryTrip)).toBeLessThan(300)
  })

  it('an explicit cruiseSpeedMps still applies to all modes (test override)', () => {
    const sim = new Simulation(prepareNetwork(testNetworkJson), new SimClock(), undefined, {
      cruiseSpeedMps: 10,
    })
    expect(sim.tripCount).toBeGreaterThan(0)
  })
})

describe('Simulation provides mode and vehicle dimensions in the snapshot', () => {
  it('snapshots identify buses and ferries', () => {
    const network = prepareNetwork(testMultiModalNetworkJson)
    const sim = new Simulation(network, new SimClock())

    // The fixture routes are short – at the exact departure time the vehicle
    // is guaranteed to be at its first stop (dwell). Tram headway 10 min,
    // ferry 15 min → both active at 08:30; bus headway 20 min → query at 08:40.
    const at0830 = sim.snapshotsAt(8 * 3600 + 30 * 60)
    const at0840 = sim.snapshotsAt(8 * 3600 + 40 * 60)

    const ferry = at0830.find((s) => s.mode === 'ferry')!
    expect(ferry).toBeDefined()
    expect(ferry.vehicle.length).toBeCloseTo(19.9)

    expect(at0830.some((s) => s.mode === 'tram')).toBe(true)

    const bus = at0840.find((s) => s.mode === 'bus')!
    expect(bus).toBeDefined()
    expect(bus.vehicle).toEqual(config.vehicles.bus)
  })
})
