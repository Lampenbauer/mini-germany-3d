import { Cartesian3, Cartographic, SceneTransforms } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stopsHarness } from './stops-test-harness'

/**
 * Stop labels sit on the height the tiles report – and that height depends
 * on the tile LOD currently loaded. Measured from the initial overview
 * camera, a coarse tile sits several meters above the real surface
 * (measured in Rostock: up to ~10 m), which used to leave those labels
 * floating once the camera moved in, because the first measurement was
 * frozen. These tests pin the re-measuring behaviour.
 */

/** Ellipsoidal ground heights a fake tileset reports per LOD. */
const COARSE_HEIGHT = 63.9
const DETAILED_HEIGHT = 57.6

const STOP = { id: 'a', name: 'Test', lon: 12.0866, lat: 54.0996, lines: ['1'] }
/** Ground height the layer starts from (see stopsHarness). */
const BASE_HEIGHT = 45

/** Sampling passes are wall-clock spaced – tests drive that clock. */
const PASS_MS = 500

let clockMs = 0

beforeEach(() => {
  clockMs = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
  // The declutter shares update() with the height pass; off-screen labels
  // keep it out of the way here.
  vi.spyOn(SceneTransforms, 'worldToWindowCoordinates').mockReturnValue(
    undefined as unknown as ReturnType<typeof SceneTransforms.worldToWindowCoordinates>,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

function harness(stops = [STOP]) {
  const h = stopsHarness(stops)
  let tileHeight: number | undefined = COARSE_HEIGHT
  h.sampleGroundHeight.mockImplementation(() => tileHeight)
  return {
    ...h,
    setTileHeight: (height: number | undefined) => {
      tileHeight = height
    },
    /** Camera straight above the first stop, `meters` away from the ground. */
    setCameraDistance: (meters: number) => {
      h.camera.positionWC = Cartesian3.fromDegrees(stops[0].lon, stops[0].lat, BASE_HEIGHT + meters)
    },
    /** Runs one sampling pass (advances the clock past the pass interval). */
    pass: () => {
      clockMs += PASS_MS
      h.layer.update()
    },
    /** Height currently applied to a stop's primitives. */
    heightOf: (index = 0) =>
      Cartographic.fromCartesian(h.disc(index).position).height,
  }
}

describe('stop height refinement', () => {
  it('re-measures a stop once the camera has come substantially closer', () => {
    const h = harness()

    // Overview camera: only coarse tiles are loaded there
    h.setCameraDistance(3600)
    h.pass()
    expect(h.heightOf()).toBeCloseTo(COARSE_HEIGHT + 0.5, 3)

    // Camera moves in, detail tiles arrive – the label must follow down
    // instead of staying frozen in mid-air.
    h.setTileHeight(DETAILED_HEIGHT)
    h.setCameraDistance(400)
    h.pass()
    expect(h.heightOf()).toBeCloseTo(DETAILED_HEIGHT + 0.5, 3)
  })

  it('does not re-measure while the camera stays at a comparable distance', () => {
    const h = harness()

    h.setCameraDistance(1000)
    h.pass()
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(1)

    // 30 % closer is the threshold – 900 m is not enough
    h.setCameraDistance(900)
    h.pass()
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(1)

    h.setCameraDistance(600)
    h.pass()
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(2)
  })

  it('never overrides a height that was bootstrapped most-detailed', () => {
    const h = harness()

    // What CesiumMap's height bootstrap does with its measurement
    h.layer.bootstrapSamples(40)[0].apply(DETAILED_HEIGHT)
    expect(h.heightOf()).toBeCloseTo(DETAILED_HEIGHT + 0.5, 3)

    h.setCameraDistance(50)
    h.pass()
    expect(h.sampleGroundHeight).not.toHaveBeenCalled()
    expect(h.heightOf()).toBeCloseTo(DETAILED_HEIGHT + 0.5, 3)
  })

  it('keeps the previous height and asks again only once the tiles changed when none is loaded there', () => {
    const h = harness()

    h.setCameraDistance(1000)
    h.pass()
    expect(h.heightOf()).toBeCloseTo(COARSE_HEIGHT + 0.5, 3)

    // Camera much closer, but nothing queryable there yet
    h.setTileHeight(undefined)
    h.setCameraDistance(200)
    h.pass()
    expect(h.heightOf()).toBeCloseTo(COARSE_HEIGHT + 0.5, 3)

    // Left alone instead of burning the budget every pass – no tile can
    // have arrived while the surface generation stands
    h.pass()
    clockMs += 5000
    h.pass()
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(2)

    // The tiles changed: asked again, and they have arrived
    h.setTileHeight(DETAILED_HEIGHT)
    h.bumpGeneration()
    h.pass()
    expect(h.heightOf()).toBeCloseTo(DETAILED_HEIGHT + 0.5, 3)
  })

  it('paces passes on the wall clock, not on the simulation tick rate', () => {
    const h = harness()
    h.setCameraDistance(1000)

    h.layer.update()
    h.layer.update()
    h.layer.update()
    // Three ticks inside one interval are still a single pass
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(1)
  })

  it('spends the per-pass budget on the stops nearest to the camera', () => {
    // Six stops, budget is four – the two farthest must wait
    const stops = Array.from({ length: 6 }, (_, i) => ({
      ...STOP,
      id: `s${i}`,
      name: `Stop ${i}`,
      lon: STOP.lon + i * 0.002,
    }))
    const h = harness(stops)
    h.setCameraDistance(300)

    h.pass()
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(4)
    const sampledLons = h.sampleGroundHeight.mock.calls.map((c) => c[0])
    // The four nearest are the first four by longitude offset
    expect(sampledLons.sort()).toEqual(stops.slice(0, 4).map((s) => s.lon).sort())
  })
})
