/** Type declarations so the lamp selection can be unit-tested from Vitest. */

export type LonLat = [number, number]

export interface LampNetwork {
  lines: {
    mode?: string
    directions: {
      path: LonLat[]
      bridges?: [number, number][]
      tunnels?: [number, number][]
    }[]
  }[]
}

export function routeSegments(
  network: LampNetwork,
  opts?: { excludeRanges?: boolean },
): [LonLat, LonLat, number, number][]

export function selectLampsAlongRoutes(
  lamps: LonLat[],
  network: LampNetwork,
  opts?: { maxDistanceMeters?: number; minSpacingMeters?: number },
): LonLat[]
