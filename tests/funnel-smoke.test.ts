import { Cartesian3 } from 'cesium'
import { describe, expect, it } from 'vitest'
import {
  FunnelSmoke,
  PLUME_LIFE_S,
  PLUME_MAX_RATE,
  PLUME_MOTION_MPS,
  SMOKE_FULL_SOG_KN,
  SMOKE_MIN_SOG_KN,
  smokeColor,
  smokeIntensity,
} from '@/map/FunnelSmoke'
import type { FrameState } from '@/map/cesium-renderer'

/**
 * The exhaust plumes over the ships' funnels: what one instance packs,
 * how the plume's clock runs, and when the primitive draws at all. The
 * shaders themselves compile only on a GL context – e2e/ship-effects.spec.ts
 * proves them in the real renderer.
 */

const host = { sunDirection: null as Cartesian3 | null, overcast: 0 }
const anchor = Cartesian3.fromDegrees(12.13, 54.1, 40)

describe('smokeIntensity', () => {
  it('shows nothing for a ship at rest or without a speed, and a full plume from ten knots', () => {
    expect(smokeIntensity(null)).toBe(0)
    expect(smokeIntensity(0)).toBe(0)
    expect(smokeIntensity(SMOKE_MIN_SOG_KN - 0.1)).toBe(0)
    expect(smokeIntensity(SMOKE_MIN_SOG_KN)).toBeCloseTo(0.45, 5)
    expect(smokeIntensity(SMOKE_FULL_SOG_KN)).toBe(1)
    expect(smokeIntensity(20)).toBe(1)
    // …and grows with the way she makes in between
    expect(smokeIntensity(5)).toBeGreaterThan(smokeIntensity(3))
    expect(smokeIntensity(5)).toBeLessThan(smokeIntensity(8))
  })
})

describe('smokeColor', () => {
  it('is a light grey by day and near dark at night, cooler than white', () => {
    const noon = smokeColor(1, 0)
    const night = smokeColor(-0.3, 0)
    expect(noon.x).toBeGreaterThan(0.5)
    expect(noon.x).toBeLessThan(0.8)
    expect(noon.z).toBeGreaterThan(noon.x)
    expect(night.x).toBeLessThan(0.15)
    // A closed sky takes some of the sun off it
    expect(smokeColor(1, 1).x).toBeLessThan(noon.x)
  })
})

describe('FunnelSmoke', () => {
  it('packs a plume as the shader reads it: the anchor in two floats, the way, the funnel, the seed', () => {
    const smoke = new FunnelSmoke(host)
    smoke.begin()
    smoke.add(anchor, 4.4, -4.4, 6, 0.8, 42)
    smoke.commit()
    expect(smoke.drawn).toBe(1)
    const instance = smoke.instanceAt(0)
    // High plus low gives the anchor back to the centimetre – float32 twice
    expect(Cartesian3.distance(instance.anchor, anchor)).toBeLessThan(0.01)
    expect(instance.velocityEast).toBeCloseTo(4.4, 5)
    expect(instance.velocityNorth).toBeCloseTo(-4.4, 5)
    expect(instance.size).toBe(6)
    expect(instance.intensity).toBeCloseTo(0.8, 5)
    expect(instance.seed).toBe(42)
  })

  it('starts each tick afresh and grows with the fleet', () => {
    const smoke = new FunnelSmoke(host)
    smoke.begin()
    for (let i = 0; i < 100; i++) smoke.add(anchor, 0, 0, 2, 1, i)
    smoke.commit()
    expect(smoke.drawn).toBe(100)
    expect(smoke.instanceAt(99).seed).toBe(99)
    smoke.begin()
    smoke.commit()
    expect(smoke.drawn).toBe(0)
  })

  it('runs on the clock it is given, no faster than three times real time, and backward under the same cap', () => {
    const smoke = new FunnelSmoke(host)
    smoke.advance(1_000, 0)
    expect(smoke.plumeTime).toBe(0)
    // A second of the ships' clock in a second of real time
    smoke.advance(2_000, 1_000)
    expect(smoke.plumeTime).toBeCloseTo(1, 5)
    // The time-lapse: two minutes in a second run as three seconds
    smoke.advance(122_000, 2_000)
    expect(smoke.plumeTime).toBeCloseTo(1 + PLUME_MAX_RATE, 5)
    // A clock standing still (the pause) moves nothing
    smoke.advance(122_000, 3_000)
    expect(smoke.plumeTime).toBeCloseTo(1 + PLUME_MAX_RATE, 5)
    // One running backward – the rewind, or a time set back – runs the
    // plume back into the funnel, no faster than the same cap
    smoke.advance(60_000, 4_000)
    expect(smoke.plumeTime).toBeCloseTo(1, 5)
    smoke.advance(60_500, 4_500)
    expect(smoke.plumeTime).toBeCloseTo(1.5, 5)
  })

  it('measures the puffs’ motion since the frame last drawn, across the clock wrapping round', () => {
    const smoke = new FunnelSmoke(host)
    smoke.advance(0, 0)
    smoke.advance(2_000, 2_000)
    expect(smoke.metersSinceRendered).toBeCloseTo(2 * PLUME_MOTION_MPS, 5)
    smoke.markRendered()
    expect(smoke.metersSinceRendered).toBe(0)
    // Past a multiple of the plume's life the clock wraps – the picture
    // is periodic in it – and the motion since the frame stays right
    const period = PLUME_LIFE_S * 1024
    smoke.advance(2_000 + period * 1000, 2_000 + period * 1000)
    expect(smoke.plumeTime).toBeLessThan(period)
    expect(smoke.plumeTime).toBeCloseTo(2, 3)
    expect(smoke.metersSinceRendered).toBeCloseTo(period * PLUME_MOTION_MPS, 1)
  })

  it('turns the weather’s wind into the velocity the puffs are carried by', () => {
    const smoke = new FunnelSmoke(host)
    // A west wind blows east
    smoke.setWind(5, 270)
    expect(smoke.state.wind.east).toBeCloseTo(5, 5)
    expect(smoke.state.wind.north).toBeCloseTo(0, 5)
    // A north wind blows south
    smoke.setWind(3, 0)
    expect(smoke.state.wind.east).toBeCloseTo(0, 5)
    expect(smoke.state.wind.north).toBeCloseTo(-3, 5)
  })

  it('draws in the render pass only, and nothing while there is no plume', () => {
    const smoke = new FunnelSmoke(host)
    const frame = (passes: FrameState['passes'], instancedArrays = true): FrameState => ({
      context: { instancedArrays, webgl2: true, createPickId: () => ({ color: {} as never, destroy() {} }) },
      commandList: [],
      passes,
    })
    // Nothing to draw: no GL work at all
    const empty = frame({ render: true })
    smoke.update(empty)
    expect(empty.commandList).toEqual([])
    smoke.begin()
    smoke.add(anchor, 0, 0, 2, 1, 1)
    smoke.commit()
    // The pick pass and the offscreen picks get nothing – a plume is not
    // to be picked, and a hull must not be clamped onto its own smoke
    const pick = frame({ render: false, pick: true })
    smoke.update(pick)
    expect(pick.commandList).toEqual([])
    const offscreen = frame({ render: true, offscreen: true })
    smoke.update(offscreen)
    expect(offscreen.commandList).toEqual([])
    // Without instanced drawing the layer stays dark rather than failing
    const plain = frame({ render: true }, false)
    smoke.update(plain)
    expect(plain.commandList).toEqual([])
    expect(smoke.state.supported).toBe(false)
  })
})
