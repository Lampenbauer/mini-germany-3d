import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { loadBundledNetwork, prepareNetwork } from '@/data/network'
import { haversineMeters, toDegrees, type LonLat } from '@/lib/geo'
import { clampCameraPose, networkCameraLimits } from '@/map/camera-limits'
import { testNetworkJson } from './fixtures'

const PADDING_M = 100_000
const MAX_HEIGHT_M = 25_000

/** Limits of the synthetic test network (straight north–south at 12.1°E). */
function testLimits() {
  return networkCameraLimits(prepareNetwork(testNetworkJson), PADDING_M, MAX_HEIGHT_M)
}

function degrees(limits: ReturnType<typeof testLimits>) {
  return {
    west: toDegrees(limits.west),
    south: toDegrees(limits.south),
    east: toDegrees(limits.east),
    north: toDegrees(limits.north),
  }
}

describe('networkCameraLimits', () => {
  it('pads the route bounding box by the requested distance', () => {
    const box = degrees(testLimits())
    // Route: 12.1°E, 54.000–54.018°N
    const north: LonLat = [12.1, 54.018]
    const south: LonLat = [12.1, 54.0]
    expect(haversineMeters(north, [12.1, box.north])).toBeGreaterThan(PADDING_M * 0.99)
    expect(haversineMeters(north, [12.1, box.north])).toBeLessThan(PADDING_M * 1.01)
    expect(haversineMeters(south, [12.1, box.south])).toBeGreaterThan(PADDING_M * 0.99)
    expect(haversineMeters(south, [12.1, box.south])).toBeLessThan(PADDING_M * 1.01)
  })

  it('keeps the east–west padding at least that wide at every latitude', () => {
    const box = degrees(testLimits())
    // Meridians converge northwards – the padding is dimensioned for the
    // box's outermost latitude and is therefore wider further south.
    for (const lat of [box.south, 54.0, box.north]) {
      expect(haversineMeters([12.1, lat], [box.east, lat])).toBeGreaterThan(PADDING_M)
      expect(haversineMeters([12.1, lat], [box.west, lat])).toBeGreaterThan(PADDING_M)
    }
  })

  it('encloses the whole Rostock network with the configured padding', () => {
    const padding = config.cameraLimits.paddingMeters
    const limits = networkCameraLimits(
      loadBundledNetwork(),
      padding,
      config.cameraLimits.maxHeightMeters,
    )
    const box = degrees(limits)
    // The network spans 12.030–12.225 °E / 54.056–54.203 °N …
    expect(box.west).toBeLessThan(12.03)
    expect(box.east).toBeGreaterThan(12.225)
    expect(box.south).toBeLessThan(54.056)
    expect(box.north).toBeGreaterThan(54.203)
    // … and the fence sits exactly the configured distance beyond it
    expect(haversineMeters([12.13, 54.203], [12.13, box.north])).toBeCloseTo(padding, -2)
    expect(haversineMeters([12.13, 54.056], [12.13, box.south])).toBeCloseTo(padding, -2)
    expect(limits.maxHeight).toBe(config.cameraLimits.maxHeightMeters)
  })

  it('falls back to the whole globe for a network without routes', () => {
    const limits = networkCameraLimits({ lines: [] } as never, PADDING_M, MAX_HEIGHT_M)
    expect(toDegrees(limits.west)).toBe(-180)
    expect(toDegrees(limits.east)).toBe(180)
    expect(limits.maxHeight).toBe(MAX_HEIGHT_M)
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
