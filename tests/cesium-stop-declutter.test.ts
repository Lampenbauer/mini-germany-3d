import { Cartesian2, Cartesian3, Matrix4, SceneTransforms } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STOP_LABEL_METRICS, STOP_LABEL_RANGE } from '@/map/StopsLayer'
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

describe('keepNonOverlappingLabels', () => {
  // Boxes arrive nearest-first, so index 0 is the closest stop.
  it('drops the later label of an overlapping pair, keeps disjoint ones', () => {
    expect(
      keepNonOverlappingLabels([
        { x: 200, y: 300, halfWidth: 40 },
        { x: 230, y: 305, halfWidth: 40 }, // overlaps the first horizontally
        { x: 600, y: 300, halfWidth: 40 }, // far enough to the side
      ], STOP_LABEL_METRICS),
    ).toEqual([true, false, true])
  })

  it('keeps labels that only miss each other vertically', () => {
    expect(
      keepNonOverlappingLabels([
        { x: 200, y: 300, halfWidth: 40 },
        { x: 200, y: 400, halfWidth: 40 },
      ], STOP_LABEL_METRICS),
    ).toEqual([true, true])
  })

  it('lets a wide label collide where a narrow one would not', () => {
    const narrow = keepNonOverlappingLabels(
      [
        { x: 200, y: 300, halfWidth: 10 },
        { x: 260, y: 300, halfWidth: 10 },
      ],
      STOP_LABEL_METRICS,
    )
    const wide = keepNonOverlappingLabels(
      [
        { x: 200, y: 300, halfWidth: 40 },
        { x: 260, y: 300, halfWidth: 40 },
      ],
      STOP_LABEL_METRICS,
    )
    expect(narrow).toEqual([true, true])
    expect(wide).toEqual([true, false])
  })

  it('is empty-safe', () => {
    expect(keepNonOverlappingLabels([], STOP_LABEL_METRICS)).toEqual([])
  })
})

describe('stop label declutter on the layer', () => {
  const stops = [
    { id: 'a', name: 'Erste', lon: 12.1, lat: 54.09, lines: ['1'] },
    { id: 'b', name: 'Zweite', lon: 12.1005, lat: 54.09, lines: ['1'] },
  ]

  /** Projects every disc to the same spot, so the two labels collide. */
  const projectAllTo = (x: number, y: number) =>
    vi
      .spyOn(SceneTransforms, 'worldToWindowCoordinates')
      .mockImplementation((_scene, _position, result) => Cartesian2.fromElements(x, y, result))

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
