/**
 * The cloud fields: the noise the volumetric clouds are cut from, and
 * what the weather does to it.
 *
 * Two fields, both periodic so that a texture of each can be tiled over
 * the whole city without a seam:
 *
 * - The coverage field, 2D. Where it rises above a threshold there is a
 *   cloud; the threshold comes from the cloud cover the weather reports,
 *   calibrated against the field's own histogram so that "60 % cover"
 *   really leaves 60 % of the sky under cloud (coverageThreshold). It is
 *   the shape of the sky as seen from the ground – cumulus cells a
 *   kilometer or two across – and the same field, read at the point where
 *   the sun's ray from a street crosses the layer, is what shadows the
 *   street (see TIME_OF_DAY_SHADER in CesiumMap).
 * - The detail field, 3D. It erodes the edges of every cloud the coverage
 *   field makes, so that a cloud is a puff and not a column, and it does
 *   so at a scale the coverage texels are too coarse for.
 *
 * Both are Perlin noise summed over a few octaves (Ken Perlin's 2002
 * "improved noise", as ported by three.js – the lattice here wraps at a
 * chosen period instead of at 256, which is what makes the tiles seamless).
 * Deliberately free of Cesium: the fields are plain arrays and the
 * calibration is plain arithmetic, unit tested as that.
 */

/** Perlin's permutation table, doubled so that lookups never wrap. */
const PERMUTATION = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142,
  8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203,
  117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74,
  165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220,
  105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132,
  187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3,
  64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227,
  47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221,
  153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185,
  112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51,
  145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121,
  50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78,
  66, 215, 61, 156, 180,
]
const P = new Uint8Array(512)
for (let i = 0; i < 256; i++) P[i] = P[i + 256] = PERMUTATION[i]

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15
  const u = h < 8 ? x : y
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
}

/**
 * Improved Perlin noise in -1 … 1, periodic in every axis with the given
 * lattice period (an integer, at least 1): noise(x + px, y, z) is
 * noise(x, y, z) exactly. Period 256 is Perlin's original table wrap.
 */
export function perlin3(
  x: number,
  y: number,
  z: number,
  periodX: number,
  periodY: number,
  periodZ: number,
): number {
  const fx = Math.floor(x)
  const fy = Math.floor(y)
  const fz = Math.floor(z)
  // Lattice corners, wrapped to the period (a negative floor wraps too)
  const X0 = ((fx % periodX) + periodX) % periodX
  const Y0 = ((fy % periodY) + periodY) % periodY
  const Z0 = ((fz % periodZ) + periodZ) % periodZ
  const X1 = (X0 + 1) % periodX
  const Y1 = (Y0 + 1) % periodY
  const Z1 = (Z0 + 1) % periodZ
  x -= fx
  y -= fy
  z -= fz
  const u = fade(x)
  const v = fade(y)
  const w = fade(z)
  // Hash of a corner: the table is indexed with each coordinate wrapped
  // to the period, so the corner past the end is the corner at the start
  const h = (X: number, Y: number, Z: number) => P[P[P[X & 255] + (Y & 255)] + (Z & 255)]
  return lerp(
    lerp(
      lerp(grad(h(X0, Y0, Z0), x, y, z), grad(h(X1, Y0, Z0), x - 1, y, z), u),
      lerp(grad(h(X0, Y1, Z0), x, y - 1, z), grad(h(X1, Y1, Z0), x - 1, y - 1, z), u),
      v,
    ),
    lerp(
      lerp(grad(h(X0, Y0, Z1), x, y, z - 1), grad(h(X1, Y0, Z1), x - 1, y, z - 1), u),
      lerp(grad(h(X0, Y1, Z1), x, y - 1, z - 1), grad(h(X1, Y1, Z1), x - 1, y - 1, z - 1), u),
      v,
    ),
    w,
  )
}

/**
 * Fractal sum of `octaves` of perlin3, each twice the frequency and half
 * the weight of the last, normalised to about -1 … 1. `period` is the
 * lattice period of the first octave in each axis; every octave doubles
 * it with the frequency, so the sum stays periodic.
 */
