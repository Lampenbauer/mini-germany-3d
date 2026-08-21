import { describe, expect, it } from 'vitest'
import { loadBundledNetwork } from '@/data/network'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'

describe('Simulation with the Rostock network', () => {
  const network = loadBundledNetwork()
  const sim = new Simulation(network, new SimClock())

  it('has active vehicles on almost all lines during rush hour', () => {
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    expect(snapshots.length).toBeGreaterThanOrEqual(network.lines.length * 2)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    // Only known line IDs …
    for (const id of activeLines) {
      expect(network.lineById.has(id), `unbekannte Linie ${id}`).toBe(true)
    }
    // … all trams run during rush hour …
    for (const line of network.lines.filter((l) => l.mode === 'tram')) {
      expect(activeLines.has(line.id), `Tram-Linie ${line.id} inaktiv`).toBe(true)
    }
    // … and buses/ferries may have occasional genuine service gaps (GTFS),
    // but the majority of the network must be on the move.
    expect(activeLines.size).toBeGreaterThanOrEqual(
      Math.floor(network.lines.length * 0.75),
    )
  })

  it('has no active trains at 3 a.m.', () => {
    expect(sim.snapshotsAt(3 * 3600)).toHaveLength(0)
  })

  it('all trains run within the city area', () => {
    const snapshots = sim.snapshotsAt(12 * 3600)
    expect(snapshots.length).toBeGreaterThan(0)
    for (const s of snapshots) {
      expect(s.lon).toBeGreaterThan(11.95)
      expect(s.lon).toBeLessThan(12.3)
      expect(s.lat).toBeGreaterThan(53.99)
      expect(s.lat).toBeLessThan(54.22)
      expect(s.bearing).toBeGreaterThanOrEqual(0)
      expect(s.bearing).toBeLessThan(360)
    }
  })

  it('snapshots are deterministic (same time → same positions)', () => {
    const a = sim.snapshotsAt(9 * 3600 + 123)
    const b = sim.snapshotsAt(9 * 3600 + 123)
    expect(a).toEqual(b)
  })

  it('snapshot IDs are unique', () => {
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    const ids = snapshots.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('provides the destination stop and the next stop', () => {
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    for (const s of snapshots) {
      expect(s.destination.length).toBeGreaterThan(0)
      expect(s.nextStopName.length).toBeGreaterThan(0)
      expect(s.color).toMatch(/^#/)
    }
  })

  it('the simulation state changes over time', () => {
    const t = 8.5 * 3600
    const before = sim.snapshotsAt(t)
    const after = sim.snapshotsAt(t + 60)
    expect(before.length).toBeGreaterThan(0)
    expect(after.length).toBeGreaterThan(0)
    expect(before).not.toEqual(after)
  })

  it.runIf(network.meta.source === 'approximated')(
    'trains move forward over time',
    () => {
      const t = 8.5 * 3600
      const before = sim.snapshotsAt(t)
      const after = sim.snapshotsAt(t + 60)
      const common = before.filter((b) =>
        after.some((a) => a.id === b.id && a.status === 'moving' && b.status === 'moving'),
      )
      expect(common.length).toBeGreaterThan(0)
      let movedCount = 0
      for (const b of common) {
        const a = after.find((x) => x.id === b.id)!
        if (Math.abs(a.lon - b.lon) > 1e-6 || Math.abs(a.lat - b.lat) > 1e-6) movedCount++
      }
      expect(movedCount).toBeGreaterThan(0)
    },
  )
})

describe('terrain heights in snapshots', () => {
  const network = loadBundledNetwork()
  const sim = new Simulation(network, new SimClock())

  it('every vehicle carries an interpolated NHN height from its route profile', () => {
    const snapshots = sim.snapshotsAt(12 * 3600)
    expect(snapshots.length).toBeGreaterThan(0)
    for (const s of snapshots) {
      // The bundled dataset has DGM heights for all directions; Rostock
      // terrain spans roughly -7…55 m NHN (ferries ride at 0).
      expect(s.nhn, `${s.lineId} without nhn`).toBeDefined()
      expect(s.nhn!).toBeGreaterThan(-10)
      expect(s.nhn!).toBeLessThan(60)
    }
  })

  it('ferries ride at sea level', () => {
    const snapshots = sim.snapshotsAt(12 * 3600).filter((s) => s.mode === 'ferry')
    for (const s of snapshots) expect(s.nhn).toBe(0)
  })
})
