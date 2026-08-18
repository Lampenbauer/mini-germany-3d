import { describe, expect, it } from 'vitest'
import {
  CANOPY_CLEARANCE,
  UNDERPASS_ALLOWANCE,
  buildProfile,
  clampToProfile,
  profileHeightAt,
} from '@/map/height-profile'

/**
 * The street-height baseline that keeps routes and vehicles from riding
 * over tree canopies: interpolated stop heights, with canopy-contaminated
 * anchors dropped and live samples clamped.
 */

describe('buildProfile', () => {
  it('keeps only stops with measured heights', () => {
    const anchors = buildProfile([
      { dist: 0, height: 50 },
      { dist: 500, height: undefined },
      { dist: 1000, height: 52 },
    ])
    expect(anchors).toEqual([
      { dist: 0, height: 50 },
      { dist: 1000, height: 52 },
    ])
  })

  it('drops an interior anchor far above its neighbors (stop under a tree)', () => {
    const anchors = buildProfile([
      { dist: 0, height: 50 },
      { dist: 500, height: 62 }, // canopy over the platform
      { dist: 1000, height: 52 },
    ])
    expect(anchors.map((a) => a.dist)).toEqual([0, 1000])
  })

  it('keeps a real hill crest that tops its neighbors by a few meters', () => {
    const anchors = buildProfile([
      { dist: 0, height: 50 },
      { dist: 500, height: 55 },
      { dist: 1000, height: 50 },
    ])
    expect(anchors).toHaveLength(3)
  })

  it('keeps stops on a continuously sloping street', () => {
    const anchors = buildProfile([
      { dist: 0, height: 50 },
      { dist: 500, height: 60 },
      { dist: 1000, height: 70 },
    ])
    expect(anchors).toHaveLength(3)
  })
})

describe('profileHeightAt', () => {
  const anchors = [
    { dist: 0, height: 50 },
    { dist: 1000, height: 60 },
    { dist: 2000, height: 50 },
  ]

  it('interpolates linearly between anchors', () => {
    expect(profileHeightAt(anchors, 500)).toBeCloseTo(55)
    expect(profileHeightAt(anchors, 1500)).toBeCloseTo(55)
  })

  it('clamps outside the anchor range and handles empty profiles', () => {
    expect(profileHeightAt(anchors, -100)).toBe(50)
    expect(profileHeightAt(anchors, 9999)).toBe(50)
    expect(profileHeightAt([], 100)).toBeUndefined()
  })
})

describe('clampToProfile', () => {
  it('caps canopy spikes above the baseline', () => {
    expect(clampToProfile(62, 50)).toBe(50 + CANOPY_CLEARANCE)
  })

  it('lets moderate dips (underpasses) pass and floors deep holes', () => {
    expect(clampToProfile(44, 50)).toBe(44)
    expect(clampToProfile(20, 50)).toBe(50 - UNDERPASS_ALLOWANCE)
  })

  it('passes samples through unchanged without a baseline', () => {
    expect(clampToProfile(75, undefined)).toBe(75)
  })
})
