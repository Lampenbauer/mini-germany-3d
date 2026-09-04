/** Type declarations so the XYZ terrain sampler can be unit-tested from Vitest. */

export interface XyzTileCorner {
  east: number
  north: number
}

export interface XyzTile {
  corner: XyzTileCorner
  width: number
  gridMeters: number
  values: Float32Array
  points: number
}

export function tileCornerFromName(name: string): XyzTileCorner | null

export function parseXyzTile(
  text: string,
  corner: XyzTileCorner,
  tileSizeMeters: number,
  gridMeters: number,
): XyzTile

export function sampleXyzTile(tile: XyzTile, x: number, y: number): number | undefined

export class XyzZipSampler {
  constructor(opts: {
    url: string
    cacheFile: string
    crs?: string
    tileSizeMeters?: number
    gridMeters?: number
    fetchImpl?: typeof fetch
  })
  heightAt(lon: number, lat: number): Promise<number | undefined>
  stats: { tiles: number; bytes: number; failedTiles: number }
}
