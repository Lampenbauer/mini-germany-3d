import { describe, expect, it, vi } from 'vitest'
import {
  boundToFixedLine,
  clipPathAt,
  clipToBounds,
  crossOverReversals,
  nearestOnPath,
  stitchWays,
} from '../scripts/fetch-osm-network.mjs'
import { isBridgeWay, isUndergroundWay, tunnelRangesFromSegments } from '../scripts/lib/tunnels.mjs'

/**
 * Tests for the OSM pipeline helpers (scripts/lib/tunnels.mjs and
 * stitchWays): CI has no Overpass access, so the extraction logic that the
 * nightly data refresh runs is validated here on synthetic ways/segments.
 */
describe('isUndergroundWay', () => {
  it('detects tunnel tags (every value except "no")', () => {
    expect(isUndergroundWay({ tags: { tunnel: 'yes' } })).toBe(true)
    expect(isUndergroundWay({ tags: { tunnel: 'building_passage' } })).toBe(true)
    expect(isUndergroundWay({ tags: { tunnel: 'covered' } })).toBe(true)
    expect(isUndergroundWay({ tags: { tunnel: 'no' } })).toBe(false)
  })

  it('detects location=underground', () => {
    expect(isUndergroundWay({ tags: { location: 'underground' } })).toBe(true)
    expect(isUndergroundWay({ tags: { location: 'overground' } })).toBe(false)
  })

  it('detects negative layers', () => {
    expect(isUndergroundWay({ tags: { layer: '-1' } })).toBe(true)
    expect(isUndergroundWay({ tags: { layer: '-2' } })).toBe(true)
    expect(isUndergroundWay({ tags: { layer: '0' } })).toBe(false)
    expect(isUndergroundWay({ tags: { layer: '1' } })).toBe(false)
  })

  it('treats ways without matching tags as above ground', () => {
    expect(isUndergroundWay({ tags: { railway: 'tram' } })).toBe(false)
    expect(isUndergroundWay({})).toBe(false)
    expect(isUndergroundWay(undefined)).toBe(false)
  })
})

describe('isBridgeWay', () => {
  it('detects bridge tags (every value except "no")', () => {
    expect(isBridgeWay({ tags: { bridge: 'yes' } })).toBe(true)
    expect(isBridgeWay({ tags: { bridge: 'viaduct' } })).toBe(true)
    expect(isBridgeWay({ tags: { bridge: 'no' } })).toBe(false)
  })

  it('ignores a positive layer without a bridge tag', () => {
    expect(isBridgeWay({ tags: { layer: '1' } })).toBe(false)
    expect(isBridgeWay({})).toBe(false)
    expect(isBridgeWay(undefined)).toBe(false)
  })
})

describe('tunnelRangesFromSegments', () => {
  it('converts flag runs into meter ranges', () => {
    expect(
      tunnelRangesFromSegments([false, true, true, false], [0, 100, 200, 300, 400]),
    ).toEqual([[100, 300]])
  })

  it('handles tunnels reaching the end of the path', () => {
    expect(tunnelRangesFromSegments([false, true], [0, 100, 200])).toEqual([[100, 200]])
  })

  it('merges short above-ground gaps between tunnel sections', () => {
    expect(
      tunnelRangesFromSegments([true, false, true], [0, 100, 115, 300]),
    ).toEqual([[0, 300]])
  })

  it('keeps sections separate when the gap is long enough', () => {
    expect(
      tunnelRangesFromSegments([true, false, true], [0, 100, 180, 300]),
    ).toEqual([
      [0, 100],
      [180, 300],
    ])
  })

  it('drops mini tunnels below the minimum length', () => {
    expect(tunnelRangesFromSegments([false, true, false], [0, 50, 60, 200])).toEqual([])
  })

  it('rounds range bounds to 0.1 m', () => {
    expect(
      tunnelRangesFromSegments([true, false], [0, 123.456789, 400]),
    ).toEqual([[0, 123.5]])
  })

  it('returns [] without tunnel segments', () => {
    expect(tunnelRangesFromSegments([false, false], [0, 100, 200])).toEqual([])
    expect(tunnelRangesFromSegments([], [0])).toEqual([])
  })
})

