import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks, linesOutInTheMorning } from './cities'
import scheduleJson from '@/cities/stuttgart/schedule.json'
import lampsJson from '@/cities/stuttgart/street-lamps.json'

/**
 * What the Stuttgart dataset has to be for the city to make sense on the
 * map. Guards the nightly refresh, and above all the one thing that makes
 * this city special: its Stadtbahn is tagged `light_rail` in OSM, which
 * every other city's definition reads as an S-Bahn. Stuttgart's names
 * `osmRoutes` on both modes instead – the U-lines are its subway, the
 * S-lines its S-Bahn – and a refresh that lost that would mix the two
 * into one mode. The other special thing is the terrain: from the
 * Talkessel at 210 m to Degerloch at 470, the steepest city here.
 */
const city = cityNetworks.find((entry) => entry.city.slug === 'stuttgart')!
const network = city.network
const schedule = scheduleJson as ScheduleJson

const heightsOf = (name: string) =>
  Object.values(city.json.stops)
    .filter((stop) => stop.name === name)
    .map((stop) => stop.nhn!)

describe('the Stuttgart dataset', () => {
  it('has the sixteen Stadtbahn lines, the S-Bahn and the SSB buses', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['U1', 'U2', 'U6', 'U9', 'U14', 'U19', 'S1', 'S4', 'S6', '40', '92', 'N1', 'X2']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('subway').length).toBeGreaterThanOrEqual(15)
    expect(byMode('train').length).toBeGreaterThanOrEqual(6)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(40)
    expect(byMode('tram')).toHaveLength(0)
    expect(byMode('ferry')).toHaveLength(0)
    // The Stadtbahn is the city's U-Bahn, the S-Bahn is not
    for (const line of byMode('subway')) expect(line.id, line.id).toMatch(/^U[0-9]+$/)
    for (const line of byMode('train')) expect(line.id, line.id).toMatch(/^S[0-9]+$/)
  })

  it('takes its Stadtbahn through the centre in tunnels and out in the open', () => {
    // Every trunk line has kilometres of tunnel under the Talkessel; the
    // U3 to Plieningen and the U19 to the Neckarpark stay on the surface.
    for (const id of ['U1', 'U2', 'U5', 'U6', 'U7', 'U12', 'U14']) {
      const line = network.lines.find((l) => l.id === id)!
      const tunnelMeters = line.directions[0].tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
      expect(tunnelMeters, `${id} tunnel length`).toBeGreaterThan(2000)
    }
  })

  it('climbs from the Talkessel to the ridge, 243 m at the station and 470 on the Fernsehturm hill', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Baden-Württemberg DGM1 via Mapterhorn. Nowhere else on this map does
    // one network span 300 m of height.
    const hbf = heightsOf('Hauptbahnhof (Arnulf-Klett-Platz)')
    expect(hbf.length).toBeGreaterThan(0)
    for (const h of hbf) expect(h).toBeGreaterThan(240)
    for (const h of hbf) expect(h).toBeLessThan(248)
    for (const h of heightsOf('Ruhbank (Fernsehturm)')) expect(h).toBeGreaterThan(460)
    const all = Object.values(city.json.stops).map((stop) => stop.nhn!)
    expect(Math.min(...all)).toBeGreaterThan(190)
    expect(Math.max(...all)).toBeLessThan(560)
    expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(250)
    expect(city.json.meta.terrainAttribution).toContain('LGL')
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
    expect(lampsJson.lamps.length).toBeGreaterThan(1200)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for every line but the event-only U11, and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    // The U11 runs to the stadium and the Wasen on event days only, so it
    // stands still on an ordinary weekday – as it does in reality.
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 2)
    for (const id of ['U1', 'U6', 'U14', 'S1', '40', 'N1']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 257 at 08:30, 104 of them Stadtbahn.
    expect(snapshots.length).toBeGreaterThan(150)
    expect(snapshots.length).toBeLessThan(700)
    const activeLines = linesOutInTheMorning(sim)
    for (const id of ['U1', 'U6', 'U7', 'U14', 'S1', 'S4']) {
      expect(activeLines, `${id} out in the morning`).toContain(id)
    }
    // The night buses are out at half past two and in by day
    const night = new Set(sim.snapshotsAt(2.5 * 3600).map((s) => s.lineId))
    expect(night).toContain('N3')
    expect(activeLines).not.toContain('N3')
  })
})
