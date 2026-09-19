import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks, linesOutInTheMorning } from './cities'
import scheduleJson from '@/cities/frankfurt/schedule.json'
import lampsJson from '@/cities/frankfurt/street-lamps.json'

/**
 * What the Frankfurt dataset has to be for the city to make sense on the
 * map. Guards the nightly refresh: the U-Bahn is a Stadtbahn that OSM tags
 * `subway` and the feed types as an underground, the trams share their line
 * numbers with the Rhein-Main region around them (the definition takes the
 * RMV network and the 11–21 block rather than an operator, because line 11
 * carries no operator tag at all), and of the buses only the MetroBus and
 * Express lines are on the map.
 */
const city = cityNetworks.find((entry) => entry.city.slug === 'frankfurt')!
const network = city.network
const schedule = scheduleJson as ScheduleJson

const heightsOf = (name: string) =>
  Object.values(city.json.stops)
    .filter((stop) => stop.name === name)
    .map((stop) => stop.nhn!)

describe('the Frankfurt dataset', () => {
  it('has the U-Bahn, the trams, all nine S-Bahn lines and the MetroBus lines', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['U1', 'U4', 'U9', '11', '12', '17', '21', 'S1', 'S8', 'M32', 'M46']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('subway')).toHaveLength(9)
    expect(byMode('tram').length).toBeGreaterThanOrEqual(9)
    // All nine: the S5 and S6 share their number with a Rhein-Neckar line
    // that is longer and also reaches the box (see the importer's
    // same-number filter), and used to be lost to it
    expect(byMode('train')).toHaveLength(9)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(8)
    expect(byMode('ferry')).toHaveLength(0)
    // MetroBus lines only: the 60 city bus lines would double the fleet, as
    // Berlin's and Munich's would, and the Express buses are regional
    // lines that only touch the city (the X95 has 450 m of route inside)
    for (const line of byMode('bus')) expect(line.id, line.id).toMatch(/^M[0-9]+$/)
    // Trams 11–21, without the Ebbelwei-Express (a museum line)
    for (const line of byMode('tram')) expect(line.id, line.id).toMatch(/^(1[1-9]|2[01])$/)
  })

  it('runs the U-Bahn under the centre and the trams on top of it', () => {
    for (const line of network.lines.filter((l) => l.mode === 'subway')) {
      const tunnelMeters = line.directions[0].tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
      expect(tunnelMeters, `${line.id} tunnel length`).toBeGreaterThan(1000)
    }
    for (const line of network.lines.filter((l) => l.mode === 'tram')) {
      const tunnelMeters = line.directions[0].tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
      expect(tunnelMeters, `${line.id} tunnel length`).toBeLessThan(500)
    }
  })

  it('stands on the Main plain, 100 m at the Hauptwache and 99 at the station', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Hessian DGM1 via Mapterhorn. The city floor lies at 96–102 m, and
    // only the Berger Rücken in the north-east climbs past 150.
    const hauptwache = heightsOf('Hauptwache')
    expect(hauptwache.length).toBeGreaterThan(0)
    for (const h of hauptwache) expect(h).toBeGreaterThan(99)
    for (const h of hauptwache) expect(h).toBeLessThan(105)
    for (const h of heightsOf('Hauptbahnhof')) expect(h).toBeLessThan(102)
    for (const stop of Object.values(city.json.stops)) {
      expect(stop.nhn!, stop.name).toBeGreaterThan(80)
      expect(stop.nhn!, stop.name).toBeLessThan(230)
    }
    expect(city.json.meta.terrainAttribution).toContain('Hessisches Ministerium')
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

  it('has real departures for nearly every line and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 3)
    for (const id of ['U1', 'U4', '11', 'S1', 'S5', 'M32']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 219 at 08:30 – two thirds of Rostock's fleet on a network
    // of four modes, because the bus lines are the MetroBus ones alone.
    expect(snapshots.length).toBeGreaterThan(150)
    expect(snapshots.length).toBeLessThan(600)
    const activeLines = linesOutInTheMorning(sim)
    for (const id of ['U1', 'U4', 'U7', '11', '16', 'S1', 'M34']) {
      expect(activeLines, `${id} out in the morning`).toContain(id)
    }
  })
})