describe('stitchWays underground flags', () => {
  // ~111 m between consecutive points (0.001° latitude)
  const p1: [number, number] = [12.1, 54.0]
  const p2: [number, number] = [12.1, 54.001]
  const p3: [number, number] = [12.1, 54.002]

  it('classifies shared and reversed ways segment by segment', () => {
    const nodes = new Map([
      [1, { lon: p1[0], lat: p1[1] }],
      [2, { lon: p2[0], lat: p2[1] }],
      [3, { lon: p3[0], lat: p3[1] }],
    ])
    const ways = new Map([
      [10, { nodes: [1, 2], tags: {} }],
      // Deliberately stored opposite to the relation's travel direction.
      [11, { nodes: [3, 2], tags: { tunnel: 'yes' } }],
    ])

    const { path, segUnderground } = stitchWays([{ ref: 10 }, { ref: 11 }], ways, nodes, 'test')
    expect(path).toEqual([p1, p2, p3])
    expect(segUnderground).toEqual([false, true])
  })

  it('classifies bridge ways segment by segment', () => {
    const nodes = new Map([
      [1, { lon: p1[0], lat: p1[1] }],
      [2, { lon: p2[0], lat: p2[1] }],
      [3, { lon: p3[0], lat: p3[1] }],
    ])
    const ways = new Map([
      [10, { nodes: [1, 2], tags: { bridge: 'yes' } }],
      [11, { nodes: [2, 3], tags: {} }],
    ])

    const { segBridge, segUnderground } = stitchWays([{ ref: 10 }, { ref: 11 }], ways, nodes, 'test')
    expect(segBridge).toEqual([true, false])
    expect(segUnderground).toEqual([false, false])
  })

  it('merges a sub-meter connector into the following way (inherits its flag)', () => {
    const nodes = new Map([
      [1, { lon: p1[0], lat: p1[1] }],
      [2, { lon: p2[0], lat: p2[1] }],
      // ~0.3 m east of node 2: close, but not the same portal node.
      [3, { lon: 12.100005, lat: 54.001 }],
      [4, { lon: 12.100005, lat: 54.002 }],
    ])
    const ways = new Map([
      [10, { nodes: [1, 2], tags: {} }],
      [11, { nodes: [3, 4], tags: { location: 'underground' } }],
    ])

    // Gaps < 1 m drop the duplicate-ish point, so the bridging segment onto
    // the tunnel way carries the tunnel flag (smoothed anyway by
    // tunnelRangesFromSegments' merge/min-length heuristics).
    const { path, segUnderground } = stitchWays([{ ref: 10 }, { ref: 11 }], ways, nodes, 'test')
    expect(path).toHaveLength(3)
    expect(segUnderground).toEqual([false, true])
  })

  it('keeps larger connectors as their own segment with the joined way\'s flag', () => {
    const nodes = new Map([
      [1, { lon: p1[0], lat: p1[1] }],
      [2, { lon: p2[0], lat: p2[1] }],
      // ~5.6 m north of node 2: a real gap, bridged by a connector segment.
      [3, { lon: 12.1, lat: 54.00105 }],
      [4, { lon: 12.1, lat: 54.002 }],
    ])
    const ways = new Map([
      [10, { nodes: [1, 2], tags: {} }],
      [11, { nodes: [3, 4], tags: { tunnel: 'yes' } }],
    ])

    const { path, segUnderground } = stitchWays([{ ref: 10 }, { ref: 11 }], ways, nodes, 'test')
    expect(path).toEqual([p1, p2, [12.1, 54.00105], [12.1, 54.002]])
    expect(segUnderground).toEqual([false, true, true])
  })
})

