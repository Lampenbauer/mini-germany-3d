import { describe, expect, it } from 'vitest'
import { bearingInSector, bearingToDeg, sectorColourTowards } from '@/lib/seamark-lights'

/**
 * What a sector light shows to a viewer (src/lib/seamark-lights.ts):
 * the sector holding the bearing from the viewer to the light, an
 * all-round light everywhere, nothing outside every sector.
 */

describe('bearingInSector', () => {
  it('runs clockwise from start to end, through north where it has to', () => {
    expect(bearingInSector(100, 62.6, 242.6)).toBe(true)
    expect(bearingInSector(62.6, 62.6, 242.6)).toBe(true)
    expect(bearingInSector(242.6, 62.6, 242.6)).toBe(true)
    expect(bearingInSector(300, 62.6, 242.6)).toBe(false)
    expect(bearingInSector(10, 62.6, 242.6)).toBe(false)
    // Through north: 350 → 10 holds 355 and 5, not 180
    expect(bearingInSector(355, 350, 10)).toBe(true)
    expect(bearingInSector(5, 350, 10)).toBe(true)
    expect(bearingInSector(180, 350, 10)).toBe(false)
    // Folded bearings, and a full circle
    expect(bearingInSector(-5, 350, 10)).toBe(true)
    expect(bearingInSector(725, 350, 10)).toBe(true)
    expect(bearingInSector(123, 90, 90)).toBe(true)
  })
})

describe('sectorColourTowards', () => {
  it('shows the sector the viewer stands in, the first where two overlap', () => {
    const buelk: [string, number | null, number | null, string | null][] = [
      ['white', 127, 146, 'Fl'],
      ['red', 146, 213, 'Fl'],
      ['green', 213, 228, 'Fl'],
      ['green', 262, 43, 'Fl'],
    ]
    expect(sectorColourTowards(buelk as never, 130)).toBe('white')
    expect(sectorColourTowards(buelk as never, 200)).toBe('red')
    expect(sectorColourTowards(buelk as never, 220)).toBe('green')
    expect(sectorColourTowards(buelk as never, 300)).toBe('green')
    expect(sectorColourTowards(buelk as never, 10)).toBe('green')
    // On the seam two sectors share, the first listed
    expect(sectorColourTowards(buelk as never, 146)).toBe('white')
    // Obscured between 43 and 127, and between 228 and 262
    expect(sectorColourTowards(buelk as never, 90)).toBeNull()
    expect(sectorColourTowards(buelk as never, 245)).toBeNull()
  })

  it('shows an all-round light everywhere, and only outside the bounded sectors where both exist', () => {
    expect(sectorColourTowards([['red', null, null, 'Oc']], 77)).toBe('red')
    const mole: [string, number | null, number | null, string | null][] = [
      ['white', null, null, null],
      ['green', 100, 200, 'Iso'],
    ]
    expect(sectorColourTowards(mole as never, 150)).toBe('green')
    expect(sectorColourTowards(mole as never, 300)).toBe('white')
    expect(sectorColourTowards([], 0)).toBeNull()
  })
})

describe('bearingToDeg', () => {
  it('reads north as 0, east as 90, and folds the rest', () => {
    expect(bearingToDeg(12.1, 54.1, 12.1, 54.2)).toBeCloseTo(0, 5)
    expect(bearingToDeg(12.1, 54.1, 12.2, 54.1)).toBeCloseTo(90, 5)
    expect(bearingToDeg(12.1, 54.1, 12.1, 54.0)).toBeCloseTo(180, 5)
    expect(bearingToDeg(12.1, 54.1, 12.0, 54.1)).toBeCloseTo(270, 5)
    // North-east at this latitude: the metres east are cos(lat) of the degrees
    const deg = bearingToDeg(12.1, 54.1, 12.1 + 0.01 / Math.cos((54.1 * Math.PI) / 180), 54.11)
    expect(deg).toBeCloseTo(45, 1)
  })
})
