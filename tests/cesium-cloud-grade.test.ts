import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Viewer } from 'cesium'
import { cloudOvercastGrade, WeatherOverlay } from '@/map/WeatherOverlay'

let clockMs = 0

beforeEach(() => {
  clockMs = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * The overlay only needs a scene to hook frame listeners into, so it goes
 * through its real constructor here – no prototype surgery, no private
 * fields to keep in sync.
 */
function cloudHarness() {
  const setUniform = vi.fn()
  const listeners: (() => void)[] = []
  const viewer = {
    scene: {
      preUpdate: {
        addEventListener: (l: () => void) => listeners.push(l),
        removeEventListener: (l: () => void) => {
          const i = listeners.indexOf(l)
          if (i >= 0) listeners.splice(i, 1)
        },
      },
    },
  } as unknown as Viewer
  const requestRender = vi.fn()
  const overlay = new WeatherOverlay(viewer, requestRender)
  overlay.attachTileShader({ setUniform } as never)

  /** Runs the frame listeners the way scene.preUpdate would. */
  const frame = (ms: number) => {
    clockMs += ms
    for (const listener of [...listeners]) listener()
  }
  /** Grade currently pushed into the shader. */
  const graded = () => {
    const call = [...setUniform.mock.calls].reverse().find((c) => c[0] === 'u_cloudFactor')
    return call?.[1] as number | undefined
  }
  return { overlay, setUniform, listeners, frame, graded, requestRender }
}

describe('cloudOvercastGrade', () => {
  it('keeps an open sky ungraded up to the threshold', () => {
    expect(cloudOvercastGrade(0)).toBe(0)
    expect(cloudOvercastGrade(20)).toBe(0)
    expect(cloudOvercastGrade(40)).toBe(0)
  })

  it('ramps from the threshold to half the grade of rain', () => {
    expect(cloudOvercastGrade(70)).toBeCloseTo(0.25, 5)
    expect(cloudOvercastGrade(100)).toBeCloseTo(0.5, 5)
    // A fully closed sky stays below the lightest rain (RAIN_TINT_BASE 0.55)
    expect(cloudOvercastGrade(100)).toBeLessThan(0.55)
  })

  it('is monotonic and clamped outside 0–100', () => {
    expect(cloudOvercastGrade(-20)).toBe(0)
    expect(cloudOvercastGrade(140)).toBeCloseTo(0.5, 5)
    expect(cloudOvercastGrade(60)).toBeLessThan(cloudOvercastGrade(90))
  })
})

describe('cloud overcast grade on the tiles', () => {
  it('eases the grade in and stops at the target', () => {
    const { overlay, setUniform, frame, graded } = cloudHarness()

    overlay.setCloudCover(100)
    let previous = 0
    // 6 s fade at 100 ms per frame
    for (let i = 0; i < 80; i++) {
      frame(100)
      const tint = graded() as number
      expect(tint).toBeGreaterThanOrEqual(previous)
      previous = tint
    }
    expect(setUniform.mock.lastCall?.[0]).toBe('u_cloudFactor')
    expect(previous).toBeCloseTo(0.5, 5)
  })

  it('unhooks its frame listener once the sky has settled', () => {
    const { overlay, listeners, frame, graded } = cloudHarness()

    overlay.setCloudCover(80)
    expect(listeners).toHaveLength(1)
    for (let i = 0; i < 80; i++) frame(100)
    // A settled sky must not keep requesting frames
    expect(listeners).toHaveLength(0)
    expect(graded()).toBeCloseTo(cloudOvercastGrade(80), 5)
  })

  it('fades back out when the sky clears', () => {
    const { overlay, frame, graded } = cloudHarness()

    overlay.setCloudCover(100)
    for (let i = 0; i < 80; i++) frame(100)
    expect(graded()).toBeGreaterThan(0)

    overlay.setCloudCover(0)
    for (let i = 0; i < 80; i++) frame(100)
    expect(graded()).toBe(0)
  })

  it('retargets a fade in flight instead of hooking a second listener', () => {
    const { overlay, listeners, frame, graded } = cloudHarness()

    overlay.setCloudCover(100)
    frame(100)
    overlay.setCloudCover(60)
    expect(listeners).toHaveLength(1)
    for (let i = 0; i < 80; i++) frame(100)
    expect(graded()).toBeCloseTo(cloudOvercastGrade(60), 5)
  })

  it('is a no-op for unchanged cover (called 4x/s from the UI tick)', () => {
    const { overlay, listeners, frame } = cloudHarness()

    overlay.setCloudCover(90)
    for (let i = 0; i < 80; i++) frame(100)
    expect(listeners).toHaveLength(0)

    overlay.setCloudCover(90)
    expect(listeners).toHaveLength(0)
  })

  it('treats every cover below the threshold as the same open sky', () => {
    const { overlay, listeners } = cloudHarness()

    overlay.setCloudCover(10)
    expect(listeners).toHaveLength(0)
    overlay.setCloudCover(35)
    expect(listeners).toHaveLength(0)
  })

  it('pushes a grade that arrived before the tiles into the fresh shader', () => {
    const { overlay, frame } = cloudHarness()

    overlay.setCloudCover(100)
    for (let i = 0; i < 80; i++) frame(100)

    // Tiles reloaded → new shader, and it must not start clear again
    const setUniform = vi.fn()
    overlay.attachTileShader({ setUniform } as never)
    expect(setUniform).toHaveBeenCalledWith('u_cloudFactor', expect.closeTo(0.5, 5))
    expect(setUniform).toHaveBeenCalledWith('u_rainFactor', 0)
  })
})
