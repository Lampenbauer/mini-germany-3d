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

export interface BridgeProfileOptions {
  anchorSetbackMeters?: number
  deckClearanceMeters?: number
  portalFeatherMeters?: number
}

export const BRIDGE_PROFILE_DEFAULTS: Required<BridgeProfileOptions>

export function applyBridgeProfile(
  heights: number[],
  cum: readonly number[],
  bridgeRanges: readonly (readonly [number, number])[],
  opts?: BridgeProfileOptions,
): void

export function sameTerrainSource(prev: unknown, attribution: string): boolean

export function withTerrainAttribution<M extends { attribution?: string; terrainAttribution?: string }>(
  meta: M,
  line: string,
): M & { attribution: string; terrainAttribution: string }

/** A direction's heights as written before, keyed by its path before densification. */
export interface PreviousHeights {
  path: number[][]
  heights: number[]
  inserted: number[]
}

export function indexPreviousHeights(prevNetwork: unknown): {
  heightsByPath: Map<string, PreviousHeights>
  nhnByStop: Map<string, number>
}

export function removeInserted<P>(path: readonly P[], inserted: readonly number[] | undefined): P[]

export interface DensifyOptions {
  toleranceMeters?: number
  minSegmentMeters?: number
  maxDepth?: number
}

export const DENSIFY_DEFAULTS: Required<DensifyOptions>

export function densifyByHeight(
  path: readonly (readonly [number, number])[],
  heights: readonly number[],
  sampleAt: (lon: number, lat: number) => Promise<number | undefined>,
  bridges?: readonly (readonly number[])[],
  options?: DensifyOptions,
): Promise<{ path: [number, number][]; heights: number[]; inserted: number[] }>
