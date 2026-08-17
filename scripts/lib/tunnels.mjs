/**
 * Tunnel/underground detection for the OSM data pipeline.
 *
 * The route relations fetched from Overpass already contain their member
 * ways including tags ("out body"), so no extra query is needed: a way is
 * considered underground when OSM tags it as a tunnel, with
 * location=underground, or with a negative layer – the same criteria as
 * the classic Overpass tunnel query
 *   way["railway"](if tunnel=yes / location=underground / layer~"^-[1-9]").
 */

/** true if the OSM way runs through a tunnel or underground. */
export function isUndergroundWay(way) {
  const tags = way?.tags
  if (!tags) return false
  if (tags.tunnel && tags.tunnel !== 'no') return true
  if (tags.location === 'underground') return true
  if (/^-[1-9]/.test(String(tags.layer ?? ''))) return true
  return false
}

/**
 * Converts per-segment underground flags into [start, end] meter ranges
 * along the path. `segFlags[i]` describes the segment between path point i
 * and i+1; `cum` are the cumulative distances (length = segFlags.length + 1).
 *
 * Short above-ground gaps between two tunnel sections (e.g. a single
 * mis-tagged portal way) are merged, and mini "tunnels" below the minimum
 * length are dropped – both avoid visible flicker when a vehicle would
 * otherwise fade in and out within a second.
 */
export function tunnelRangesFromSegments(segFlags, cum, opts = {}) {
  const mergeGap = opts.mergeGapMeters ?? 20
  const minLength = opts.minLengthMeters ?? 15

  const ranges = []
  let start = null
  for (let i = 0; i < segFlags.length; i++) {
    if (segFlags[i] && start === null) start = cum[i]
    if (!segFlags[i] && start !== null) {
      ranges.push([start, cum[i]])
      start = null
    }
  }
  if (start !== null) ranges.push([start, cum[segFlags.length]])

  const merged = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] - last[1] <= mergeGap) last[1] = range[1]
    else merged.push([...range])
  }

  return merged
    .filter(([s, e]) => e - s >= minLength)
    .map(([s, e]) => [Math.round(s * 10) / 10, Math.round(e * 10) / 10])
}
