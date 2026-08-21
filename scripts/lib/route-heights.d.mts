/** Type declarations so the height helpers can be unit-tested from Vitest. */

export function haversineMeters(a: readonly number[], b: readonly number[]): number

export function cumulativeDistances(path: readonly (readonly number[])[]): number[]

export function fillHeightGaps(
  heights: (number | undefined)[],
  cum: readonly number[],
): number

export function heightAtDistance(
  heights: readonly number[],
  cum: readonly number[],
  d: number,
): number

export function normalizeRanges(
  raw: readonly (readonly number[])[] | undefined,
  totalLength: number,
): [number, number][]

export function applyBridgeProfile(
  heights: number[],
  cum: readonly number[],
  bridgeRanges: readonly (readonly [number, number])[],
): void

export function indexPreviousHeights(prevNetwork: unknown): {
  heightsByPath: Map<string, number[]>
  nhnByStop: Map<string, number>
}
