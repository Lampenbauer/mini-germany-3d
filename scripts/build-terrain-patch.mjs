#!/usr/bin/env node
/**
 * Builds the terrain tiles a city folder carries over Mapterhorn
 * (src/cities/<slug>/terrain/{z}/{x}/{y}.webp – the sampler in
 * lib/terrain.mjs reads a tile from there before it asks
 * tiles.mapterhorn.com): Terrarium WebP tiles in Mapterhorn's own format,
 * built from the state's 1 m terrain model where Mapterhorn's import of
 * that model has holes.
 *
 * Hamburg: Mapterhorn imports the LGV DGM1 (the 2016 release, 2 km
 * squares of ASCII XYZ in EPSG:25832) but lacks 19 of its squares – the
 * city centre, Ottensen, Hammerbrook, Rothenburgsort, Wilhelmsburg
 * (mapterhorn/mapterhorn#131). Its tiles there come from the 30 m global
 * surface model, 3–20 m above the ground. The squares themselves are in
 * the zip, so the tiles are rebuilt from it here.
 *
 * A one-off, run by hand; the weekly pipeline only reads the committed
 * tiles:
 *
 *   node scripts/build-terrain-patch.mjs --city hamburg
 *   node scripts/build-terrain-patch.mjs --city hamburg --squares 564_5934,566_5934
 *   node scripts/build-terrain-patch.mjs --city hamburg --zoom 14
 *
 * Every 2 km square of the zip (or the ones named, "E_N" in km) is
 * compared with Mapterhorn at a lattice of 400 points: a square where
 * most of them differ by more than a meter is one Mapterhorn lacks (an
 * imported square agrees to the centimeter; at the state line and over
 * water Mapterhorn blends its sources, which moves a few percent of the
 * points by a meter or two – that is not a hole). Every tile at the zoom
 * (the city's, 15 – a --zoom must match the `terrain.zoom` of city.json,
 * the sampler looks for its own zoom only) that touches a missing square
 * is then built from the DGM, bilinear over the 1 m grid exactly as the
 * sampler reads a tile: DGM heights where the DGM has data, Mapterhorn's
 * own pixels elsewhere (beyond the state line, and at the DGM's few 0.0
 * cells, which Mapterhorn treats as no data). Rerunning yields the same
 * bytes; a run after a Mapterhorn fix that closes the holes writes
 * nothing and names the committed tiles that can go.
 *
 * The zip is read with HTTP range requests – the central directory
 * first, then each square's compressed bytes – so a run moves the
 * squares it looks at, not the 3 GB archive at once. Squares stay
 * decoded in a small LRU (16 MB each); a tile touches at most four.
 *
 * Data license: the heights are © Freie und Hansestadt Hamburg,
 * Landesbetrieb Geoinformation und Vermessung (DGM1, dl-de/by-2-0) –
 * the same source Mapterhorn's Hamburg tiles are built from, so the
 * city's terrain attribution covers both.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { CITIES_DIR } from './lib/city.mjs'
import { MapterhornSampler, TILE_SIZE, lonLatToPixel } from './lib/terrain.mjs'

/** The DGM behind a city's patch: a zip of ASCII XYZ squares in a UTM zone. */
const SOURCES = {
  hamburg: {
    zip: 'https://archiv.transparenz.hamburg.de/hmbtgarchive/HMDK/dgm1_2x2km_xyz_hh_2016-01-04_4735_snap_1_16267_snap_1.ZIP',
    /** Zip entry → [E0, N0] in meters, or null for anything that is not a square. */
    square: (name) => {
      const m = /DGM1_32(\d{3})_(\d{4})_2_FHH\.xyz$/.exec(name)
      return m ? [Number(m[1]) * 1000, Number(m[2]) * 1000] : null
    },
    squareMeters: 2000,
    utmZone: 32,
    zoom: 15,
  },
}

const REQUEST_HEADERS = {
  'User-Agent':
    'mini-germany-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-germany-3d)',
}

/**
 * A square is missing at Mapterhorn when this share of its lattice points
 * is off by more than a meter – of at least MIN_POINTS points: a sliver of
 * a square at the state line has a handful, and two of six say nothing.
 */
const MISSING_SHARE = 0.3
const MIN_POINTS = 40
const LATTICE_STEP = 100
const OFF_METERS = 1

