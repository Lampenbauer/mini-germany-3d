import { describe, expect, it } from 'vitest'
import { loadRostockNetwork } from './cities'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'

describe('Simulation with the Rostock network', () => {
  const network = loadRostockNetwork()
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

describe('the bearing over the bogies', () => {
  const sim = new Simulation(loadRostockNetwork(), new SimClock())

  it('turns a tram through a corner gradually rather than at one vertex', () => {
    // Every vehicle out at 08:30, followed second by second for a
    // minute: no tram turns more than 30° in a second (a 32 m body on
    // a 25 m radius turns about 20°/s), and the rest of the fleet keeps
    // under 40°/s at the 99th percentile – a 12 m bus on a 10 m chord
    // does swing 80°/s round a street corner, which is what a bus does.
    // The bearing was the path segment's under the centre, and a corner
    // of the 0.3 m simplified path turned the body by the whole angle
    // in one step
    const turns: number[] = []
    let largestTram = 0
    for (let t = 8.5 * 3600; t < 8.5 * 3600 + 60; t++) {
      const before = new Map(sim.snapshotsAt(t).map((s) => [s.id, s]))
      for (const after of sim.snapshotsAt(t + 1)) {
        const prev = before.get(after.id)
        if (!prev || after.status !== 'moving' || prev.status !== 'moving') continue
        const turn = Math.abs(((after.bearing - prev.bearing + 540) % 360) - 180)
        turns.push(turn)
        if (after.mode === 'tram') largestTram = Math.max(largestTram, turn)
      }
    }
    turns.sort((a, b) => b - a)
    expect(turns.length).toBeGreaterThan(1000)
    expect(largestTram).toBeLessThan(30)
    expect(turns[Math.floor(turns.length * 0.01)]).toBeLessThan(40)
  })
})

describe('where a vehicle was some seconds ago (positionAt)', () => {
  it('answers with the timetable at the earlier instant, and null for a trip not active then', () => {
    const clock = new SimClock()
    clock.setSecondsOfDay(8.5 * 3600)
    // Held still: the clock runs on Date.now(), and the two readings
    // compared below are milliseconds apart – enough for a vehicle to
    // move past the tolerance on a slow runner
    clock.setPaused(true)
    const sim = new Simulation(loadRostockNetwork(), clock)
    const moving = sim.snapshots().find((s) => s.status === 'moving')!
    const now = sim.positionAt(moving.id, 0)!
    expect(now.lon).toBeCloseTo(moving.lon, 6)
    expect(now.lat).toBeCloseTo(moving.lat, 6)
    // Half a minute earlier she was somewhere else on her route – the
    // same place the clock set back would put her
    const earlier = sim.positionAt(moving.id, 30)!
    expect(Math.hypot(earlier.lon - now.lon, earlier.lat - now.lat)).toBeGreaterThan(0)
    clock.setSecondsOfDay(clock.secondsOfDay() - 30)
    const then = sim.snapshots().find((s) => s.id === moving.id)!
    expect(earlier.lon).toBeCloseTo(then.lon, 6)
    expect(earlier.lat).toBeCloseTo(then.lat, 6)
    expect(sim.positionAt('no-such-trip', 0)).toBeNull()
  })
})

describe('trip progress (all stops + vehicle position)', () => {
  const network = loadRostockNetwork()
  const sim = new Simulation(network, new SimClock())
  const t = 8.5 * 3600

  it('lists every stop of the trip with increasing arrival times', () => {
    const snap = sim.snapshotsAt(t).find((s) => s.status === 'moving')!
    const progress = sim.tripProgress(snap.id, t)!
    expect(progress).not.toBeNull()
    const { stops, position } = progress
    expect(stops.length).toBeGreaterThanOrEqual(2)
    expect(position).toBeGreaterThanOrEqual(0)
    expect(position).toBeLessThanOrEqual(stops.length - 1)
    for (const stop of stops) {
      // Stop coordinates (fly-to target) lie inside the city area
      expect(stop.lon).toBeGreaterThan(11.95)
      expect(stop.lon).toBeLessThan(12.3)
      expect(stop.lat).toBeGreaterThan(53.99)
      expect(stop.lat).toBeLessThan(54.22)
    }
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i].arrivalSec).toBeGreaterThanOrEqual(stops[i - 1].arrivalSec)
    }
  })

  it('marks the served stops and points at the snapshot next stop', () => {
    const snap = sim.snapshotsAt(t).find((s) => s.status === 'moving')!
    const { stops, position } = sim.tripProgress(snap.id, t)!
    // Moving between floor(position) and floor(position)+1
    const lastReached = Math.floor(position)
    expect(position).toBeGreaterThan(lastReached)
    expect(stops[lastReached + 1].name).toBe(snap.nextStopName)
    stops.forEach((stop, i) => {
      expect(stop.passed).toBe(i <= lastReached)
    })
  })

  it('reports an integer position while dwelling at a stop', () => {
    const snap = sim.snapshotsAt(t).find((s) => s.status === 'dwell')
    if (!snap) return // no vehicle dwelling at this exact second
    const { stops, position } = sim.tripProgress(snap.id, t)!
    expect(Number.isInteger(position)).toBe(true)
    // The dwelling stop itself is not yet passed
    expect(stops[position].passed).toBe(false)
    expect(stops[position + 1].name).toBe(snap.nextStopName)
  })

  it('shifts the predicted arrivals and the position by the GTFS-RT delay', () => {
    const delaySec = 120
    // Pick a trip that stays inside its timetable window under the delay
    // (a trip that departed less than 120 s ago would vanish time-shifted)
    let base: ReturnType<typeof sim.tripProgress> = null
    let delayed: ReturnType<typeof sim.tripProgress> = null
    for (const snap of sim.snapshotsAt(t)) {
      base = sim.tripProgress(snap.id, t)
      sim.setRealtimeDelays(new Map([[snap.id, delaySec]]))
      delayed = sim.tripProgress(snap.id, t)
      sim.setRealtimeDelays(new Map())
      if (base && delayed) break
    }
    expect(base).not.toBeNull()
    expect(delayed).not.toBeNull()
    // Same stop list, every arrival two minutes later, vehicle further back
    expect(delayed!.stops.map((s) => s.name)).toEqual(base!.stops.map((s) => s.name))
    base!.stops.forEach((stop, i) => {
      expect(delayed!.stops[i].arrivalSec).toBe(stop.arrivalSec + delaySec)
    })
    expect(delayed!.position).toBeLessThanOrEqual(base!.position)
  })

  it('returns null for unknown or inactive trips', () => {
    expect(sim.tripProgress('no-such-trip', t)).toBeNull()
    const snap = sim.snapshotsAt(12 * 3600)[0]
    expect(sim.tripProgress(snap.id, 3 * 3600)).toBeNull()
  })
})

