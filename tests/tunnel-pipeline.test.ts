import { describe, expect, it } from 'vitest'
import { stitchWays } from '../scripts/fetch-osm-network.mjs'
import { isUndergroundWay, tunnelRangesFromSegments } from '../scripts/lib/tunnels.mjs'

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
