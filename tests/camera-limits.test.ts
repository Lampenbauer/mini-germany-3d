import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { toDegrees } from '@/lib/geo'
import { padBoundingBox, rostockBoundingBox } from '@/lib/rostock-bounding-box'
import { boundingBoxCameraLimits, clampCameraPose } from '@/map/camera-limits'

const MAX_HEIGHT_M = 25_000

/** A fence 100 km around a straight north–south route at 12.1 °E. */
function testLimits() {
  return boundingBoxCameraLimits(
    padBoundingBox({ west: 12.1, south: 54.0, east: 12.1, north: 54.018 }, 100_000),
    MAX_HEIGHT_M,
  )
}

describe('boundingBoxCameraLimits', () => {
  it('is the Rostock bounding box in radians plus the ceiling', () => {
    const limits = boundingBoxCameraLimits(rostockBoundingBox, config.cameraLimits.maxHeightMeters)
    expect(toDegrees(limits.west)).toBeCloseTo(rostockBoundingBox.west, 9)
    expect(toDegrees(limits.south)).toBeCloseTo(rostockBoundingBox.south, 9)
    expect(toDegrees(limits.east)).toBeCloseTo(rostockBoundingBox.east, 9)
    expect(toDegrees(limits.north)).toBeCloseTo(rostockBoundingBox.north, 9)
    expect(limits.maxHeight).toBe(config.cameraLimits.maxHeightMeters)
  })
})

describe('clampCameraPose', () => {
  const limits = testLimits()
  const inside = { longitude: limits.west + 0.01, latitude: limits.south + 0.01, height: 800 }

  it('leaves a pose inside the fence alone', () => {
    expect(clampCameraPose(inside, limits)).toBeNull()
  })

  it('pulls a pose from the other end of the world back to the border', () => {
    const munich = { longitude: 0.2022, latitude: 0.8401, height: 5000 }
    const clamped = clampCameraPose(munich, limits)
    expect(clamped).not.toBeNull()
    expect(clamped!.latitude).toBe(limits.south)
    expect(clamped!.longitude).toBe(munich.longitude) // 11.58°E is inside
    expect(clamped!.height).toBe(5000)
  })

  it('caps the height without moving the camera sideways', () => {
    const clamped = clampCameraPose({ ...inside, height: 4_000_000 }, limits)
    expect(clamped).not.toBeNull()
    expect(clamped!.height).toBe(limits.maxHeight)
    expect(clamped!.longitude).toBe(inside.longitude)
    expect(clamped!.latitude).toBe(inside.latitude)
  })

  it('accepts an already clamped pose despite round-trip noise', () => {
    // A clamped pose goes through Cartesian3 and back before it is checked
    // again; without a tolerance it would be corrected every single frame.
    const noisy = {
      longitude: limits.east + 1e-12,
      latitude: limits.north + 1e-12,
      height: limits.maxHeight + 1e-6,
    }
    expect(clampCameraPose(noisy, limits)).toBeNull()
  })
})
