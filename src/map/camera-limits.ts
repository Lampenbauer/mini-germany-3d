/**
 * The camera leash: which area the camera may be in and how far it may
 * zoom out. The area is the bounding box of all route paths widened by a
 * fixed padding, the ceiling a maximum height above the ellipsoid.
 *
 * Deliberately free of Cesium – the rule is plain geometry and is unit
 * tested as such; CesiumMap only wires it into the render loop.
 */

import { toRadians } from '@/lib/geo'
import type { PreparedNetwork } from '@/data/network-types'

/**
 * Mean length of a degree of latitude on WGS84 (110.57 km at the equator,
 * 111.69 km at the pole). A fence does not care about the ~0.5 % spread.
 */
const METERS_PER_DEGREE_LATITUDE = 111_132

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

/**
 * Fence around the network: the bounding box of every route path, widened
 * by `paddingMeters` on all four sides. The longitude padding is converted
 * at the padded box's outermost latitude, so the fence is at least that
 * wide everywhere inside it – meridians converge toward the poles.
 *
 * A network without any path (nothing to fence in) yields the whole globe;
 * the height ceiling still applies.
 */
export function networkCameraLimits(
  network: PreparedNetwork,
  paddingMeters: number,
  maxHeightMeters: number,
): CameraLimits {
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const line of network.lines) {
    for (const direction of line.directions) {
      for (const [lon, lat] of direction.path) {
        if (lon < west) west = lon
        if (lon > east) east = lon
        if (lat < south) south = lat
        if (lat > north) north = lat
      }
    }
  }
  if (!Number.isFinite(west)) {
    return {
      west: toRadians(-180),
      south: toRadians(-90),
      east: toRadians(180),
      north: toRadians(90),
      maxHeight: maxHeightMeters,
    }
  }

  const latPadding = paddingMeters / METERS_PER_DEGREE_LATITUDE
  const outermostLat = Math.min(89, Math.max(Math.abs(south), Math.abs(north)) + latPadding)
  const lonPadding = latPadding / Math.cos(toRadians(outermostLat))
  return {
    west: toRadians(Math.max(-180, west - lonPadding)),
    south: toRadians(Math.max(-90, south - latPadding)),
    east: toRadians(Math.min(180, east + lonPadding)),
    north: toRadians(Math.min(90, north + latPadding)),
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
