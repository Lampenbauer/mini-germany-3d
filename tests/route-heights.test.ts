import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ATTRIBUTION,
  MapterhornSampler,
  TILE_SIZE,
  heightsFromPixels,
  lonLatToPixel,
  terrainAttribution,
  terrariumHeight,
} from '../scripts/lib/terrain.mjs'
import {
  applyBridgeProfile,
  fillHeightGaps,
  heightAtDistance,
  indexPreviousHeights,
  normalizeRanges,
  sameTerrainSource,
  withTerrainAttribution,
} from '../scripts/lib/route-heights.mjs'
import { prepareNetwork } from '@/data/network'
import { testNetworkJson } from './fixtures'
import type { NetworkJson } from '@/data/network-types'

describe('terrarium encoding', () => {
  it('decodes R·256 + G + B/256 − 32768', () => {
    expect(terrariumHeight(0, 0, 0)).toBe(-32768)
    expect(terrariumHeight(128, 0, 0)).toBe(0)
    expect(terrariumHeight(128, 10, 128)).toBe(10.5)
  })

  it('reads interleaved pixels whatever their channel count', () => {
    const rgba = [128, 1, 0, 255, 128, 2, 64, 255]
    expect(Array.from(heightsFromPixels(rgba, 4))).toEqual([1, 2.25])
    expect(Array.from(heightsFromPixels([128, 3, 0], 3))).toEqual([3])
  })
})

describe('lonLatToPixel', () => {
  it('puts the origin at the center of the single z0 tile', () => {
    expect(lonLatToPixel(0, 0, 0)).toEqual([TILE_SIZE / 2, TILE_SIZE / 2])
  })

  it('lands a known position on the z15 tile the live endpoint serves it from', () => {
    // 15/17294/10590 – checked against tiles.mapterhorn.com.
    const [px, py] = lonLatToPixel(10.0, 53.55, 15)
    expect(Math.floor(px / TILE_SIZE)).toBe(17294)
    expect(Math.floor(py / TILE_SIZE)).toBe(10590)
  })
})

/** Inverse of lonLatToPixel, so a test can ask for an exact pixel position. */
function lonLatFromPixel(px: number, py: number, zoom: number): [number, number] {
  const size = 2 ** zoom * TILE_SIZE
  const lon = (px / size) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / size))) * 180) / Math.PI
  return [lon, lat]
}

/**
 * A fake tile server plus decoder: every tile's bytes spell out its
 * z/x/y, and decoding paints the plane h = gx + gy / 1024 in global pixel
 * coordinates of that zoom – bilinear interpolation of a plane is exact,
 * so a sample must read back the position it was taken at.
 */
function fakeTiles(opts: { missingZooms?: number[]; fail?: boolean } = {}) {
  const fetched: string[] = []
  let decodes = 0
  const fetchImpl = async (url: string) => {
    const match = /(\d+)\/(\d+)\/(\d+)\.webp$/.exec(url)!
    const key = `${match[1]}/${match[2]}/${match[3]}`
    fetched.push(key)
    if (opts.fail) throw new Error('connection reset')
    if (opts.missingZooms?.includes(Number(match[1]))) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const bytes = new TextEncoder().encode(key)
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
  }
  const decodeImpl = (bytes: Uint8Array) => {
    decodes++
    const [, x, y] = new TextDecoder().decode(bytes).split('/').map(Number)
    const heights = new Float32Array(TILE_SIZE * TILE_SIZE)
    for (let j = 0; j < TILE_SIZE; j++) {
      for (let i = 0; i < TILE_SIZE; i++) {
        heights[j * TILE_SIZE + i] = x * TILE_SIZE + i + (y * TILE_SIZE + j) / 1024
      }
    }
    return heights
  }
  return { fetchImpl, decodeImpl, fetched, decodes: () => decodes }
}

const plane = (px: number, py: number) => px - 0.5 + (py - 0.5) / 1024

