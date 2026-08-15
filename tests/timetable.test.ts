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
  it('erzeugt Abfahrten im angegebenen Takt', () => {
    const deps = departuresFromService([{ startMin: 360, endMin: 420, headwayMin: 10 }])
    expect(deps).toEqual([21600, 22200, 22800, 23400, 24000, 24600])
  })

  it('entfernt Duplikate an Taktgrenzen', () => {
    const deps = departuresFromService([
      { startMin: 360, endMin: 380, headwayMin: 10 },
      { startMin: 370, endMin: 390, headwayMin: 10 },
    ])
    expect(deps).toEqual([21600, 22200, 22800])
  })
})

describe('stopOffsets', () => {
  it('leitet Fahrzeiten aus Distanz und Geschwindigkeit ab', () => {
    const offsets = stopOffsets(line.directions[0], 10, 30)
    expect(offsets).toHaveLength(3)
    expect(offsets[0]).toEqual({ arrival: 0, departure: 0 })
    // ~1000 m bei 10 m/s ≈ 100 s, dann 30 s Haltezeit
    expect(offsets[1].arrival).toBeGreaterThan(90)
    expect(offsets[1].arrival).toBeLessThan(110)
    expect(offsets[1].departure).toBe(offsets[1].arrival + 30)
    // Letzte Haltestelle: keine Haltezeit mehr
    expect(offsets[2].departure).toBe(offsets[2].arrival)
  })
})

describe('buildTripsForDirection / tripStateAt', () => {
  const dep = 8 * 3600
  const [trip] = buildTripsForDirection(line, 0, [dep], opts)
  const dir = line.directions[0]

  it('startet als Halt an der Starthaltestelle', () => {
    const state = tripStateAt(trip, dir, dep)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('dwell')
    expect(state!.distance).toBeCloseTo(0, 0)
    expect(state!.nextStopIndex).toBe(1)
  })

  it('ist zwischen zwei Haltestellen in Fahrt und interpoliert die Distanz', () => {
    const midTime = dep + 50 // Hälfte der ~100 s Fahrzeit zum zweiten Halt
    const state = tripStateAt(trip, dir, midTime)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('moving')
    expect(state!.distance).toBeGreaterThan(300)
    expect(state!.distance).toBeLessThan(700)
    expect(state!.bearing).toBeCloseTo(0, 0) // fährt nach Norden
    expect(state!.nextStopIndex).toBe(1)
  })

  it('hält an der Zwischenhaltestelle', () => {
    const arrivalB = trip.stopTimes[1].arrival
    const state = tripStateAt(trip, dir, arrivalB + 10)
    expect(state).not.toBeNull()
    expect(state!.status).toBe('dwell')
    expect(state!.nextStopIndex).toBe(2)
  })

  it('ist vor Abfahrt und nach Ankunft nicht aktiv', () => {
    expect(tripStateAt(trip, dir, dep - 1)).toBeNull()
    const lastArrival = trip.stopTimes[2].arrival
    expect(tripStateAt(trip, dir, lastArrival + 1)).toBeNull()
  })
})

describe('Gegenrichtung (gespiegelt)', () => {
  it('fährt vom letzten zum ersten Halt', () => {
    const dir1 = line.directions[1]
    expect(dir1.from).toBe('Gamma')
    expect(dir1.to).toBe('Alpha')
    expect(dir1.stops[0].name).toBe('Gamma')
    expect(dir1.stops[2].name).toBe('Alpha')
    // Distanzen monoton steigend auch in Gegenrichtung
    expect(dir1.stops[1].dist).toBeGreaterThan(dir1.stops[0].dist)
    expect(dir1.stops[2].dist).toBeGreaterThan(dir1.stops[1].dist)

    const [trip] = buildTripsForDirection(line, 1, [1000], opts)
    const state = tripStateAt(trip, dir1, 1050)
    expect(state).not.toBeNull()
    expect(state!.bearing).toBeCloseTo(180, 0) // fährt nach Süden
  })
})

describe('buildAllTrips', () => {
  it('erzeugt Fahrten für beide Richtungen', () => {
    const trips = buildAllTrips(network, opts)
    expect(trips.length).toBeGreaterThan(0)
    expect(trips.some((t) => t.direction === 0)).toBe(true)
    expect(trips.some((t) => t.direction === 1)).toBe(true)
  })

  it('nutzt echte Abfahrtszeiten aus schedule.json, wenn vorhanden', () => {
    const schedule = {
      lines: { T: { '0': { departures: [100, 200] } } },
    }
    const trips = buildAllTrips(network, opts, schedule)
    const dir0 = trips.filter((t) => t.direction === 0)
    expect(dir0).toHaveLength(2)
    expect(dir0[0].stopTimes[0].departure).toBe(100)
    expect(dir0[1].stopTimes[0].departure).toBe(200)
    // Richtung 1 fällt auf den synthetischen Takt zurück
    const dir1 = trips.filter((t) => t.direction === 1)
    expect(dir1.length).toBeGreaterThan(2)
  })
})
