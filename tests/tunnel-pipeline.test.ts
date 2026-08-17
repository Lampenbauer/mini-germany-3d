import { describe, expect, it } from 'vitest'
import { isUndergroundWay, tunnelRangesFromSegments } from '../scripts/lib/tunnels.mjs'

/**
 * Tests for the OSM pipeline helpers (scripts/lib/tunnels.mjs): CI has no
 * Overpass access, so the extraction logic that the nightly data refresh
 * runs is validated here on synthetic ways/segments.
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
