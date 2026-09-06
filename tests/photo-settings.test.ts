import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import {
  DEFAULT_PHOTO_SETTINGS,
  focalLengthMm,
  fovDegFromFocalLength,
  isDefaultPhotoSettings,
  isNeutralGrade,
  lensFovDeg,
  NEUTRAL_WHITE_BALANCE_K,
  whiteBalanceGain,
  withTiltShift,
} from '@/lib/photo-settings'

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

describe('photo settings', () => {
  it('open on the lens of the default look, a neutral grade and the effect as configured', () => {
    expect(DEFAULT_PHOTO_SETTINGS.fovDeg).toBe(lensFovDeg(config.camera.miniatureDefault))
    expect(DEFAULT_PHOTO_SETTINGS.tiltShift.enabled).toBe(config.camera.miniatureDefault)
    expect(isNeutralGrade(DEFAULT_PHOTO_SETTINGS)).toBe(true)
    expect(isDefaultPhotoSettings(DEFAULT_PHOTO_SETTINGS)).toBe(true)
  })

  it('count as default only while every knob stands where it opened', () => {
    expect(isDefaultPhotoSettings({ ...DEFAULT_PHOTO_SETTINGS, exposureEv: 0.1 })).toBe(false)
    expect(isDefaultPhotoSettings({ ...DEFAULT_PHOTO_SETTINGS, fovDeg: 40 })).toBe(false)
    expect(
      isDefaultPhotoSettings({
        ...DEFAULT_PHOTO_SETTINGS,
        tiltShift: { ...DEFAULT_PHOTO_SETTINGS.tiltShift, sharpen: 0.5 },
      }),
    ).toBe(false)
    // A fresh copy with the same numbers is the default – identity is not the test
    expect(
      isDefaultPhotoSettings({
        ...DEFAULT_PHOTO_SETTINGS,
        tiltShift: { ...DEFAULT_PHOTO_SETTINGS.tiltShift },
      }),
    ).toBe(true)
  })

  it('treat a grade as neutral only when every knob leaves the frame alone', () => {
    expect(isNeutralGrade({ ...DEFAULT_PHOTO_SETTINGS, whiteBalanceK: 6400 })).toBe(false)
    expect(isNeutralGrade({ ...DEFAULT_PHOTO_SETTINGS, vignette: 0.01 })).toBe(false)
    expect(isNeutralGrade({ ...DEFAULT_PHOTO_SETTINGS, contrast: 1, saturation: 1 })).toBe(true)
  })
})

describe('withTiltShift', () => {
  it('brings the lens of its look along with the switch', () => {
    const on = withTiltShift(DEFAULT_PHOTO_SETTINGS, true)
    expect(on.tiltShift.enabled).toBe(true)
    expect(on.fovDeg).toBe(config.camera.fovDeg)
    const off = withTiltShift(on, false)
    expect(off.tiltShift.enabled).toBe(false)
    expect(off.fovDeg).toBe(config.camera.fovOffDeg)
  })

  it('leaves every other knob where it was', () => {
    const adjusted = {
      ...DEFAULT_PHOTO_SETTINGS,
      exposureEv: 0.7,
      tiltShift: { ...DEFAULT_PHOTO_SETTINGS.tiltShift, maxBlurRadius: 0.05 },
    }
    const on = withTiltShift(adjusted, true)
    expect(on.exposureEv).toBe(0.7)
    expect(on.tiltShift.maxBlurRadius).toBe(0.05)
    // A new object each time: the app treats the settings as immutable
    expect(on).not.toBe(adjusted)
    expect(on.tiltShift).not.toBe(adjusted.tiltShift)
  })
})

describe('focal length', () => {
  it('reads the two lenses as a 31 mm wide angle and an 81 mm short telephoto', () => {
    expect(focalLengthMm(60)).toBeCloseTo(31.2, 1)
    expect(focalLengthMm(25)).toBeCloseTo(81.2, 1)
    // The classic normal lens sits in between
    expect(focalLengthMm(fovDegFromFocalLength(50))).toBeCloseTo(50, 9)
  })

  it('round-trips through the angle', () => {
    for (const fov of [25, 35, 45, 60]) {
      expect(fovDegFromFocalLength(focalLengthMm(fov))).toBeCloseTo(fov, 9)
    }
  })
})

describe('white balance gain', () => {
  it('is no gain at all at the neutral setting', () => {
    const gain = whiteBalanceGain(NEUTRAL_WHITE_BALANCE_K)
    for (const channel of gain) expect(channel).toBeCloseTo(1, 9)
  })

  it('warms the picture at a higher setting and cools it at a lower one', () => {
    // As on a camera: the setting names the light being compensated for,
    // so a "cool light" setting pushes the picture warm, and vice versa
    const warm = whiteBalanceGain(9000)
    expect(warm[0]).toBeGreaterThan(warm[2])
    const cool = whiteBalanceGain(4000)
    expect(cool[2]).toBeGreaterThan(cool[0])
  })

  it('holds the luminance of white, whatever the setting', () => {
    // The balance shifts the colour; the exposure knob is for brightness
    for (const kelvin of [3000, 4500, 6500, 8000, 10_000]) {
      expect(luminance(whiteBalanceGain(kelvin))).toBeCloseTo(1, 9)
    }
  })
})
