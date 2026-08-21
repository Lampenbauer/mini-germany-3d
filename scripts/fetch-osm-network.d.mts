/** Type declarations so stitchWays can be unit-tested from Vitest. */

export interface StitchedWayPath {
  path: number[][]
  segUnderground: boolean[]
  segBridge: boolean[]
}

export function stitchWays(
  ways: { ref: number }[],
  wayById: Map<number, { nodes?: number[]; tags?: Record<string, string | undefined> }>,
  nodeById: Map<number, { lon: number; lat: number }>,
  label: string,
): StitchedWayPath

export function clipPathAt(
  path: number[][],
  cum: readonly number[],
  cutDist: number,
  keep: 'before' | 'after',
  ranges?: readonly (readonly [number, number])[],
): { path: number[][]; ranges: [number, number][] }