describe('clipPathAt (S-Bahn truncation at Rostock Hbf)', () => {
  // Straight north–south path: ~111 m per 0.001° latitude.
  const path = [
    [12.1, 54.0],
    [12.1, 54.001],
    [12.1, 54.002],
    [12.1, 54.003],
  ]
  const cum = [0, 111.2, 222.4, 333.6]

  it('keeps the "before" side with an interpolated cut point', () => {
    const { path: clipped } = clipPathAt(path, cum, 166.8, 'before')
    expect(clipped).toHaveLength(3)
    expect(clipped[2][1]).toBeCloseTo(54.0015, 5)
  })

  it('keeps the "after" side and shifts the ranges to the new origin', () => {
    const { path: clipped, ranges } = clipPathAt(path, cum, 111.2, 'after', [
      [50, 100], // entirely before the cut → dropped
      [100, 200], // straddles the cut → clipped and shifted
    ])
    expect(clipped[0][1]).toBeCloseTo(54.001, 6)
    expect(ranges).toHaveLength(1)
    expect(ranges[0][0]).toBeCloseTo(0, 1)
    expect(ranges[0][1]).toBeCloseTo(88.8, 1)
  })

  it('clips ranges on the "before" side without shifting', () => {
    const { ranges } = clipPathAt(path, cum, 200, 'before', [
      [100, 300],
      [250, 300], // entirely after the cut → dropped
    ])
    expect(ranges).toEqual([[100, 200]])
  })
})

describe('nearestOnPath', () => {
  // A path that goes out east and comes back the same way: every point is
  // passed twice.
  const path = [
    [12.0, 54.0],
    [12.01, 54.0],
    [12.02, 54.0],
    [12.01, 54.0],
    [12.0, 54.0],
  ]
  const cum = [0, 654, 1308, 1962, 2616]

  it('measures the offset beside the path in meters', () => {
    const { offsetMeters } = nearestOnPath(path, cum, [12.005, 54.001])
    expect(offsetMeters).toBeCloseTo(111, 0)
  })

  it('takes the first pass only when asked to', () => {
    const pier = [12.02, 54.0]
    expect(nearestOnPath(path, cum, pier, { firstPass: true }).along).toBeCloseTo(1308, 0)
    // The plain nearest point is the first exact hit too – but a point a
    // hair off the turnaround must not jump to the first pass:
    const beside = [12.0105, 54.0]
    const plain = nearestOnPath(path, cum, beside)
    expect(plain.offsetMeters).toBeCloseTo(0, 0)
  })
})

describe('boundToFixedLine (Kiel F1 relation runs on past Laboe)', () => {
  const node = (id: number, lon: number, lat: number) => ({ id, lon, lat, tags: {} })
  // Bahnhof → Laboe → Falckenstein → back to Laboe
  const path = [
    [10.135, 54.315],
    [10.17, 54.35],
    [10.216, 54.403],
    [10.186, 54.404],
    [10.216, 54.403],
  ]
  const cum = [0, 4500, 7500, 9500, 11500]
  const stopNodes = [
    { node: node(1, 10.135, 54.315), name: 'Bahnhof' },
    { node: node(2, 10.17, 54.35), name: 'Mönkeberg' },
    { node: node(3, 10.216, 54.403), name: 'Laboe' },
    { node: node(4, 10.186, 54.404), name: 'Falckenstein' },
  ]

  it('cuts the path at the first pass of the "to" pier and drops the stops after it', () => {
    const cut = boundToFixedLine(path, cum, stopNodes, { from: 'Bahnhof', to: 'Laboe' }, [], [[8000, 9000]])!
    expect(cut).not.toBeNull()
    expect(cut.path).toHaveLength(3)
    expect(cut.path[2]).toEqual([10.216, 54.403])
    expect(cut.stopNodes.map((s) => s.name)).toEqual(['Bahnhof', 'Mönkeberg', 'Laboe'])
    // The bridge range beyond the cut is gone
    expect(cut.bridges).toEqual([])
  })

  it('reads a relation that runs the other way round', () => {
    const cut = boundToFixedLine(path, cum, stopNodes, { from: 'Laboe', to: 'Bahnhof' }, [], [])!
    expect(cut.stopNodes.map((s) => s.name)).toEqual(['Bahnhof', 'Mönkeberg', 'Laboe'])
  })

  it('leaves a relation alone whose ends are the named piers', () => {
    expect(boundToFixedLine(path.slice(0, 3), cum.slice(0, 3), stopNodes.slice(0, 3), { from: 'Bahnhof', to: 'Laboe' }, [], [])).toBeNull()
    expect(boundToFixedLine(path, cum, stopNodes, { from: 'Nowhere', to: 'Elsewhere' }, [], [])).toBeNull()
  })
})

