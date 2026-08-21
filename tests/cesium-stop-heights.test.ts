import { Cartesian3, Cartographic } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CesiumMap } from '@/map/CesiumMap'

/**
 * Stop labels sit on the height tileset.getHeight() reports – and that
 * height depends on the tile LOD currently loaded. Measured from the initial
 * overview camera, a coarse tile sits several meters above the real surface
 * (measured in Rostock: up to ~10 m), which used to leave those labels
 * floating once the camera moved in, because the first measurement was
 * frozen. These tests pin the re-measuring behaviour.
 */

/** Ellipsoidal ground heights a fake tileset reports per LOD. */
const COARSE_HEIGHT = 63.9
const DETAILED_HEIGHT = 57.6

const STOP = { lon: 12.0866, lat: 54.0996 }

/** Sampling passes are wall-clock spaced – tests drive that clock. */
const PASS_MS = 500

let clockMs = 0

beforeEach(() => {
  clockMs = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Runs one sampling pass (advances the clock past the pass interval). */
const pass = (map: CesiumMap): void => {
  clockMs += PASS_MS
  ;(map as unknown as { resolveStopHeights: () => void }).resolveStopHeights()
}

interface Harness {
  map: CesiumMap
  /** Height currently reported by the fake tileset. */
  setTileHeight: (height: number | undefined) => void
  /** Moves the fake camera to a distance (in meters) from the stop. */
  setCameraDistance: (meters: number) => void
  getHeight: ReturnType<typeof vi.fn>
  stop: { disc: { position: unknown }; label: { position: unknown }; sampledFrom: number }
  /** Height currently applied to the stop primitives. */
  entityHeight: () => number
}

function harness(sampledFrom = Number.POSITIVE_INFINITY): Harness {
  let tileHeight: number | undefined = COARSE_HEIGHT
  const getHeight = vi.fn(() => tileHeight)

  const stopPosition = Cartesian3.fromDegrees(STOP.lon, STOP.lat, 45)
  const stop = {
    disc: { position: undefined as unknown },
    label: { position: undefined as unknown },
    lon: STOP.lon,
    lat: STOP.lat,
    position: stopPosition,
    sampledFrom,
    retryAfter: 0,
  }

  // Camera straight above the stop – its distance is then purely the height
  // difference, which keeps the approach steps easy to reason about.
  const camera = { positionWC: Cartesian3.clone(stopPosition) }

  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    viewer: { camera, scene: {} },
    googleTileset: { getHeight },
    stopRecords: [stop],
    lastStopSampleAt: 0,
  })

  return {
    map,
    getHeight,
    stop,
    setTileHeight: (height) => {
      tileHeight = height
    },
    setCameraDistance: (meters) => {
      camera.positionWC = Cartesian3.fromDegrees(STOP.lon, STOP.lat, 45 + meters)
    },
    entityHeight: () => {
      // Disc and label always get the same position – checking one suffices
      return Cartographic.fromCartesian(stop.disc.position as Cartesian3).height
    },
  }
}