describe('MapterhornSampler', () => {
  it('interpolates bilinearly between the pixel centers of one tile', async () => {
    const fake = fakeTiles()
    const sampler = new MapterhornSampler({ zoom: 3, minZoom: 1, ...fake, retryDelayMs: 0 })
    const [px, py] = [1000.25, 700.75]
    const h = await sampler.heightAt(...lonLatFromPixel(px, py, 3))
    expect(h).toBeCloseTo(plane(px, py), 3)
    expect(fake.fetched).toEqual(['3/1/1'])
    expect(sampler.stats).toEqual({ tiles: 1, bytes: 5, failedTiles: 0 })
  })

  it('fetches the neighbor tile where the footprint straddles an edge', async () => {
    const fake = fakeTiles()
    const sampler = new MapterhornSampler({ zoom: 3, minZoom: 1, ...fake, retryDelayMs: 0 })
    // 0.3 px into tile 1: the western pair of corners lies in tile 0.
    const [px, py] = [TILE_SIZE + 0.3, 700]
    const h = await sampler.heightAt(...lonLatFromPixel(px, py, 3))
    expect(h).toBeCloseTo(plane(px, py), 3)
    expect(fake.fetched.sort()).toEqual(['3/0/1', '3/1/1'])
  })

  it('answers one level coarser where the zoom has no tile', async () => {
    const fake = fakeTiles({ missingZooms: [5, 4] })
    const sampler = new MapterhornSampler({ zoom: 5, minZoom: 1, ...fake, retryDelayMs: 0 })
    const lonLat = lonLatFromPixel(4000.5, 3000.5, 5)
    const h = await sampler.heightAt(...lonLat)
    const [px3, py3] = lonLatToPixel(lonLat[0], lonLat[1], 3)
    expect(h).toBeCloseTo(plane(px3, py3), 3)
    expect(fake.fetched.map((k) => k.split('/')[0])).toEqual(['5', '4', '3'])
    // The 404s are remembered – a second point in the same tiles asks once.
    await sampler.heightAt(...lonLatFromPixel(4010, 3010, 5))
    expect(fake.fetched).toHaveLength(3)
  })

  it('gives up on an unreachable server without guessing', async () => {
    const fake = fakeTiles({ fail: true })
    const sampler = new MapterhornSampler({ zoom: 3, minZoom: 1, ...fake, retryDelayMs: 0 })
    const lonLat = lonLatFromPixel(1000, 700, 3)
    expect(await sampler.heightAt(...lonLat)).toBeUndefined()
    expect(sampler.stats.failedTiles).toBe(1)
    // One retry, then the failure is remembered for the run.
    expect(fake.fetched).toEqual(['3/1/1', '3/1/1'])
    expect(await sampler.heightAt(...lonLat)).toBeUndefined()
    expect(fake.fetched).toHaveLength(2)
  })

  it('keeps every tile fetched but only a few decoded', async () => {
    const fake = fakeTiles()
    const sampler = new MapterhornSampler({ zoom: 3, minZoom: 1, ...fake, retryDelayMs: 0, maxDecodedTiles: 2 })
    const tiles: [number, number][] = [
      [100, 100],
      [700, 100],
      [1300, 100],
    ]
    for (const [px, py] of tiles) await sampler.heightAt(...lonLatFromPixel(px, py, 3))
    expect(fake.fetched).toEqual(['3/0/0', '3/1/0', '3/2/0'])
    expect(fake.decodes()).toBe(3)
    // Back to the first tile: evicted from the decoded set, so decoded
    // again – from the bytes kept in memory, not from the server.
    await sampler.heightAt(...lonLatFromPixel(100, 100, 3))
    expect(fake.fetched).toHaveLength(3)
    expect(fake.decodes()).toBe(4)
    // The most recently used one is still decoded.
    await sampler.heightAt(...lonLatFromPixel(1300, 100, 3))
    expect(fake.decodes()).toBe(4)
  })
})

