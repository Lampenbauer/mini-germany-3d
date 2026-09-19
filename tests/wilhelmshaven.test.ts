import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks, linesOutInTheMorning } from './cities'
import scheduleJson from '@/cities/wilhelmshaven/schedule.json'
import lampsJson from '@/cities/wilhelmshaven/street-lamps.json'

/**
 * What the Wilhelmshaven dataset has to be for the city to make sense on
 * the map – the smallest city here: fourteen bus lines of the Stadtwerke
 * on the flattest ground, right at sea level. Its point is the water: the
 * Jade carries the deepest port in Germany, and the AIS backdrop is what
 * the map really shows off here.
 */
const city = cityNetworks.find((entry) => entry.city.slug === 'wilhelmshaven')!
const network = city.network
const schedule = scheduleJson as ScheduleJson

const heightsOf = (name: string) =>
  Object.values(city.json.stops)
    .filter((stop) => stop.name === name)
    .map((stop) => stop.nhn!)

describe('the Wilhelmshaven dataset', () => {
  it('has the Stadtwerke bus network and nothing on rails', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['1', '2', '3', '4', '6', 'S1', 'S3']) expect(ids, id).toContain(id)
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(12)
    for (const mode of ['tram', 'subway', 'train', 'ferry'] as const) {
      expect(network.lines.filter((l) => l.mode === mode), mode).toHaveLength(0)
    }
    // City lines and the S-prefixed ones the Stadtwerke run – both buses
    for (const line of byMode('bus')) expect(line.id, line.id).toMatch(/^S?[0-9]{1,2}$/)
  })

  it('keeps the AIS backdrop on, because the Jade is what there is to see', () => {
    expect(city.city.ais.enabled).toBe(true)
    expect(city.city.ais.simulatedByMmsi).toEqual({})
  })

  it('lies at sea level from end to end', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Lower Saxon DGM1 via Mapterhorn. The whole city sits on reclaimed
    // marsh between 0 and 7 m; there is no hill to be had.
    const hbf = heightsOf('Hauptbahnhof (ZOB)')
    expect(hbf.length).toBeGreaterThan(0)
    for (const h of hbf) expect(h).toBeLessThan(4)
    for (const stop of Object.values(city.json.stops)) {
      expect(stop.nhn!, stop.name).toBeGreaterThan(-2)
      expect(stop.nhn!, stop.name).toBeLessThan(12)
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
    expect(lampsJson.lamps.length).toBeGreaterThan(60)
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
    for (const id of ['1', '2', '3']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 17 at 08:30 – a city of 76 000 with a bus every 20 minutes.
    expect(snapshots.length).toBeGreaterThan(8)
    expect(snapshots.length).toBeLessThan(80)
    const activeLines = linesOutInTheMorning(sim)
    for (const id of ['1', '2', '3', '4']) {
      expect(activeLines, `${id} out in the morning`).toContain(id)
    }
  })
})
