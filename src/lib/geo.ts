/**
 * Geodesic helper functions for movement along polylines.
 * All coordinates are [longitude, latitude] in degrees (WGS84).
 */

export type LonLat = [number, number]

const EARTH_RADIUS_M = 6371008.8

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI
}

/** Great-circle distance (haversine) in meters. */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a
  const [lon2, lat2] = b
  const φ1 = toRadians(lat1)
  const φ2 = toRadians(lat2)
  const dφ = toRadians(lat2 - lat1)
  const dλ = toRadians(lon2 - lon1)
  const h =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * The point `eastMeters` east and `northMeters` north of `a` (negative
 * values go west and south). Flat-earth arithmetic on the local degree
 * lengths – exact to well under a meter over the few kilometers this is
 * used for.
 */
export function offsetLonLat(a: LonLat, eastMeters: number, northMeters: number): LonLat {
  const metersPerDegree = toRadians(1) * EARTH_RADIUS_M
  return [
    a[0] + eastMeters / (metersPerDegree * Math.cos(toRadians(a[1]))),
    a[1] + northMeters / metersPerDegree,
  ]
}

/** Initial bearing from a to b in degrees (0° = north, clockwise). */
export function bearingDegrees(a: LonLat, b: LonLat): number {
  const φ1 = toRadians(a[1])
  const φ2 = toRadians(b[1])
  const dλ = toRadians(b[0] - a[0])
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (toDegrees(Math.atan2(y, x)) + 360) % 360
}

/** Cumulative distances along a polyline; length = path.length. */
export function cumulativeDistances(path: LonLat[]): number[] {
  const cum: number[] = new Array(path.length)
  cum[0] = 0
  for (let i = 1; i < path.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(path[i - 1], path[i])
  }
  return cum
}

export interface PathSample {
  lon: number
  lat: number
  /** Direction of travel at this point in degrees (0° = north). */
  bearing: number
}

/**
 * Point (and direction of travel) at distance `d` along the polyline.
 * `d` is clamped to [0, total length]. Linear interpolation is entirely
 * sufficient at city scale (segments < 1 km).
 */
export function sampleAtDistance(path: LonLat[], cum: number[], d: number): PathSample {
  const total = cum[cum.length - 1]
  const dist = Math.min(Math.max(d, 0), total)

  // Binary search for the segment with cum[i] <= dist <= cum[i+1]
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= dist) lo = mid
    else hi = mid
  }

  const segLen = cum[hi] - cum[lo]
  const t = segLen > 0 ? (dist - cum[lo]) / segLen : 0
  const a = path[lo]
  const b = path[hi]
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    bearing: bearingDegrees(a, b),
  }
}

/**
 * Height at distance `d` along a path with per-vertex heights (linear
 * interpolation, `d` clamped to [0, total]). `heights` and `cum` must be
 * parallel to the same path.
 */
export function heightAtDistance(
  heights: readonly number[],
  cum: readonly number[],
  d: number,
): number {
  const last = cum.length - 1
  if (d <= cum[0]) return heights[0]
  if (d >= cum[last]) return heights[last]
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= d) lo = mid
    else hi = mid
  }
  const span = cum[hi] - cum[lo]
  const t = span > 0 ? (d - cum[lo]) / span : 0
  return heights[lo] + (heights[hi] - heights[lo]) * t
}

/**
 * Distance along the polyline to the foot of the projection of `p`.
 * Uses a local equirectangular approximation per segment – more than
 * accurate enough for matching stops onto the route.
 *
 * `fromDist` (meters) restricts the search to the part of the route from
 * that distance onward: for lines that travel the same stretch of road
 * multiple times (loops), the global projection is ambiguous – stops are
 * therefore projected sequentially, each one only past its predecessor.
 */
export function projectOntoPath(
  path: LonLat[],
  cum: number[],
  p: LonLat,
  fromDist = 0,
): number {
  let bestDist = Infinity
  let bestAlong = fromDist
  const cosLat = Math.cos(toRadians(p[1]))

  for (let i = 0; i < path.length - 1; i++) {
    if (cum[i + 1] <= fromDist) continue // segment lies entirely before fromDist
    const a = path[i]
    const b = path[i + 1]
    // Local metric coordinates (meters) relative to a
    const ax = 0
    const ay = 0
    const bx = (b[0] - a[0]) * cosLat * 111320
    const by = (b[1] - a[1]) * 110540
    const px = (p[0] - a[0]) * cosLat * 111320
    const py = (p[1] - a[1]) * 110540

    const segLenSq = (bx - ax) ** 2 + (by - ay) ** 2
    let t = 0
    if (segLenSq > 0) {
      t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / segLenSq
      t = Math.min(1, Math.max(0, t))
    }
    const cx = ax + t * (bx - ax)
    const cy = ay + t * (by - ay)
    const dSq = (px - cx) ** 2 + (py - cy) ** 2
    if (dSq < bestDist) {
      bestDist = dSq
      // Scale proportionally to the (haversine-computed) segment length so
      // the result is consistent with `cum`. Never land before fromDist
      // (the projection foot can lie in the partially cut-off segment before it).
      bestAlong = Math.max(fromDist, cum[i] + (cum[i + 1] - cum[i]) * t)
    }
  }
  return bestAlong
}
