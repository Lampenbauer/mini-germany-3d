/**
 * Smoothed street-height reference along a line direction.
 *
 * tileset.getHeight() measures the TOP surface of the photorealistic tiles –
 * over tree-lined streets that is the canopy, not the road, so raw samples
 * make routes drape over trees and vehicles bob up and down. The stops,
 * however, are measured precisely (sampleHeightMostDetailed) and platforms
 * are almost always open sky. Interpolating between the stop heights of a
 * direction therefore gives a stable street-level baseline; live samples are
 * clamped against it.
 */

export interface ProfileAnchor {
  /** Along-route distance of the stop in meters. */
  dist: number
  /** Measured ellipsoidal ground height in meters. */
  height: number
}

/**
 * A live sample may exceed the baseline by this much before it is treated
 * as canopy/roof contamination. Generous enough for real local rises
 * (bridge decks between their approach stops), tight enough to reject
 * street trees (crowns start ~5 m above ground).
 */
export const CANOPY_CLEARANCE = 4

/**
 * How far below the baseline a sample may go – underpasses genuinely dip
 * below the interpolated stop line; holes in not-yet-loaded tiles do not
 * get to pull vehicles underground indefinitely.
 */
export const UNDERPASS_ALLOWANCE = 12

/**
 * A stop anchor this far above BOTH neighbors is itself canopy. Compared
 * against the higher neighbor (not their connecting line) so real hill
 * crests survive: a crest tops its neighbors by a few meters, a tree over
 * the platform by 8–15 m.
 */
const ANCHOR_OUTLIER_THRESHOLD = 6

/**
 * Builds the anchor list for one direction from its stops (sorted by dist).
 * Stops without a measured height are skipped; interior anchors well above
 * both neighbors are dropped (stop under a tree).
 */
export function buildProfile(
  stops: readonly { dist: number; height: number | undefined }[],
): ProfileAnchor[] {
  const known: ProfileAnchor[] = []
  for (const s of stops) {
    if (s.height !== undefined) known.push({ dist: s.dist, height: s.height })
  }
  if (known.length < 3) return known
  return known.filter((a, i) => {
    if (i === 0 || i === known.length - 1) return true
    const higherNeighbor = Math.max(known[i - 1].height, known[i + 1].height)
    return a.height <= higherNeighbor + ANCHOR_OUTLIER_THRESHOLD
  })
}

/** Baseline height at an along-route distance (clamped to the anchor range). */
export function profileHeightAt(
  anchors: readonly ProfileAnchor[],
  dist: number,
): number | undefined {
  if (anchors.length === 0) return undefined
  if (dist <= anchors[0].dist) return anchors[0].height
  const last = anchors[anchors.length - 1]
  if (dist >= last.dist) return last.height
  // Binary search for the segment containing dist
  let lo = 0
  let hi = anchors.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (anchors[mid].dist <= dist) lo = mid
    else hi = mid
  }
  const a = anchors[lo]
  const b = anchors[hi]
  const t = (dist - a.dist) / (b.dist - a.dist || 1)
  return a.height + (b.height - a.height) * t
}

/**
 * Clamps a raw tile-surface sample against the baseline: canopy spikes are
 * capped, moderate dips (underpasses) pass through. Without a baseline the
 * sample is returned unchanged.
 */
export function clampToProfile(sampled: number, baseline: number | undefined): number {
  if (baseline === undefined) return sampled
  return Math.max(Math.min(sampled, baseline + CANOPY_CLEARANCE), baseline - UNDERPASS_ALLOWANCE)
}
