import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { Simulation } from '@/engine/simulation'
import { SimClock } from '@/lib/clock'
import { cumulativeDistances } from '@/lib/geo'
import type { LonLat } from '@/lib/geo'
import {
  isInTunnel,
  mirrorTunnelRanges,
  normalizeTunnelRanges,
  splitPathByTunnels,
} from '@/lib/tunnels'
import { testNetworkJson, testTunnelNetworkJson } from './fixtures'

describe('normalizeTunnelRanges', () => {
  it('returns [] for missing/empty input', () => {
    expect(normalizeTunnelRanges(undefined, 1000)).toEqual([])
    expect(normalizeTunnelRanges([], 1000)).toEqual([])
  })

  it('clamps ranges to the path length', () => {
    expect(normalizeTunnelRanges([[-50, 100]], 1000)).toEqual([[0, 100]])
    expect(normalizeTunnelRanges([[500, 2000]], 1000)).toEqual([[500, 1000]])
  })

  it('drops degenerate, reversed, and non-finite ranges', () => {
    expect(normalizeTunnelRanges([[100, 100]], 1000)).toEqual([])
    expect(normalizeTunnelRanges([[700, 400]], 1000)).toEqual([])
    expect(normalizeTunnelRanges([[Number.NaN, 200]], 1000)).toEqual([])
    expect(normalizeTunnelRanges([[100]], 1000)).toEqual([])
  })

  it('sorts and merges overlapping/touching ranges', () => {
    expect(
      normalizeTunnelRanges(
        [
          [300, 400],
          [100, 200],
          [200, 250],
        ],
        1000,
      ),
    ).toEqual([
      [100, 250],
      [300, 400],
    ])
  })
})

describe('mirrorTunnelRanges', () => {
  it('mirrors ranges onto the reversed path and keeps them sorted', () => {
    expect(mirrorTunnelRanges([[400, 700]], 2000)).toEqual([[1300, 1600]])
    expect(
      mirrorTunnelRanges(
        [
          [100, 200],
          [300, 400],
        ],
        1000,
      ),
    ).toEqual([
      [600, 700],
      [800, 900],
    ])
  })
})

describe('isInTunnel', () => {
  const ranges: [number, number][] = [
    [400, 700],
    [1200, 1300],
  ]

  it('detects positions inside, at the portals, and outside', () => {
    expect(isInTunnel(ranges, 500)).toBe(true)
    expect(isInTunnel(ranges, 400)).toBe(true)
    expect(isInTunnel(ranges, 700)).toBe(true)
    expect(isInTunnel(ranges, 399.9)).toBe(false)
    expect(isInTunnel(ranges, 700.1)).toBe(false)
    expect(isInTunnel(ranges, 1000)).toBe(false)
    expect(isInTunnel(ranges, 1250)).toBe(true)
    expect(isInTunnel([], 500)).toBe(false)
  })
})

describe('splitPathByTunnels', () => {
  // Straight north–south line, two segments of ~1000.8 m each
  const path: LonLat[] = [
    [12.1, 54.0],
    [12.1, 54.009],
    [12.1, 54.018],
  ]
  const cum = cumulativeDistances(path)
  const total = cum[cum.length - 1]

  it('returns the whole path as one above-ground piece without tunnels', () => {
    expect(splitPathByTunnels(path, cum, [])).toEqual([{ path, tunnel: false }])
  })

  it('splits into above-ground/tunnel/above-ground pieces with shared boundaries', () => {
    const pieces = splitPathByTunnels(path, cum, [[400, 700]])
    expect(pieces.map((p) => p.tunnel)).toEqual([false, true, false])

    // Pieces connect seamlessly and cover the full route
    expect(pieces[0].path[0]).toEqual(path[0])
    expect(pieces[0].path[pieces[0].path.length - 1]).toEqual(pieces[1].path[0])
    expect(pieces[1].path[pieces[1].path.length - 1]).toEqual(pieces[2].path[0])
    expect(pieces[2].path[pieces[2].path.length - 1]).toEqual(path[2])

    // The middle path vertex survives in the last piece
    expect(pieces[2].path).toContainEqual(path[1])

    // Piece lengths match the requested ranges
    const len = (p: LonLat[]) => cumulativeDistances(p).at(-1)!
    expect(len(pieces[0].path)).toBeCloseTo(400, 0)
    expect(len(pieces[1].path)).toBeCloseTo(300, 0)
    expect(len(pieces[2].path)).toBeCloseTo(total - 700, 0)
  })

  it('handles tunnels at the start and covering the whole path', () => {
    const fromStart = splitPathByTunnels(path, cum, [[0, 500]])
    expect(fromStart.map((p) => p.tunnel)).toEqual([true, false])

    const whole = splitPathByTunnels(path, cum, [[0, total]])
    expect(whole).toHaveLength(1)
    expect(whole[0].tunnel).toBe(true)
    expect(cumulativeDistances(whole[0].path).at(-1)!).toBeCloseTo(total, 0)
  })

  it('keeps ranges aligned with path vertices seamless', () => {
    const pieces = splitPathByTunnels(path, cum, [[0, cum[1]]])
    expect(pieces.map((p) => p.tunnel)).toEqual([true, false])
    expect(pieces[0].path).toHaveLength(2)
    expect(pieces[1].path).toHaveLength(2)
  })
})

