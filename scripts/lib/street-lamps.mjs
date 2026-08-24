/**
 * Picks the street lamps that light the transit routes: everything from
 * OSM that stands close enough to a route path, thinned out to a minimum
 * spacing so the runtime draws light pools, not a solid carpet.
 *
 * Pure geometry (no I/O) so scripts/fetch-street-lamps.mjs stays a thin
 * fetch-and-write wrapper and this part is unit tested.
 */

const METERS_PER_DEGREE_LATITUDE = 111_132
const METERS_PER_DEGREE_LONGITUDE_EQUATOR = 111_320

/** Local metric scale [x, y] meters per degree at a latitude. */
function metersPerDegree(lat) {
  return [
    METERS_PER_DEGREE_LONGITUDE_EQUATOR * Math.cos((lat * Math.PI) / 180),
    METERS_PER_DEGREE_LATITUDE,
  ]
}

/** Squared distance in meters² from p to the segment a→b. */
function distanceToSegmentSq(p, a, b, mx, my) {
  const px = (p[0] - a[0]) * mx
  const py = (p[1] - a[1]) * my
  const bx = (b[0] - a[0]) * mx
  const by = (b[1] - a[1]) * my
  const lenSq = bx * bx + by * by
  const t = lenSq > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / lenSq)) : 0
  const dx = px - t * bx
  const dy = py - t * by
  return dx * dx + dy * dy
}

/**
 * Route segments of a network, with the meter range each one covers along
 * its direction – excluded ranges (bridges, tunnels) drop out here, so a
 * lamp is never matched against a stretch whose height profile is not the
 * terrain the lamp stands on.
 */
export function routeSegments(network, { excludeRanges = true } = {}) {
  const segments = []
  for (const line of network.lines ?? []) {
    // Ferries run over water – no street lamps out there.
    if (line.mode === 'ferry') continue
    for (const dir of line.directions ?? []) {
      const path = dir.path ?? []
      if (path.length < 2) continue
      const skip = excludeRanges ? [...(dir.bridges ?? []), ...(dir.tunnels ?? [])] : []
      let along = 0
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i]
        const b = path[i + 1]
        const [mx, my] = metersPerDegree(a[1])
        const length = Math.hypot((b[0] - a[0]) * mx, (b[1] - a[1]) * my)
        const start = along
        along += length
        // A segment that touches a bridge or tunnel is dropped whole: its
        // terrain height is the deck or the surface above the tube, not
        // the ground a lamp beside it stands on.
        if (skip.some(([from, to]) => start < to && along > from)) continue
        segments.push([a, b, mx, my])
      }
    }
  }
  return segments
}

/** Grid index over the segments; cell size in degrees of latitude. */
function indexSegments(segments, cellDegrees) {
  const grid = new Map()
  for (const seg of segments) {
    const [a, b] = seg
    const ix0 = Math.floor(Math.min(a[0], b[0]) / cellDegrees)
    const ix1 = Math.floor(Math.max(a[0], b[0]) / cellDegrees)
    const iy0 = Math.floor(Math.min(a[1], b[1]) / cellDegrees)
    const iy1 = Math.floor(Math.max(a[1], b[1]) / cellDegrees)
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const key = `${ix}:${iy}`
        let cell = grid.get(key)
        if (!cell) grid.set(key, (cell = []))
        cell.push(seg)
      }
    }
  }
  return grid
}

/**
 * The lamps standing within `maxDistanceMeters` of a route, thinned to
 * `minSpacingMeters` between two kept lamps.
 *
 * The thinning is deliberately order-dependent on the input: Overpass
 * returns nodes sorted by quadtree tile (`out skel qt;`), so neighbors
 * arrive next to each other and the kept lamps end up evenly spread
 * instead of clustered at the start of the list.
 *
 * @param lamps [lon, lat] pairs
 * @param network the prepared network.json
 * @returns the kept [lon, lat] pairs, in input order
 */
export function selectLampsAlongRoutes(
  lamps,
  network,
  { maxDistanceMeters = 25, minSpacingMeters = 0 } = {},
) {
  const segments = routeSegments(network)
  if (segments.length === 0) return []
  // One cell per ~110 m, and the search widens by the lamp radius.
  const cellDegrees = 0.001
  const grid = indexSegments(segments, cellDegrees)
  const reach = Math.ceil(maxDistanceMeters / 100)
  const maxDistSq = maxDistanceMeters * maxDistanceMeters

  // Second grid for the thinning, sized so two lamps closer than the
  // spacing always share a cell or touch neighboring ones.
  const spacingCell = minSpacingMeters > 0 ? minSpacingMeters / METERS_PER_DEGREE_LATITUDE : 0
  const kept = []
  const keptGrid = new Map()
  const minSpacingSq = minSpacingMeters * minSpacingMeters

  for (const lamp of lamps) {
    const ix0 = Math.floor(lamp[0] / cellDegrees)
    const iy0 = Math.floor(lamp[1] / cellDegrees)
    let near = false
    for (let ix = ix0 - reach; ix <= ix0 + reach && !near; ix++) {
      for (let iy = iy0 - reach; iy <= iy0 + reach && !near; iy++) {
        for (const [a, b, mx, my] of grid.get(`${ix}:${iy}`) ?? []) {
          if (distanceToSegmentSq(lamp, a, b, mx, my) <= maxDistSq) {
            near = true
            break
          }
        }
      }
    }
    if (!near) continue

    if (minSpacingMeters > 0) {
      const [mx, my] = metersPerDegree(lamp[1])
      const jx0 = Math.floor(lamp[0] / spacingCell)
      const jy0 = Math.floor(lamp[1] / spacingCell)
      let crowded = false
      for (let jx = jx0 - 1; jx <= jx0 + 1 && !crowded; jx++) {
        for (let jy = jy0 - 1; jy <= jy0 + 1 && !crowded; jy++) {
          for (const other of keptGrid.get(`${jx}:${jy}`) ?? []) {
            const dx = (lamp[0] - other[0]) * mx
            const dy = (lamp[1] - other[1]) * my
            if (dx * dx + dy * dy < minSpacingSq) {
              crowded = true
              break
            }
          }
        }
      }
      if (crowded) continue
      const key = `${jx0}:${jy0}`
      let cell = keptGrid.get(key)
      if (!cell) keptGrid.set(key, (cell = []))
      cell.push(lamp)
    }
    kept.push(lamp)
  }
  return kept
}