describe("clipToBounds (Cologne's 192 reaches across the limits for two stops)", () => {
  const node = (id: number, lon: number) => ({ id, lon, lat: 54.0, tags: {} })
  // East along a parallel, ~654 m per 0.01° of longitude at 54° N; the
  // city begins at 12.022.
  const path = [12.0, 12.01, 12.02, 12.03, 12.04, 12.05].map((lon) => [lon, 54.0])
  const cum = [0, 653.6, 1307.2, 1960.8, 2614.4, 3268]
  const isInside = (lon: number) => lon > 12.022
  const stops = (...lons: number[]) => lons.map((lon, i) => ({ node: node(i + 1, lon) }))

  it('skips a route the cut leaves under a kilometre', () => {
    const cut = clipToBounds(path, cum, stops(12.0, 12.01, 12.02, 12.025, 12.03), isInside, [], [])
    expect(cut).toEqual({ skip: 'stub', keptStops: 2, lengthMeters: expect.closeTo(327, 0) })
  })

  it('keeps a route the cut leaves longer, from its first stop inside', () => {
    const cut = clipToBounds(path, cum, stops(12.0, 12.01, 12.02, 12.025, 12.04, 12.05), isInside, [], [])
    expect(cut).toMatchObject({ droppedStops: 3 })
    expect(cut && 'path' in cut ? cut.path[0][0] : null).toBeCloseTo(12.025, 6)
  })

  it('skips a route with no stop inside, and leaves a short one wholly inside alone', () => {
    expect(clipToBounds(path, cum, stops(12.0, 12.01, 12.02), isInside, [], [])).toEqual({ skip: 'outside' })
    // A line of the city's own is not measured – only what a cut leaves.
    expect(clipToBounds(path.slice(3, 5), [0, 653.6], stops(12.03, 12.035), isInside, [], [])).toBeNull()
  })
})

