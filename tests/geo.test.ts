import { describe, expect, it } from 'vitest'
import {
  bearingDegrees,
  cumulativeDistances,
  haversineMeters,
  heightAtDistance,
  nextQuarterHeading,
  offsetLonLat,
  projectOntoPath,
  sampleAtDistance,
  windAngleTo,
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

describe('windAngleTo', () => {
  it('leaves an angle that has not moved alone', () => {
    // The compass state is set from this on every UI tick – an unchanged
    // heading has to come back identical, or the app re-renders for nothing
    expect(windAngleTo(37, 37)).toBe(37)
    expect(windAngleTo(397, 37)).toBe(397)
    expect(windAngleTo(-323, 37)).toBe(-323)
  })

  it('takes the short way across north instead of unwinding the dial', () => {
    expect(windAngleTo(359, 1)).toBe(361)
    expect(windAngleTo(1, 359)).toBe(-1)
    expect(windAngleTo(361, 359)).toBe(359)
  })

  it('keeps turning in one direction as the dial is dragged round', () => {
    let wound = 0
    for (const heading of [90, 180, 270, 0, 90, 180, 270, 0]) {
      wound = windAngleTo(wound, heading)
    }
    // Two full turns forward, never a jump back through the dial
    expect(wound).toBe(720)
  })

  it('always lands on the angle it was given, modulo a full turn', () => {
    for (const [from, to] of [
      [0, 137],
      [720, 45],
      [-90, 300],
      [12.5, 200],
    ]) {
      const wound = windAngleTo(from, to)
      expect(((wound % 360) + 360) % 360).toBeCloseTo(((to % 360) + 360) % 360, 6)
      expect(Math.abs(wound - from)).toBeLessThanOrEqual(180)
    }
  })
})

describe('nextQuarterHeading', () => {
  it('snaps to the quarter the view is closest to', () => {
    expect(nextQuarterHeading(20)).toBe(0)
    expect(nextQuarterHeading(46)).toBe(90)
    expect(nextQuarterHeading(100)).toBe(90)
    expect(nextQuarterHeading(170)).toBe(180)
    expect(nextQuarterHeading(250)).toBe(270)
  })

  it('reads the far side of north as north, not as a fourth quarter', () => {
    expect(nextQuarterHeading(316)).toBe(0)
    expect(nextQuarterHeading(359)).toBe(0)
  })

  it('moves on when the view already stands on a quarter', () => {
    // A press has to turn the map, or it reads as a dead button
    expect(nextQuarterHeading(0)).toBe(90)
    expect(nextQuarterHeading(90)).toBe(180)
    expect(nextQuarterHeading(180)).toBe(270)
    // …round past north, which is where it used to stop
    expect(nextQuarterHeading(270)).toBe(0)
    expect(nextQuarterHeading(360)).toBe(90)
  })

  it('counts a hair off a quarter as standing on it', () => {
    // Snapping back by a third of a degree would look like nothing happened
    expect(nextQuarterHeading(270.3)).toBe(0)
    expect(nextQuarterHeading(269.7)).toBe(0)
    // …but a visible tilt is still worth straightening
    expect(nextQuarterHeading(272)).toBe(270)
    expect(nextQuarterHeading(268)).toBe(270)
  })

  it('answers within the dial for a wound or negative angle', () => {
    // The needle's angle is wound on rather than wrapped (see windAngleTo)
    expect(nextQuarterHeading(720)).toBe(90)
    expect(nextQuarterHeading(721)).toBe(0)
    expect(nextQuarterHeading(700)).toBe(0)
    expect(nextQuarterHeading(-90)).toBe(0)
    expect(nextQuarterHeading(-100)).toBe(270)
  })

  it('walks the whole dial round when pressed over and over', () => {
    let heading = 0
    const visited = [0, 1, 2, 3, 4].map(() => (heading = nextQuarterHeading(heading)))
    expect(visited).toEqual([90, 180, 270, 0, 90])
  })
})

describe('offsetLonLat', () => {
  const origin: LonLat = [12.1469, 54.1477]

  it('moves a point by the requested distance in each direction', () => {
    for (const [east, north, bearing] of [
      [0, 1000, 0],
      [1000, 0, 90],
      [0, -1000, 180],
      [-1000, 0, 270],
    ]) {
      const moved = offsetLonLat(origin, east, north)
      expect(haversineMeters(origin, moved)).toBeCloseTo(1000, 0)
      // The flat-earth step east or west leaves a parallel, whose initial
      // great-circle bearing at 54° differs from 90°/270° by ~0.006°
      expect(bearingDegrees(origin, moved)).toBeCloseTo(bearing, 1)
    }
  })

  it('leaves the point alone for a zero offset', () => {
    expect(offsetLonLat(origin, 0, 0)).toEqual(origin)
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
