import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks } from './cities'
import bremenScheduleJson from '@/cities/bremen/schedule.json'
import bremenLampsJson from '@/cities/bremen/street-lamps.json'

/**
 * What the Bremen dataset has to be for the city to make sense on the
 * map – the counterpart of the Kiel and Rostock checks. Guards the
 * nightly refresh: the whole BSAG network (trams, buses, night lines) is
 * on the map, the Regio-S-Bahn is selected by its RS refs rather than
 * the usual S ones and leaves the city within a stop or two, and the
 * marshland terrain has to come back flat – Mapterhorn's Bremen source
 * is the state's own DGM1, where a fallback to the surface model would
 * show as house-high stops.
 */
const bremen = cityNetworks.find((entry) => entry.city.slug === 'bremen')!
const network = bremen.network
const schedule = bremenScheduleJson as ScheduleJson

describe('the Bremen dataset', () => {
  it('has the BSAG trams and buses and the Regio-S-Bahn', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['1', '2', '3', '4', '6', '8', '10', 'N1', 'RS1', 'RS2', '20', '26', '63', '90', 'N7']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('tram').length).toBeGreaterThanOrEqual(10)
    expect(byMode('train').length).toBeGreaterThanOrEqual(3)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(35)
    expect(byMode('subway')).toHaveLength(0)
    expect(byMode('ferry')).toHaveLength(0)
    // Regio-S-Bahn lines carry RS refs; a plain S-line here would be a
    // stray relation from another network
    for (const line of byMode('train')) expect(line.id, line.id).toMatch(/^RS[0-9]+$/)
    // Trams: day and night lines, nothing else
    for (const line of byMode('tram')) expect(line.id, line.id).toMatch(/^N?[0-9]+$/)
  })

  it('runs its trams stop by stop on the surface', () => {
    for (const line of network.lines.filter((l) => l.mode === 'tram')) {
      for (const dir of line.directions) {
        expect(dir.stops.length, `${line.id} ${dir.from} → ${dir.to}`).toBeGreaterThanOrEqual(12)
        const tunnelMeters = dir.tunnels.reduce((sum, [start, end]) => sum + (end - start), 0)
        expect(tunnelMeters, `${line.id} tunnel length`).toBeLessThan(500)
      }
    }
  })

  it('stands on the flat marsh, 4 m at the station and 10 m on the dune of the Altstadt', () => {
    // Stop heights are meters NHN straight from the terrain sampler: the
    // Bremen DGM1 via Mapterhorn. The station and the university sit on
    // the marsh at 2–5 m, the Altstadt on its dune at 9–11 m (Domsheide).
    const heightsOf = (name: string) =>
      Object.values(bremen.json.stops)
        .filter((stop) => stop.name === name)
        .map((stop) => stop.nhn!)
    const hbf = heightsOf('Hauptbahnhof')
    expect(hbf.length).toBeGreaterThan(0)
    for (const h of hbf) expect(h).toBeGreaterThan(2.5)
    for (const h of hbf) expect(h).toBeLessThan(6)
    for (const h of heightsOf('Domsheide')) expect(h).toBeGreaterThan(8)
    for (const h of heightsOf('Domsheide')) expect(h).toBeLessThan(13)
    for (const h of heightsOf('Universität/Zentralbereich')) expect(h).toBeLessThan(5)
    // Nothing in the city stands higher than its few dumps and dykes
    for (const stop of Object.values(bremen.json.stops)) expect(stop.nhn!, stop.name).toBeLessThan(40)
    expect(bremen.json.meta.terrainAttribution).toContain('Landesamt GeoInformation Bremen')
  })

  it('carries a height for every route vertex and every stop', () => {
    for (const line of bremen.json.lines) {
      for (const dir of line.directions) {
        expect(dir.heights?.length, `${line.id} ${dir.from} → ${dir.to}`).toBe(dir.path.length)
      }
    }
    for (const stop of Object.values(bremen.json.stops)) {
      expect(stop.nhn, stop.name).toBeTypeOf('number')
    }
  })

  it('lights its routes with the OSM lamps along them', () => {
    // Community-mapped: some 1900 along 60 lines.
    expect(bremenLampsJson.lamps.length).toBeGreaterThan(1200)
  })

  it('draws every line with a consist the map knows', () => {
    for (const line of network.lines) {
      expect(line.model, `${line.id} (${line.mode})`).toBeDefined()
      expect(Object.keys(VEHICLE_CONSISTS), `${line.id}: ${line.model}`).toContain(line.model)
    }
  })

  it('has real departures for nearly every line and runs a full morning', () => {
    const withDepartures = Object.keys(schedule.lines ?? {})
    // Left without: the 66 and N94 (no trips that day) and the RS4, whose
    // two-stop stub inside the city its trips did not project onto.
    expect(withDepartures.length).toBeGreaterThanOrEqual(network.lines.length - 4)
    for (const id of ['1', '4', '6', 'RS1', '26', '90', 'N7']) expect(withDepartures).toContain(id)
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Measured 223 at 08:30 – two thirds of Rostock, a third of it trams.
    expect(snapshots.length).toBeGreaterThan(150)
    expect(snapshots.length).toBeLessThan(600)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    for (const id of ['1', '2', '4', '6', '10', 'RS1', '26', '90']) {
      expect(activeLines, `${id} out at 08:30`).toContain(id)
    }
    // The night lines run in the weekend nights only – the feed's Friday
    // carries them as its small hours – so they are out at a quarter past
    // three and in by day
    const night = new Set(sim.snapshotsAt(3.25 * 3600).map((s) => s.lineId))
    expect(night).toContain('N1')
    expect(activeLines).not.toContain('N1')
  })
})
