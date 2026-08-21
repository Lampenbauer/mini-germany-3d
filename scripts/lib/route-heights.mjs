/**
 * Pure helpers for deriving per-vertex route heights from terrain samples:
 * gap filling where the DGM has no data (water, coverage edges) and bridge
 * interpolation (the DGM is a bare-earth model – under a bridge it dips to
 * the valley/water surface, so bridge sections get a straight deck
 * interpolated between the terrain heights at both bridge ends).
 */

export function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371008.8
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function cumulativeDistances(path) {
  const cum = [0]
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(path[i - 1], path[i]))
  }
  return cum
}

/**
 * Replaces undefined entries by linear interpolation between the nearest
 * valid neighbors (by distance along the path); runs at the ends are
 * extended flat. Returns the number of filled entries, or -1 if no entry
 * was valid at all (the caller should then drop the whole array).
 * Mutates `heights` in place.
 */
export function fillHeightGaps(heights, cum) {
  const valid = []
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] !== undefined && Number.isFinite(heights[i])) valid.push(i)
  }
  if (valid.length === 0) return -1
  let filled = 0
  let nextValid = 0
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] !== undefined && Number.isFinite(heights[i])) continue
    while (nextValid < valid.length && valid[nextValid] < i) nextValid++
    const after = valid[nextValid]
    const before = valid[nextValid - 1]
    if (before === undefined) heights[i] = heights[after]
    else if (after === undefined) heights[i] = heights[before]
    else {
      const t = (cum[i] - cum[before]) / (cum[after] - cum[before] || 1)
      heights[i] = heights[before] + (heights[after] - heights[before]) * t
    }
    filled++
  }
  return filled
}

/** Height at distance `d` along the path, linearly interpolated. */
export function heightAtDistance(heights, cum, d) {
  if (d <= cum[0]) return heights[0]
  const last = cum.length - 1
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

/** Sorts, clamps, and merges raw [start, end] meter ranges (like tunnels). */
export function normalizeRanges(raw, totalLength) {
  if (!raw || raw.length === 0 || !(totalLength > 0)) return []
  const clamped = []
  for (const range of raw) {
    if (!Array.isArray(range) || range.length < 2) continue
    const start = Math.max(0, Math.min(totalLength, Number(range[0])))
    const end = Math.max(0, Math.min(totalLength, Number(range[1])))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= 0) continue
    clamped.push([start, end])
  }
  clamped.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of clamped) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push(range)
  }
  return merged
}

/**
 * Index over a previously enriched network.json for height reuse: terrain
 * never changes, so a direction whose path is identical to the previous
 * run keeps its heights without any WCS request, and a stop keeps its
 * `nhn` as long as its coordinate is unchanged. Directions are keyed by
 * their full path geometry (not by line id) – renamed or renumbered lines
 * still reuse, while any geometry change forces a fresh sample.
 */
export function indexPreviousHeights(prevNetwork) {
  const heightsByPath = new Map()
  const nhnByStop = new Map()
  if (!prevNetwork || typeof prevNetwork !== 'object') return { heightsByPath, nhnByStop }
  for (const line of prevNetwork.lines ?? []) {
    for (const dir of line.directions ?? []) {
      if (dir.heights && dir.path && dir.heights.length === dir.path.length) {
        heightsByPath.set(JSON.stringify(dir.path), dir.heights)
      }
    }
  }
  for (const [id, stop] of Object.entries(prevNetwork.stops ?? {})) {
    if (stop.nhn !== undefined && stop.coord) {
      nhnByStop.set(`${id}:${stop.coord[0]}:${stop.coord[1]}`, stop.nhn)
    }
  }
  return { heightsByPath, nhnByStop }
}

/**
 * Straightens the height profile across each bridge range: every vertex
 * whose distance falls inside [start, end] gets the linear interpolation
 * between the terrain heights at the two bridge ends. Mutates `heights`
 * in place.
 */
export function applyBridgeProfile(heights, cum, bridgeRanges) {
  for (const [start, end] of bridgeRanges) {
    const h0 = heightAtDistance(heights, cum, start)
    const h1 = heightAtDistance(heights, cum, end)
    for (let i = 0; i < heights.length; i++) {
      if (cum[i] <= start || cum[i] >= end) continue
      const t = (cum[i] - start) / (end - start)
      heights[i] = h0 + (h1 - h0) * t
    }
  }
}