export function fbm3(
  x: number,
  y: number,
  z: number,
  periodX: number,
  periodY: number,
  periodZ: number,
  octaves: number,
): number {
  let sum = 0
  let amplitude = 1
  let total = 0
  let frequency = 1
  for (let i = 0; i < octaves; i++) {
    sum +=
      amplitude *
      perlin3(
        x * frequency,
        y * frequency,
        z * frequency,
        periodX * frequency,
        periodY * frequency,
        periodZ * frequency,
      )
    total += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return sum / total
}

/** A field as the GPU takes it: bytes, row-major, with its dimensions. */
export interface CloudField {
  data: Uint8Array
  width: number
  height: number
  /** 1 for the coverage field. */
  depth: number
}

/**
 * The coverage field: `size` texels a side, `cells` lattice cells of the
 * first octave across it (so a texture tiled every T meters shows
 * cumulus cells about T / cells across). The values are stretched to use
 * the full byte range – coverageThreshold reads the actual distribution,
 * so the stretch costs nothing and buys resolution.
 */
export function buildCoverageField(size: number, cells: number): CloudField {
  const data = new Uint8Array(size * size)
  const values = new Float32Array(size * size)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  const scale = cells / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fbm3(x * scale, y * scale, 0.37, cells, cells, 1, 4)
      values[y * size + x] = v
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  const span = max - min || 1
  for (let i = 0; i < values.length; i++) {
    data[i] = Math.round(((values[i] - min) / span) * 255)
  }
  return { data, width: size, height: size, depth: 1 }
}

/**
 * The detail field: a box of `width` × `height` × `depth` texels holding
 * `cells` lattice cells across its width and height and `cellsZ` across
 * its depth (the layer's thickness, which is much less than its tile).
 * Three octaves, the last two at half weight each – enough grain to
 * erode a cloud's edge, not so much that the coverage cells disappear
 * under it.
 */
export function buildDetailField(
  width: number,
  height: number,
  depth: number,
  cells: number,
  cellsZ: number,
): CloudField {
  const data = new Uint8Array(width * height * depth)
  const sx = cells / width
  const sy = cells / height
  const sz = cellsZ / depth
  let i = 0
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = fbm3(x * sx, y * sy, z * sz, cells, cells, cellsZ, 3)
        // -1 … 1 → 0 … 255 (a three-octave sum rarely leaves ±0.8)
        data[i++] = Math.round(Math.min(255, Math.max(0, (v * 0.6 + 0.5) * 255)))
      }
    }
  }
  return { data, width, height, depth }
}

/**
 * The value below which a share of the field's texels lies – the field's
 * own histogram, sorted once. Used to turn a cloud cover in percent into
 * a threshold: at 40 % cover the threshold is the 60th percentile, so
 * the top 40 % of the field is cloud.
 */
export class CoverageQuantiles {
  private readonly sorted: Uint8Array

  constructor(field: CloudField) {
    this.sorted = Uint8Array.from(field.data).sort()
  }

  /** The field value (0 … 1) that `share` (0 … 1) of the texels lie below. */
  quantile(share: number): number {
    const s = Math.min(1, Math.max(0, share))
    const index = Math.min(this.sorted.length - 1, Math.floor(s * this.sorted.length))
    return this.sorted[index] / 255
  }
}

/**
 * Half-width of the transition from clear to cloud around the threshold,
 * in field units. Wide enough to give a cloud a soft edge instead of a
 * contour line, narrow enough that the calibration above still holds.
 */
export const COVERAGE_SOFTNESS = 0.06

/**
 * The threshold the coverage field is cut at for a cloud cover in
 * percent, 0 … 100: the share of the sky the weather says is covered is
 * the share of the field that ends up above it. At 0 % the threshold sits
 * above the highest value plus the softness – not a wisp anywhere; at
 * 100 % below the lowest, so every texel is cloud (their density still
 * follows the field, see the shaders).
 */
export function coverageThreshold(cloudCoverPercent: number, quantiles: CoverageQuantiles): number {
  const cover = Math.min(100, Math.max(0, cloudCoverPercent)) / 100
  if (cover <= 0) return 1 + COVERAGE_SOFTNESS
  if (cover >= 1) return -COVERAGE_SOFTNESS
  return quantiles.quantile(1 - cover)
}

/**
 * How fast the clouds drift, in meters per second east and north, from
 * the wind at 10 m the weather reports (speed in m/s, direction the wind
 * blows FROM in degrees, meteorological). Clouds ride the wind a
 * kilometer up, which over land runs about twice the surface wind – a
 * rule of thumb, not a sounding, but the difference between clouds that
 * crawl and clouds that move.
 */
export const CLOUD_LEVEL_WIND_FACTOR = 1.8

export interface DriftVector {
  eastMps: number
  northMps: number
}

export function cloudDrift(windSpeedMps: number, windFromDeg: number): DriftVector {
  const speed = Math.max(0, windSpeedMps) * CLOUD_LEVEL_WIND_FACTOR
  if (speed === 0) return { eastMps: 0, northMps: 0 }
  const from = (windFromDeg * Math.PI) / 180
  // A wind from the west (270°) blows towards the east
  return { eastMps: -Math.sin(from) * speed, northMps: -Math.cos(from) * speed }
}
