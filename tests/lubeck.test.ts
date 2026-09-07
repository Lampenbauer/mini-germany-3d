import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks } from './cities'
import scheduleJson from '@/cities/lubeck/schedule.json'
import lampsJson from '@/cities/lubeck/street-lamps.json'

/**
 * What the Lübeck dataset has to be for the city to make sense on the map
 * – a bus city like Kiel, with its old town on an island and Travemünde
 * twenty kilometers down the Trave, both inside the city limits. Guards
 * the nightly refresh: the operator regex is the only thing that keeps
 * the regional Autokraft lines through the box out of the map.
 */
const city = cityNetworks.find((entry) => entry.city.slug === 'lubeck')!
const network = city.network
const schedule = scheduleJson as ScheduleJson

const heightsOf = (name: string) =>
  Object.values(city.json.stops)
    .filter((stop) => stop.name === name)
    .map((stop) => stop.nhn!)

describe('the Lübeck dataset', () => {
  it('has the Stadtwerke Lübeck Mobil bus network and nothing else', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['1', '2', '3', '4', '5', '6', '9', '11', '12', '21', '30', '40']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(24)
    for (const mode of ['tram', 'subway', 'train', 'ferry'] as const) {
      expect(network.lines.filter((l) => l.mode === mode), mode).toHaveLength(0)
    }
    // Numbered city lines, not the four-digit regional ones of the HVV
    for (const line of byMode('bus')) expect(line.id, line.id).toMatch(/^[0-9]{1,2}$/)
  })

  it('serves the old town and reaches Travemünde', () => {
    const names = new Set(Object.values(city.json.stops).map((stop) => stop.name))
    for (const name of ['Lübeck ZOB/Hauptbahnhof', 'Strandbahnhof']) {
      expect(names, name).toContain(name)
    }
    // Travemünde is 18 km down the Trave and inside the city limits, so
    // the lines that go there are the longest on the map
    const longest = Math.max(...network.lines.flatMap((l) => l.directions.map((d) => d.totalLength)))
    expect(longest).toBeGreaterThan(15_000)
  })

  it('stands at sea level, the old town on its hill', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Schleswig-Holstein DGM1 via Mapterhorn. The Trave is at 0, the old
    // town island rises to 12–14 m, nothing in the city passes 30.
    for (const h of heightsOf('Strandbahnhof')) expect(h).toBeLessThan(6)
    const marketHill = heightsOf('Gustav-Radbruch-Platz')
    expect(marketHill.length).toBeGreaterThan(0)
    for (const h of marketHill) expect(h).toBeGreaterThan(9)
    for (const stop of Object.values(city.json.stops)) {
      expect(stop.nhn!, stop.name).toBeGreaterThan(0)
      expect(stop.nhn!, stop.name).toBeLessThan(45)
    }
    expect(city.json.meta.terrainAttribution).toContain('LVermGeo SH')
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
    expect(lampsJson.lamps.length).toBeGreaterThan(2500)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for every line and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 2)
    for (const id of ['1', '5', '11', '30']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 93 at 08:30 – a bus city the size of Kiel's daytime fleet.
    expect(snapshots.length).toBeGreaterThan(50)
    expect(snapshots.length).toBeLessThan(300)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    for (const id of ['1', '4', '11', '30']) {
      expect(activeLines, `${id} out at 08:30`).toContain(id)
    }
  })
})
