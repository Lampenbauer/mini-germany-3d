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

describe('prepareNetwork mit Verkehrsmitteln', () => {
  const network = prepareNetwork(testMultiModalNetworkJson)

  it('fehlender mode wird als tram interpretiert (alte network.json)', () => {
    const tram = network.lineById.get('T')!
    expect(tram.mode).toBe('tram')
    expect(tram.vehicle).toEqual(config.vehicles.tram)
  })

  it('Bus erhält die Standard-Busmaße', () => {
    const bus = network.lineById.get('22')!
    expect(bus.mode).toBe('bus')
    expect(bus.vehicle).toEqual(config.vehicles.bus)
  })

  it('Fähre behält ihre individuellen Maße', () => {
    const ferry = network.lineById.get('F1')!
    expect(ferry.mode).toBe('ferry')
    expect(ferry.vehicle).toEqual({ length: 19.9, width: 6.6, height: 3.5 })
  })
})

describe('Takte und Geschwindigkeiten pro Verkehrsmittel', () => {
  const network = prepareNetwork(testMultiModalNetworkJson)

  it('ohne schedule.json gilt der Modus-Standardtakt', () => {
    const trips = buildAllTrips(network, {
      cruiseSpeedMps: 8.3,
      dwellSeconds: 25,
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const perLine = (id: string) => trips.filter((t) => t.lineId === id).length
    // 2 Richtungen × Abfahrten des jeweiligen Modus-Takts
    expect(perLine('T')).toBe(2 * departuresFromService(DEFAULT_SERVICE_BY_MODE.tram).length)
    expect(perLine('22')).toBe(2 * departuresFromService(DEFAULT_SERVICE_BY_MODE.bus).length)
    expect(perLine('F1')).toBe(2 * departuresFromService(DEFAULT_SERVICE_BY_MODE.ferry).length)
  })

  it('Fähre ist mit Modus-Geschwindigkeit langsamer unterwegs als die Tram', () => {
    const trips = buildAllTrips(network, {
      cruiseSpeedMps: 8.3,
      dwellSeconds: 25,
      cruiseSpeedByMode: { tram: 8.3, bus: 6.9, ferry: 3.0 },
    })
    const tramTrip = trips.find((t) => t.lineId === 'T' && t.direction === 0)!
    const ferryTrip = trips.find((t) => t.lineId === 'F1' && t.direction === 0)!
    const travel = (trip: typeof tramTrip) =>
      trip.stopTimes[trip.stopTimes.length - 1].arrival - trip.stopTimes[0].departure
    // Tram: ~2000 m bei 8,3 m/s (+Haltezeit) · Fähre: ~590 m bei 3,0 m/s
    expect(travel(tramTrip)).toBeGreaterThan(200)
    // Fähre braucht für ~590 m rund 196 s – deutlich mehr als mit Tram-Tempo (~71 s)
    expect(travel(ferryTrip)).toBeGreaterThan(150)
    expect(travel(ferryTrip)).toBeLessThan(300)
  })

  it('explizite cruiseSpeedMps gilt weiterhin für alle Modi (Test-Übersteuerung)', () => {
    const sim = new Simulation(prepareNetwork(testNetworkJson), new SimClock(), undefined, {
      cruiseSpeedMps: 10,
    })
    expect(sim.tripCount).toBeGreaterThan(0)
  })
})

describe('Simulation liefert Modus und Fahrzeugmaße im Snapshot', () => {
  it('Snapshots kennzeichnen Busse und Fähren', () => {
    const network = prepareNetwork(testMultiModalNetworkJson)
    const sim = new Simulation(network, new SimClock())

    // Die Fixture-Strecken sind kurz – zum exakten Abfahrtszeitpunkt steht
    // das Fahrzeug sicher am Starthalt (dwell). Tram-Takt 10 min, Fähre 15 min
    // → beide um 08:30 aktiv; Bus-Takt 20 min → Abfrage um 08:40.
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
