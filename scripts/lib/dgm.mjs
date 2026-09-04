/**
 * DGM (digital terrain model) sampling for the data pipeline, backed by a
 * WCS 2.0.1 that serves uncompressed float32 GeoTIFF tiles in a UTM zone
 * with NHN heights (DHHN2016) – written for the open DGM5 of the LAiV M-V
 * (geodaten-mv.de, © GeoBasis-DE/M-V) and parameterized per city
 * (city.json `terrain`: url, coverage, crs). The sampler fetches fixed
 * 1 km tiles on demand, caches them in memory, and answers point queries
 * with bilinear interpolation – 5 m terrain resolution is plenty for
 * route polylines that are lifted ~1 m above the surface anyway.
 *
 * WGS84 coordinates are treated as ETRS89 (the datums differ by well under
 * a meter – irrelevant at 5 m grid spacing).
 */

import proj4 from 'proj4'

/** The UTM zones German state services deliver in, by EPSG code. */
const UTM_BY_CRS = {
  'EPSG:25832': '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs',
  'EPSG:25833': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs',
}

/** [lon, lat] (WGS84) → [easting, northing] in the given UTM CRS. */
export function lonLatToUtm(lon, lat, crs = 'EPSG:25833') {
  const definition = UTM_BY_CRS[crs]
  if (!definition) throw new Error(`Unsupported terrain CRS ${crs} (known: ${Object.keys(UTM_BY_CRS).join(', ')})`)
  return proj4('EPSG:4326', definition, [lon, lat])
}

/** [lon, lat] (WGS84) → [easting, northing] in EPSG:25833 (the MV DGM's zone). */
export function lonLatToUtm33(lon, lat) {
  return lonLatToUtm(lon, lat, 'EPSG:25833')
}

// TIFF tag ids used below
const TAG_WIDTH = 256
const TAG_HEIGHT = 257
const TAG_BITS_PER_SAMPLE = 258
const TAG_COMPRESSION = 259
const TAG_STRIP_OFFSETS = 273
const TAG_ROWS_PER_STRIP = 278
const TAG_STRIP_BYTE_COUNTS = 279
const TAG_SAMPLE_FORMAT = 339
const TAG_MODEL_PIXEL_SCALE = 33550
const TAG_MODEL_TIEPOINT = 33922

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 }

/**
 * Minimal reader for the exact TIFF flavor the WCS emits: little-endian,
 * single band, uncompressed float32, strip layout, with the GeoTIFF
 * ModelPixelScale/ModelTiepoint tags for georeferencing. Anything else is
 * rejected loudly – better a clear pipeline error than silently wrong
 * heights.
 */
export function parseFloat32Tiff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || view.getUint16(0, true) !== 0x4949 || view.getUint16(2, true) !== 42) {
    throw new Error('not a little-endian classic TIFF')
  }
  const ifdOffset = view.getUint32(4, true)
  const entryCount = view.getUint16(ifdOffset, true)
  const entries = new Map()
  for (let i = 0; i < entryCount; i++) {
    const off = ifdOffset + 2 + i * 12
    entries.set(view.getUint16(off, true), {
      type: view.getUint16(off + 2, true),
      count: view.getUint32(off + 4, true),
      valueOffset: off + 8,
    })
  }

  const values = (tag) => {
    const e = entries.get(tag)
    if (!e) return undefined
    const size = TYPE_SIZES[e.type]
    if (!size) throw new Error(`TIFF tag ${tag}: unsupported type ${e.type}`)
    const base = size * e.count <= 4 ? e.valueOffset : view.getUint32(e.valueOffset, true)
    const out = []
    for (let i = 0; i < e.count; i++) {
      const p = base + i * size
      if (e.type === 3) out.push(view.getUint16(p, true))
      else if (e.type === 4) out.push(view.getUint32(p, true))
      else if (e.type === 12) out.push(view.getFloat64(p, true))
      else if (e.type === 11) out.push(view.getFloat32(p, true))
      else out.push(view.getUint8(p))
    }
    return out
  }
  const single = (tag) => values(tag)?.[0]

  const width = single(TAG_WIDTH)
  const height = single(TAG_HEIGHT)
  if (!width || !height) throw new Error('TIFF without dimensions')
  if ((single(TAG_COMPRESSION) ?? 1) !== 1) throw new Error('compressed TIFF not supported')
  if (single(TAG_BITS_PER_SAMPLE) !== 32 || single(TAG_SAMPLE_FORMAT) !== 3) {
    throw new Error('expected float32 samples')
  }

  const stripOffsets = values(TAG_STRIP_OFFSETS)
  const stripByteCounts = values(TAG_STRIP_BYTE_COUNTS)
  const rowsPerStrip = single(TAG_ROWS_PER_STRIP) ?? height
  if (!stripOffsets || !stripByteCounts) throw new Error('TIFF without strip layout')

  const data = new Float32Array(width * height)
  let px = 0
  for (let s = 0; s < stripOffsets.length; s++) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip)
    const expected = rows * width * 4
    if (stripByteCounts[s] < expected) throw new Error('TIFF strip shorter than expected')
    for (let i = 0; i < rows * width; i++) {
      data[px++] = view.getFloat32(stripOffsets[s] + i * 4, true)
    }
  }

  // GeoTIFF georeferencing: tie point maps raster (0,0) to world coordinates,
  // pixel scale is meters per pixel (y positive, rows run north → south).
  const scale = values(TAG_MODEL_PIXEL_SCALE)
  const tiepoint = values(TAG_MODEL_TIEPOINT)
  if (!scale || !tiepoint || tiepoint.length < 6) {
    throw new Error('TIFF without GeoTIFF georeferencing tags')
  }

  return {
    width,
    height,
    data,
    originX: tiepoint[3] - tiepoint[0] * scale[0],
    originY: tiepoint[4] + tiepoint[1] * scale[1],
    scaleX: scale[0],
    scaleY: scale[1],
  }
}

