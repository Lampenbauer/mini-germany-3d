import { Cartesian2, Cartesian3, Matrix4, SceneTransforms } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STOP_LABEL_RANGE, STOP_NAME_BUDGET, type StopsLayer } from '@/map/StopsLayer'
import { keepNonOverlappingLabels } from '@/map/screen-rects'
import { stopsHarness } from './stops-test-harness'

/**
 * Screen-space declutter of the stop name labels: overlapping labels are
 * hidden (nearest stop wins), the discs stay untouched, and the pass only
 * recomputes when the camera moved or a stop changed.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

/** Projects every disc to the same spot, so the labels collide. */
const projectAllTo = (x: number, y: number) =>
  vi
    .spyOn(SceneTransforms, 'worldToWindowCoordinates')
    .mockImplementation((_scene, _position, result) => Cartesian2.fromElements(x, y, result))

describe('keepNonOverlappingLabels', () => {
  /*
   * Geometry of its own rather than the layer's: these pin the algorithm,
   * and the numbers below are chosen against this box. Read against
   * STOP_LABEL_METRICS they would break every time somebody tunes the
   * plate – the clearance alone has been 4, 16 and 24.
   */
  const METRICS = { offsetY: -12, height: 14, gap: 4 }

  // Boxes arrive nearest-first, so index 0 is the closest stop.
  it('drops the later label of an overlapping pair, keeps disjoint ones', () => {
    expect(
      keepNonOverlappingLabels([
        { x: 200, y: 300, halfWidth: 40 },
        { x: 230, y: 305, halfWidth: 40 }, // overlaps the first horizontally
        { x: 600, y: 300, halfWidth: 40 }, // far enough to the side
      ], METRICS),
    ).toEqual([true, false, true])
  })

  it('keeps labels that only miss each other vertically', () => {
    expect(
      keepNonOverlappingLabels([
        { x: 200, y: 300, halfWidth: 40 },
        { x: 200, y: 400, halfWidth: 40 },
      ], METRICS),
    ).toEqual([true, true])
  })

  it('lets a wide label collide where a narrow one would not', () => {
    const narrow = keepNonOverlappingLabels(
      [
        { x: 200, y: 300, halfWidth: 10 },
        { x: 260, y: 300, halfWidth: 10 },
      ],
      METRICS,
    )
    const wide = keepNonOverlappingLabels(
      [
        { x: 200, y: 300, halfWidth: 40 },
        { x: 260, y: 300, halfWidth: 40 },
      ],
      METRICS,
    )
    expect(narrow).toEqual([true, true])
    expect(wide).toEqual([true, false])
  })

  it('is empty-safe', () => {
    expect(keepNonOverlappingLabels([], METRICS)).toEqual([])
  })
})

describe('stop label declutter on the layer', () => {
  const stops = [
    { id: 'a', name: 'Erste', lon: 12.1, lat: 54.09, lines: ['1'] },
    { id: 'b', name: 'Zweite', lon: 12.1005, lat: 54.09, lines: ['1'] },
  ]

  it('hides one of two colliding labels but leaves both discs alone', () => {
    projectAllTo(400, 300)
    const { layer, disc, label } = stopsHarness(stops)

    layer.update()

    expect([label(0).show, label(1).show].filter(Boolean)).toHaveLength(1)
    expect(disc(0).show).toBe(true)
    expect(disc(1).show).toBe(true)
  })

  it('skips stops beyond the label display range entirely', () => {
    const project = projectAllTo(400, 300)
    // Above STOP_LABEL_RANGE, where the label is hidden anyway. Taken from
    // the constant rather than written out: the range follows the field of
    // view (see camera-fov.ts), so a fixed height would drift inside it.
    const { layer } = stopsHarness(stops, { cameraHeight: STOP_LABEL_RANGE * 2 })

    layer.update()

    expect(project).not.toHaveBeenCalled()
  })

  it('does not recompute while the camera stands still and nothing changed', () => {
    const project = projectAllTo(400, 300)
    const { layer, camera } = stopsHarness(stops)

    layer.update()
    const afterFirst = project.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    layer.update()
    expect(project).toHaveBeenCalledTimes(afterFirst)

    // A camera move re-triggers the pass
    camera.viewMatrix = Matrix4.multiplyByTranslation(
      camera.viewMatrix as Matrix4,
      new Cartesian3(1, 0, 0),
      new Matrix4(),
    )
    layer.update()
    expect(project.mock.calls.length).toBeGreaterThan(afterFirst)
  })

  it('reruns after the line visibility changed a stop', () => {
    const project = projectAllTo(400, 300)
    const { layer } = stopsHarness(stops)

    layer.update()
    const afterFirst = project.mock.calls.length

    layer.setVisibleLines(new Set())
    layer.update()
    // Hidden stops are skipped, so the pass ran but projected nothing new
    expect(project.mock.calls.length).toBe(afterFirst)
  })
})

/**
 * Stop names are drawn when their stop first comes close enough to show
 * one, not when the city goes up: Berlin's 2682 of them cost ~300 ms in the
 * single frame of the city handover, where none of them could be seen (the
 * camera is 85 km up by then). Node has no 2D canvas, so what these read is
 * the bookkeeping – which stops the layer has drawn a name for.
 */
describe('stop names are drawn on approach', () => {
  const named = (layer: StopsLayer): boolean[] =>
    (layer as unknown as { stopRecords: { named: boolean }[] }).stopRecords.map((r) => r.named)

  /** More stops than one pass may draw, all within label range. */
  const crowd = Array.from({ length: STOP_NAME_BUDGET + 5 }, (_, i) => ({
    id: `s${i}`,
    name: `Haltestelle ${i}`,
    lon: 12.1 + i * 0.0001,
    lat: 54.09,
    lines: ['1'],
  }))

  afterEach(() => vi.restoreAllMocks())

  it('draws none of them when the city goes up', () => {
    const { layer } = stopsHarness(crowd)
    expect(named(layer).some(Boolean)).toBe(false)
  })

  it('draws a budget per pass, nearest first, and asks for the next frame', () => {
    projectAllTo(400, 300)
    const { layer, requestRender } = stopsHarness(crowd)
    requestRender.mockClear()

    layer.update()
    expect(named(layer).filter(Boolean)).toHaveLength(STOP_NAME_BUDGET)
    // The rest are still owed, so the pass books itself a rerun
    expect(requestRender).toHaveBeenCalled()

    layer.update()
    expect(named(layer).every(Boolean)).toBe(true)
  })

  it('leaves a stop beyond the label range unnamed', () => {
    projectAllTo(400, 300)
    // The camera stands above the range, so nothing is close enough
    const { layer } = stopsHarness(crowd, { cameraHeight: STOP_LABEL_RANGE * 2 })
    layer.update()
    expect(named(layer).some(Boolean)).toBe(false)
  })
})
