import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { VEHICLE_CONSISTS } from '@/map/VehicleLayer'
import type { ScheduleJson } from '@/lib/timetable'
import { cityNetworks } from './cities'
import hamburgScheduleJson from '@/cities/hamburg/schedule.json'

/**
 * What the Hamburg dataset has to be for the city to make sense on the
 * map – the counterpart of the Rostock checks in network.test.ts,
 * schedule-data.test.ts and simulation.test.ts. Guards the nightly
 * refresh: a broken Overpass answer or an S-Bahn whose two relations
 * both leave the same terminus must not slip through.
 */
const hamburg = cityNetworks.find((entry) => entry.city.slug === 'hamburg')!
const network = hamburg.network
const schedule = hamburgScheduleJson as ScheduleJson

describe('the Hamburg dataset', () => {
  it('has the four subway lines, the S-Bahn, the Metrobus lines and the harbour ferries', () => {
    const ids = new Set(network.lines.map((l) => l.id))
    for (const id of ['U1', 'U2', 'U3', 'U4', 'S1', 'S3', '5', '6', '62']) {
      expect(ids, id).toContain(id)
    }
    const byMode = (mode: string) => network.lines.filter((l) => l.mode === mode)
    expect(byMode('subway')).toHaveLength(4)
    expect(byMode('train').length).toBeGreaterThanOrEqual(4)
    expect(byMode('bus').length).toBeGreaterThanOrEqual(20)
    expect(byMode('ferry').length).toBeGreaterThanOrEqual(5)
    // The Stadtbus lines are left out on purpose (see README, Cities)
    for (const line of byMode('bus')) expect(Number(line.id)).toBeLessThanOrEqual(27)
  })

  it('runs its subway in tunnels', () => {
    for (const line of network.lines.filter((l) => l.mode === 'subway')) {
      const tunnelMeters = line.directions
        .flatMap((dir) => dir.tunnels)
        .reduce((sum, [start, end]) => sum + (end - start), 0)
      expect(tunnelMeters, `${line.id} tunnel length`).toBeGreaterThan(5000)
    }
  })

  it('pairs each rail direction with the way back, not with a second branch', () => {
    // The S1 forks at Ohlsdorf (Poppenbüttel and the airport): both branch
    // relations leave Rissen, and only one of them is the way out – the
    // way back has to be the reverse, or the return trips run backwards.
    // Buses are looser: a return variant may end one stop short of the
    // outbound terminus ("Schenefeld, Busbetriebshof" vs "…, Aneken").
    for (const line of network.lines) {
      const [out, back] = line.directions
      if (line.mode === 'subway' || line.mode === 'train') {
        expect(back.from, `${line.id} return direction`).toBe(out.to)
        expect(back.to, `${line.id} return direction`).toBe(out.from)
      } else {
        expect(back.to, `${line.id} return direction`).not.toBe(out.to)
      }
    }
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
    const sim = new Simulation(network, new SimClock(), schedule, {
      cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
    })
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    // Rostock runs ~350 vehicles at 08:30; Hamburg's selection about twice
    // that – and far below the thousands the whole HVV bus network would be.
    expect(snapshots.length).toBeGreaterThan(300)
    expect(snapshots.length).toBeLessThan(1500)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    for (const id of ['U1', 'U2', 'U3', 'S1', 'S3', '62']) {
      expect(activeLines, `${id} out at 08:30`).toContain(id)
    }
  })
})
