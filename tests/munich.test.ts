import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks } from './cities'
import munichScheduleJson from '@/cities/munich/schedule.json'
import munichLampsJson from '@/cities/munich/street-lamps.json'

/**
 * What the Munich dataset has to be for the city to make sense on the
 * map – the counterpart of the Hamburg and Berlin checks. Guards the
 * nightly refresh: the U-Bahn is the first network here that runs
 * underground almost end to end, the S-Bahn lines all share the trunk
 * line under the centre and are cut at the city limits, and the bus
 * selection is the MetroBus and ExpressBus lines alone – a refresh that
 * let the 80 StadtBus lines in would double the fleet.
 */
const munich = cityNetworks.find((entry) => entry.city.slug === 'munich')!
const network = munich.network
const schedule = munichScheduleJson as ScheduleJson

describe('the Munich dataset', () => {
  it('has the U-Bahn, the S-Bahn, the trams and the MetroBus and ExpressBus lines', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['U1', 'U3', 'U6', 'U8', 'S1', 'S8', 'S20', '12', '19', '27', 'N27', '53', '58', 'X30']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('subway')).toHaveLength(8)
    expect(byMode('train').length).toBeGreaterThanOrEqual(8)
    expect(byMode('tram').length).toBeGreaterThanOrEqual(14)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(15)
    expect(byMode('ferry')).toHaveLength(0)
    // MetroBus (50–68) and ExpressBus (X30…) only – no StadtBus, no night bus
    for (const line of byMode('bus')) expect(line.id, line.id).toMatch(/^([5-6][0-9]|X[0-9]+)$/)
    // Day and night trams, but no E-lines (works replacement services)
    for (const line of byMode('tram')) expect(line.id, line.id).toMatch(/^N?[0-9]+$/)
  })

  it('runs its subway underground almost end to end', () => {
    for (const line of network.lines.filter((l) => l.mode === 'subway')) {
      for (const dir of line.directions) {
        const tunnelMeters = dir.tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
        expect(tunnelMeters / dir.totalLength, `${line.id} ${dir.from} → ${dir.to}`).toBeGreaterThan(0.7)
      }
    }
  })

  it('stands on the Munich gravel plain, 516 m at Marienplatz and 530 m on the Isar high bank', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Bavarian DGM1 via Mapterhorn. The Altstadt sits at 515–520 m, the
    // Isar valley 5 m lower, Haidhausen and the Ostbahnhof 10 m higher.
    const heightsOf = (name: string) =>
      Object.values(munich.json.stops)
        .filter((stop) => stop.name === name)
        .map((stop) => stop.nhn!)
    const marienplatz = heightsOf('Marienplatz')
    expect(marienplatz.length).toBeGreaterThan(0)
    for (const h of marienplatz) expect(h).toBeGreaterThan(513)
    for (const h of marienplatz) expect(h).toBeLessThan(520)
    for (const h of heightsOf('Isartor')) expect(h).toBeLessThan(516)
    for (const h of heightsOf('Ostbahnhof')) expect(h).toBeGreaterThan(527)
    for (const h of heightsOf('Ostbahnhof')) expect(h).toBeLessThan(534)
    expect(munich.json.meta.terrainAttribution).toContain('Bayerische Vermessungsverwaltung')
  })

  it('carries a height for every route vertex and every stop', () => {
    for (const line of munich.json.lines) {
      for (const dir of line.directions) {
        expect(dir.heights?.length, `${line.id} ${dir.from} → ${dir.to}`).toBe(dir.path.length)
      }
    }
    for (const stop of Object.values(munich.json.stops)) {
      expect(stop.nhn, stop.name).toBeTypeOf('number')
    }
  })

  it('lights its routes with the OSM lamps along them', () => {
    // Community-mapped, not an official import: some 2300 along 50 lines.
    expect(munichLampsJson.lamps.length).toBeGreaterThan(1500)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for every line but the Saturday-only U8, and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    // The U8 runs on Saturdays only; the schedule is a weekday, so it
    // stays on the map without a train – as it does in reality.
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 2)
    for (const id of ['U1', 'U6', 'S1', 'S8', '19', '53', 'X30', 'N19']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 372 at 08:30 – Rostock's size, with the whole bus network
    // left out on purpose.
    expect(snapshots.length).toBeGreaterThan(250)
    expect(snapshots.length).toBeLessThan(800)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    for (const id of ['U1', 'U3', 'U6', 'S1', 'S8', '19', '53']) {
      expect(activeLines, `${id} out at 08:30`).toContain(id)
    }
    // The night trams are out at half past two and in by day
    const night = new Set(sim.snapshotsAt(2.5 * 3600).map((s) => s.lineId))
    expect(night).toContain('N19')
    expect(activeLines).not.toContain('N19')
  })
})
