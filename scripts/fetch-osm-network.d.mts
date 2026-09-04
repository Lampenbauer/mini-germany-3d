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

export function nearestOnPath(
  path: readonly (readonly number[])[],
  cum: readonly number[],
  p: readonly number[],
  opts?: { firstPass?: boolean },
): { along: number; offsetMeters: number }

export interface FixedLineStopNode {
  node: { id?: number; lon: number; lat: number; tags?: Record<string, string> }
  name?: string
}

export function boundToFixedLine(
  path: number[][],
  cum: number[],
  stopNodes: FixedLineStopNode[],
  fixed: { from?: string; to?: string },
  tunnels: [number, number][],
  bridges: [number, number][],
): { path: number[][]; tunnels: [number, number][]; bridges: [number, number][]; stopNodes: FixedLineStopNode[] } | null

export const NAME_INHERIT_RADIUS: number

export function inheritUnnamedStopNames(
  stops: Record<string, { name: string; coord: [number, number] | number[] }>,
): void

export function fetchStopAreaNames(osmNodeIds: number[]): Promise<Map<number, string>>
