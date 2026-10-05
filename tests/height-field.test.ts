import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import {
  FIELD_BAND_M,
  FIELD_FINE_RANGE_M,
  FIELD_REACH_M,
  HeightField,
} from '@/map/height-field'
import { testNetworkJson } from './fixtures'

/**
 * The NHN→ellipsoid offset as a field along every direction, fed by the
 * stops measured on the tiles (see src/map/height-field.ts).
 */
describe('HeightField', () => {
  const network = prepareNetwork(testNetworkJson)
  const line = network.lines[0]
  const dir = line.directions[0]
  const [alpha, beta, gamma] = dir.stops

  function field(base = 40) {
    const f = new HeightField(base)
    f.add(network)
    return f
  }

  it('is the base everywhere until a stop is measured', () => {
    const f = field()
    expect(f.offsetAt(line.id, 0, 0)).toBe(40)
    expect(f.offsetAt(line.id, 0, beta.dist)).toBe(40)
    expect(f.offsetAt('no-such-line', 0, 0)).toBe(40)
    expect(f.sampleCount).toBe(0)
  })

  it('takes a fine measurement in band, names the directions it changes, and ignores the rest', () => {
    const f = field()
    // Fine and in band: a sample, on both directions the stop lies on
    expect(f.measure(beta.id, 42, 300).sort()).toEqual([`${line.id}|0`, `${line.id}|1`])
    expect(f.offsetAt(line.id, 0, beta.dist)).toBeCloseTo(42, 9)
    // Measured again within the settled band: nothing to redraw
    expect(f.measure(beta.id, 42.1, 200)).toEqual([])
    // Coarse: from further than the fine range
    expect(f.measure(alpha.id, 45, FIELD_FINE_RANGE_M + 1)).toEqual([])
    expect(f.offsetAt(line.id, 0, alpha.dist)).toBeLessThan(45)
    // A roof: out of band, held but not used
    f.measure(gamma.id, 40 + FIELD_BAND_M + 1, 100)
    expect(f.offsetAt(line.id, 0, gamma.dist)).toBeCloseTo(40, 9)
    // An unknown stop belongs to no direction
    expect(f.measure('nowhere', 41, 10)).toEqual([])
  })

  it('runs between two samples and fades back to the base beyond their reach', () => {
    const f = field()
    f.measure(alpha.id, 42, 0)
    f.measure(gamma.id, 38, 0)
    // At the samples their own offsets
    expect(f.offsetAt(line.id, 0, alpha.dist)).toBeCloseTo(42, 6)
    expect(f.offsetAt(line.id, 0, gamma.dist)).toBeCloseTo(38, 6)
    // Halfway (the fixture's stops are 1 km apart): the two blend
    const mid = f.offsetAt(line.id, 0, (alpha.dist + gamma.dist) / 2)
    expect(mid).toBeGreaterThan(38)
    expect(mid).toBeLessThan(42)
    // Out of every sample's reach: the base
    expect(f.offsetAt(line.id, 0, gamma.dist + FIELD_REACH_M + 1)).toBe(40)
    // Halfway out of reach: halfway back to the base
    expect(f.offsetAt(line.id, 0, gamma.dist + FIELD_REACH_M / 2)).toBeCloseTo(39, 6)
  })

  it('reads the band against a new base, and forgets a city with its measurements', () => {
    const f = field(40)
    f.measure(beta.id, 43, 0)
    expect(f.samples(line.id, 0)).toHaveLength(1)
    // The calibration moves the base: a sample 3 m over 40 is 7 m over 36 – a roof now
    f.setBase(36)
    expect(f.samples(line.id, 0)).toHaveLength(0)
    expect(f.offsetAt(line.id, 0, beta.dist)).toBe(36)
    f.clear()
    expect(f.sampleCount).toBe(0)
    expect(f.measure(beta.id, 37, 0)).toEqual([])
    expect(f.baseOffset).toBe(36)
  })
})
