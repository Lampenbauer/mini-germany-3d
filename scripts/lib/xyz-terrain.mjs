/**
 * Terrain sampling from a downloadable DGM: a zip of ASCII XYZ tiles, the
 * way Hamburg publishes its terrain models (Transparenzportal, dl-de/by-2-0)
 * – 2 km × 2 km tiles named after their south-west corner in kilometers,
 * one "easting northing height" line per grid cell center, cells missing
 * where the tile reaches past the state border.
 *
 * The archive is downloaded once into scripts/.cache and tiles are
 * inflated one at a time as points ask for them, so a run that needs a
 * few tiles along the routes never unpacks the whole city. Point queries
 * are answered by bilinear interpolation over the four surrounding cell
 * centers, falling back to the nearest valid one where the grid has a
 * hole or the point sits on a tile edge – at 10 m spacing that is a
 * difference nobody sees under a light pool.
 *
 * Same interface as DgmSampler (dgm.mjs): heightAt(lon, lat) and stats.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { lonLatToUtm } from './dgm.mjs'

const REQUEST_HEADERS = {
  'User-Agent':
    'mini-germany-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-germany-3d)',
}

/**
 * South-west corner of a tile from its file name – "DGM10_32548_5934_2_FHH.xyz"
 * is the tile at easting 548 km, northing 5934 km in UTM zone 32 (the
 * leading "32" is the zone). Returns null for anything else in the zip.
 */
export function tileCornerFromName(name) {
  const match = /(?:^|\/)[A-Za-z0-9]+_(\d{2})(\d{3})_(\d{4})_\d+_[A-Za-z]+\.xyz$/i.exec(name)
  if (!match) return null
  return { east: Number(match[2]) * 1000, north: Number(match[3]) * 1000 }
}

/**
 * Parses one XYZ tile into a dense grid: `values[iy * width + ix]` is the
 * height at the cell center (east0 + ix·grid + grid/2, north0 + iy·grid + grid/2),
 * NaN where the tile has no point. Whitespace-separated, decimal point,
 * comment or header lines skipped.
 */
export function parseXyzTile(text, corner, tileSizeMeters, gridMeters) {
  const width = Math.round(tileSizeMeters / gridMeters)
  const values = new Float32Array(width * width).fill(Number.NaN)
  const half = gridMeters / 2
  let points = 0
  for (const line of text.split('\n')) {
    if (line.length < 5) continue
    const parts = line.trim().split(/[\s;,]+/)
    if (parts.length < 3) continue
    const x = Number(parts[0])
    const y = Number(parts[1])
    const z = Number(parts[2])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const ix = Math.round((x - corner.east - half) / gridMeters)
    const iy = Math.round((y - corner.north - half) / gridMeters)
    if (ix < 0 || iy < 0 || ix >= width || iy >= width) continue
    values[iy * width + ix] = z
    points++
  }
  return { corner, width, gridMeters, values, points }
}

/**
 * Height at a UTM position from a parsed tile: bilinear over the four
 * surrounding cell centers, the nearest valid one where fewer than four
 * are valid, undefined where none is.
 */
export function sampleXyzTile(tile, x, y) {
  const { corner, width, gridMeters, values } = tile
  const fx = (x - corner.east) / gridMeters - 0.5
  const fy = (y - corner.north) / gridMeters - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const at = (ix, iy) =>
    ix < 0 || iy < 0 || ix >= width || iy >= width ? Number.NaN : values[iy * width + ix]
  const corners = [
    { v: at(x0, y0), w: (1 - tx) * (1 - ty) },
    { v: at(x0 + 1, y0), w: tx * (1 - ty) },
    { v: at(x0, y0 + 1), w: (1 - tx) * ty },
    { v: at(x0 + 1, y0 + 1), w: tx * ty },
  ]
  const valid = corners.filter((c) => Number.isFinite(c.v))
  if (valid.length === 0) return undefined
  if (valid.length < 4) {
    return valid.reduce((best, c) => (c.w > best.w ? c : best)).v
  }
  return corners.reduce((sum, c) => sum + c.v * c.w, 0)
}

