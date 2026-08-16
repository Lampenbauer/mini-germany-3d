/**
 * Polyline simplification for the network data pipeline.
 *
 * Douglas–Peucker in a local metric approximation (meters): at a tolerance
 * well below the rendered line width the route geometry stays visually
 * identical while the point count – and with it bundle size and startup
 * work (cumulative distances, stop projection) – drops considerably.
 */

/** Default tolerance in meters (far below visibility for 5-px route lines). */
export const DEFAULT_TOLERANCE_M = 0.3

const METERS_PER_DEG_LAT = 110540

/**
 * Douglas–Peucker on [lon, lat] pairs with a tolerance in meters.
 * Endpoints are always kept; the input is not mutated.
 */
export function simplifyPath(path, toleranceMeters = DEFAULT_TOLERANCE_M) {
  if (path.length <= 2) return [...path]
  const mx = METERS_PER_DEG_LAT * Math.cos((path[0][1] * Math.PI) / 180)
  const my = METERS_PER_DEG_LAT
  const tolSq = toleranceMeters * toleranceMeters

  const keep = new Uint8Array(path.length)
  keep[0] = 1
  keep[path.length - 1] = 1
  const stack = [[0, path.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    const ax = path[a][0] * mx
    const ay = path[a][1] * my
    const dx = path[b][0] * mx - ax
    const dy = path[b][1] * my - ay
    const lenSq = dx * dx + dy * dy

    let maxDistSq = -1
    let maxIndex = -1
    for (let i = a + 1; i < b; i++) {
      const px = path[i][0] * mx - ax
      const py = path[i][1] * my - ay
      let t = lenSq > 0 ? (px * dx + py * dy) / lenSq : 0
      t = Math.min(1, Math.max(0, t))
      const ex = px - t * dx
      const ey = py - t * dy
      const distSq = ex * ex + ey * ey
      if (distSq > maxDistSq) {
        maxDistSq = distSq
        maxIndex = i
      }
    }
    if (maxDistSq > tolSq) {
      keep[maxIndex] = 1
      stack.push([a, maxIndex], [maxIndex, b])
    }
  }
  return path.filter((_, i) => keep[i] === 1)
}

/** Rounds [lon, lat] to 6 decimal places (~11 cm) and drops consecutive duplicates. */
export function roundAndDedupePath(path) {
  const out = []
  for (const [lon, lat] of path) {
    const p = [Number(lon.toFixed(6)), Number(lat.toFixed(6))]
    const prev = out[out.length - 1]
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue
    out.push(p)
  }
  return out
}

/** simplifyPath + roundAndDedupePath in the order intended for the pipeline. */
export function compactPath(path, toleranceMeters = DEFAULT_TOLERANCE_M) {
  return roundAndDedupePath(simplifyPath(path, toleranceMeters))
}
