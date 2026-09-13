import { describe, expect, it } from 'vitest'
import { SurfaceGeneration } from '@/map/surface-generation'

describe('the surface generation', () => {
  it('stands still while no tile loads, however many ticks go by', () => {
    const g = new SurfaceGeneration()
    expect(g.current).toBe(0)
    for (let t = 0; t < 60_000; t += 33) expect(g.advance(t)).toBe(false)
    expect(g.current).toBe(0)
  })

  it('advances for a loaded tile, then not again for two seconds however many load', () => {
    const g = new SurfaceGeneration()
    g.noteTileLoaded()
    expect(g.advance(1000)).toBe(true)
    expect(g.current).toBe(1)
    // The tiles keep streaming in – the load-progress transitions that
    // used to be a generation each
    for (let t = 1033; t < 1000 + SurfaceGeneration.MIN_INTERVAL_MS; t += 33) {
      g.noteTileLoaded()
      expect(g.advance(t)).toBe(false)
    }
    expect(g.advance(1000 + SurfaceGeneration.MIN_INTERVAL_MS)).toBe(true)
    expect(g.current).toBe(2)
    // Quiet since: the interval alone earns nothing
    expect(g.advance(10_000)).toBe(false)
    expect(g.current).toBe(2)
  })

  it('bumps at once for a swapped tileset and counts the interval from there', () => {
    const g = new SurfaceGeneration()
    g.noteTileLoaded()
    g.advance(1000)
    g.bump(1500)
    expect(g.current).toBe(2)
    g.noteTileLoaded()
    expect(g.advance(3000)).toBe(false)
    expect(g.advance(3500)).toBe(true)
  })
})
