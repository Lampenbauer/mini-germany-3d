/**
 * The camera leash: which area the camera may be in and how far it may
 * zoom out. The area is the Rostock bounding box – the city limits widened
 * by 15 km, the same rectangle the data pipeline and the AIS subscription
 * use (see lib/rostock-bounding-box.ts) – the ceiling a maximum height
 * above the ellipsoid.
 *
 * Deliberately free of Cesium – the rule is plain geometry and is unit
 * tested as such; CesiumMap only wires it into the render loop.
 */

import { toRadians } from '@/lib/geo'
import type { BoundingBox } from '@/lib/rostock-bounding-box'

/**
 * Tolerance for "already inside": a clamped pose travels through a
 * Cartesian3 and back before it is checked again, and correcting those
 * last bits every frame would keep the camera – and the URL persistence
 * that follows it – permanently busy. 1e-9 rad is about 6 mm.
 */
const ANGLE_TOLERANCE_RADIANS = 1e-9
const HEIGHT_TOLERANCE_METERS = 0.01

/** Allowed camera area in radians, plus the height ceiling in meters. */
export interface CameraLimits {
  west: number
  south: number
  east: number
  north: number
  maxHeight: number
}

/** Camera position: longitude/latitude in radians, height in meters. */
export interface CameraPose {
  longitude: number
  latitude: number
  height: number
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** The fence: `box` (degrees) as radians, plus the height ceiling. */
export function boundingBoxCameraLimits(box: BoundingBox, maxHeightMeters: number): CameraLimits {
  return {
    west: toRadians(box.west),
    south: toRadians(box.south),
    east: toRadians(box.east),
    north: toRadians(box.north),
    maxHeight: maxHeightMeters,
  }
}

/**
 * Pulls a camera pose back inside the limits – or null when it is already
 * there (within the tolerances above), which is the normal case and must
 * stay free of side effects.
 */
export function clampCameraPose(pose: CameraPose, limits: CameraLimits): CameraPose | null {
  const longitude = clamp(pose.longitude, limits.west, limits.east)
  const latitude = clamp(pose.latitude, limits.south, limits.north)
  const height = Math.min(pose.height, limits.maxHeight)
  if (
    Math.abs(longitude - pose.longitude) < ANGLE_TOLERANCE_RADIANS &&
    Math.abs(latitude - pose.latitude) < ANGLE_TOLERANCE_RADIANS &&
    pose.height - height < HEIGHT_TOLERANCE_METERS
  ) {
    return null
  }
  return { longitude, latitude, height }
}
