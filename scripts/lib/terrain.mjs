/**
 * Terrain heights for the data pipeline, from Mapterhorn
 * (https://mapterhorn.com): Terrarium-encoded terrain RGB tiles, 512 px
 * WebP per z/x/y, built from open terrain models – in Germany the 1 m DGM1
 * of every state (Mecklenburg-Vorpommern: GeoBasis-DE/M-V, CC BY 4.0;
 * Schleswig-Holstein: GeoBasis-DE/LVermGeo SH, CC BY 4.0; the full list is
 * https://mapterhorn.com/attribution). Not every import is complete –
 * Hamburg's city centre falls back to the 30 m surface model there
 * (mapterhorn/mapterhorn#131) – so a new city is worth a look at a few
 * known heights before it goes live. One source for every city, no key,
 * no fee; heights are meters above the source's datum, in Germany NHN
 * (DHHN2016), so the app's geoid calibration stays as it is.
 *
 * The sampler fetches tiles on demand at the city's zoom (city.json
 * `terrain.zoom`: 15 is ~1.4 m per pixel at German latitudes, one level
 * under the 1 m sources and plenty for route vertices tens of meters
 * apart) and answers point queries with bilinear interpolation over the
 * four surrounding pixel centers, fetching the neighbor tile where those
 * straddle an edge. A zoom the server has no tile for (404, outside the
 * fine-resolution coverage) is answered one level coarser, down to the
 * global 30 m layer at z12.
 *
 * Memory: the WebP bytes of every tile fetched stay in memory – a city's
 * routes touch a few hundred tiles of ~120 kB, so no tile is fetched
 * twice however the points are ordered – while the decoded heights (1 MB
 * per tile) live in a small LRU: lamps arrive in OSM order rather than
 * along the routes, and the CI runner is the smallest machine this runs
 * on. Fetches run strictly sequentially – the pipeline is a weekly batch
 * job, not a latency-critical client.
 */

export const TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
export const TILE_SIZE = 512
export const DEFAULT_ZOOM = 15
/** Below this only the global 30 m layer exists (planet archive, z0–12). */
export const MIN_ZOOM = 12
/** What the generated files carry when a city names no source of its own. */
export const DEFAULT_ATTRIBUTION = 'Terrain heights © Mapterhorn (mapterhorn.com).'

const REQUEST_HEADERS = {
  'User-Agent':
    'mini-germany-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-germany-3d)',
}

/** Terrarium: height = R · 256 + G + B / 256 − 32768, in 1/256 m steps. */
export function terrariumHeight(r, g, b) {
  return r * 256 + g + b / 256 - 32768
}

/**
 * Web Mercator pixel coordinates of a WGS84 position at a zoom, for
 * 512 px tiles: the tile is the integer part of the value divided by
 * TILE_SIZE, the remainder the pixel within it.
 */
export function lonLatToPixel(lon, lat, zoom) {
  const size = 2 ** zoom * TILE_SIZE
  const latRad = (lat * Math.PI) / 180
  return [
    ((lon + 180) / 360) * size,
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * size,
  ]
}

/** Heights from the interleaved RGB(A) pixels of a decoded tile, row-major. */
export function heightsFromPixels(pixels, channels) {
  const count = Math.floor(pixels.length / channels)
  const heights = new Float32Array(count)
  for (let i = 0, p = 0; i < count; i++, p += channels) {
    heights[i] = terrariumHeight(pixels[p], pixels[p + 1], pixels[p + 2])
  }
  return heights
}

/**
 * Decodes a WebP tile with sharp – imported here rather than at the top,
 * so the tests (which inject their own decoder) never load the native
 * module.
 */
async function decodeWebp(bytes) {
  const { default: sharp } = await import('sharp')
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  if (info.width !== TILE_SIZE || info.height !== TILE_SIZE) {
    throw new Error(`expected a ${TILE_SIZE} px tile, got ${info.width}×${info.height}`)
  }
  return heightsFromPixels(data, info.channels)
}

export class MapterhornSampler {
  /**
   * @param opts.zoom             tile zoom to sample at (DEFAULT_ZOOM)
   * @param opts.minZoom          coarsest zoom tried where finer ones have no tile (MIN_ZOOM)
   * @param opts.urlTemplate      {z}/{x}/{y} template (TILE_URL)
   * @param opts.maxDecodedTiles  decoded tiles kept at once, 1 MB each
   * @param opts.retryDelayMs     pause before the one retry of a failed fetch
   * @param opts.fetchImpl        fetch replacement for the tests
   * @param opts.decodeImpl       WebP → heights replacement for the tests
   */
  constructor(opts = {}) {
    this.zoom = opts.zoom ?? DEFAULT_ZOOM
    this.minZoom = opts.minZoom ?? MIN_ZOOM
    this.urlTemplate = opts.urlTemplate ?? TILE_URL
    this.maxDecodedTiles = opts.maxDecodedTiles ?? 128
    this.retryDelayMs = opts.retryDelayMs ?? 2000
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.decodeImpl = opts.decodeImpl ?? decodeWebp
    /** "z/x/y" → WebP bytes; null where the zoom has no tile (404), false where the fetch failed. */
    this.raw = new Map()
    /** "z/x/y" → heights, least recently used first. */
    this.decoded = new Map()
    this.stats = { tiles: 0, bytes: 0, failedTiles: 0 }
    this.label = `Mapterhorn z${this.zoom}`
  }