describe('prepareNetwork with tunnel data', () => {
  const network = prepareNetwork(testTunnelNetworkJson)
  const [dir0, dir1] = network.lineById.get('U')!.directions

  it('normalizes the declared tunnel ranges of direction 0', () => {
    expect(dir0.tunnels).toEqual([[400, 700]])
  })

  it('mirrors the tunnel ranges onto the auto-generated direction 1', () => {
    expect(dir1.tunnels).toHaveLength(1)
    expect(dir1.tunnels[0][0]).toBeCloseTo(dir1.totalLength - 700, 5)
    expect(dir1.tunnels[0][1]).toBeCloseTo(dir1.totalLength - 400, 5)
  })

  it('directions without tunnel data get an empty list', () => {
    const plain = prepareNetwork(testNetworkJson)
    for (const dir of plain.lineById.get('T')!.directions) {
      expect(dir.tunnels).toEqual([])
    }
  })
})

describe('Simulation inTunnel flag', () => {
  // Single departure at 08:00 per direction, 10 m/s, 30 s dwell:
  // direction 0 leaves stop a (dist 0) at 28800 and reaches stop b
  // (dist ~1000.8 m) at 28900 – so distance ≈ (t - 28800) · 10.008 m.
  const network = prepareNetwork(testTunnelNetworkJson)
  const sim = new Simulation(network, new SimClock(), undefined, {
    cruiseSpeedMps: 10,
    dwellSeconds: 30,
    service: [{ startMin: 480, endMin: 481, headwayMin: 10 }],
  })
  const snapAt = (offsetSec: number, id: string) => {
    const snap = sim.snapshotsAt(28800 + offsetSec).find((s) => s.id === id)
    expect(snap, `${id} at +${offsetSec}s`).toBeDefined()
    return snap!
  }

  it('is false before the portal, true inside, false after (direction 0)', () => {
    expect(snapAt(20, 'U-0-480').inTunnel).toBe(false) // ~200 m
    expect(snapAt(50, 'U-0-480').inTunnel).toBe(true) // ~500 m
    expect(snapAt(85, 'U-0-480').inTunnel).toBe(false) // ~850 m
  })

  it('applies the mirrored ranges to direction 1', () => {
    expect(snapAt(50, 'U-1-480').inTunnel).toBe(false) // ~500 m (tunnel is at ~1301–1601 m)
    expect(snapAt(175, 'U-1-480').inTunnel).toBe(true) // ~1451 m
    expect(snapAt(215, 'U-1-480').inTunnel).toBe(false) // ~1852 m
  })

  it('stays false on lines without tunnels', () => {
    const plainSim = new Simulation(prepareNetwork(testNetworkJson), new SimClock(), undefined, {
      cruiseSpeedMps: 10,
      dwellSeconds: 30,
      service: [{ startMin: 480, endMin: 481, headwayMin: 10 }],
    })
    for (const t of [20, 50, 85, 175]) {
      for (const snap of plainSim.snapshotsAt(28800 + t)) {
        expect(snap.inTunnel).toBe(false)
      }
    }
  })
})
