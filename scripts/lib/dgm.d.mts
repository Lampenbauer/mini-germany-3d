/** Type declarations so the DGM helpers can be unit-tested from Vitest. */

export interface DgmTile {
  width: number
  height: number
  data: Float32Array
  originX: number
  originY: number
  scaleX: number
  scaleY: number
}

export function lonLatToUtm(lon: number, lat: number, crs?: string): [number, number]

export function lonLatToUtm33(lon: number, lat: number): [number, number]

export function parseFloat32Tiff(buf: Uint8Array): DgmTile

export function sampleTile(tile: DgmTile, x: number, y: number): number | undefined

export class DgmSampler {
  constructor(opts?: {
    endpoint?: string
    coverageId?: string
    crs?: string
    tileSizeMeters?: number
    marginMeters?: number
    fetchImpl?: typeof fetch
  })
  heightAt(lon: number, lat: number): Promise<number | undefined>
  stats: { tiles: number; bytes: number; failedTiles: number }
}
