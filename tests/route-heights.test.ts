import { describe, expect, it } from 'vitest'
import { lonLatToUtm33, parseFloat32Tiff, sampleTile } from '../scripts/lib/dgm.mjs'
import {
  applyBridgeProfile,
  fillHeightGaps,
  heightAtDistance,
  indexPreviousHeights,
  normalizeRanges,
} from '../scripts/lib/route-heights.mjs'
import { prepareNetwork } from '@/data/network'
import { testNetworkJson } from './fixtures'
import type { NetworkJson } from '@/data/network-types'

describe('lonLatToUtm33', () => {
  it('maps Rostock into the EPSG:25833 coverage window of the MV DGM', () => {
    // Reference values computed with proj4 (EPSG:4326 → ETRS89 / UTM 33N);
    // the WCS coverage envelope is x 200000–465000, y 5886000–6075000.
    const [x, y] = lonLatToUtm33(12.123295, 54.084875)
    expect(x).toBeCloseTo(311841.7, 0)
    expect(y).toBeCloseTo(5996791.8, 0)
  })
})

/**
 * Builds the exact TIFF flavor the WCS delivers: little-endian, single
 * strip, float32, 5 m pixel scale, raster origin at world (1000, 2000).
 * `omitTiepoint` produces a file without georeferencing for the error case.
 */
function syntheticTile(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
  omitTiepoint = false,
) {
  const entries = omitTiepoint ? 8 : 9
  const headerSize = 8
  const ifdSize = 2 + entries * 12 + 4
  const scaleOffset = headerSize + ifdSize
  const tieOffset = scaleOffset + 3 * 8
  const dataOffset = tieOffset + 6 * 8
  const bytes = new Uint8Array(dataOffset + width * height * 4)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, headerSize, true)
  view.setUint16(headerSize, entries, true)
  const entry = (i: number, tag: number, type: number, count: number, val: number) => {
    const off = headerSize + 2 + i * 12
    view.setUint16(off, tag, true)
    view.setUint16(off + 2, type, true)
    view.setUint32(off + 4, count, true)
    view.setUint32(off + 8, val, true)
  }
  entry(0, 256, 4, 1, width)
  entry(1, 257, 4, 1, height)
  entry(2, 258, 3, 1, 32)
  entry(3, 273, 4, 1, dataOffset)
  entry(4, 278, 4, 1, height)
  entry(5, 279, 4, 1, width * height * 4)
  entry(6, 339, 3, 1, 3)
  entry(7, 33550, 12, 3, scaleOffset)
  view.setFloat64(scaleOffset, 5, true) // 5 m per pixel
  view.setFloat64(scaleOffset + 8, 5, true)
  view.setFloat64(scaleOffset + 16, 0, true)
  if (!omitTiepoint) {
    entry(8, 33922, 12, 6, tieOffset)
    const tiepoint = [0, 0, 0, 1000, 2000, 0] // raster (0,0) = world (1000, 2000)
    tiepoint.forEach((v, i) => view.setFloat64(tieOffset + i * 8, v, true))
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      view.setFloat32(dataOffset + (y * width + x) * 4, value(x, y), true)
    }
  }
  return bytes
}

describe('parseFloat32Tiff / sampleTile', () => {
  it('parses dimensions, georeferencing, and pixel values', () => {
    const tile = parseFloat32Tiff(syntheticTile(4, 3, (x, y) => 10 + x + y * 4))
    expect(tile.width).toBe(4)
    expect(tile.height).toBe(3)
    expect(tile.originX).toBe(1000)
    expect(tile.originY).toBe(2000)
    expect(tile.scaleX).toBe(5)
    expect(tile.data[0]).toBe(10)
    expect(tile.data[4 * 3 - 1]).toBe(10 + 3 + 2 * 4)
  })

  it('rejects TIFFs without georeferencing tags', () => {
    expect(() => parseFloat32Tiff(syntheticTile(2, 2, () => 1, true))).toThrow(/georeferencing/)
  })

  it('interpolates bilinearly between grid cells', () => {
    // Height rises 1 m per pixel eastward → 0.2 m per meter at 5 m grid
    const tile = parseFloat32Tiff(syntheticTile(4, 4, (x) => 10 + x))
    // Pixel centers are at originX + (px + 0.5) * scale = 1002.5, 1007.5, …
    expect(sampleTile(tile, 1002.5, 1990)).toBeCloseTo(10, 5)
    expect(sampleTile(tile, 1007.5, 1990)).toBeCloseTo(11, 5)
    expect(sampleTile(tile, 1005.0, 1990)).toBeCloseTo(10.5, 5)
  })

  it('falls back to the nearest valid corner next to nodata', () => {
    const NODATA = -3.4e38
    const tile = parseFloat32Tiff(syntheticTile(2, 2, (x) => (x === 0 ? 7 : NODATA)))
    // Between the pixel centers (1002.5/1007.5 × 1997.5/1992.5): the east
    // column is nodata, the nearest valid corner in the west supplies 7.
    expect(sampleTile(tile, 1003, 1995)).toBe(7)
  })

  it('returns undefined outside the tile and on all-nodata cells', () => {
    const tile = parseFloat32Tiff(syntheticTile(2, 2, () => -3.4e38))
    expect(sampleTile(tile, 1005, 1995)).toBeUndefined()
    const ok = parseFloat32Tiff(syntheticTile(2, 2, () => 5))
    expect(sampleTile(ok, 900, 1995)).toBeUndefined()
  })
})

