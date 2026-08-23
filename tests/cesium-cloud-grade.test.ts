import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CesiumMap, cloudOvercastGrade } from '@/map/CesiumMap'

let clockMs = 0

beforeEach(() => {
  clockMs = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** CesiumMap stub instance for the cloud grade (no WebGL, no canvas). */
function cloudHarness() {
  const setUniform = vi.fn()
  const listeners: (() => void)[] = []
  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    cloudTint: 0,
    cloudTintTarget: 0,
    lastCloudUpdateMs: 0,
    removeCloudListener: null,
    tileShader: { setUniform },
    renderRequested: false,
    viewer: {
      scene: {
        preUpdate: {
          addEventListener: (l: () => void) => listeners.push(l),
          removeEventListener: (l: () => void) => {
            const i = listeners.indexOf(l)
            if (i >= 0) listeners.splice(i, 1)
          },
        },
      },
    },
  })
  /** Runs the frame listeners the way scene.preUpdate would. */
  const frame = (ms: number) => {
    clockMs += ms
    for (const listener of [...listeners]) listener()
  }
  return { map, setUniform, listeners, frame }
}

const tintOf = (map: CesiumMap) => (map as unknown as { cloudTint: number }).cloudTint

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
    const { map, setUniform, frame } = cloudHarness()

    map.setCloudCover(100)
    let previous = 0
    // 6 s fade at 100 ms per frame
    for (let i = 0; i < 80; i++) {
      frame(100)
      const tint = setUniform.mock.lastCall?.[1] as number
      expect(tint).toBeGreaterThanOrEqual(previous)
      previous = tint
    }
    expect(setUniform.mock.lastCall?.[0]).toBe('u_cloudFactor')
    expect(previous).toBeCloseTo(0.5, 5)
  })

  it('unhooks its frame listener once the sky has settled', () => {
    const { map, listeners, frame } = cloudHarness()

    map.setCloudCover(80)
    expect(listeners).toHaveLength(1)
    for (let i = 0; i < 80; i++) frame(100)
    // A settled sky must not keep requesting frames
    expect(listeners).toHaveLength(0)
    expect(tintOf(map)).toBeCloseTo(cloudOvercastGrade(80), 5)
  })

  it('fades back out when the sky clears', () => {
    const { map, frame } = cloudHarness()

    map.setCloudCover(100)
    for (let i = 0; i < 80; i++) frame(100)
    expect(tintOf(map)).toBeGreaterThan(0)

    map.setCloudCover(0)
    for (let i = 0; i < 80; i++) frame(100)
    expect(tintOf(map)).toBe(0)
  })

  it('retargets a fade in flight instead of hooking a second listener', () => {
    const { map, listeners, frame } = cloudHarness()

    map.setCloudCover(100)
    frame(100)
    map.setCloudCover(60)
    expect(listeners).toHaveLength(1)
    for (let i = 0; i < 80; i++) frame(100)
    expect(tintOf(map)).toBeCloseTo(cloudOvercastGrade(60), 5)
  })

  it('is a no-op for unchanged cover (called 4x/s from the UI tick)', () => {
    const { map, listeners, frame } = cloudHarness()

    map.setCloudCover(90)
    for (let i = 0; i < 80; i++) frame(100)
    expect(listeners).toHaveLength(0)

    map.setCloudCover(90)
    expect(listeners).toHaveLength(0)
    // Values below the threshold all mean the same open sky
    map.setCloudCover(90.0)
    expect(listeners).toHaveLength(0)
  })

  it('treats every cover below the threshold as the same open sky', () => {
    const { map, listeners } = cloudHarness()

    map.setCloudCover(10)
    expect(listeners).toHaveLength(0)
    map.setCloudCover(35)
    expect(listeners).toHaveLength(0)
  })
})
