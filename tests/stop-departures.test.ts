import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { loadRostockNetwork } from './cities'
import { testNetworkJson } from './fixtures'

/**
 * Upcoming departures at a stop (the stop card's data source). The test
 * network is a straight line Alpha → Beta → Gamma, ~1 km per hop, run on
 * the default headway service in both directions.
 */

function makeSim() {
  return new Simulation(prepareNetwork(testNetworkJson), new SimClock())
}

describe('upcomingDepartures', () => {
  it('lists departures soonest first, within the window only', () => {
    const sim = makeSim()
    const deps = sim.upcomingDepartures('b', 8 * 3600, { windowSeconds: 1800 })
    expect(deps.length).toBeGreaterThan(0)
    for (const dep of deps) {
      expect(dep.secondsUntil).toBeGreaterThanOrEqual(0)
      expect(dep.secondsUntil).toBeLessThanOrEqual(1800)
      expect(dep.lineId).toBe('T')
    }
    const order = deps.map((d) => d.secondsUntil)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('serves the middle stop in both directions, the terminus in one', () => {
    const sim = makeSim()
    const atBeta = sim.upcomingDepartures('b', 8 * 3600)
    expect(new Set(atBeta.map((d) => d.direction))).toEqual(new Set([0, 1]))
    // Gamma is direction 0's terminus: nothing departs toward nowhere,
    // but direction 1 starts here.
    const atGamma = sim.upcomingDepartures('c', 8 * 3600)
    expect(atGamma.length).toBeGreaterThan(0)
    expect(new Set(atGamma.map((d) => d.direction))).toEqual(new Set([1]))
    for (const dep of atGamma) expect(dep.destination).toBe('Alpha')
  })

  it('shifts a delayed trip and flags it as realtime', () => {
    const sim = makeSim()
    const before = sim.upcomingDepartures('b', 8 * 3600)
    const target = before[0]
    sim.setRealtimeDelays(new Map([[target.tripId, 300]]))
    const after = sim.upcomingDepartures('b', 8 * 3600)
    const shifted = after.find((d) => d.tripId === target.tripId)
    expect(shifted).toBeDefined()
    expect(shifted!.departureSec).toBe(target.departureSec + 300)
    expect(shifted!.delaySeconds).toBe(300)
    expect(shifted!.realtime).toBe(true)
    // The rest of the board stays on schedule
    for (const d of after) if (d.tripId !== target.tripId) expect(d.realtime).toBe(false)
  })

  it('wraps the window across midnight', () => {
    // Night service encoded past 24:00, the way after-midnight GTFS trips
    // are: departures 23:00–24:40. Queried at 23:55 the board must carry
    // the 00:xx departures – the day number changing is not a service gap.
    const sim = new Simulation(prepareNetwork(testNetworkJson), new SimClock(), undefined, {
      service: [{ startMin: 23 * 60, endMin: 25 * 60, headwayMin: 20 }],
    })
    const deps = sim.upcomingDepartures('b', 23 * 3600 + 55 * 60, { windowSeconds: 3600 })
    expect(deps.length).toBeGreaterThan(0)
    expect(deps.some((d) => d.departureSec >= 24 * 3600)).toBe(true)
    for (const dep of deps) expect(dep.secondsUntil).toBeLessThanOrEqual(3600)
    const order = deps.map((d) => d.secondsUntil)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('marks a trip whose vehicle is on the map as active', () => {
    const sim = makeSim()
    const deps = sim.upcomingDepartures('b', 8 * 3600, { windowSeconds: 3600, limit: 20 })
    const activeIds = new Set(sim.snapshotsAt(8 * 3600).map((s) => s.id))
    expect(activeIds.size).toBeGreaterThan(0)
    // Exactly the departures whose trip has a snapshot are active
    for (const dep of deps) expect(dep.active).toBe(activeIds.has(dep.tripId))
    expect(deps.some((d) => d.active)).toBe(true)
    expect(deps.some((d) => !d.active)).toBe(true)
  })

  it('respects the limit', () => {
    const sim = makeSim()
    expect(sim.upcomingDepartures('b', 8 * 3600, { limit: 3 })).toHaveLength(3)
  })

  it('returns nothing for an unknown stop', () => {
    expect(makeSim().upcomingDepartures('nope', 8 * 3600)).toEqual([])
  })
})

describe('upcomingDepartures on the real network', () => {
  it('fills a rush-hour board at a real interchange', () => {
    // Imported at the top, not here: the city's network.json is parsed
    // on import, and inside the test that parse counted against its five
    // seconds – which a loaded two-core CI runner once exceeded.
    const network = loadRostockNetwork()
    const sim = new Simulation(network, new SimClock())
    // Any stop served by at least two tram lines
    const counts = new Map<string, Set<string>>()
    for (const line of network.lines) {
      if (line.mode !== 'tram') continue
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          let set = counts.get(stop.id)
          if (!set) counts.set(stop.id, (set = new Set()))
          set.add(line.id)
        }
      }
    }
    const hub = [...counts.entries()].find(([, lines]) => lines.size >= 2)
    expect(hub).toBeDefined()
    const deps = sim.upcomingDepartures(hub![0], 8 * 3600)
    expect(deps.length).toBeGreaterThanOrEqual(4)
    expect(new Set(deps.map((d) => d.lineId)).size).toBeGreaterThanOrEqual(2)
  })
})
