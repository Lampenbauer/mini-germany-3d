import { describe, expect, it } from 'vitest'
import {
  bearingDegrees,
  cumulativeDistances,
  haversineMeters,
  heightAtDistance,
  projectOntoPath,
  sampleAtDistance,
  type LonLat,
} from '@/lib/geo'

describe('haversineMeters', () => {
  it('computes the distance Hauptbahnhof → Neuer Markt (~1.2–1.35 km)', () => {
    const hbf: LonLat = [12.131, 54.0783]
    const neuerMarkt: LonLat = [12.1406, 54.0881]
    const d = haversineMeters(hbf, neuerMarkt)
    expect(d).toBeGreaterThan(1150)
    expect(d).toBeLessThan(1400)
  })

  it('is symmetric and zero for identical points', () => {
    const a: LonLat = [12.1, 54.1]
    const b: LonLat = [12.2, 54.05]
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6)
    expect(haversineMeters(a, a)).toBe(0)
  })
})

describe('bearingDegrees', () => {
  it('north ≈ 0°, east ≈ 90°, south ≈ 180°, west ≈ 270°', () => {
    const origin: LonLat = [12.1, 54.0]
    expect(bearingDegrees(origin, [12.1, 54.01])).toBeCloseTo(0, 0)
    expect(bearingDegrees(origin, [12.11, 54.0])).toBeCloseTo(90, 0)
    expect(bearingDegrees(origin, [12.1, 53.99])).toBeCloseTo(180, 0)
    expect(bearingDegrees(origin, [12.09, 54.0])).toBeCloseTo(270, 0)
  })
})

describe('cumulativeDistances', () => {
  it('starts at 0 and increases monotonically', () => {
    const path: LonLat[] = [
      [12.1, 54.0],
      [12.11, 54.0],
      [12.11, 54.01],
    ]
    const cum = cumulativeDistances(path)
    expect(cum).toHaveLength(3)
    expect(cum[0]).toBe(0)
    expect(cum[1]).toBeGreaterThan(0)
    expect(cum[2]).toBeGreaterThan(cum[1])
  })
})

describe('sampleAtDistance', () => {
  const path: LonLat[] = [
    [12.1, 54.0],
    [12.1, 54.009], // ~1000 m north
  ]
  const cum = cumulativeDistances(path)

  it('interpolates the middle of the segment', () => {
    const total = cum[1]
    const mid = sampleAtDistance(path, cum, total / 2)
    expect(mid.lon).toBeCloseTo(12.1, 6)
    expect(mid.lat).toBeCloseTo(54.0045, 4)
    expect(mid.bearing).toBeCloseTo(0, 0)
  })

  it('clamps to the start and end', () => {
    const before = sampleAtDistance(path, cum, -50)
    expect(before.lat).toBeCloseTo(54.0, 6)
    const after = sampleAtDistance(path, cum, cum[1] + 500)
    expect(after.lat).toBeCloseTo(54.009, 6)
  })
})

describe('projectOntoPath', () => {
  it('finds the distance of the nearest point on the path', () => {
    const path: LonLat[] = [
      [12.1, 54.0],
      [12.1, 54.009],
      [12.109, 54.009],
    ]
    const cum = cumulativeDistances(path)
    // Point just off the middle of the first segment
    const d = projectOntoPath(path, cum, [12.1005, 54.0045])
    expect(d).toBeGreaterThan(cum[1] * 0.4)
    expect(d).toBeLessThan(cum[1] * 0.6)
    // Corner point exactly on the path
    const corner = projectOntoPath(path, cum, [12.1, 54.009])
    expect(corner).toBeCloseTo(cum[1], 0)
  })
})

describe('heightAtDistance', () => {
  it('interpolates linearly between vertices and clamps at the ends', () => {
    const cum = [0, 100, 300]
    const heights = [10, 20, 10]
    expect(heightAtDistance(heights, cum, -5)).toBe(10)
    expect(heightAtDistance(heights, cum, 50)).toBeCloseTo(15)
    expect(heightAtDistance(heights, cum, 200)).toBeCloseTo(15)
    expect(heightAtDistance(heights, cum, 999)).toBe(10)
  })
})
