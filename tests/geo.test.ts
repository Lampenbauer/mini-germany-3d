import { describe, expect, it } from 'vitest'
import {
  bearingDegrees,
  cumulativeDistances,
  haversineMeters,
  projectOntoPath,
  sampleAtDistance,
  type LonLat,
} from '@/lib/geo'

describe('haversineMeters', () => {
  it('berechnet die Distanz Hauptbahnhof → Neuer Markt (~1,2–1,35 km)', () => {
    const hbf: LonLat = [12.131, 54.0783]
    const neuerMarkt: LonLat = [12.1406, 54.0881]
    const d = haversineMeters(hbf, neuerMarkt)
    expect(d).toBeGreaterThan(1150)
    expect(d).toBeLessThan(1400)
  })

  it('ist symmetrisch und null bei identischen Punkten', () => {
    const a: LonLat = [12.1, 54.1]
    const b: LonLat = [12.2, 54.05]
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6)
    expect(haversineMeters(a, a)).toBe(0)
  })
})

describe('bearingDegrees', () => {
  it('Norden ≈ 0°, Osten ≈ 90°, Süden ≈ 180°, Westen ≈ 270°', () => {
    const origin: LonLat = [12.1, 54.0]
    expect(bearingDegrees(origin, [12.1, 54.01])).toBeCloseTo(0, 0)
    expect(bearingDegrees(origin, [12.11, 54.0])).toBeCloseTo(90, 0)
    expect(bearingDegrees(origin, [12.1, 53.99])).toBeCloseTo(180, 0)
    expect(bearingDegrees(origin, [12.09, 54.0])).toBeCloseTo(270, 0)
  })
})

describe('cumulativeDistances', () => {
  it('beginnt bei 0 und wächst monoton', () => {
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
    [12.1, 54.009], // ~1000 m nach Norden
  ]
  const cum = cumulativeDistances(path)

  it('interpoliert die Mitte des Segments', () => {
    const total = cum[1]
    const mid = sampleAtDistance(path, cum, total / 2)
    expect(mid.lon).toBeCloseTo(12.1, 6)
    expect(mid.lat).toBeCloseTo(54.0045, 4)
    expect(mid.bearing).toBeCloseTo(0, 0)
  })

  it('begrenzt auf Anfang und Ende', () => {
    const before = sampleAtDistance(path, cum, -50)
    expect(before.lat).toBeCloseTo(54.0, 6)
    const after = sampleAtDistance(path, cum, cum[1] + 500)
    expect(after.lat).toBeCloseTo(54.009, 6)
  })
})

describe('projectOntoPath', () => {
  it('findet die Distanz des nächstgelegenen Streckenpunkts', () => {
    const path: LonLat[] = [
      [12.1, 54.0],
      [12.1, 54.009],
      [12.109, 54.009],
    ]
    const cum = cumulativeDistances(path)
    // Punkt knapp neben der Streckenmitte des ersten Segments
    const d = projectOntoPath(path, cum, [12.1005, 54.0045])
    expect(d).toBeGreaterThan(cum[1] * 0.4)
    expect(d).toBeLessThan(cum[1] * 0.6)
    // Eckpunkt exakt auf der Strecke
    const corner = projectOntoPath(path, cum, [12.1, 54.009])
    expect(corner).toBeCloseTo(cum[1], 0)
  })
})