describe('fillHeightGaps', () => {
  const cum = [0, 100, 200, 300, 400]

  it('interpolates interior gaps by distance and extends the ends flat', () => {
    const heights = [undefined, 10, undefined, 16, undefined]
    expect(fillHeightGaps(heights, cum)).toBe(3)
    expect(heights).toEqual([10, 10, 13, 16, 16])
  })

  it('returns -1 when nothing is valid', () => {
    expect(fillHeightGaps([undefined, undefined], [0, 100])).toBe(-1)
  })
})

describe('applyBridgeProfile', () => {
  it('replaces the terrain dip under a bridge with a straight deck', () => {
    const cum = [0, 100, 200, 300, 400]
    // Terrain dips to 0 (water) in the middle; bridge spans 50–350 m
    const heights = [12, 6, 0, 6, 12]
    applyBridgeProfile(heights, cum, [[50, 350]])
    // Deck ends: terrain at 50 m = 9, at 350 m = 9 → linear in between
    expect(heights[1]).toBeCloseTo(9, 5)
    expect(heights[2]).toBeCloseTo(9, 5)
    expect(heights[3]).toBeCloseTo(9, 5)
    expect(heights[0]).toBe(12)
    expect(heights[4]).toBe(12)
  })
})

describe('heightAtDistance / normalizeRanges', () => {
  it('interpolates along the cumulative distances', () => {
    expect(heightAtDistance([10, 20], [0, 100], 25)).toBeCloseTo(12.5)
    expect(heightAtDistance([10, 20], [0, 100], -5)).toBe(10)
    expect(heightAtDistance([10, 20], [0, 100], 500)).toBe(20)
  })

  it('normalizes raw ranges like the tunnel logic', () => {
    expect(
      normalizeRanges(
        [
          [300, 250],
          [-20, 50],
          [40, 120],
        ],
        200,
      ),
    ).toEqual([[0, 120]])
  })
})

describe('indexPreviousHeights', () => {
  const prev = {
    stops: {
      a: { name: 'Alpha', coord: [12.1, 54.0], nhn: 7.5 },
      b: { name: 'Beta', coord: [12.2, 54.1] }, // no nhn
    },
    lines: [
      {
        id: 'T',
        directions: [
          { path: [[12.1, 54.0], [12.2, 54.1]], heights: [7.5, 9.1] },
          { path: [[12.2, 54.1], [12.1, 54.0]], heights: [9.1] }, // length mismatch
        ],
      },
    ],
  }

  it('indexes directions by geometry and stops by id + coordinate', () => {
    const { heightsByPath, nhnByStop } = indexPreviousHeights(prev)
    expect(heightsByPath.get(JSON.stringify([[12.1, 54.0], [12.2, 54.1]]))).toEqual([7.5, 9.1])
    expect(nhnByStop.get('a:12.1:54')).toBe(7.5)
    expect(nhnByStop.has('b:12.2:54.1')).toBe(false)
  })

  it('skips directions whose heights do not match their path', () => {
    const { heightsByPath } = indexPreviousHeights(prev)
    expect(heightsByPath.has(JSON.stringify([[12.2, 54.1], [12.1, 54.0]]))).toBe(false)
  })

  it('tolerates missing or malformed previous data', () => {
    expect(indexPreviousHeights(null).heightsByPath.size).toBe(0)
    expect(indexPreviousHeights({}).nhnByStop.size).toBe(0)
  })
})

describe('prepareNetwork with height data', () => {
  const withHeights: NetworkJson = JSON.parse(JSON.stringify(testNetworkJson))
  withHeights.lines[0].directions[0].heights = [5, 8, 11]
  withHeights.stops.b.nhn = 8.2

  it('passes validated heights through and mirrors them onto direction 1', () => {
    const network = prepareNetwork(withHeights)
    const [dir0, dir1] = network.lineById.get('T')!.directions
    expect(dir0.heights).toEqual([5, 8, 11])
    expect(dir1.heights).toEqual([11, 8, 5])
  })

  it('exposes stop NHN heights on the prepared stops', () => {
    const network = prepareNetwork(withHeights)
    const dir0 = network.lineById.get('T')!.directions[0]
    expect(dir0.stops.find((s) => s.id === 'b')?.nhn).toBe(8.2)
    expect(dir0.stops.find((s) => s.id === 'a')?.nhn).toBeUndefined()
  })

  it('drops heights that do not match the path vertex count', () => {
    const broken: NetworkJson = JSON.parse(JSON.stringify(withHeights))
    broken.lines[0].directions[0].heights = [5, 8]
    const network = prepareNetwork(broken)
    expect(network.lineById.get('T')!.directions[0].heights).toBeUndefined()
    expect(network.lineById.get('T')!.directions[1].heights).toBeUndefined()
  })
})
