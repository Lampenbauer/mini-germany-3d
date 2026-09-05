/** Type declarations so the terrain sampler can be unit-tested from Vitest. */

export const TILE_URL: string
export const TILE_SIZE: number
export const DEFAULT_ZOOM: number
export const MIN_ZOOM: number
export const DEFAULT_ATTRIBUTION: string

export function terrariumHeight(r: number, g: number, b: number): number

export function lonLatToPixel(lon: number, lat: number, zoom: number): [number, number]

export function heightsFromPixels(pixels: ArrayLike<number>, channels: number): Float32Array

export interface TerrainStats {
  tiles: number
  bytes: number
  failedTiles: number
  /** Tiles read from the city folder instead of the server. */
  localTiles: number
}

/** The part of a fetch Response the sampler reads. */
export interface TileResponse {
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export class MapterhornSampler {
  constructor(opts?: {
    zoom?: number
    minZoom?: number
    urlTemplate?: string
    localDir?: string
    maxDecodedTiles?: number
    retryDelayMs?: number
    fetchImpl?: (url: string, init?: RequestInit) => Promise<TileResponse>
    decodeImpl?: (bytes: Uint8Array) => Promise<Float32Array> | Float32Array
  })
  zoom: number
  label: string
  stats: TerrainStats
  heightAt(lon: number, lat: number): Promise<number | undefined>
}

export function createTerrainSampler(city: { slug: string; terrain: { zoom: number } }): MapterhornSampler

export function terrainAttribution(city: { terrain: { attribution?: string } }): string

export function terrainSummary(sampler: MapterhornSampler): string
