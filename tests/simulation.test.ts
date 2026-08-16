import { describe, expect, it } from 'vitest'
import { loadBundledNetwork } from '@/data/network'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'

describe('Simulation mit dem Rostocker Netz', () => {
  const network = loadBundledNetwork()
  const sim = new Simulation(network, new SimClock())

  it('hat zur Hauptverkehrszeit auf fast allen Linien aktive Fahrzeuge', () => {
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    expect(snapshots.length).toBeGreaterThanOrEqual(network.lines.length * 2)
    const activeLines = new Set(snapshots.map((s) => s.lineId))
    // Nur bekannte Linien-IDs …
    for (const id of activeLines) {
      expect(network.lineById.has(id), `unbekannte Linie ${id}`).toBe(true)
    }
    // … alle Trams fahren zur HVZ …
    for (const line of network.lines.filter((l) => l.mode === 'tram')) {
      expect(activeLines.has(line.id), `Tram-Linie ${line.id} inaktiv`).toBe(true)
    }
    // … und Busse/Fähren dürfen einzelne echte Taktlücken haben (GTFS),
    // aber der Großteil des Netzes muss unterwegs sein.
    expect(activeLines.size).toBeGreaterThanOrEqual(
      Math.floor(network.lines.length * 0.75),
    )
  })

  it('hat nachts um 3 Uhr keine aktiven Bahnen', () => {
    expect(sim.snapshotsAt(3 * 3600)).toHaveLength(0)
  })

  it('alle Bahnen fahren innerhalb des Stadtgebiets', () => {
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

  it('Snapshots sind deterministisch (gleiche Zeit → gleiche Positionen)', () => {
    const a = sim.snapshotsAt(9 * 3600 + 123)
    const b = sim.snapshotsAt(9 * 3600 + 123)
    expect(a).toEqual(b)
  })

  it('Snapshot-IDs sind eindeutig', () => {
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    const ids = snapshots.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('liefert Zielhaltestelle und nächsten Halt', () => {
    const snapshots = sim.snapshotsAt(8.5 * 3600)
    for (const s of snapshots) {
      expect(s.destination.length).toBeGreaterThan(0)
      expect(s.nextStopName.length).toBeGreaterThan(0)
      expect(s.color).toMatch(/^#/)
    }
  })

  it('der Simulationszustand ändert sich mit der Zeit', () => {
    const t = 8.5 * 3600
    const before = sim.snapshotsAt(t)
    const after = sim.snapshotsAt(t + 60)
    expect(before.length).toBeGreaterThan(0)
    expect(after.length).toBeGreaterThan(0)
    expect(before).not.toEqual(after)
  })

  it.runIf(network.meta.source === 'approximated')(
    'Bahnen bewegen sich mit der Zeit vorwärts',
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