  /** Height in meters at a WGS84 position, undefined where there is none. */
  async heightAt(lon, lat) {
    for (let zoom = this.zoom; zoom >= this.minZoom; zoom--) {
      const [px, py] = lonLatToPixel(lon, lat, zoom)
      const tile = await this.tileAt(zoom, Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE))
      if (tile === null) continue // nothing this fine here – one level coarser
      if (tile === false) return undefined // unreachable – no guessing
      return this.sampleAt(zoom, px, py)
    }
    return undefined
  }

  /**
   * Bilinear over the four pixel centers around (px, py); a corner whose
   * tile is missing drops out, and with fewer than four the nearest one
   * answers alone, like the samplers before it.
   */
  async sampleAt(zoom, px, py) {
    const fx = px - 0.5
    const fy = py - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const tx = fx - x0
    const ty = fy - y0
    const corners = [
      { x: x0, y: y0, w: (1 - tx) * (1 - ty) },
      { x: x0 + 1, y: y0, w: tx * (1 - ty) },
      { x: x0, y: y0 + 1, w: (1 - tx) * ty },
      { x: x0 + 1, y: y0 + 1, w: tx * ty },
    ]
    const valid = []
    for (const corner of corners) {
      const v = await this.pixelAt(zoom, corner.x, corner.y)
      if (v !== undefined) valid.push({ v, w: corner.w })
    }
    if (valid.length === 0) return undefined
    if (valid.length < 4) return valid.reduce((best, c) => (c.w > best.w ? c : best)).v
    return valid.reduce((sum, c) => sum + c.v * c.w, 0)
  }

  /** One pixel's height in global pixel coordinates, undefined without a tile. */
  async pixelAt(zoom, gx, gy) {
    const tileX = Math.floor(gx / TILE_SIZE)
    const tileY = Math.floor(gy / TILE_SIZE)
    const tile = await this.tileAt(zoom, tileX, tileY)
    if (!tile) return undefined
    return tile[(gy - tileY * TILE_SIZE) * TILE_SIZE + (gx - tileX * TILE_SIZE)]
  }

  /**
   * The decoded tile: from the LRU, else decoded from the kept bytes,
   * else fetched. null where the server has no such tile, false where it
   * could not be fetched.
   */
  async tileAt(zoom, x, y) {
    const key = `${zoom}/${x}/${y}`
    const kept = this.decoded.get(key)
    if (kept) {
      this.decoded.delete(key)
      this.decoded.set(key, kept)
      return kept
    }
    let bytes = this.raw.get(key)
    if (bytes === undefined) {
      bytes = await this.fetchTile(zoom, x, y)
      this.raw.set(key, bytes)
    }
    if (!bytes) return bytes
    const heights = await this.decodeImpl(bytes)
    this.decoded.set(key, heights)
    if (this.decoded.size > this.maxDecodedTiles) {
      this.decoded.delete(this.decoded.keys().next().value)
    }
    return heights
  }

  /** One tile's bytes; null on 404, false after the retry failed too. */
  async fetchTile(zoom, x, y) {
    const url = this.urlTemplate.replace('{z}', zoom).replace('{x}', x).replace('{y}', y)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryDelayMs))
      try {
        const response = await this.fetchImpl(url, {
          headers: REQUEST_HEADERS,
          signal: AbortSignal.timeout(60_000),
        })
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        this.stats.tiles++
        this.stats.bytes += bytes.length
        return bytes
      } catch (err) {
        if (attempt > 0) {
          this.stats.failedTiles++
          console.warn(`  ⚠ terrain tile ${zoom}/${x}/${y} failed: ${err.message}`)
        }
      }
    }
    return false
  }
}

/** The sampler for a city – every city samples the same tiles at its own zoom. */
export function createTerrainSampler(city) {
  return new MapterhornSampler({ zoom: city.terrain.zoom })
}

/** The attribution line the generated files carry for their heights. */
export function terrainAttribution(city) {
  return city.terrain.attribution ?? DEFAULT_ATTRIBUTION
}

/** One line for the run summary: what was fetched. */
export function terrainSummary(sampler) {
  const { tiles, bytes, failedTiles } = sampler.stats
  return (
    `${tiles} ${sampler.label} tiles, ${(bytes / 1024 / 1024).toFixed(1)} MB` +
    (failedTiles > 0 ? `, ${failedTiles} tile(s) FAILED` : '')
  )
}