export class XyzZipSampler {
  /**
   * @param opts.url        the zip to download (once, into cacheFile)
   * @param opts.cacheFile  where the zip is kept between runs
   * @param opts.crs        UTM CRS the tiles are in (EPSG:25832 / 25833)
   * @param opts.tileSizeMeters  tile edge (2000 for the Hamburg DGMs)
   * @param opts.gridMeters      cell spacing (10 for DGM10)
   */
  constructor(opts) {
    this.url = opts.url
    this.cacheFile = opts.cacheFile
    this.crs = opts.crs ?? 'EPSG:25832'
    this.tileSize = opts.tileSizeMeters ?? 2000
    this.gridMeters = opts.gridMeters ?? 10
    this.fetchImpl = opts.fetchImpl ?? fetch
    /** Raw zip bytes once loaded. */
    this.zip = null
    /** "east:north" → entry name, built from the zip's directory. */
    this.names = null
    /** "east:north" → parsed tile or null (no such tile). */
    this.tiles = new Map()
    this.stats = { tiles: 0, bytes: 0, failedTiles: 0 }
  }

  async heightAt(lon, lat) {
    const [x, y] = lonLatToUtm(lon, lat, this.crs)
    const tile = await this.tileFor(x, y)
    return tile ? sampleXyzTile(tile, x, y) : undefined
  }

  /** Loads the archive (from the cache, else the network) and indexes its tiles. */
  async load() {
    if (this.zip) return
    if (!existsSync(this.cacheFile)) {
      console.log(`Downloading ${this.url} … (once, cached at ${this.cacheFile})`)
      const response = await this.fetchImpl(this.url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(600_000),
      })
      if (!response.ok) throw new Error(`Terrain download failed: HTTP ${response.status}`)
      const buffer = new Uint8Array(await response.arrayBuffer())
      mkdirSync(new URL('.', `file://${this.cacheFile}`).pathname, { recursive: true })
      writeFileSync(this.cacheFile, buffer)
      console.log(`Downloaded ${(buffer.length / 1e6).toFixed(1)} MB`)
    } else {
      console.log(`Using cached terrain archive ${this.cacheFile}`)
    }
    this.zip = new Uint8Array(readFileSync(this.cacheFile))
    // The directory only: a filter that keeps nothing inflates nothing.
    this.names = new Map()
    unzipSync(this.zip, {
      filter: (file) => {
        const corner = tileCornerFromName(file.name)
        if (corner) this.names.set(`${corner.east}:${corner.north}`, file.name)
        return false
      },
    })
    if (this.names.size === 0) {
      throw new Error(`${this.cacheFile} holds no XYZ tiles named after their corner`)
    }
  }

  async tileFor(x, y) {
    await this.load()
    const east = Math.floor(x / this.tileSize) * this.tileSize
    const north = Math.floor(y / this.tileSize) * this.tileSize
    const key = `${east}:${north}`
    if (this.tiles.has(key)) return this.tiles.get(key)
    const name = this.names.get(key)
    let tile = null
    if (name) {
      try {
        const files = unzipSync(this.zip, { filter: (file) => file.name === name })
        const bytes = files[name]
        if (!bytes) throw new Error('entry missing')
        tile = parseXyzTile(
          new TextDecoder('utf-8').decode(bytes),
          { east, north },
          this.tileSize,
          this.gridMeters,
        )
        this.stats.tiles++
        this.stats.bytes += bytes.length
      } catch (err) {
        this.stats.failedTiles++
        console.warn(`  ⚠ terrain tile ${name} failed: ${err.message}`)
        tile = null
      }
    }
    this.tiles.set(key, tile)
    return tile
  }
}
