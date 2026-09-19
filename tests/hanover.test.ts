import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks, linesOutInTheMorning } from './cities'
import scheduleJson from '@/cities/hanover/schedule.json'
import lampsJson from '@/cities/hanover/street-lamps.json'

/**
 * What the Hanover dataset has to be for the city to make sense on the
 * map. Guards the nightly refresh, and above all the one thing that makes
 * this city special: its Stadtbahn is a tram to OSM and to this map, and
 * an underground (route_type 1) to the GTFS feed. Without the city's own
 * `gtfs.routeTypes` every one of its fifteen lines would stand still.
 */
const city = cityNetworks.find((entry) => entry.city.slug === 'hanover')!
const network = city.network
const schedule = scheduleJson as ScheduleJson

const heightsOf = (name: string) =>
  Object.values(city.json.stops)
    .filter((stop) => stop.name === name)
    .map((stop) => stop.nhn!)

describe('the Hanover dataset', () => {
  it('has the ÜSTRA Stadtbahn, the S-Bahn and the ÜSTRA buses', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['1', '2', '3', '4', '5', '7', '9', '10', '13', '17', 'S1', 'S5', '100', '121']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('tram').length).toBeGreaterThanOrEqual(14)
    expect(byMode('train').length).toBeGreaterThanOrEqual(8)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(20)
    expect(byMode('subway')).toHaveLength(0)
    expect(byMode('ferry')).toHaveLength(0)
  })

  it('runs its Stadtbahn under the centre and out on the surface', () => {
    // The A, B and C tunnels carry the lines through the middle; every
    // line surfaces beyond the ring, so none of them is all tunnel.
    for (const line of network.lines.filter((l) => l.mode === 'tram')) {
      const dir = line.directions[0]
      const tunnelMeters = dir.tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
      expect(tunnelMeters, `${line.id} tunnel length`).toBeGreaterThan(100)
      expect(tunnelMeters / dir.totalLength, `${line.id} tunnel share`).toBeLessThan(0.8)
    }
  })

  it('stands on the Leine plain, 56 m at the Kröpcke', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Lower Saxon DGM1 via Mapterhorn. The centre lies at 52–57 m, the
    // Kronsberg in the south-east is the only real climb.
    const kroepcke = heightsOf('Kröpcke')
    expect(kroepcke.length).toBeGreaterThan(0)
    for (const h of kroepcke) expect(h).toBeGreaterThan(53)
    for (const h of kroepcke) expect(h).toBeLessThan(59)
    for (const stop of Object.values(city.json.stops)) {
      expect(stop.nhn!, stop.name).toBeGreaterThan(40)
      expect(stop.nhn!, stop.name).toBeLessThan(130)
    }
    expect(city.json.meta.terrainAttribution).toContain('Niedersachsen')
  })

  it('carries a height for every route vertex and every stop', () => {
    for (const line of city.json.lines) {
      for (const dir of line.directions) {
        expect(dir.heights?.length, `${line.id} ${dir.from} → ${dir.to}`).toBe(dir.path.length)
      }
    }
    for (const stop of Object.values(city.json.stops)) {
      expect(stop.nhn, stop.name).toBeTypeOf('number')
    }
  })

  it('lights its routes with the OSM lamps along them', () => {
    expect(lampsJson.lamps.length).toBeGreaterThan(1000)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('gives its Stadtbahn real departures although the feed calls it an underground', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 4)
    // The Stadtbahn lines – the ones the route_type override is for
    for (const id of ['1', '3', '7', '10', '13']) expect(withDepartures).toContain(id)
    for (const id of ['S1', '100']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 184 at 08:30, half of them Stadtbahn.
    expect(snapshots.length).toBeGreaterThan(120)
    expect(snapshots.length).toBeLessThan(500)
    const activeLines = linesOutInTheMorning(sim)
    for (const id of ['1', '3', '4', '7', '9', '10']) {
      expect(activeLines, `${id} out in the morning`).toContain(id)
    }
  })
})
