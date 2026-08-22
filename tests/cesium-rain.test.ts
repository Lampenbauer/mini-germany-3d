import { Cartesian3 } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CesiumMap } from '@/map/CesiumMap'

let clockMs = 0

beforeEach(() => {
  clockMs = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** CesiumMap stub instance for the rain overlay (no WebGL, no canvas). */
function rainHarness() {
  const removed: unknown[] = []
  const setUniform = vi.fn()
  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    rainBillboards: null,
    rainDrops: [],
    rainIntensity: 0,
    rainTint: 0,
    rainFallDistance: 0,
    lastRainUpdateMs: 0,
    removeRainListener: null,
    tileShader: { setUniform },
    renderRequested: false,
    viewer: {
      camera: { positionWC: Cartesian3.fromDegrees(12.1, 54.0, 500) },
      scene: { primitives: { add: vi.fn(), remove: (p: unknown) => removed.push(p) } },
    },
  })
  return { map, removed, setUniform }
}

/** Injects a fake drop pool the way createRainDrops would. */
function stubDropPool(map: CesiumMap, size: number) {
  const drops = Array.from({ length: size }, () => ({ billboard: { show: false } }))
  const collection = { fake: true }
  const unlisten = vi.fn()
  Object.assign(map, {
    createRainDrops: () => {
      Object.assign(map, {
        rainBillboards: collection,
        rainDrops: drops,
        removeRainListener: unlisten,
        lastRainUpdateMs: clockMs,
      })
      return true
    },
  })
  return { drops, collection, unlisten }
}

const updateRain = (map: CesiumMap): void => {
  ;(map as unknown as { updateRain: () => void }).updateRain()
}

const shownCount = (drops: { billboard: { show: boolean } }[]) =>
  drops.filter((d) => d.billboard.show).length

describe('rain overlay', () => {
  it('scales the visible drop count with the precipitation', () => {
    const { map } = rainHarness()
    const { drops } = stubDropPool(map, 3000)

    // 1 mm → base 800 + 1 × 1000
    map.setRain(1)
    expect(shownCount(drops)).toBe(1800)

    // Heavy rain is capped at the pool size
    map.setRain(5)
    expect(shownCount(drops)).toBe(3000)

    // Lighter again – drops hide back down
    map.setRain(0.2)
    expect(shownCount(drops)).toBe(1000)
  })

  it('eases the overcast grade in while it rains', () => {
    const { map, setUniform } = rainHarness()
    stubDropPool(map, 10)

    map.setRain(3) // tint target: min(1, 0.55 + 3 × 0.15) = 1
    let previous = 0
    for (let i = 0; i < 40; i++) {
      clockMs += 100
      updateRain(map)
      const tint = setUniform.mock.lastCall?.[1] as number
      expect(tint).toBeGreaterThanOrEqual(previous)
      previous = tint
    }
    // 40 × 100 ms ≫ 2.5 s fade → fully overcast
    expect(previous).toBe(1)
  })

  it('hides the drops immediately but fades the overcast out before tearing down', () => {
    const { map, removed, setUniform } = rainHarness()
    const { drops, collection, unlisten } = stubDropPool(map, 10)

    map.setRain(2)
    for (let i = 0; i < 40; i++) {
      clockMs += 100
      updateRain(map)
    }

    map.setRain(0)
    // Drops are gone right away, the collection still fades the tint
    expect(shownCount(drops)).toBe(0)
    expect(removed).toEqual([])

    for (let i = 0; i < 40; i++) {
      clockMs += 100
      updateRain(map)
    }
    expect(removed).toEqual([collection])
    expect(unlisten).toHaveBeenCalledOnce()
    expect((map as unknown as { rainBillboards: unknown }).rainBillboards).toBeNull()
    // The shader ends exactly at 0
    expect(setUniform.mock.lastCall).toEqual(['u_rainFactor', 0])
  })

  it('is a no-op for unchanged intensity (called 4×/s from the UI tick)', () => {
    const { map } = rainHarness()
    const { drops } = stubDropPool(map, 100)
    map.setRain(1)
    // Hide everything behind setRain's back – an identical value must not reapply
    for (const drop of drops) drop.billboard.show = false
    map.setRain(1)
    expect(shownCount(drops)).toBe(0)
  })

  it('stays inert without a 2D canvas (jsdom)', () => {
    const { map, removed } = rainHarness()
    // Real createRainDrops: jsdom's canvas has no 2D context → no pool
    map.setRain(3)
    expect((map as unknown as { rainBillboards: unknown }).rainBillboards).toBeNull()
    map.setRain(0)
    expect(removed).toEqual([])
  })
})
