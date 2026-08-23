import { type BillboardCollection, Cartesian3, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WeatherOverlay } from '@/map/WeatherOverlay'

let clockMs = 0

beforeEach(() => {
  clockMs = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Real WeatherOverlay on a fake viewer. Only the drop sprite is stubbed:
 * jsdom has no 2D canvas context, and without a sprite the overlay
 * deliberately stays inert (see "stays inert without a 2D canvas").
 */
function rainHarness({ sprite = true } = {}) {
  const setUniform = vi.fn()
  const added: unknown[] = []
  const removed: unknown[] = []
  const listeners: (() => void)[] = []
  const viewer = {
    camera: { positionWC: Cartesian3.fromDegrees(12.1, 54.0, 500) },
    scene: {
      primitives: {
        add: (p: unknown) => added.push(p),
        remove: (p: unknown) => removed.push(p),
      },
      preUpdate: {
        addEventListener: (l: () => void) => listeners.push(l),
        removeEventListener: (l: () => void) => {
          const i = listeners.indexOf(l)
          if (i >= 0) listeners.splice(i, 1)
        },
      },
    },
  } as unknown as Viewer
  const overlay = new WeatherOverlay(viewer, vi.fn())
  overlay.attachTileShader({ setUniform } as never)
  if (sprite) {
    // Stands in for the streak gradient jsdom cannot draw – the pool below
    // is built by the overlay's real createRainDrops.
    type SpriteSource = { rainSprite: () => HTMLCanvasElement | undefined }
    vi.spyOn(overlay as unknown as SpriteSource, 'rainSprite').mockReturnValue({
      width: 4,
      height: 32,
    } as HTMLCanvasElement)
  }
  const frame = (ms: number) => {
    clockMs += ms
    for (const listener of [...listeners]) listener()
  }
  /** Visible drops in the pool the overlay handed to the scene. */
  const shownCount = () => {
    const pool = added[0] as BillboardCollection | undefined
    if (!pool) return 0
    let shown = 0
    for (let i = 0; i < pool.length; i++) if (pool.get(i).show) shown++
    return shown
  }
  const tint = () => {
    const call = [...setUniform.mock.calls].reverse().find((c) => c[0] === 'u_rainFactor')
    return call?.[1] as number | undefined
  }
  return { overlay, added, removed, listeners, frame, shownCount, tint, setUniform }
}

describe('rain overlay', () => {
  it('scales the visible drop count with the precipitation', () => {
    const { overlay, shownCount } = rainHarness()

    // 1 mm → base 800 + 1 × 1000
    overlay.setRain(1)
    expect(shownCount()).toBe(1800)

    // Heavy rain is capped at the pool size
    overlay.setRain(5)
    expect(shownCount()).toBe(4000)

    // Lighter again – drops hide back down
    overlay.setRain(0.2)
    expect(shownCount()).toBe(1000)
  })

  it('eases the overcast grade in while it rains', () => {
    const { overlay, frame, tint } = rainHarness()

    overlay.setRain(3) // tint target: min(1, 0.55 + 3 × 0.15) = 1
    let previous = 0
    for (let i = 0; i < 40; i++) {
      frame(100)
      const current = tint() as number
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
    // 40 × 100 ms ≫ 2.5 s fade → fully overcast
    expect(previous).toBe(1)
  })

  it('hides the drops immediately but fades the overcast out before tearing down', () => {
    const { overlay, added, removed, frame, shownCount, setUniform } = rainHarness()

    overlay.setRain(2)
    for (let i = 0; i < 40; i++) frame(100)

    overlay.setRain(0)
    // Drops are gone right away, the collection still fades the tint
    expect(shownCount()).toBe(0)
    expect(removed).toEqual([])

    for (let i = 0; i < 40; i++) frame(100)
    expect(removed).toEqual([added[0]])
    // The shader ends exactly at 0
    expect(setUniform.mock.lastCall).toEqual(['u_rainFactor', 0])
  })

  it('unhooks its frame listener when the rain is over', () => {
    const { overlay, listeners, frame } = rainHarness()

    overlay.setRain(2)
    expect(listeners).toHaveLength(1)
    overlay.setRain(0)
    for (let i = 0; i < 40; i++) frame(100)
    expect(listeners).toHaveLength(0)
  })

  it('is a no-op for unchanged intensity (called 4×/s from the UI tick)', () => {
    const { overlay, shownCount } = rainHarness()

    overlay.setRain(1)
    const before = shownCount()
    expect(before).toBeGreaterThan(0)
    overlay.setRain(1)
    expect(shownCount()).toBe(before)
  })

  it('stays inert without a 2D canvas (jsdom)', () => {
    const { overlay, added, removed } = rainHarness({ sprite: false })

    // Real rainSprite: jsdom's canvas has no 2D context → no pool
    overlay.setRain(3)
    expect(added).toEqual([])
    overlay.setRain(0)
    expect(removed).toEqual([])
  })
})
