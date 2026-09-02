import { describe, expect, it } from 'vitest'
import { clampFovDeg, framingDistanceScale, REFERENCE_FOV_DEG } from '@/map/camera-fov'

describe('framing distance scale', () => {
  it('leaves the tuned distances alone at the reference angle', () => {
    expect(framingDistanceScale(REFERENCE_FOV_DEG)).toBe(1)
  })

  it('moves the camera back as the angle narrows', () => {
    // tan(30°)/tan(22.5°) and tan(30°)/tan(15°) – the same factors the
    // side-by-side renders were shot at
    expect(framingDistanceScale(45)).toBeCloseTo(1.394, 3)
    expect(framingDistanceScale(30)).toBeCloseTo(2.155, 3)
  })

  it('moves it closer as the angle widens', () => {
    expect(framingDistanceScale(90)).toBeCloseTo(0.577, 3)
  })

  it('keeps the same ground in frame at any angle', () => {
    // What the scale is for: half the frame width at the flown distance
    // has to come out the same wherever the knob stands.
    const halfWidth = (fovDeg: number) =>
      1000 * framingDistanceScale(fovDeg) * Math.tan((fovDeg * Math.PI) / 360)
    const reference = halfWidth(REFERENCE_FOV_DEG)
    for (const fovDeg of [20, 35, 45, 75, 110]) {
      expect(halfWidth(fovDeg)).toBeCloseTo(reference, 6)
    }
  })

  it('holds an unusable field of view inside its guard rails', () => {
    expect(clampFovDeg(0)).toBe(10)
    expect(clampFovDeg(-30)).toBe(10)
    expect(clampFovDeg(180)).toBe(120)
    expect(clampFovDeg(Number.NaN)).toBe(REFERENCE_FOV_DEG)
    // A zero angle would otherwise divide the distances by zero
    expect(Number.isFinite(framingDistanceScale(0))).toBe(true)
  })
})
