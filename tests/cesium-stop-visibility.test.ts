import { Cartesian2, SceneTransforms } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTE_PULSE_DURATION_MS } from '@/map/RoutesLayer'
import { networkOf, stopsHarness } from './stops-test-harness'

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

describe('line focus on the stops', () => {
  const stops = [
    { id: 'a', name: 'Only 1', lon: 12.1, lat: 54.09, lines: ['1'] },
    { id: 'b', name: 'Shared', lon: 12.101, lat: 54.09, lines: ['1', '5'] },
    { id: 'c', name: 'Only 5', lon: 12.102, lat: 54.09, lines: ['5'] },
  ]

  let clockMs = 0

  afterEach(() => vi.restoreAllMocks())

  /** A screen for the declutter update() runs: no two names collide on it. */
  function spreadOnScreen() {
    let n = 0
    vi.spyOn(SceneTransforms, 'worldToWindowCoordinates').mockImplementation(
      (_scene, _position, result) => Cartesian2.fromElements(100 + 200 * n++, 300, result),
    )
  }

  function focused() {
    clockMs = 50_000
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
    spreadOnScreen()
    const h = stopsHarness(stops)
    h.layer.startLineFocus('1', ROUTE_PULSE_DURATION_MS)
    return h
  }

  it('leaves the stops of every other line off the map while the pulse runs', () => {
    const { layer, disc, label } = focused()
    expect(disc(0).show).toBe(true)
    expect(disc(1).show).toBe(true)
    expect(disc(2).show).toBe(false)
    // The name goes with its disc, as under the line filter
    expect(label(2).show).toBe(false)

    // …and the declutter, which reads the same composed visibility, does
    // not hand it back on its next pass
    layer.update()
    expect(label(2).show).toBe(false)
    expect(label(0).show).toBe(true)
  })

  it('brings them back on the first frame after the focus ends', () => {
    const { layer, disc } = focused()

    // Still inside the window – one millisecond short of the end
    clockMs += ROUTE_PULSE_DURATION_MS - 1
    layer.update()
    expect(disc(2).show).toBe(false)

    clockMs += 1
    layer.update()
    expect(disc(2).show).toBe(true)
  })

  it('never shows a stop the line filter has taken off', () => {
    clockMs = 50_000
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
    const { layer, disc } = stopsHarness(stops)


    layer.setVisibleLines(new Set(['1']))
    layer.startLineFocus('5', ROUTE_PULSE_DURATION_MS)

    // Shared with the focused line and shown by the filter – on the map
    expect(disc(1).show).toBe(true)
    // Focused line, but switched off in the panel – stays off
    expect(disc(2).show).toBe(false)
    // Shown by the filter, but not on the focused line – steps aside
    expect(disc(0).show).toBe(false)
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

  it('ghosts the surface stops of the city that arrives', () => {
    const { layer, disc } = stopsHarness(stops)
    layer.setUnderground(true)
    expect(disc(0).color.alpha).toBeCloseTo(0.2, 5)

    // A city switch below ground: clearCity() takes these stops off and the
    // next city's go up while the reader is still down there. The view is
    // the reader's, not the city's, so it has to reach them.
    layer.clear()
    layer.add(networkOf([{ id: 'next', name: 'Nächste', lon: 10.7, lat: 53.87, lines: ['1'] }]))

    expect(disc(0).color.alpha).toBeCloseTo(0.2, 5)
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
