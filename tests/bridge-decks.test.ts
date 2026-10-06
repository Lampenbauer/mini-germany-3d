import { Cartesian3, Intersect, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import { prepareNetwork } from '@/data/network'
import type { NetworkJson } from '@/data/network-types'
import { BridgeDecks, DECK_MAX_GRADIENT, deckFromSamples, pruneRoofs } from '@/map/bridge-decks'

/**
 * Bridge decks measured on the tiles: the roof pruning and the deck
 * profile as pure functions, and the class on a stubbed camera – which
 * vertices a pass measures, how the deck blends into the profile at the
 * portals, the mirrored direction, the retry and the re-read after a
 * load cycle, and when what changed is published.
 */

/** Samples 100 m apart (25 m: the Stadtbahn's vertex spacing). */
const every100 = (n: number): number[] => Array.from({ length: n }, (_, i) => i * 100)
const every25 = (n: number): number[] => Array.from({ length: n }, (_, i) => i * 25)

describe('pruneRoofs', () => {
  it('marks a run no deck could climb to from its neighbours', () => {
    const pruned = pruneRoofs(every100(7), [10, 10, 25, 25, 25, 10, 10], 0.06)
    expect(pruned).toEqual([false, false, true, true, true, false, false])
  })

  it('leaves a ramp and the hump of a bridge alone', () => {
    expect(pruneRoofs(every100(4), [0, 2, 4, 6], 0.06)).toEqual([false, false, false, false])
    expect(pruneRoofs(every100(5), [0, 2, 3, 2, 0], 0.06)).toEqual([false, false, false, false, false])
  })

  it('prunes a train baked into the survey and a low canopy alike', () => {
    expect(pruneRoofs(every25(3), [10, 13.6, 10], 0.06)).toEqual([false, true, false])
    expect(pruneRoofs(every25(3), [10, 16, 10], 0.06)).toEqual([false, true, false])
  })

  it('drops a hole in the mesh without pulling the deck around it down', () => {
    const pruned = pruneRoofs(every100(5), [60, 60, 50, 60, 60], 0.06)
    expect(pruned).toEqual([false, false, true, false, false])
  })

  it('catches a hall as far as the gradient cone from the deck stays under its roof', () => {
    // 15 m of roof over 300 m: the cone from the deck 200 m away reaches
    // 12 m at the middle, so the whole run is roof
    expect(pruneRoofs(every100(7), [60, 60, 75, 75, 75, 60, 60], 0.06)).toEqual([
      false, false, true, true, true, false, false,
    ])
    // 10 m of roof over the same span: the cone reaches 12 m at the
    // middle sample, which survives as a tent – the known limit
    expect(pruneRoofs(every100(7), [60, 60, 70, 70, 70, 60, 60], 0.06)).toEqual([
      false, false, true, false, true, false, false,
    ])
    // A railway's 3 % reaches only 6 m there: the whole hall goes
    expect(pruneRoofs(every100(7), [60, 60, 70, 70, 70, 60, 60], DECK_MAX_GRADIENT.train)).toEqual(
      [false, false, true, true, true, false, false],
    )
  })
})

describe('deckFromSamples', () => {
  const cum = every100(11)
  const ranges: [number, number][] = [[150, 850]]
  /** The pipeline's straight deck: 50 m all along. */
  const profile = cum.map(() => 50)
  const onBridge = (c: number) => c > 150 && c < 850

  it('takes the samples inside the range and leaves the rest undefined', () => {
    const samples = cum.map((c) => (onBridge(c) ? 60 : undefined))
    const deck = deckFromSamples(cum, samples, profile, ranges, 0.06)
    expect(deck.slice(0, 2)).toEqual([undefined, undefined])
    expect(deck.slice(2, 9)).toEqual([60, 60, 60, 60, 60, 60, 60])
    expect(deck.slice(9)).toEqual([undefined, undefined])
  })

  it('interpolates a roof between the trusted samples around it', () => {
    const samples = cum.map((c) => (onBridge(c) ? (c === 500 ? 80 : 60) : undefined))
    expect(deckFromSamples(cum, samples, profile, ranges, 0.06)[5]).toBe(60)
    const sloped = cum.map((c) =>
      onBridge(c) ? (c === 500 ? 80 : 60 + (c - 200) / 100) : undefined,
    )
    expect(deckFromSamples(cum, sloped, profile, ranges, 0.06)[5]).toBeCloseTo(63, 6)
  })

  it('extends the deck flat under a hall at the end of its range', () => {
    // The range ends under the roof: nothing trusted after it, the roof
    // is pruned as far as the gradient's cone from the last deck sample
    // stays under it, and the deck is extended flat from there
    const samples = cum.map((c) => (onBridge(c) ? (c >= 700 ? 80 : 60) : undefined))
    const deck = deckFromSamples(cum, samples, profile, ranges, 0.06)
    expect(deck[6]).toBe(60)
    expect(deck[7]).toBe(60)
    expect(deck[8]).toBe(60)
  })

  it('leaves a sample that is not clear above the profile to the profile', () => {
    // A ray through a hole in the mesh lands on the street or the water
    // – and a portal's samples sit on the ground the profile has anyway
    const samples = cum.map((c) => (onBridge(c) ? (c <= 300 ? 50.5 : 60) : undefined))
    const deck = deckFromSamples(cum, samples, profile, ranges, 0.06)
    expect(deck[2]).toBeUndefined()
    expect(deck[3]).toBeUndefined()
    expect(deck[4]).toBe(60)
  })

  it('keeps a weak sample on its own where no deck encloses it', () => {
    // A low bridge: the deck stands 1.3 m over the profile all along
    const low = cum.map((c) => (onBridge(c) ? 51.3 : undefined))
    expect(deckFromSamples(cum, low, profile, ranges, 0.06)[5]).toBe(51.3)
    // The same value inside a viaduct is a hole to the street: bridged
    const hole = cum.map((c) => (onBridge(c) ? (c === 500 ? 51.3 : 60) : undefined))
    expect(deckFromSamples(cum, hole, profile, ranges, 0.06)[5]).toBe(60)
    // And a weak sample never pulls a deck sample down
    const edge = cum.map((c) => (onBridge(c) ? (c <= 300 ? 51.3 : 60) : undefined))
    const deck = deckFromSamples(cum, edge, profile, ranges, 0.06)
    expect(deck[3]).toBe(51.3)
    expect(deck[4]).toBe(60)
  })

  it('bridges a hole enclosed by deck within reach, not a wide one', () => {
    const narrow = cum.map((c) => (onBridge(c) ? (c === 500 ? 46 : 60) : undefined))
    expect(deckFromSamples(cum, narrow, profile, ranges, 0.06)[5]).toBe(60)
    const wide = cum.map((c) => (onBridge(c) ? (c >= 400 && c <= 600 ? 46 : 60) : undefined))
    const deck = deckFromSamples(cum, wide, profile, ranges, 0.06)
    expect(deck[3]).toBe(60)
    expect(deck[4]).toBeUndefined()
    expect(deck[5]).toBeUndefined()
    expect(deck[7]).toBe(60)
  })

  it('does not let a hole pull the deck around it down', () => {
    // Under the old envelope alone a sample at water level would have
    // drawn a 6 % cone through 100 m of deck on either side
    const samples = cum.map((c) => (onBridge(c) ? (c === 500 ? 46 : 62) : undefined))
    const deck = deckFromSamples(cum, samples, profile, ranges, 0.06)
    expect(deck[4]).toBe(62)
    expect(deck[6]).toBe(62)
  })

  it('takes a sample hundreds of metres over the profile for no deck', () => {
    // A coarse tile answered 478 m over a bus bridge 16 m high: alone in
    // its range the sample leaves the profile standing, between decks it
    // is a roof interpolated across
    const alone = cum.map((c) => (c === 500 ? 478 : undefined))
    expect(deckFromSamples(cum, alone, profile, ranges, 0.06)[5]).toBeUndefined()
    const between = cum.map((c) => (onBridge(c) ? (c === 500 ? 478 : 60) : undefined))
    expect(deckFromSamples(cum, between, profile, ranges, 0.06)[5]).toBe(60)
    // A high deck is still a deck: the Köhlbrandbrücke stands 55 m over the water
    const high = cum.map((c) => (onBridge(c) ? 105 : undefined))
    expect(deckFromSamples(cum, high, profile, ranges, 0.06)[5]).toBe(105)
  })

  it('ignores samples outside every range and unmeasured vertices', () => {
    const samples = cum.map((c) => (c === 300 || c === 0 ? 60 : undefined))
    const deck = deckFromSamples(cum, samples, profile, ranges, 0.06)
    expect(deck[0]).toBeUndefined()
    expect(deck[3]).toBe(60)
    expect(deck[4]).toBeUndefined()
  })
})

/**
 * A straight south–north line of eleven vertices ~100 m apart, on a
 * 10 m NHN profile, with a bridge from 150 m to 850 m: seven interior
 * vertices, and stations every 30 m or less between them and the range's
 * ends – one in each 50 m end gap, three in each 100 m gap, 27 points.
 * One direction – the other is mirrored.
 */
const POINTS = 7 + 2 * 1 + 6 * 3

function bridgeNetwork(): NetworkJson {
  const path = Array.from({ length: 11 }, (_, i): [number, number] => [12.1, 54 + i * 0.0009])
  return {
    meta: { source: 'osm', attribution: 'test' },
    stops: {
      a: { name: 'Alpha', coord: [12.1, 54] },
      b: { name: 'Beta', coord: [12.1, 54.009] },
    },
    lines: [
      {
        id: 'S',
        name: 'S3',
        color: '#00aa88',
        mode: 'train',
        directions: [
          {
            from: 'Alpha',
            to: 'Beta',
            path,
            stops: ['a', 'b'],
            bridges: [[150, 850]],
            heights: path.map(() => 10),
          },
        ],
      },
    ],
  }
}

/** The NHN→ellipsoid offset the profile is drawn at (10 m NHN → 50 m). */
const OFFSET = 40

function harness({
  surface = () => 60,
  frustum = Intersect.INTERSECTING,
}: {
  surface?: (lon: number, lat: number) => number | undefined
  frustum?: Intersect
} = {}) {
  const viewer = {
    camera: {
      positionWC: Cartesian3.fromDegrees(12.1, 54.0045, 1500),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: { computeCullingVolume: () => ({ computeVisibility: () => frustum }) },
    },
  } as unknown as Viewer
  let generation = 0
  const deckChanged = vi.fn()
  const requestRender = vi.fn()
  const sample = vi.fn(surface)
  const decks = new BridgeDecks(viewer, {
    sampleSurfaceHeight: sample,
    surfaceGeneration: () => generation,
    deckChanged,
    routeHeightOffset: () => OFFSET,
    requestRender,
  })
  decks.add(prepareNetwork(bridgeNetwork()))
  /** Runs `passes` passes 300 ms apart from `from`, returns the time after the last. */
  const passes = (from: number, count: number): number => {
    for (let i = 0; i < count; i++) decks.update(from + i * 300)
    return from + count * 300
  }
  return {
    decks,
    sample,
    deckChanged,
    requestRender,
    passes,
    bumpGeneration: () => generation++,
  }
}

describe('BridgeDecks', () => {
  it('registers the points inside the bridge range, once for both directions', () => {
    const h = harness()
    expect(h.decks.info).toEqual({ directions: 1, vertices: POINTS, measured: 0, roofs: 0, low: 0 })
    expect(h.decks.stationsBetween('S', 0, 100, 200).map((s) => Math.round(s.cum))).toEqual([175])
    expect(h.decks.stationsBetween('S', 0, 200, 300).map((s) => Math.round(s.cum))).toEqual([
      225, 250, 275,
    ])
    // The mirrored direction sees the same stations from its own end
    const total = prepareNetwork(bridgeNetwork()).lines[0].directions[0].totalLength
    expect(
      h.decks.stationsBetween('S', 1, total - 300, total - 200).map((s) => Math.round(s.cum)),
    ).toEqual([Math.round(total - 275), Math.round(total - 250), Math.round(total - 225)])
  })

  it('measures a budget of points per pass and publishes what changed', () => {
    const h = harness()
    h.decks.update(1000)
    expect(h.sample).toHaveBeenCalledTimes(6)
    expect(h.deckChanged).toHaveBeenCalledWith('S', 0)
    expect(h.decks.info.measured).toBe(6)
    // Within the pass interval nothing happens; after it the next six follow
    h.decks.update(1100)
    expect(h.sample).toHaveBeenCalledTimes(6)
    h.decks.update(1300)
    expect(h.decks.info.measured).toBe(12)
    h.passes(1600, 4)
    expect(h.decks.info.measured).toBe(POINTS)
    expect(h.sample).toHaveBeenCalledTimes(POINTS)
    // Everything read at this generation – a further pass costs no ray
    h.decks.update(4000)
    expect(h.sample).toHaveBeenCalledTimes(POINTS)
  })

  it('publishes only when let, and then everything that changed in one go', () => {
    const h = harness()
    h.decks.update(1000, false)
    expect(h.decks.info.measured).toBe(6)
    expect(h.deckChanged).not.toHaveBeenCalled()
    expect(h.requestRender).not.toHaveBeenCalled()
    // Still nothing published: the deck the vehicles read is unchanged
    expect(h.decks.heightAt('S', 0, 500, OFFSET)).toBeUndefined()
    h.decks.update(1300, false)
    expect(h.decks.info.measured).toBe(12)
    expect(h.deckChanged).not.toHaveBeenCalled()
    // Let: the direction is announced once, for both passes' points
    h.decks.update(1600, true)
    expect(h.deckChanged).toHaveBeenCalledTimes(1)
    expect(h.deckChanged).toHaveBeenCalledWith('S', 0)
    expect(h.requestRender).toHaveBeenCalledTimes(1)
    expect(h.decks.heightAt('S', 0, 500, OFFSET)).toBeCloseTo(60, 6)
    // Nothing changed since: a pass that may publish announces nothing
    h.passes(1900, 4)
    const calls = h.deckChanged.mock.calls.length
    h.decks.update(4000, true)
    expect(h.deckChanged).toHaveBeenCalledTimes(calls)
  })

  it('rides the measured deck inside the bridge and blends into the profile at the portals', () => {
    const h = harness()
    const t = h.passes(1000, 6)
    h.decks.update(t + 1000)
    expect(h.decks.heightAt('S', 0, 500, OFFSET)).toBeCloseTo(60, 6)
    // The vertex at 100 m is profile (10 + 40), the station at 175 m deck (60)
    expect(h.decks.heightAt('S', 0, 150, OFFSET)).toBeCloseTo(50 + (10 * 50) / 75, 1)
    // Outside any measured point the profile applies (undefined)
    expect(h.decks.heightAt('S', 0, 50, OFFSET)).toBeUndefined()
    expect(h.decks.heightAt('S', 0, 1000, OFFSET)).toBeUndefined()
  })

  it('serves the mirrored direction from the same deck', () => {
    const h = harness()
    const t = h.passes(1000, 6)
    h.decks.update(t + 1000)
    const total = prepareNetwork(bridgeNetwork()).lines[0].directions[0].totalLength
    expect(h.decks.heightAt('S', 1, total - 500, OFFSET)).toBeCloseTo(60, 6)
    expect(h.decks.heightAt('S', 1, total - 150, OFFSET)).toBeCloseTo(50 + (10 * 50) / 75, 1)
  })

  it('prunes a hall roof out of the measured deck', () => {
    const h = harness({ surface: (_lon, lat) => (Math.abs(lat - 54.0045) < 0.0001 ? 85 : 60) })
    const t = h.passes(1000, 6)
    h.decks.update(t + 1000)
    expect(h.decks.info.roofs).toBe(1)
    expect(h.decks.heightAt('S', 0, 500, OFFSET)).toBeCloseTo(60, 6)
  })

  it('asks a point no tile has answered for again only after a load cycle, like an answered one', () => {
    let answer: number | undefined = undefined
    const h = harness({ surface: () => answer })
    // Every point gets one ray and rests until the tiles change – the
    // same tiles cannot answer differently
    h.passes(1000, 6)
    expect(h.sample).toHaveBeenCalledTimes(POINTS)
    expect(h.deckChanged).not.toHaveBeenCalled()
    h.passes(2900, 6)
    expect(h.sample).toHaveBeenCalledTimes(POINTS)
    answer = 60
    h.bumpGeneration()
    h.decks.update(5100)
    expect(h.decks.info.measured).toBe(6)
    h.passes(5400, 6)
    expect(h.decks.info.measured).toBe(POINTS)
    // A load cycle finished: every point on screen is read again
    const before = h.sample.mock.calls.length
    h.bumpGeneration()
    h.passes(7500, 6)
    expect(h.sample.mock.calls.length).toBe(before + POINTS)
  })

  it('measures nothing off screen and forgets everything on clear', () => {
    const h = harness({ frustum: Intersect.OUTSIDE })
    h.decks.update(1000)
    expect(h.sample).not.toHaveBeenCalled()
    h.decks.clear()
    expect(h.decks.info).toEqual({ directions: 0, vertices: 0, measured: 0, roofs: 0, low: 0 })
    expect(h.decks.stationsBetween('S', 0, 0, 1000)).toEqual([])
  })
})