describe('terrain attribution', () => {
  it('names Mapterhorn when a city names no source of its own', () => {
    expect(terrainAttribution({ terrain: {} })).toBe(DEFAULT_ATTRIBUTION)
    expect(terrainAttribution({ terrain: { attribution: 'Terrain © X.' } })).toBe('Terrain © X.')
  })

  it('lets a previous file lend its heights only for the same source', () => {
    const attribution = 'Terrain heights © Mapterhorn (mapterhorn.com).'
    const prev = { meta: { attribution: `Routes © OSM. ${attribution}`, terrainAttribution: attribution } }
    expect(sameTerrainSource(prev, attribution)).toBe(true)
    expect(sameTerrainSource({ meta: { terrainAttribution: 'Terrain © X (z16).' } }, attribution)).toBe(false)
    // Files from before the field existed came from the state services.
    expect(sameTerrainSource({ meta: { attribution: `Routes © OSM. ${attribution}` } }, attribution)).toBe(false)
    expect(sameTerrainSource(null, attribution)).toBe(false)
  })

  it('appends the terrain line once and replaces it on a source change', () => {
    const osm = 'Route and stop data © OpenStreetMap contributors (ODbL 1.0).'
    const old = 'Terrain heights © GeoBasis-DE/M-V (DGM via WCS).'
    const line = 'Terrain heights © Mapterhorn (mapterhorn.com).'
    // Fresh from data:update
    const first = withTerrainAttribution({ source: 'osm', attribution: osm }, line)
    expect(first).toEqual({ source: 'osm', attribution: `${osm} ${line}`, terrainAttribution: line })
    // Rerun on the enriched file: byte-stable
    expect(withTerrainAttribution(first, line)).toEqual(first)
    // Source change: the recorded line goes, the new one comes
    expect(withTerrainAttribution(first, old)).toEqual({ source: 'osm', attribution: `${osm} ${old}`, terrainAttribution: old })
    // A file from before the field existed that already carries the line
    expect(withTerrainAttribution({ attribution: `${osm} ${line}` }, line)).toEqual({ attribution: `${osm} ${line}`, terrainAttribution: line })
    expect(withTerrainAttribution({}, line)).toEqual({ attribution: line, terrainAttribution: line })
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
  // Neutral options isolate the pure anchor interpolation.
  const plain = { anchorSetbackMeters: 0, deckClearanceMeters: 0, portalFeatherMeters: 0 }

  it('replaces the terrain dip under a bridge with a straight deck', () => {
    const cum = [0, 100, 200, 300, 400]
    // Terrain dips to 0 (water) in the middle; bridge spans 50–350 m
    const heights = [12, 6, 0, 6, 12]
    applyBridgeProfile(heights, cum, [[50, 350]], plain)
    // Deck ends: terrain at 50 m = 9, at 350 m = 9 → linear in between
    expect(heights[1]).toBeCloseTo(9, 5)
    expect(heights[2]).toBeCloseTo(9, 5)
    expect(heights[3]).toBeCloseTo(9, 5)
    expect(heights[0]).toBe(12)
    expect(heights[4]).toBe(12)
  })

  it('samples anchors outside the range so edge dips cannot pull the deck down', () => {
    const cum = [0, 100, 200, 300, 400]
    // Terrain right at the boundary (100 m) already dips into the void
    const heights = [10, 4, 0, 4, 10]
    applyBridgeProfile(heights, cum, [[100, 300]], { ...plain, anchorSetbackMeters: 50 })
    // Anchors at 50 m / 350 m → terrain 7 on both sides, not the dipped 4
    expect(heights[2]).toBeCloseTo(7, 5)
  })

  it('adds the deck clearance feathered in from the portals', () => {
    const cum = [0, 10, 100, 190, 200]
    const heights = [5, 5, 0, 5, 5]
    applyBridgeProfile(heights, cum, [[0, 200]], {
      ...plain,
      deckClearanceMeters: 1,
      portalFeatherMeters: 20,
    })
    // 10 m into the bridge: half the feather ramp → +0.5
    expect(heights[1]).toBeCloseTo(5.5, 5)
    // Mid-span: full clearance → 5 + 1
    expect(heights[2]).toBeCloseTo(6, 5)
    // 10 m before the end: half ramp again
    expect(heights[3]).toBeCloseTo(5.5, 5)
  })

  it('reads anchors from the pristine terrain even with adjacent ranges', () => {
    const cum = [0, 100, 200, 300, 400]
    const heights = [8, 2, 8, 2, 8]
    // Second range's start anchor (at 200 m with setback 0) must see the
    // original terrain 8, not a value mutated by the first range.
    applyBridgeProfile(
      heights,
      cum,
      [
        [50, 150],
        [200, 380],
      ],
      plain,
    )
    expect(heights[3]).toBeGreaterThan(2)
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