describe('terminal layover', () => {
  const network = loadRostockNetwork()
  const sim = new Simulation(network, new SimClock())

  it('keeps the vehicle standing at its terminus for the turnaround time', () => {
    const t = 8.5 * 3600
    const snap = sim.snapshotsAt(t).find((s) => s.status === 'moving')!
    const { stops } = sim.tripProgress(snap.id, t)!
    const terminus = stops[stops.length - 1]

    // One minute after the final arrival the vehicle still stands there
    const lingering = sim.snapshotsAt(terminus.arrivalSec + 60).find((s) => s.id === snap.id)
    expect(lingering).toBeDefined()
    expect(lingering!.status).toBe('dwell')
    expect(lingering!.nextStopName).toBe(terminus.name)
    expect(lingering!.lon).toBeCloseTo(terminus.lon, 2)
    expect(lingering!.lat).toBeCloseTo(terminus.lat, 2)

    // The card marker sits on the destination row during the layover
    const progress = sim.tripProgress(snap.id, terminus.arrivalSec + 60)!
    expect(progress.position).toBe(progress.stops.length - 1)

    // After the turnaround time (config: 180 s) the vehicle is gone
    expect(
      sim.snapshotsAt(terminus.arrivalSec + 200).find((s) => s.id === snap.id),
    ).toBeUndefined()
    expect(sim.tripProgress(snap.id, terminus.arrivalSec + 200)).toBeNull()
  })

  it('can be disabled via the simulation options', () => {
    const bare = new Simulation(network, new SimClock(), undefined, {
      terminalLingerSeconds: 0,
    })
    const t = 8.5 * 3600
    const snap = bare.snapshotsAt(t).find((s) => s.status === 'moving')!
    const { stops } = bare.tripProgress(snap.id, t)!
    const lastArrival = stops[stops.length - 1].arrivalSec
    expect(bare.snapshotsAt(lastArrival + 30).find((s) => s.id === snap.id)).toBeUndefined()
  })
})

describe('terrain heights in snapshots', () => {
  const network = loadRostockNetwork()
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