/** Heights outside this window are treated as nodata (MV: −10 … +180 m NHN). */
const MIN_VALID = -50
const MAX_VALID = 500

function validHeight(v) {
  return Number.isFinite(v) && v > MIN_VALID && v < MAX_VALID
}

/**
 * Bilinear height at world position (x, y); undefined outside the tile or
 * on nodata. Corners with nodata fall back to the nearest valid corner so a
 * point right at a water edge still gets the adjacent land height.
 */
export function sampleTile(tile, x, y) {
  const fx = (x - tile.originX) / tile.scaleX - 0.5
  const fy = (tile.originY - y) / tile.scaleY - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= tile.width || y0 + 1 >= tile.height) return undefined
  const tx = fx - x0
  const ty = fy - y0
  const at = (px, py) => tile.data[py * tile.width + px]
  const corners = [
    { v: at(x0, y0), w: (1 - tx) * (1 - ty) },
    { v: at(x0 + 1, y0), w: tx * (1 - ty) },
    { v: at(x0, y0 + 1), w: (1 - tx) * ty },
    { v: at(x0 + 1, y0 + 1), w: tx * ty },
  ]
  const valid = corners.filter((c) => validHeight(c.v))
  if (valid.length === 0) return undefined
  if (valid.length < 4) {
    return valid.reduce((best, c) => (c.w > best.w ? c : best)).v
  }
  return corners.reduce((sum, c) => sum + c.v * c.w, 0)
}

const DEFAULT_ENDPOINT = 'https://www.geodaten-mv.de/dienste/dgm_wcs'

const REQUEST_HEADERS = {
  'User-Agent':
    'mini-germany-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-germany-3d)',
}

/**
 * On-demand, cached access to the DGM: point queries in WGS84, answered
 * from 1 km × 1 km WCS tiles (plus a margin so bilinear interpolation works
 * across tile edges). Fetches run strictly sequentially – the pipeline is a
 * nightly batch job, not a latency-critical client.
 */
export class DgmSampler {
  /**
   * `endpoint`, `coverageId` and `crs` come from the city's terrain
   * config; the DGM_WCS_URL / DGM_COVERAGE environment variables still
   * override them for a one-off run against another service.
   */
  constructor(opts = {}) {
    this.endpoint = process.env.DGM_WCS_URL ?? opts.endpoint ?? DEFAULT_ENDPOINT
    this.coverageId = process.env.DGM_COVERAGE ?? opts.coverageId ?? 'mv_dgm5'
    this.crs = opts.crs ?? 'EPSG:25833'
    this.tileSize = opts.tileSizeMeters ?? 1000
    this.marginMeters = opts.marginMeters ?? 10
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.tiles = new Map() // "tx:ty" → parsed tile or null (fetch failed)
    this.stats = { tiles: 0, bytes: 0, failedTiles: 0 }
  }

  async heightAt(lon, lat) {
    const [x, y] = lonLatToUtm(lon, lat, this.crs)
    const tile = await this.tileFor(x, y)
    return tile ? sampleTile(tile, x, y) : undefined
  }

  async tileFor(x, y) {
    const tx = Math.floor(x / this.tileSize)
    const ty = Math.floor(y / this.tileSize)
    const key = `${tx}:${ty}`
    if (this.tiles.has(key)) return this.tiles.get(key)
    // The margin also covers points that fall within half a grid cell of
    // the tile edge (bilinear needs the neighbor across the border).
    const x0 = tx * this.tileSize - this.marginMeters
    const x1 = (tx + 1) * this.tileSize + this.marginMeters
    const y0 = ty * this.tileSize - this.marginMeters
    const y1 = (ty + 1) * this.tileSize + this.marginMeters
    const url =
      `${this.endpoint}?service=WCS&version=2.0.1&request=GetCoverage` +
      `&coverageId=${this.coverageId}&format=image/tiff` +
      `&subset=x(${x0},${x1})&subset=y(${y0},${y1})`
    let tile = null
    for (let attempt = 0; attempt < 2 && tile === null; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000))
      try {
        const response = await this.fetchImpl(url, {
          headers: REQUEST_HEADERS,
          signal: AbortSignal.timeout(60_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const raw = new Uint8Array(await response.arrayBuffer())
        tile = parseFloat32Tiff(raw)
        this.stats.tiles++
        this.stats.bytes += raw.length
      } catch (err) {
        if (attempt > 0) {
          this.stats.failedTiles++
          console.warn(`  ⚠ DGM tile ${key} failed: ${err.message}`)
        }
      }
    }
    this.tiles.set(key, tile)
    return tile
  }
}
