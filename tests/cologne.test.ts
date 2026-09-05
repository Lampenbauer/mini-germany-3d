import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks } from './cities'
import cologneScheduleJson from '@/cities/cologne/schedule.json'
import cologneLampsJson from '@/cities/cologne/street-lamps.json'

/**
 * What the Cologne dataset has to be for the city to make sense on the map
 * – the counterpart of the Hamburg and Berlin checks. Guards the nightly
 * refresh: the Stadtbahn is a tram network that dives under the centre
 * and crosses the Rhine on bridges, two of its S-Bahn lines are tagged
 * `regional` rather than `commuter` in OSM (so the definition selects
 * them by ref alone), and the bus selection leaves the 181 out while its
 * OSM relation is a stub – a refresh that let it back in would show a
 * four-stop line running a handful of its trips.
 */
const cologne = cityNetworks.find((entry) => entry.city.slug === 'cologne')!
const network = cologne.network
const schedule = cologneScheduleJson as ScheduleJson

describe('the Cologne dataset', () => {
  it('has the Stadtbahn, the four S-Bahn lines and the KVB buses', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['1', '3', '4', '5', '7', '9', '12', '13', '15', '16', '17', '18', 'S6', 'S11', 'S12', 'S19', '106', '127', '133', '159']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('tram')).toHaveLength(12)
    expect(byMode('train')).toHaveLength(4)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(55)
    expect(byMode('subway')).toHaveLength(0)
    expect(byMode('ferry')).toHaveLength(0)
    // The S-Bahn lines that stop in Cologne only – the S1/S7/S8/S23/S28/S68
    // of the wider S-Bahn Rhein-Ruhr and Rhein-Sieg pass the box outside
    // the city and are dropped without a stop inside it
    for (const line of byMode('train')) expect(['S6', 'S11', 'S12', 'S19']).toContain(line.id)
    // KVB's 1xx bus lines, minus the 181 (see the header)
    for (const line of byMode('bus')) expect(line.id, line.id).toMatch(/^1[0-9][0-9]$/)
    expect(ids).not.toContain('181')
  })

  it('runs its Stadtbahn under the centre and over the Rhine', () => {
    // Every trunk line has kilometres of tunnel (the 7 alone stays on the
    // surface: it crosses the Rhine on the Deutzer Brücke and runs on
    // street track east of it); the 13 rides the Gürtel over its bridges.
    for (const id of ['1', '3', '4', '5', '9', '12', '15', '16', '18']) {
      const line = network.lines.find((l) => l.id === id)!
      const tunnelMeters = line.directions[0].tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
      expect(tunnelMeters, `${id} tunnel length`).toBeGreaterThan(3000)
    }
    // Rhine crossings: the 1 and the 7 reach Deutz from the Altstadt, the
    // 3 and 4 reach Mülheim, the 13 and 18 the right bank, so both banks
    // carry stops of the network
    const names = new Set(Object.values(cologne.json.stops).map((stop) => stop.name))
    for (const name of ['Neumarkt', 'Dom/Hbf', 'Bf Deutz/Messe', 'Mülheim Wiener Platz', 'Chlodwigplatz']) {
      expect(names, name).toContain(name)
    }
  })

  it('stands on the Rhine terrace, 52 m at the Neumarkt and 45 m in Deutz', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // NRW DGM1 via Mapterhorn. The left-bank Altstadt and the Ringe sit at
    // 50–53 m, Deutz on the right bank at 45–47 m, the Rhine itself near
    // 38 m at mean water.
    const heightsOf = (name: string) =>
      Object.values(cologne.json.stops)
        .filter((stop) => stop.name === name)
        .map((stop) => stop.nhn!)
    const neumarkt = heightsOf('Neumarkt')
    expect(neumarkt.length).toBeGreaterThan(0)
    for (const h of neumarkt) expect(h).toBeGreaterThan(50)
    for (const h of neumarkt) expect(h).toBeLessThan(55)
    for (const h of heightsOf('Bf Deutz/Messe')) expect(h).toBeGreaterThan(43)
    for (const h of heightsOf('Bf Deutz/Messe')) expect(h).toBeLessThan(48)
    expect(cologne.json.meta.terrainAttribution).toContain('Geobasis NRW')
  })

  it('carries a height for every route vertex and every stop', () => {
    for (const line of cologne.json.lines) {
      for (const dir of line.directions) {
        expect(dir.heights?.length, `${line.id} ${dir.from} → ${dir.to}`).toBe(dir.path.length)
      }
    }
    for (const stop of Object.values(cologne.json.stops)) {
      expect(stop.nhn, stop.name).toBeTypeOf('number')
    }
  })

  it('lights its routes with a few thousand OSM lamps', () => {
    expect(cologneLampsJson.lamps.length).toBeGreaterThan(4000)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for nearly every line and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 3)
    for (const id of ['1', '18', 'S11', '127']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 372 at 08:30 – Rostock's size, a third of it Stadtbahn.
    expect(snapshots.length).toBeGreaterThan(250)
    expect(snapshots.length).toBeLessThan(800)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    for (const id of ['1', '4', '9', '16', '18', 'S11', 'S12', '127', '133']) {
      expect(activeLines, `${id} out at 08:30`).toContain(id)
    }
  })
})
