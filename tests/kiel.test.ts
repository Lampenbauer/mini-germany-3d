import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks, linesOutInTheMorning } from './cities'
import kielScheduleJson from '@/cities/kiel/schedule.json'

/**
 * What the Kiel dataset has to be for the city to make sense on the map
 * – the counterpart of the Rostock checks in network.test.ts,
 * schedule-data.test.ts and simulation.test.ts. Guards the nightly
 * refresh: Kiel's OSM relations mostly list platforms instead of stop
 * positions, and its ferry relations run on past the piers the map
 * shows, so a regression in either fallback would show up here first.
 */
const kiel = cityNetworks.find((entry) => entry.city.slug === 'kiel')!
const network = kiel.network
const schedule = kielScheduleJson as ScheduleJson

/**
 * KVG's summer lines to the beaches – the X90 from the Hauptbahnhof to the
 * Falckensteiner Strand every day, the X92 from Strande to Laboe at
 * weekends. In 2026 the feed ran both until Sunday 11 October, so a service
 * day after it has neither: the busiest of the next three weeks was Friday
 * the 9th, then Monday the 12th the night after, when the refresh failed on
 * the X90.
 */
const SEASONAL_LINES = ['X90', 'X92']

describe('the Kiel dataset', () => {
  it('has the KVG bus lines and the two Förde ferries', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['2', '11', '14', '22', '61', 'X30', 'F1', 'F2']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(30)
    expect(byMode('ferry')).toHaveLength(2)
    expect(byMode('tram')).toHaveLength(0)
    expect(byMode('subway')).toHaveLength(0)
  })

  it('serves its bus routes stop by stop, not terminus to terminus', () => {
    // Platforms without a stop position stand in for the stop (see
    // scripts/fetch-osm-network.mjs) – without that, most of Kiel's
    // lines had two or three stops on fifteen kilometers.
    for (const line of network.lines.filter((l) => l.mode === 'bus')) {
      for (const dir of line.directions) {
        const km = dir.path.length > 1 ? 1 : 0
        expect(dir.stops.length, `${line.id} ${dir.from} → ${dir.to}`).toBeGreaterThanOrEqual(5 * km)
      }
    }
  })

  it('sails the F1 from the station to Laboe and the F2 up to Wellingdorf', () => {
    const f1 = network.lines.find((l) => l.id === 'F1')!
    const f2 = network.lines.find((l) => l.id === 'F2')!
    const names = (line: typeof f1) => line.directions[0].stops.map((stop) => stop.name)
    expect(names(f1)[0]).toBe('Bahnhof')
    expect(names(f1).at(-1)).toBe('Laboe')
    expect(names(f1)).toContain('Mönkeberg')
    expect(names(f2)[0]).toBe('Reventlou')
    expect(names(f2).at(-1)).toBe('Wellingdorf')
    // The F1 relation carries on from Laboe to its summer piers and back
    // (40 km in all) – the map shows the 15 km the definition names.
    const meters = (line: typeof f1) => {
      const path = line.directions[0].path
      let sum = 0
      for (let i = 1; i < path.length; i++) {
        const [lon1, lat1] = path[i - 1]
        const [lon2, lat2] = path[i]
        const x = ((lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180) * 111_320)
        const y = (lat2 - lat1) * 111_320
        sum += Math.hypot(x, y)
      }
      return sum
    }
    expect(meters(f1)).toBeGreaterThan(12_000)
    expect(meters(f1)).toBeLessThan(18_000)
    expect(meters(f2)).toBeLessThan(4_000)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for nearly every line and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    const idle = network.lines
      .filter((line) => !SEASONAL_LINES.includes(line.id) && !withDepartures.includes(line.id))
      .map((line) => line.id)
    expect(idle.length, `without departures: ${idle.join(', ')}`).toBeLessThanOrEqual(2)
    expect(withDepartures).toContain('F1')
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Rostock runs ~350 vehicles at 08:30; Kiel's bus network is of a
    // similar size.
    expect(snapshots.length).toBeGreaterThan(100)
    expect(snapshots.length).toBeLessThan(900)
    const activeLines = linesOutInTheMorning(sim)
    for (const id of ['2', '11', '22', '61']) {
      expect(activeLines, `${id} out in the morning`).toContain(id)
    }
  })
})
