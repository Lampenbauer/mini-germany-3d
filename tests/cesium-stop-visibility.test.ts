import { describe, expect, it } from 'vitest'
import { stopsHarness } from './stops-test-harness'

/**
 * Line-driven stop visibility: hiding lines hides exactly the stops no
 * shown line serves – stops shared with a still-visible line stay on the
 * map, and re-showing a line brings its stops back.
 */
describe('line-driven stop visibility', () => {
  const stops = [
    { id: 'a', name: 'Only 1', lon: 12.1, lat: 54.09, lines: ['1'] },
    { id: 'b', name: 'Shared', lon: 12.101, lat: 54.09, lines: ['1', '5'] },
    { id: 'c', name: 'Only 5', lon: 12.102, lat: 54.09, lines: ['5'] },
  ]

  it('hides exclusive stops, keeps shared ones, and restores on re-show', () => {
    const { layer, disc, label } = stopsHarness(stops)

    layer.setVisibleLines(new Set(['5']))
    expect(disc(0).show).toBe(false)
    expect(disc(1).show).toBe(true)
    expect(disc(2).show).toBe(true)
    // The label follows its disc – a hidden stop shows no name either
    expect(label(0).show).toBe(false)

    layer.setVisibleLines(new Set(['1', '5']))
    expect(disc(0).show).toBe(true)
    expect(label(0).show).toBe(true)
  })

  it('renders again only when something actually changed', () => {
    const { layer, requestRender } = stopsHarness(stops)
    requestRender.mockClear()

    layer.setVisibleLines(new Set(['1', '5']))
    expect(requestRender).not.toHaveBeenCalled()

    layer.setVisibleLines(new Set(['1']))
    expect(requestRender).toHaveBeenCalledOnce()
  })

  it('hides every stop when no line is shown', () => {
    const { layer, disc } = stopsHarness(stops)

    layer.setVisibleLines(new Set())
    expect([disc(0).show, disc(1).show, disc(2).show]).toEqual([false, false, false])
  })
})

describe('underground view on the stops', () => {
  // One platform inside the tunnel range, one outside it
  const tunnels: [number, number][] = [[100, 300]]
  const stops = [
    { id: 'surface', name: 'Oben', lon: 12.1, lat: 54.09, lines: ['1'], dist: 50, tunnels },
    { id: 'below', name: 'Unten', lon: 12.101, lat: 54.09, lines: ['1'], dist: 200, tunnels },
  ]

  it('ghosts the surface stops and keeps the underground ones solid', () => {
    const { layer, disc, label } = stopsHarness(stops)

    layer.setUnderground(true)
    expect(disc(0).color.alpha).toBeCloseTo(0.2, 5)
    expect(label(0).color.alpha).toBeCloseTo(0.2, 5)
    expect(disc(1).color.alpha).toBeCloseTo(1, 5)
    expect(label(1).color.alpha).toBeCloseTo(1, 5)

    layer.setUnderground(false)
    expect(disc(0).color.alpha).toBeCloseTo(1, 5)
    expect(disc(1).color.alpha).toBeCloseTo(0.2, 5)
  })

  it('counts a stop as underground when any serving line runs below', () => {
    const shared = [
      { id: 'shared', name: 'Geteilt', lon: 12.1, lat: 54.09, lines: ['1'], dist: 200, tunnels },
      { id: 'shared2', name: 'Geteilt', lon: 12.1, lat: 54.09, lines: ['2'], dist: 50 },
    ]
    const { layer, disc } = stopsHarness(shared)
    layer.setUnderground(true)
    expect(disc(0).color.alpha).toBeCloseTo(1, 5)
  })
})
