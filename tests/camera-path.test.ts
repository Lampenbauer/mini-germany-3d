import { describe, expect, it } from 'vitest'
import type { CameraView } from '@/lib/camera-hash'
import {
  describeKeyframe,
  easeProgress,
  formatCameraPathHash,
  headingDelta,
  interpolateView,
  isFlyable,
  parseCameraPathHash,
  viewAlongPath,
  type CameraPath,
} from '@/lib/camera-path'

const a: CameraView = { longitude: 12.1, latitude: 54.08, height: 3000, heading: 350, pitch: -40 }
const b: CameraView = { longitude: 12.14, latitude: 54.1, height: 800, heading: 10, pitch: -30 }
const path: CameraPath = { keyframes: [a, b], durationS: 20, ease: 'linear' }

describe('a camera path', () => {
  it('turns the heading the short way round', () => {
    expect(headingDelta(350, 10)).toBe(20)
    expect(headingDelta(10, 350)).toBe(-20)
    expect(headingDelta(0, 180)).toBe(-180)
    expect(headingDelta(90, 270)).toBe(-180)
    expect(interpolateView(a, b, 0.5).heading).toBe(0)
    expect(interpolateView({ ...a, heading: 10 }, { ...b, heading: 350 }, 0.25).heading).toBe(5)
  })

  it('moves every value in step and stays on the ends', () => {
    const mid = interpolateView(a, b, 0.5)
    expect(mid.longitude).toBeCloseTo(12.12)
    expect(mid.latitude).toBeCloseTo(54.09)
    expect(mid.height).toBe(1900)
    expect(mid.pitch).toBe(-35)
    expect(interpolateView(a, b, -1)).toEqual({ ...a, heading: 350 })
    expect(interpolateView(a, b, 2)).toEqual({ ...b, heading: 10 })
  })

  it('shares the time equally between the segments and eases the whole way', () => {
    const c: CameraView = { longitude: 12.2, latitude: 54.2, height: 500, heading: 90, pitch: -20 }
    const three: CameraPath = { keyframes: [a, b, c], durationS: 30, ease: 'linear' }
    expect(viewAlongPath(three, 0)).toEqual(a)
    expect(viewAlongPath(three, 0.5)).toEqual(b)
    expect(viewAlongPath(three, 1)).toEqual(c)
    expect(viewAlongPath(three, 0.75).height).toBe(650)
    expect(easeProgress(0.5, 'smooth')).toBe(0.5)
    expect(easeProgress(0.25, 'smooth')).toBeLessThan(0.25)
    expect(easeProgress(0.75, 'smooth')).toBeGreaterThan(0.75)
    expect(viewAlongPath({ ...path, ease: 'smooth' }, 0.25).height).toBeGreaterThan(
      viewAlongPath(path, 0.25).height,
    )
  })

  it('goes into the hash and comes back the same', () => {
    const hash = formatCameraPathHash(path)
    expect(hash).toBe('&path=54.080000,12.100000,3000,350,-40;54.100000,12.140000,800,10,-30&dur=20&ease=linear')
    expect(parseCameraPathHash(`#lat=1&lon=2&height=3${hash}`)).toEqual(path)
    // Smooth is the default and stays out of the hash; linear is the deviation
    expect(formatCameraPathHash({ ...path, ease: 'smooth', durationS: 2.5 })).toContain('&dur=2.5')
    expect(formatCameraPathHash({ ...path, ease: 'smooth' })).not.toContain('ease=')
    expect(parseCameraPathHash('#' + formatCameraPathHash({ ...path, ease: 'smooth' }))?.ease).toBe('smooth')
    expect(parseCameraPathHash('#' + formatCameraPathHash(path))?.ease).toBe('linear')
  })

  it('refuses what cannot be flown', () => {
    expect(isFlyable(null)).toBe(false)
    expect(isFlyable({ ...path, keyframes: [a] })).toBe(false)
    expect(isFlyable({ ...path, durationS: 0.5 })).toBe(false)
    expect(formatCameraPathHash({ ...path, keyframes: [a] })).toBe('')
    expect(parseCameraPathHash('#path=54,12,3000,0,-40')).toBeNull()
    expect(parseCameraPathHash('#path=54,12,3000,0,-40;x,12,800,0,-30&dur=20')).toBeNull()
    expect(parseCameraPathHash('#path=54,12,3000,0,-40;54,12,800,0,-30&dur=9999')).toBeNull()
    expect(parseCameraPathHash('#path=54,12,3000,0,-40;54,12,800,0,-30')).toMatchObject({
      durationS: 20,
      ease: 'smooth',
    })
    expect(parseCameraPathHash('#lat=54&lon=12&height=100')).toBeNull()
  })

  it('describes a keyframe the way the popover lists it', () => {
    expect(describeKeyframe(a)).toBe('54.0800° N 12.1000° E\n3.0 km · 350° · −40°')
    expect(describeKeyframe({ ...b, height: 800, heading: 360 })).toBe('54.1000° N 12.1400° E\n800 m · 0° · −30°')
  })
})
