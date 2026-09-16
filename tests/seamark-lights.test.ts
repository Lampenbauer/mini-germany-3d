import { describe, expect, it } from 'vitest'
import type { Lighthouse } from '@/data/lighthouses'
import { MIN_TURN_S, beamColour, lensAzimuthsDeg, lensCount, rotatingOptic } from '@/lib/lighthouse-beam'
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

describe('the rotating optic (lib/lighthouse-beam.ts)', () => {
  const warnemuende: Lighthouse = [12.0858, 54.1814, 'major', 34, 20, [['white', 62.6, 242.6, 'Fl', 24, '3+1']]]
  const buk: Lighthouse = [11.6937, 54.1319, 'major', 95, 24, [['white', 73, 265, 'LFl', 15, '4'], ['red', 40, 73, 'LFl', 15, '4']]]
  /** Friedrichsort: seven sectors, every one Fl 3s – one optic turning behind coloured screens. */
  const friedrichsort: Lighthouse = [10.1973, 54.4552, 'major', 29, 14, [
    ['white', 127, 146, 'Fl', 3, null],
    ['red', 146, 213, 'Fl', 3, null],
    ['green', 213, 228, 'Fl', 3, null],
    ['white', 228, 262, 'Fl', 3, null],
    ['green', 262, 43, 'Fl', 3, null],
  ]]

  it('turns a tower whose every sector flashes with one period, one lens per flash of the group, a turn per period', () => {
    expect(rotatingOptic(warnemuende)).toEqual({ periodS: 24, turnS: 24, lenses: 4 })
    expect(rotatingOptic(buk)).toEqual({ periodS: 15, turnS: 15, lenses: 4 })
    expect(lensCount('2+1')).toBe(3)
    expect(lensCount('x')).toBe(1)
    expect(lensCount(null)).toBe(1)
  })

  it('takes a short period as more lenses, not a faster optic: a turn lasts MIN_TURN_S at least', () => {
    // Fl 3s: one lens would race round in three seconds (the strobe the
    // user saw); four lenses in twelve show the same flash every three
    expect(rotatingOptic(friedrichsort)).toEqual({ periodS: 3, turnS: 12, lenses: 4 })
    // Fl(2) 9s: two lenses in nine would be too quick, four in eighteen
    expect(rotatingOptic([9.84, 54.46, 'major', 36, 21, [['white', null, null, 'Fl', 9, '2']]])).toEqual({
      periodS: 9,
      turnS: 18,
      lenses: 4,
    })
    expect(MIN_TURN_S).toBe(12)
  })

  it('turns nothing without a period, for an occulting or fixed light, on a pier head, or on a pole without a range', () => {
    // A file from before the period was carried: four elements, no turn
    expect(rotatingOptic([12.08, 54.18, 'major', 34, 20, [['white', 62.6, 242.6, 'Fl']]])).toBeNull()
    expect(rotatingOptic([12.08, 54.18, 'major', 34, 20, [['white', 62.6, 242.6, 'Fl', null, null]]])).toBeNull()
    expect(rotatingOptic([12.08, 54.18, 'major', 24, 19, [['red', null, null, 'Oc', 6, null]]])).toBeNull()
    expect(rotatingOptic([12.08, 54.18, 'minor', 14, 6, [['green', null, null, 'Fl', 3, null]]])).toBeNull()
    // The Havel's flashing sector light, light_major on a four-metre pole
    // with no range in OSM (Berlin): an LED, no optic
    expect(rotatingOptic([12.978, 52.3438, 'major', null, null, [['red', 65, 155, 'LFl', 4, null]]])).toBeNull()
    expect(rotatingOptic([12.978, 52.3438, 'major', 4, 6, [['red', 65, 155, 'LFl', 4, null]]])).toBeNull()
  })

  it('turns nothing where the sectors differ in character – a leading or sector light with a flashing lamp, not an optic', () => {
    // Wilhelmshaven's leading light: Oc 6s over the degree of the leading
    // line, Fl 3s a degree left of it, Fl(2) 9s three degrees right, fixed
    // colours over the rest – the first rule swept a beam through the
    // degree and strobed
    const wilhelmshaven: Lighthouse = [8.1816, 53.4813, 'major', 30, 21, [
      ['white', 176.4, 177.4, 'Oc', 6, null],
      ['white', 175.5, 176.4, 'Fl', 3, null],
      ['white', 177.4, 180.5, 'Fl', 9, '2'],
      ['green', 152, 174.6, 'F', null, null],
      ['red', 180.5, 191, 'F', null, null],
    ]]
    expect(rotatingOptic(wilhelmshaven)).toBeNull()
    // Bülk: a white Fl(2) over one arc of the fjord among occulting and fixed sectors
    const buelk: Lighthouse = [9.8428, 54.4595, 'major', 36, 21, [
      ['green', 237.5, 241.5, 'Oc', 4, null],
      ['white', 251, 268, 'Fl', 9, '2'],
      ['red', 193, 208, 'F', null, null],
    ]]
    expect(rotatingOptic(buelk)).toBeNull()
    // Two flashing sectors of different periods are two lamps as well
    expect(rotatingOptic([9.8, 54.4, 'major', 30, 20, [['white', 0, 180, 'Fl', 3, null], ['red', 180, 360, 'Fl', 6, null]]])).toBeNull()
  })

  it('spaces the lenses evenly and turns them once per turn, clockwise from north', () => {
    const optic = { periodS: 22, turnS: 22, lenses: 3 }
    expect(lensAzimuthsDeg(0, optic)).toEqual([0, 120, 240])
    // A quarter turn in: every lens 90° on
    const quarter = lensAzimuthsDeg(5.5, optic)
    expect(quarter[0]).toBeCloseTo(90, 6)
    expect(quarter[1]).toBeCloseTo(210, 6)
    expect(quarter[2]).toBeCloseTo(330, 6)
    // A whole turn later the lenses are back where they were
    expect(lensAzimuthsDeg(22, optic)[0]).toBeCloseTo(0, 6)
    // Friedrichsort: a flash passes north every three seconds, the lens after the lens
    const fried = rotatingOptic(friedrichsort)!
    expect(lensAzimuthsDeg(3, fried)[3]).toBeCloseTo(0, 6)
    expect(lensAzimuthsDeg(6, fried)[2]).toBeCloseTo(0, 6)
  })

  it('lights a beam in the colour of the sector it points into, and screens it elsewhere', () => {
    // Warnemünde shows white to vessels at bearings 62.6–242.6 (from
    // seaward): a beam pointing north (out to sea) is white, one
    // pointing south over the town is screened
    expect(beamColour(warnemuende[5], 0)).toBe('white')
    expect(beamColour(warnemuende[5], 180)).toBeNull()
    // Bastorf: red towards the Kühlungsborn shallows, white to sea
    expect(beamColour(buk[5], 235)).toBe('red')
    expect(beamColour(buk[5], 300)).toBe('white')
    // Friedrichsort: red up the fjord, green across, white along the fairway
    expect(beamColour(friedrichsort[5], 180 - 180)).toBe('red')
    expect(beamColour(friedrichsort[5], 220 - 180)).toBe('green')
    expect(beamColour(friedrichsort[5], 130 - 180 + 360)).toBe('white')
  })
})