describe('stop height refinement', () => {
  it('re-measures a stop once the camera has come substantially closer', () => {
    const h = harness()

    // Overview camera: only coarse tiles are loaded there
    h.setCameraDistance(3600)
    pass(h.map)
    expect(h.entityHeight()).toBeCloseTo(COARSE_HEIGHT + 0.5, 3)
    expect(h.stop.sampledFrom).toBeCloseTo(3600, 0)

    // Camera moves in, detail tiles arrive – the label must follow down
    // instead of staying frozen in mid-air.
    h.setTileHeight(DETAILED_HEIGHT)
    h.setCameraDistance(400)
    pass(h.map)
    expect(h.entityHeight()).toBeCloseTo(DETAILED_HEIGHT + 0.5, 3)
    expect(h.stop.sampledFrom).toBeCloseTo(400, 0)
  })

  it('does not re-measure while the camera stays at a comparable distance', () => {
    const h = harness()

    h.setCameraDistance(1000)
    pass(h.map)
    expect(h.getHeight).toHaveBeenCalledTimes(1)

    // 800 m is closer, but not by the 30 % that justifies a new ray cast
    h.setCameraDistance(800)
    pass(h.map)
    expect(h.getHeight).toHaveBeenCalledTimes(1)

    h.setCameraDistance(600)
    pass(h.map)
    expect(h.getHeight).toHaveBeenCalledTimes(2)
  })

  it('never overrides a height that was bootstrapped most-detailed', () => {
    // sampledFrom 0 marks the sampleHeightMostDetailed() result
    const h = harness(0)

    h.setCameraDistance(50)
    pass(h.map)
    expect(h.getHeight).not.toHaveBeenCalled()
  })

  it('keeps the previous height and retries later when no tile is loaded there', () => {
    const h = harness()

    h.setCameraDistance(3600)
    pass(h.map)
    expect(h.entityHeight()).toBeCloseTo(COARSE_HEIGHT + 0.5, 3)

    // Camera close, but the tile is not queryable (yet)
    h.setTileHeight(undefined)
    h.setCameraDistance(300)
    pass(h.map)
    expect(h.entityHeight()).toBeCloseTo(COARSE_HEIGHT + 0.5, 3)
    // Distance not recorded → the stop stays a candidate
    expect(h.stop.sampledFrom).toBeCloseTo(3600, 0)

    // Backs off first, so it cannot monopolize the per-pass budget
    h.setTileHeight(DETAILED_HEIGHT)
    pass(h.map)
    expect(h.entityHeight()).toBeCloseTo(COARSE_HEIGHT + 0.5, 3)

    clockMs += 1500
    pass(h.map)
    expect(h.entityHeight()).toBeCloseTo(DETAILED_HEIGHT + 0.5, 3)
  })

  it('paces passes on the wall clock, not on the simulation tick rate', () => {
    // With the clock paused the app ticks syncVehicles at 2 Hz – a frame-based
    // throttle stretched a pass to 7.5 s and left visible stops on the
    // fallback height for minutes.
    const h = harness()
    h.setCameraDistance(400)

    ;(h.map as unknown as { resolveStopHeights: () => void }).resolveStopHeights()
    expect(h.getHeight).toHaveBeenCalledTimes(1)

    // Same 500 ms tick, no time passed yet → no second ray cast
    ;(h.map as unknown as { resolveStopHeights: () => void }).resolveStopHeights()
    expect(h.getHeight).toHaveBeenCalledTimes(1)
  })

  it('spends the per-pass budget on the stops nearest to the camera', () => {
    // Ten unmeasured stops in a row, the camera closest to the last one:
    // a plain round-robin would refine the far end of the line first and
    // take minutes to reach the ones actually on screen.
    const heights = [70, 71, 72, 73, 74, 75, 76, 77, 78, 79]
    const stops = heights.map((_, i) => ({
      disc: { position: undefined as unknown },
      label: { position: undefined as unknown },
      lon: STOP.lon + i * 0.01,
      lat: STOP.lat,
      position: Cartesian3.fromDegrees(STOP.lon + i * 0.01, STOP.lat, 45),
      sampledFrom: Number.POSITIVE_INFINITY,
      retryAfter: 0,
    }))
    const measured: number[] = []
    const map = Object.create(CesiumMap.prototype) as CesiumMap
    Object.assign(map, {
      viewer: {
        camera: { positionWC: Cartesian3.fromDegrees(STOP.lon + 0.09, STOP.lat, 445) },
        scene: {},
      },
      googleTileset: {
        getHeight: (carto: Cartographic) => {
          const index = Math.round(((carto.longitude * 180) / Math.PI - STOP.lon) / 0.01)
          measured.push(index)
          return heights[index]
        },
      },
      stopRecords: stops,
      lastStopSampleAt: 0,
    })

    pass(map)

    // Four measurements per pass, nearest first
    expect(measured).toEqual([9, 8, 7, 6])
    expect(stops.slice(6).every((s) => Number.isFinite(s.sampledFrom))).toBe(true)
    expect(stops.slice(0, 6).every((s) => s.sampledFrom === Number.POSITIVE_INFINITY)).toBe(true)
  })
})
