import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks, linesOutInTheMorning } from './cities'
import berlinScheduleJson from '@/cities/berlin/schedule.json'

/**
 * What the Berlin dataset has to be for the city to make sense on the
 * map – the counterpart of the Rostock checks in network.test.ts,
 * schedule-data.test.ts and simulation.test.ts. Guards the nightly
 * refresh: the Ringbahn relations are closed rings whose orientation
 * only the stops reveal, and their trips are rounds rather than runs
 * from A to B – a regression in either would show up here first.
 */
const berlin = cityNetworks.find((entry) => entry.city.slug === 'berlin')!
const network = berlin.network
const schedule = berlinScheduleJson as ScheduleJson

/**
 * The ferries that do not sail every day of the week: the F21 and the F23
 * from Tuesday to Sunday, the F24 at weekends alone (the feeds of
 * 2026-09-05 and 2026-09-26 agree), so a Monday's service day has none of
 * the three and any weekday's no F24. Which weekday the service day is
 * moves with the calendar – see WEEKEND_NIGHT_LINES in cologne.test.ts.
 */
const PART_WEEK_FERRIES = ['F21', 'F23', 'F24']

describe('the Berlin dataset', () => {
  it('has the U-Bahn, the S-Bahn, the trams, the Metrobus lines and the ferries', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['U1', 'U9', 'S1', 'S41', 'S42', 'M4', 'M10', '12', 'M41', '100', 'F10']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('subway')).toHaveLength(9)
    expect(byMode('train').length).toBeGreaterThanOrEqual(14)
    expect(byMode('tram').length).toBeGreaterThanOrEqual(20)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(18)
    expect(byMode('ferry').length).toBeGreaterThanOrEqual(5)
    // Only the Metrobus lines and the 100/200/300 – the whole BVG bus
    // network would be 150 lines more (see README, Cities)
    for (const line of byMode('bus')) expect(line.id, line.id).toMatch(/^(M[0-9]+|100|200|300)$/)
  })

  it('runs the Ringbahn as one closed ring per direction line', () => {
    for (const id of ['S41', 'S42']) {
      const line = network.lines.find((l) => l.id === id)!
      const dir = line.directions[0]
      expect(dir.stops.length, `${id} stops`).toBeGreaterThanOrEqual(27)
      const [lon0, lat0] = dir.path[0]
      const [lon1, lat1] = dir.path[dir.path.length - 1]
      const meters = Math.hypot((lon1 - lon0) * Math.cos((lat0 * Math.PI) / 180) * 111_320, (lat1 - lat0) * 111_320)
      expect(meters, `${id} ring closes`).toBeLessThan(150)
    }
  })

  it('runs its subway mostly in tunnels', () => {
    for (const line of network.lines.filter((l) => l.mode === 'subway')) {
      const tunnelMeters = line.directions
        .flatMap((dir) => dir.tunnels)
        .reduce((sum, [start, end]) => sum + (end - start), 0)
      expect(tunnelMeters, `${line.id} tunnel length`).toBeGreaterThan(2000)
    }
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for nearly every line, rounds on the ring, and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    // The ferries that do not sail every day are not counted, the chosen
    // day may be one they do not sail on
    const idle = network.lines
      .filter((line) => !PART_WEEK_FERRIES.includes(line.id) && !withDepartures.includes(line.id))
      .map((line) => line.id)
    expect(idle.length, `without departures: ${idle.join(', ')}`).toBeLessThanOrEqual(3)
    for (const id of ['S41', 'S42']) {
      const rounds = Object.values(schedule.lines?.[id] ?? {}).reduce((n, d) => n + d.departures.length, 0)
      expect(rounds, `${id} rounds a day`).toBeGreaterThan(150)
    }
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Rostock runs ~350 vehicles at 08:30, Berlin's selection about
    // twice that (measured: 685) – and far below the thousands the whole
    // BVG bus network would add.
    expect(snapshots.length).toBeGreaterThan(400)
    expect(snapshots.length).toBeLessThan(2000)
    const activeLines = linesOutInTheMorning(sim)
    for (const id of ['U1', 'U5', 'S41', 'S42', 'M4', 'M10', '100']) {
      expect(activeLines, `${id} out in the morning`).toContain(id)
    }
  })
})
