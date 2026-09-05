import { describe, expect, it } from 'vitest'
import { shadowStrengthForOvercast } from '@/map/CesiumMap'
import { cloudOvercastGrade, overcastGrade, rainOvercastGrade } from '@/map/WeatherOverlay'

/**
 * How the weather weakens the vehicle shadows. A sunlit street casts a
 * crisp shadow, a closed sky makes the light diffuse, and in real rain
 * there is barely a shadow at all.
 *
 * The strength rides the same 0..1 overcast grade the tiles are graded
 * by, so the shadow and the city always read the same weather. These
 * tests pin the ends and the shape; the two anchors themselves are meant
 * to be tuned (SHADOW_WEATHER_LIGHT / _HEAVY in CesiumMap).
 */

describe('overcast grade', () => {
  it('reads a clear sky as clear', () => {
    expect(overcastGrade(0, 0)).toBe(0)
    // A few clouds must not tint the city – the threshold is 40 %
    expect(overcastGrade(0, 30)).toBe(0)
  })

  it('saturates at heavy rain', () => {
    expect(rainOvercastGrade(3)).toBe(1)
    expect(rainOvercastGrade(20)).toBe(1)
  })

  it('lets rain outrank cloud cover, because rain implies an overcast sky', () => {
    // A closed sky alone reads 0.5; the lightest drizzle already reads more
    expect(cloudOvercastGrade(100)).toBeCloseTo(0.5, 6)
    expect(overcastGrade(0.1, 100)).toBeGreaterThan(0.5)
  })

  it('is dry at exactly zero rain, not lightly overcast', () => {
    expect(rainOvercastGrade(0)).toBe(0)
    expect(rainOvercastGrade(-1)).toBe(0)
  })
})

describe('shadowStrengthForOvercast', () => {
  it('leaves a clear sky at full strength', () => {
    expect(shadowStrengthForOvercast(0)).toBe(1)
  })

  it('leaves under a third of the shadow under a closed sky or light rain', () => {
    // A fully closed sky without rain
    expect(shadowStrengthForOvercast(cloudOvercastGrade(100))).toBeCloseTo(0.3, 6)
    // Drizzle sits just past that anchor, so a touch weaker still
    const drizzle = shadowStrengthForOvercast(overcastGrade(0.1, 0))
    expect(drizzle).toBeLessThan(0.3)
    expect(drizzle).toBeGreaterThan(0.2)
  })

  it('leaves about a twentieth of it in heavy rain', () => {
    expect(shadowStrengthForOvercast(overcastGrade(3, 100))).toBeCloseTo(0.05, 6)
  })

  it('never strengthens a shadow and never inverts one', () => {
    for (let g = -0.5; g <= 1.5; g += 0.05) {
      const strength = shadowStrengthForOvercast(g)
      expect(strength).toBeGreaterThanOrEqual(0)
      expect(strength).toBeLessThanOrEqual(1)
    }
  })

  it('only ever weakens as the weather closes in', () => {
    let previous = Infinity
    for (let g = 0; g <= 1; g += 0.02) {
      const strength = shadowStrengthForOvercast(g)
      expect(strength).toBeLessThanOrEqual(previous + 1e-9)
      previous = strength
    }
  })
})
