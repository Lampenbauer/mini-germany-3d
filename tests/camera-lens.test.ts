import { Math as CesiumMath, PerspectiveFrustum, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraLens, cameraFovDeg, cameraFramingScale } from '@/map/CameraLens'
import { config } from '@/config'

let clockMs = 0

beforeEach(() => {
  clockMs = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Real lens on a camera that is nothing but its frustum. */
function lensHarness(miniature = true) {
  const frustum = new PerspectiveFrustum()
  const viewer = { camera: { frustum } } as unknown as Viewer
  /** Every distance factor the lens asked for, in order. */
  const factors: number[] = []
  const lens = new CameraLens(
    viewer,
    {
      requestRender: vi.fn(),
      applyDistanceFactor: (factor) => factors.push(factor),
    },
    miniature,
  )
  return {
    lens,
    factors,
    fovDeg: () => CesiumMath.toDegrees(frustum.fov ?? 0),
    /** Runs the ease to its end, one frame every 16 ms. */
    settle: (frames = 60) => {
      for (let i = 0; i < frames; i++) {
        clockMs += 16
        lens.update()
      }
    },
  }
}

/** Distance factor between two angles – what holds the framing. */
const framingFactor = (fromDeg: number, toDeg: number) =>
  Math.tan(CesiumMath.toRadians(fromDeg) / 2) / Math.tan(CesiumMath.toRadians(toDeg) / 2)

describe('CameraLens', () => {
  it('starts on the lens of the look it is built with', () => {
    const { fovDeg, lens, factors } = lensHarness(true)
    expect(fovDeg()).toBeCloseTo(config.camera.fovDeg, 6)
    expect(lens.fovDeg).toBeCloseTo(config.camera.fovDeg, 6)
    // Nothing to hold in place before anything was framed
    expect(factors).toEqual([])

    const plain = lensHarness(false)
    expect(plain.fovDeg()).toBeCloseTo(config.camera.fovOffDeg, 6)
    expect(plain.factors).toEqual([])
  })

  it('wears the configured default look when not told otherwise', () => {
    const frustum = new PerspectiveFrustum()
    const viewer = { camera: { frustum } } as unknown as Viewer
    new CameraLens(viewer, { requestRender: vi.fn(), applyDistanceFactor: vi.fn() })
    const expected = config.camera.miniatureDefault ? config.camera.fovDeg : config.camera.fovOffDeg
    expect(CesiumMath.toDegrees(frustum.fov ?? 0)).toBeCloseTo(expected, 6)
  })

  it('swaps without an ease and without walking before the first frame', () => {
    // A shared link that opens with the effect off has no view yet to ease
    // in front of – it should simply open through the plain lens. And it
    // must not walk the camera: the restored pose was saved through that
    // very lens, so walking it would bring every reload a step closer.
    const { lens, fovDeg, factors } = lensHarness()
    lens.setMiniature(false)
    expect(fovDeg()).toBeCloseTo(config.camera.fovOffDeg, 6)
    expect(factors).toEqual([])
  })

  it('eases to the plain lens and lands on it exactly', () => {
    const { lens, fovDeg, settle } = lensHarness()
    lens.update()
    lens.setMiniature(false)

    clockMs += 100
    lens.update()
    const midway = fovDeg()
    expect(midway).toBeGreaterThan(config.camera.fovDeg)
    expect(midway).toBeLessThan(config.camera.fovOffDeg)

    settle()
    // Exactly on the target, so the ease stops instead of creeping
    expect(lens.fovDeg).toBe(config.camera.fovOffDeg)
    expect(fovDeg()).toBeCloseTo(config.camera.fovOffDeg, 6)
  })

  it('holds the framing across every step of the ease', () => {
    // The point of the dolly: however many steps the ease takes, the
    // distance factors it asks for have to multiply out to the one factor
    // the whole angle change costs – otherwise the frame drifts.
    const { lens, factors, settle } = lensHarness()
    lens.update()
    lens.setMiniature(false)
    settle()

    expect(factors.length).toBeGreaterThan(3)
    const total = factors.reduce((a, b) => a * b, 1)
    expect(total).toBeCloseTo(framingFactor(config.camera.fovDeg, config.camera.fovOffDeg), 6)
  })

  it('comes back to where it started', () => {
    const { lens, fovDeg, factors, settle } = lensHarness()
    lens.update()
    lens.setMiniature(false)
    settle()
    lens.setMiniature(true)
    settle()

    expect(lens.fovDeg).toBe(config.camera.fovDeg)
    expect(fovDeg()).toBeCloseTo(config.camera.fovDeg, 6)
    // There and back multiplies out to no move at all
    expect(factors.reduce((a, b) => a * b, 1)).toBeCloseTo(1, 6)
  })

  it('eases to any angle the photo popover asks for, and holds the framing', () => {
    const { lens, fovDeg, factors, settle } = lensHarness(false)
    lens.update()
    lens.setFovDeg(40)
    settle()
    expect(lens.fovDeg).toBe(40)
    expect(fovDeg()).toBeCloseTo(40, 6)
    const total = factors.reduce((a, b) => a * b, 1)
    expect(total).toBeCloseTo(framingFactor(config.camera.fovOffDeg, 40), 6)
  })

  it('keeps a requested angle inside the guard rails', () => {
    const { lens, settle } = lensHarness(false)
    lens.update()
    lens.setFovDeg(5)
    settle()
    expect(lens.fovDeg).toBe(25)
    lens.setFovDeg(120)
    settle()
    expect(lens.fovDeg).toBe(60)
  })

  it('ignores a swap to the lens it already wears', () => {
    const { lens, factors, settle } = lensHarness()
    lens.update()
    lens.setMiniature(true)
    settle()
    expect(factors).toEqual([])
  })

  it('reads the angle back off the camera', () => {
    // What every distance that follows the lens depends on
    const frustum = new PerspectiveFrustum()
    frustum.fov = CesiumMath.toRadians(60)
    const camera = { frustum } as unknown as Parameters<typeof cameraFovDeg>[0]
    expect(cameraFovDeg(camera)).toBeCloseTo(60, 6)
    expect(cameraFramingScale(camera)).toBeCloseTo(1, 6)

    frustum.fov = CesiumMath.toRadians(30)
    expect(cameraFramingScale(camera)).toBeCloseTo(2.155, 3)
  })
})