// ─── Transverse Mercator (GRS80, UTM) ───────────────────────────────────

const A = 6378137
const F = 1 / 298.257222101
const E2 = 2 * F - F * F
const EP2 = E2 / (1 - E2)
const K0 = 0.9996

/** WGS84 → UTM easting/northing (Snyder's series – millimeters within the zone). */
export function lonLatToUtm(lon, lat, zone) {
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180)
  const p = lat * (Math.PI / 180)
  const l = lon * (Math.PI / 180)
  const sp = Math.sin(p)
  const cp = Math.cos(p)
  const tp = Math.tan(p)
  const n = A / Math.sqrt(1 - E2 * sp * sp)
  const t = tp * tp
  const c = EP2 * cp * cp
  const a = (l - lon0) * cp
  const m =
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * p -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * p) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * p) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * p))
  const x =
    K0 * n * (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120) +
    500000
  const y =
    K0 *
    (m +
      n *
        tp *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720))
  return [x, y]
}

/** UTM easting/northing → WGS84 [lon, lat]. */
export function utmToLonLat(x, y, zone) {
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180)
  const mu = y / K0 / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256))
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2))
  const p1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)
  const sp = Math.sin(p1)
  const cp = Math.cos(p1)
  const tp = Math.tan(p1)
  const n1 = A / Math.sqrt(1 - E2 * sp * sp)
  const t1 = tp * tp
  const c1 = EP2 * cp * cp
  const r1 = (A * (1 - E2)) / (1 - E2 * sp * sp) ** 1.5
  const d = (x - 500000) / (n1 * K0)
  const p =
    p1 -
    ((n1 * tp) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720)
  const l =
    lon0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
      cp
  return [l * (180 / Math.PI), p * (180 / Math.PI)]
}

/** Inverse of lonLatToPixel: the WGS84 position of a global pixel coordinate. */
export function pixelToLonLat(px, py, zoom) {
  const size = 2 ** zoom * TILE_SIZE
  const lon = (px / size) * 360 - 180
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / size))) * (180 / Math.PI)
  return [lon, lat]
}

