import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks } from './cities'
import scheduleJson from '@/cities/schwerin/schedule.json'
import lampsJson from '@/cities/schwerin/street-lamps.json'

/**
 * What the Schwerin dataset has to be for the city to make sense on the
 * map – the smallest network here: four tram lines and fifteen bus lines
 * of the NVS between the lakes. Guards the nightly refresh; the city is
 * small enough that a broken operator filter would show as an empty map
 * rather than as a few missing lines.
 */
const city = cityNetworks.find((entry) => entry.city.slug === 'schwerin')!
const network = city.network
const schedule = scheduleJson as ScheduleJson

const heightsOf = (name: string) =>
  Object.values(city.json.stops)
    .filter((stop) => stop.name === name)
    .map((stop) => stop.nhn!)

describe('the Schwerin dataset', () => {
  it('has the four NVS tram lines and its bus network', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['1', '2', '3', '4', '5', '10', '14']) expect(ids, id).toContain(id)
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('tram')).toHaveLength(4)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(12)
    expect(byMode('subway')).toHaveLength(0)
    expect(byMode('train')).toHaveLength(0)
    // The Pfaffenteich ferry is a real NVS line, but no feed carries a
    // timetable for it – it would stand still on the map (see the README)
    expect(byMode('ferry')).toHaveLength(0)
  })

  it('runs its trams on the surface, stop by stop', () => {
    for (const line of network.lines.filter((l) => l.mode === 'tram')) {
      for (const dir of line.directions) {
        expect(dir.stops.length, `${line.id} ${dir.from} → ${dir.to}`).toBeGreaterThanOrEqual(10)
        // Nothing runs underground here – the only tunnel section on the
        // network is the underpass by the station, a hundred meters of it
        const tunnelMeters = dir.tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
        expect(tunnelMeters, `${line.id} tunnel length`).toBeLessThan(300)
      }
    }
  })

  it('stands between the lakes, 43 m at the Marienplatz', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Mecklenburg DGM1 via Mapterhorn. The Schweriner See lies at 37.5 m
    // and the city rises from its shore to the Lankow ridge at ~78 m.
    const marienplatz = heightsOf('Marienplatz')
    expect(marienplatz.length).toBeGreaterThan(0)
    for (const h of marienplatz) expect(h).toBeGreaterThan(40)
    for (const h of marienplatz) expect(h).toBeLessThan(48)
    for (const stop of Object.values(city.json.stops)) {
      expect(stop.nhn!, stop.name).toBeGreaterThan(35)
      expect(stop.nhn!, stop.name).toBeLessThan(95)
    }
    expect(city.json.meta.terrainAttribution).toContain('GeoBasis-DE/M-V')
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
    expect(lampsJson.lamps.length).toBeGreaterThan(600)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for every line and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 1)
    for (const id of ['1', '2', '3', '4']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 38 at 08:30 – the smallest fleet on the map, and right for
    // a city of 100 000 with four tram lines.
    expect(snapshots.length).toBeGreaterThan(20)
    expect(snapshots.length).toBeLessThan(150)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    for (const id of ['1', '2', '3', '4']) {
      expect(activeLines, `${id} out at 08:30`).toContain(id)
    }
  })
})
