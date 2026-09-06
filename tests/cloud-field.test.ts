import { describe, expect, it } from 'vitest'
import {
  buildCoverageField,
  buildDetailField,
  cloudDrift,
  CLOUD_LEVEL_WIND_FACTOR,
  COVERAGE_SOFTNESS,
  coverageThreshold,
  CoverageQuantiles,
  fbm3,
  perlin3,
} from '@/lib/cloud-field'

describe('periodic perlin noise', () => {
  it('repeats exactly at its period in every axis', () => {
    for (const [x, y, z] of [
      [0.3, 1.7, 2.2],
      [3.9, 0.1, 5.5],
      [7.25, 6.5, 0.75],
    ]) {
      const here = perlin3(x, y, z, 8, 4, 2)
      expect(perlin3(x + 8, y, z, 8, 4, 2)).toBeCloseTo(here, 12)
      expect(perlin3(x, y + 4, z, 8, 4, 2)).toBeCloseTo(here, 12)
      expect(perlin3(x, y, z + 2, 8, 4, 2)).toBeCloseTo(here, 12)
      expect(perlin3(x - 16, y + 8, z - 6, 8, 4, 2)).toBeCloseTo(here, 12)
    }
  })

  it('is continuous across the wrap – a texture tiled from it has no seam', () => {
    // Either side of the period boundary, a hair apart: the values must
    // be as close as any two neighbouring samples are
    const a = perlin3(7.999, 2.5, 0.5, 8, 8, 1)
    const b = perlin3(8.001, 2.5, 0.5, 8, 8, 1)
    expect(Math.abs(a - b)).toBeLessThan(0.02)
  })

  it('stays inside -1 … 1 and is not flat', () => {
    let min = 1
    let max = -1
    for (let i = 0; i < 2000; i++) {
      const v = perlin3(i * 0.173, i * 0.091, i * 0.037, 16, 16, 16)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(min).toBeGreaterThanOrEqual(-1)
    expect(max).toBeLessThanOrEqual(1)
    expect(max - min).toBeGreaterThan(0.5)
  })

  it('sums octaves that keep the period', () => {
    const here = fbm3(1.3, 2.1, 0.4, 4, 4, 2, 4)
    expect(fbm3(5.3, 2.1, 0.4, 4, 4, 2, 4)).toBeCloseTo(here, 12)
    expect(fbm3(1.3, 6.1, 2.4, 4, 4, 2, 4)).toBeCloseTo(here, 12)
  })
})

describe('the cloud fields', () => {
  const coverage = buildCoverageField(64, 4)
  const quantiles = new CoverageQuantiles(coverage)

  it('fills the byte range and tiles without a seam', () => {
    const { data, width } = coverage
    expect(Math.min(...data)).toBe(0)
    expect(Math.max(...data)).toBe(255)
    // The last column continues into the first: neighbours across the
    // wrap differ no more than neighbours inside the tile do
    let inside = 0
    let across = 0
    for (let y = 0; y < width; y++) {
      inside = Math.max(inside, Math.abs(data[y * width + 1] - data[y * width]))
      across = Math.max(across, Math.abs(data[y * width + width - 1] - data[y * width]))
    }
    expect(across).toBeLessThanOrEqual(inside + 12)
  })

  it('cuts the sky at the share of the field the cover asks for', () => {
    // 40 % cover: two fifths of the texels lie above the threshold
    const covered = (percent: number) => {
      const threshold = coverageThreshold(percent, quantiles)
      let above = 0
      for (const v of coverage.data) if (v / 255 > threshold) above++
      return above / coverage.data.length
    }
    expect(covered(40)).toBeGreaterThan(0.36)
    expect(covered(40)).toBeLessThan(0.44)
    expect(covered(80)).toBeGreaterThan(0.76)
    expect(covered(80)).toBeLessThan(0.84)
  })

  it('leaves a clear sky without a wisp and a closed sky without a gap', () => {
    // Above the field plus the soft edge – smoothstep never starts
    expect(coverageThreshold(0, quantiles)).toBeGreaterThan(1)
    expect(coverageThreshold(0, quantiles)).toBeGreaterThanOrEqual(1 + COVERAGE_SOFTNESS)
    // Below the field minus the soft edge – smoothstep is 1 everywhere
    expect(coverageThreshold(100, quantiles)).toBeLessThanOrEqual(-COVERAGE_SOFTNESS)
    expect(coverageThreshold(-5, quantiles)).toBe(coverageThreshold(0, quantiles))
    expect(coverageThreshold(140, quantiles)).toBe(coverageThreshold(100, quantiles))
  })

  it('lowers the threshold as the cover rises', () => {
    let previous = coverageThreshold(5, quantiles)
    for (let percent = 10; percent < 100; percent += 10) {
      const next = coverageThreshold(percent, quantiles)
      expect(next).toBeLessThanOrEqual(previous)
      previous = next
    }
  })

  it('builds a detail box of the asked size with grain in it', () => {
    const detail = buildDetailField(16, 16, 8, 2, 1)
    expect(detail.data.length).toBe(16 * 16 * 8)
    expect(detail.width).toBe(16)
    expect(detail.depth).toBe(8)
    const values = new Set(detail.data)
    expect(values.size).toBeGreaterThan(20)
  })
})

describe('cloud drift', () => {
  it('blows towards where the wind goes, faster than the surface wind', () => {
    // A westerly (from 270°) carries the clouds east
    const westerly = cloudDrift(5, 270)
    expect(westerly.eastMps).toBeCloseTo(5 * CLOUD_LEVEL_WIND_FACTOR, 9)
    expect(westerly.northMps).toBeCloseTo(0, 9)
    // A northerly (from 0°) carries them south
    const northerly = cloudDrift(2, 0)
    expect(northerly.northMps).toBeCloseTo(-2 * CLOUD_LEVEL_WIND_FACTOR, 9)
    expect(northerly.eastMps).toBeCloseTo(0, 9)
  })

  it('is a calm at no wind, whatever the direction says', () => {
    expect(cloudDrift(0, 123)).toEqual({ eastMps: 0, northMps: 0 })
    expect(cloudDrift(-3, 90)).toEqual({ eastMps: 0, northMps: 0 })
  })
})