/** Terrarium RGB of a height: R·256 + G + B/256 − 32768, rounded to 1/256 m. */
export function terrariumRgb(height) {
  const v = Math.round((height + 32768) * 256)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

// ─── The zip, by range requests ─────────────────────────────────────────

async function fetchRange(url, start, end) {
  const response = await fetch(url, {
    headers: { ...REQUEST_HEADERS, Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(600_000),
  })
  if (response.status !== 206) throw new Error(`range request failed: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** The entries of a (non-zip64) zip: name → { offset, compressedSize, size, method }. */
export async function readZipDirectory(url) {
  const head = await fetch(url, { method: 'HEAD', headers: REQUEST_HEADERS })
  const total = Number(head.headers.get('content-length'))
  if (!total) throw new Error('zip size unknown (no Content-Length)')
  const tail = await fetchRange(url, Math.max(0, total - 65_557), total - 1)
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record')
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported')
  const cd = await fetchRange(url, cdOffset, cdOffset + cdSize - 1)
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const entries = new Map()
  for (let pos = 0; pos + 46 <= cd.length && cdv.getUint32(pos, true) === 0x02014b50; ) {
    const nameLength = cdv.getUint16(pos + 28, true)
    const extraLength = cdv.getUint16(pos + 30, true)
    const commentLength = cdv.getUint16(pos + 32, true)
    const name = new TextDecoder('latin1').decode(cd.subarray(pos + 46, pos + 46 + nameLength))
    entries.set(name, {
      method: cdv.getUint16(pos + 10, true),
      compressedSize: cdv.getUint32(pos + 20, true),
      size: cdv.getUint32(pos + 24, true),
      offset: cdv.getUint32(pos + 42, true),
    })
    pos += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** One entry's bytes, inflated. */
async function readZipEntry(url, entry) {
  const header = await fetchRange(url, entry.offset, entry.offset + 29)
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (hv.getUint32(0, true) !== 0x04034b50) throw new Error('zip: bad local header')
  const start = entry.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true)
  const compressed = await fetchRange(url, start, start + entry.compressedSize - 1)
  if (entry.method === 0) return compressed
  if (entry.method !== 8) throw new Error(`zip: unsupported compression method ${entry.method}`)
  const bytes = inflateRawSync(compressed)
  if (bytes.length !== entry.size) throw new Error(`zip: inflated ${bytes.length} bytes, expected ${entry.size}`)
  return bytes
}

// ─── The DGM squares ────────────────────────────────────────────────────

/**
 * An ASCII XYZ square ("E N H" per line, cell centers at .5 m) as a
 * Float32Array grid, row-major from the south-west corner; NaN where the
 * square has no line (beyond the state line).
 */
export function parseXyzSquare(text, E0, N0, squareMeters) {
  const grid = new Float32Array(squareMeters * squareMeters).fill(NaN)
  let count = 0
  for (let pos = 0; pos < text.length; ) {
    let end = text.indexOf('\n', pos)
    if (end < 0) end = text.length
    const line = text.slice(pos, end)
    pos = end + 1
    const s1 = line.indexOf(' ')
    const s2 = line.indexOf(' ', s1 + 1)
    if (s1 < 0 || s2 < 0) continue
    const e = Math.floor(Number(line.slice(0, s1)) - E0)
    const n = Math.floor(Number(line.slice(s1 + 1, s2)) - N0)
    if (e < 0 || e >= squareMeters || n < 0 || n >= squareMeters) continue
    grid[n * squareMeters + e] = Number(line.slice(s2 + 1))
    count++
  }
  return { grid, count }
}

/** The squares of the zip, decoded on demand and kept in a small LRU. */
class SquareStore {
  constructor(source, entries) {
    this.source = source
    this.size = source.squareMeters
    /** "E0_N0" → zip entry */
    this.entries = new Map()
    for (const [name, entry] of entries) {
      const square = source.square(name)
      if (square) this.entries.set(`${square[0]}_${square[1]}`, entry)
    }
    this.grids = new Map()
    this.maxGrids = 48
    this.stats = { squares: 0, bytes: 0 }
  }

  keys() {
    return [...this.entries.keys()]
  }

  /** The grid holding meter (E, N), or null where the zip has no square. */
  async gridAt(E, N) {
    const E0 = Math.floor(E / this.size) * this.size
    const N0 = Math.floor(N / this.size) * this.size
    const key = `${E0}_${N0}`
    const kept = this.grids.get(key)
    if (kept !== undefined) {
      this.grids.delete(key)
      this.grids.set(key, kept)
      return kept
    }
    const entry = this.entries.get(key)
    let grid = null
    if (entry) {
      const bytes = await readZipEntry(this.source.zip, entry)
      this.stats.squares++
      this.stats.bytes += entry.compressedSize
      grid = { E0, N0, ...parseXyzSquare(new TextDecoder('latin1').decode(bytes), E0, N0, this.size) }
    }
    this.grids.set(key, grid)
    if (this.grids.size > this.maxGrids) this.grids.delete(this.grids.keys().next().value)
    return grid
  }

  /**
   * A synchronous reader over the squares an area touches, loaded up
   * front: cell(E, N) is the cell whose center is nearest, NaN without
   * data, and height(E, N) the bilinear over the four cell centers around
   * (E, N) – the same rule the sampler applies to a tile's pixels, one
   * level finer. A cell without data drops out; with none, NaN. A cell at
   * exactly 0.0 counts as no data, as Mapterhorn reads the source.
   */
  async readerFor(minE, minN, maxE, maxN) {
    const grids = new Map()
    for (let E = Math.floor((minE - 1) / this.size) * this.size; E <= maxE + 1; E += this.size) {
      for (let N = Math.floor((minN - 1) / this.size) * this.size; N <= maxN + 1; N += this.size) {
        grids.set(`${E}_${N}`, await this.gridAt(E, N))
      }
    }
    const size = this.size
    const cell = (E, N) => {
      const grid = grids.get(`${Math.floor(E / size) * size}_${Math.floor(N / size) * size}`)
      if (!grid) return NaN
      return grid.grid[(Math.floor(N) - grid.N0) * size + (Math.floor(E) - grid.E0)]
    }
    const height = (E, N) => {
      const fx = E - 0.5
      const fy = N - 0.5
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      const tx = fx - x0
      const ty = fy - y0
      let sum = 0
      let weight = 0
      for (const [x, y, w] of [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x0 + 1, y0, tx * (1 - ty)],
        [x0, y0 + 1, (1 - tx) * ty],
        [x0 + 1, y0 + 1, tx * ty],
      ]) {
        const v = cell(x + 0.5, y + 0.5)
        if (Number.isFinite(v) && v !== 0) {
          sum += v * w
          weight += w
        }
      }
      return weight > 0 ? sum / weight : NaN
    }
    return { cell, height }
  }
}

// ─── Squares vs Mapterhorn ──────────────────────────────────────────────

/**
 * How much of a square Mapterhorn gets wrong: the share of lattice
 * points (every LATTICE_STEP m, at the cell centers) where its height is
 * off by more than OFF_METERS. null for a square without data.
 */
async function offShare(grid, size, zone, mapterhorn) {
  let points = 0
  let off = 0
  for (let n = LATTICE_STEP / 2; n < size; n += LATTICE_STEP) {
    for (let e = LATTICE_STEP / 2; e < size; e += LATTICE_STEP) {
      const dgm = grid.grid[Math.floor(n) * size + Math.floor(e)]
      if (!Number.isFinite(dgm) || dgm === 0) continue
      const [lon, lat] = utmToLonLat(grid.E0 + e, grid.N0 + n, zone)
      const h = await mapterhorn.heightAt(lon, lat)
      if (h === undefined) continue
      points++
      if (Math.abs(h - dgm) > OFF_METERS) off++
    }
  }
  return points === 0 ? null : { points, share: off / points }
}

/** The tiles at `zoom` that touch the square [E0, E0+size] × [N0, N0+size], as "x/y". */
export function tilesTouching(E0, N0, size, zone, zoom) {
  const corners = [
    [E0, N0],
    [E0 + size, N0],
    [E0, N0 + size],
    [E0 + size, N0 + size],
  ].map(([E, N]) => lonLatToPixel(...utmToLonLat(E, N, zone), zoom).map((v) => Math.floor(v / TILE_SIZE)))
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const tiles = []
  for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) tiles.push(`${x}/${y}`)
  }
  return tiles
}

/**
 * The tile's heights from the DGM: Float32Array in tile order, NaN
 * where the DGM has nothing.
 */
async function dgmTile(store, zone, zoom, x, y) {
  const count = TILE_SIZE * TILE_SIZE
  const eastings = new Float64Array(count)
  const northings = new Float64Array(count)
  let minE = Infinity
  let minN = Infinity
  let maxE = -Infinity
  let maxN = -Infinity
  for (let j = 0; j < TILE_SIZE; j++) {
    for (let i = 0; i < TILE_SIZE; i++) {
      const [lon, lat] = pixelToLonLat(x * TILE_SIZE + i + 0.5, y * TILE_SIZE + j + 0.5, zoom)
      const [E, N] = lonLatToUtm(lon, lat, zone)
      eastings[j * TILE_SIZE + i] = E
      northings[j * TILE_SIZE + i] = N
      if (E < minE) minE = E
      if (E > maxE) maxE = E
      if (N < minN) minN = N
      if (N > maxN) maxN = N
    }
  }
  const reader = await store.readerFor(minE, minN, maxE, maxN)
  const heights = new Float32Array(count)
  for (let i = 0; i < count; i++) heights[i] = reader.height(eastings[i], northings[i])
  return heights
}

async function encodeTerrariumWebp(heights) {
  const { default: sharp } = await import('sharp')
  const rgb = Buffer.alloc(TILE_SIZE * TILE_SIZE * 3)
  for (let i = 0, p = 0; i < heights.length; i++, p += 3) {
    const [r, g, b] = terrariumRgb(heights[i])
    rgb[p] = r
    rgb[p + 1] = g
    rgb[p + 2] = b
  }
  return sharp(rgb, { raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 3 } })
    .webp({ lossless: true, effort: 6 })
    .toBuffer()
}

/** Every {z}/{x}/{y}.webp under a folder, relative. */
function tileFiles(dir) {
  if (!existsSync(dir)) return []
  const files = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.webp')) files.push(relative(dir, path))
    }
  }
  walk(dir)
  return files.sort()
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return { city: get('--city') ?? process.env.CITY, squares: get('--squares'), zoom: get('--zoom') }
}

async function main() {
  const { city: slug, squares: requested, zoom: zoomArg } = parseArgs(process.argv)
  const source = SOURCES[slug]
  if (!source) {
    throw new Error(`--city must name a city with a patch source: ${Object.keys(SOURCES).join(', ')}`)
  }
  const outDir = resolve(CITIES_DIR, slug, 'terrain')
  const zone = source.utmZone
  const zoom = zoomArg ? Number(zoomArg) : source.zoom

  console.log(`Reading the zip directory of ${source.zip}`)
  const store = new SquareStore(source, await readZipDirectory(source.zip))
  const squares = requested
    ? requested.split(',').map((s) => s.trim().split('_').map((v) => Number(v) * 1000).join('_'))
    : store.keys().sort()
  for (const key of squares) {
    if (!store.entries.has(key)) throw new Error(`no square ${key} in the zip`)
  }
  const mapterhorn = new MapterhornSampler({ zoom })

  console.log(`\n${squares.length} squares against Mapterhorn z${zoom}:`)
  const missing = []
  let empty = 0
  for (const key of squares) {
    const [E0, N0] = key.split('_').map(Number)
    const grid = await store.gridAt(E0, N0)
    const result = grid && grid.count > 0 ? await offShare(grid, store.size, zone, mapterhorn) : null
    if (!result) {
      empty++
      continue
    }
    const percent = Math.round(result.share * 100)
    const isMissing = result.share > MISSING_SHARE && result.points >= MIN_POINTS
    const verdict = isMissing
      ? 'MISSING at Mapterhorn'
      : result.points < MIN_POINTS
        ? 'too few points to tell'
        : percent > 0
          ? 'blended edges'
          : 'ok'
    if (isMissing) missing.push(key)
    if (isMissing || percent > 0) {
      console.log(`  ${key.padEnd(14)} ${String(result.points).padStart(3)} points, ${String(percent).padStart(3)} % off → ${verdict}`)
    }
  }
  console.log(`${missing.length} squares missing, ${empty} without data\n`)

  const tiles = new Set()
  for (const key of missing) {
    const [E0, N0] = key.split('_').map(Number)
    for (const tile of tilesTouching(E0, N0, store.size, zone, zoom)) tiles.add(tile)
  }
  console.log(`${tiles.size} tiles touch them → ${outDir}`)
  const written = new Set()
  let bytes = 0
  for (const tile of [...tiles].sort()) {
    const [x, y] = tile.split('/').map(Number)
    const dgm = await dgmTile(store, zone, zoom, x, y)
    const current = await mapterhorn.tileAt(zoom, x, y)
    if (current === false) throw new Error(`Mapterhorn tile ${zoom}/${x}/${y} unreachable – rerun later`)
    let count = 0
    for (let i = 0; i < dgm.length; i++) {
      if (Number.isNaN(dgm[i])) {
        // No DGM here: Mapterhorn's own pixel, or – without any tile –
        // the lowest Terrarium value, like an empty tile would carry.
        dgm[i] = current ? current[i] : -32768
      } else {
        count++
      }
    }
    if (count === 0) continue
    const encoded = await encodeTerrariumWebp(dgm)
    const file = resolve(outDir, `${zoom}/${x}/${y}.webp`)
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file) || !readFileSync(file).equals(encoded)) writeFileSync(file, encoded)
    written.add(relative(outDir, file))
    bytes += encoded.length
  }

  const stale = tileFiles(outDir).filter((file) => !written.has(file) && (!requested || file.startsWith(`${zoom}/`)))
  console.log(
    `\n${written.size} tiles written (${(bytes / 1024 / 1024).toFixed(1)} MB); ` +
      `${store.stats.squares} squares read (${(store.stats.bytes / 1024 / 1024).toFixed(0)} MB compressed), ` +
      `${mapterhorn.stats.tiles} Mapterhorn tiles (${(mapterhorn.stats.bytes / 1024 / 1024).toFixed(1)} MB)`,
  )
  if (stale.length > 0 && !requested) {
    console.log(`\n${stale.length} tile(s) in the folder that no missing square needs any more – delete them:`)
    for (const file of stale) console.log(`  ${file}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
