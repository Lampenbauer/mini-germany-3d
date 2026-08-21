/** Type declarations so the pipeline helpers can be unit-tested from Vitest. */

export interface OsmWayLike {
  tags?: Record<string, string | undefined>
}

export function isUndergroundWay(way: OsmWayLike | null | undefined): boolean

export function isBridgeWay(way: OsmWayLike | null | undefined): boolean

export function tunnelRangesFromSegments(
  segFlags: readonly boolean[],
  cum: readonly number[],
  opts?: { mergeGapMeters?: number; minLengthMeters?: number },
): [number, number][]