describe("crossOverReversals (Rostock's 6 changes ends behind the Thierfelderstraße loop)", () => {
  // Tram 6 towards the Zoo as the nightly run of 15 Nov 2026 stitched it:
  // south-west from S Parkstraße past Platz der Jugend, into the turning
  // loop at [4], round it west, south and east, 176° at the switch [23],
  // and out along the single track to the Zoo
  const loop = [
    [12.107846, 54.083003], [12.105882, 54.081933], [12.105497, 54.081728], [12.104813, 54.081347],
    [12.104648, 54.081281], [12.104462, 54.081223], [12.104321, 54.081203], [12.104141, 54.081189],
    [12.103568, 54.081204], [12.103484, 54.081193], [12.103417, 54.081173], [12.103305, 54.081105],
    [12.103274, 54.08106], [12.103256, 54.08101], [12.103268, 54.080955], [12.10329, 54.080901],
    [12.103338, 54.080862], [12.103416, 54.080834], [12.103516, 54.080815], [12.103626, 54.080809],
    [12.103728, 54.080822], [12.103967, 54.080903], [12.104167, 54.080978], [12.104308, 54.081038],
    [12.102821, 54.080308], [12.102619, 54.080223], [12.102419, 54.080159], [12.10223, 54.080116],
    [12.101816, 54.080053],
  ]
  const reversal = 23
  // On the single track 56 m past the switch, 11 m from the loop's south side
  const thierfelderstrasse = [12.10365, 54.080713]
  const unflagged = (path: number[][]) => path.slice(1).map(() => false)
  const stitched = (path: number[][]) => ({
    path,
    segUnderground: unflagged(path),
    segBridge: unflagged(path),
  })
  const heading = (a: number[], b: number[]) =>
    (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI
  const turnAt = (path: number[][], i: number) =>
    Math.abs(((heading(path[i], path[i + 1]) - heading(path[i - 1], path[i]) + 540) % 360) - 180)
  const sharpestTurn = (path: number[][]) =>
    Math.max(...path.slice(1, -1).map((_, i) => turnAt(path, i + 1)))
  const offsetMeters = (path: number[][], p: number[]) => {
    const cum = [0]
    for (let i = 1; i < path.length; i++) {
      const dx = (path[i][0] - path[i - 1][0]) * Math.cos((path[i][1] * Math.PI) / 180)
      cum.push(cum[i - 1] + Math.hypot(dx, path[i][1] - path[i - 1][1]) * 111_320)
    }
    return nearestOnPath(path, cum, p).offsetMeters
  }

  it('leaves the loop out and crosses over from where the path last ran the way out', () => {
    // Bridge flags on the segment the crossover starts from and on the one
    // after the switch, to see them spliced with the path
    const segBridge = loop.slice(1).map((_, i) => i === 4 || i === reversal + 1)
    const out = crossOverReversals({ ...stitched(loop), segBridge }, [thierfelderstrasse], 'test')
    expect(sharpestTurn(loop)).toBeGreaterThan(170)
    expect(out.path).toEqual([...loop.slice(0, 5), ...loop.slice(reversal)])
    expect(sharpestTurn(out.path)).toBeLessThan(30)
    expect(out.segUnderground).toHaveLength(out.path.length - 1)
    expect(out.segBridge.flatMap((flag, i) => (flag ? [i] : []))).toEqual([4, 6])
    expect(offsetMeters(out.path, thierfelderstrasse)).toBeLessThan(2)
  })

  it("takes a first reversal along with a later one's crossover, and names neither", () => {
    // Berlin's trams at Köpenick, where the ways are not split at the
    // junction: on along the line (300°) past it, back north-east, south-east
    // past it again and back out north-west – two reversals in 200 m, the
    // first with no crossover of its own. Built in metres east and north
    const at = (x: number, y: number) => [
      13.58 + x / (111_320 * Math.cos((52.44 * Math.PI) / 180)),
      52.44 + y / 111_320,
    ]
    const twice = [
      at(0, 0), at(-86.6, 50), at(-173.2, 100), at(-216.5, 125), at(-259.8, 150),
      at(-221.2, 160.4), at(-210.9, 132.2), at(-243, 170.5), at(-275.1, 208.8),
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = crossOverReversals(stitched(twice), [], 'test')
    expect(out.path).toEqual([...twice.slice(0, 3), ...twice.slice(6)])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('keeps the loop where a stop would be left off the path', () => {
    // On the loop's far side, 42 m from the single track
    expect(crossOverReversals(stitched(loop), [loop[13]], 'test').path).toBe(loop)
  })

  it('leaves a spike into a station alone: nothing before it ran the way out', () => {
    // West past the platform to the end of the track and back east, the way
    // Bremen-Vegesack's RS1 changes ends
    const spike = [
      [8.64, 53.17], [8.635, 53.17], [8.63, 53.17],
      [8.635, 53.1701], [8.64, 53.1701], [8.645, 53.172],
    ]
    expect(crossOverReversals(stitched(spike), [], 'test').path).toBe(spike)
  })

  it('returns a path that never reverses as it is', () => {
    // The loop alone turns 180° too, but a few degrees at a time
    const run = loop.slice(0, reversal)
    expect(crossOverReversals(stitched(run), [], 'test').path).toBe(run)
  })
})
