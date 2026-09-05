import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks } from './cities'
import hamburgScheduleJson from '@/cities/hamburg/schedule.json'
import hamburgLampsJson from '@/cities/hamburg/street-lamps.json'

/**
 * What the Hamburg dataset has to be for the city to make sense on the
 * map – the counterpart of the Kiel and Rostock checks. Guards the
 * nightly refresh, and above all the terrain: Mapterhorn's Hamburg import
 * lacks 20 of the DGM1's 2 km squares, where its tiles carry a 30 m
 * surface model 3–20 m above the ground, and the city folder's own tiles
 * (src/cities/hamburg/terrain) close those holes. Should the pipeline
 * ever sample the centre without them, Mönckebergstraße comes back at
 * 20–30 m instead of 13, and this notices.
 */
const hamburg = cityNetworks.find((entry) => entry.city.slug === 'hamburg')!
const network = hamburg.network
const schedule = hamburgScheduleJson as ScheduleJson

describe('the Hamburg dataset', () => {
  it('has the U-Bahn, the S-Bahn, the Metrobus lines and the HADAG ferries', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['U1', 'U2', 'U3', 'U4', 'S1', 'S3', 'S5', '5', '6', '25', '61', '62', '72']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('subway')).toHaveLength(4)
    expect(byMode('train').length).toBeGreaterThanOrEqual(4)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(24)
    expect(byMode('ferry').length).toBeGreaterThanOrEqual(6)
    expect(byMode('tram')).toHaveLength(0)
  })

  it('stands on the DGM1 in the centre, not on the surface model', () => {
    // Stop heights are meters NHN straight from the terrain sampler. The
    // DGM1 has Mönckebergstraße at 12–13 m and the Rathaus at 6 m; the
    // 30 m surface model Mapterhorn falls back to there says 21 and 10.
    const heightsOf = (name: string) =>
      Object.values(hamburg.json.stops)
        .filter((stop) => stop.name === name)
        .map((stop) => stop.nhn!)
    const moenckeberg = heightsOf('Mönckebergstraße')
    expect(moenckeberg.length).toBeGreaterThan(0)
    for (const h of moenckeberg) expect(h).toBeGreaterThan(11)
    for (const h of moenckeberg) expect(h).toBeLessThan(15)
    for (const h of heightsOf('Rathaus')) expect(h).toBeLessThan(8)
    for (const h of heightsOf('Rathaus Wilhelmsburg')) expect(h).toBeLessThan(4)
    expect(hamburg.json.meta.terrainAttribution).toContain('Landesbetrieb Geoinformation und Vermessung')
  })

  it('carries a height for every route vertex and every stop', () => {
    for (const line of hamburg.json.lines) {
      for (const dir of line.directions) {
        expect(dir.heights?.length, `${line.id} ${dir.from} → ${dir.to}`).toBe(dir.path.length)
      }
    }
    for (const stop of Object.values(hamburg.json.stops)) {
      expect(stop.nhn, stop.name).toBeTypeOf('number')
    }
  })

  it('lights its routes with a few thousand OSM lamps', () => {
    expect(hamburgLampsJson.lamps.length).toBeGreaterThan(3000)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for nearly every line and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 2)
    for (const id of ['U1', 'S1', '62']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Between Rostock's ~350 and Berlin's ~700 vehicles at 08:30.
    expect(snapshots.length).toBeGreaterThan(300)
    expect(snapshots.length).toBeLessThan(1000)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    for (const id of ['U1', 'U3', 'S1', '5', '62']) {
      expect(activeLines, `${id} out at 08:30`).toContain(id)
    }
  })
})
