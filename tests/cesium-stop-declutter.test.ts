import { Cartesian2, Cartesian3, Matrix4, SceneTransforms } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CesiumMap } from '@/map/CesiumMap'

/**
 * Screen-space declutter of the stop name labels: overlapping labels are
 * hidden (nearest stop wins), the discs stay untouched, and the pass only
 * recomputes when the camera moved or a stop changed. Screen positions are
 * injected by mocking SceneTransforms.worldToWindowCoordinates.
 */

interface FakeStop {
  point: { position: Cartesian3 }
  label: { show: boolean }
  labelHalfWidth: number
  position: Cartesian3
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** Stop at the given camera distance whose label anchors at (x, y) px. */
function makeStop(
  screen: Map<Cartesian3, { x: number; y: number }>,
  cameraDistance: number,
  x: number,
  y: number,
  labelHalfWidth = 40,
): FakeStop {
  // Camera sits at the origin – the position doubles as the distance.
  const position = new Cartesian3(cameraDistance, 0, 0)
  screen.set(position, { x, y })
  return { point: { position }, label: { show: true }, labelHalfWidth, position }
}

function harness(stops: FakeStop[], screen: Map<Cartesian3, { x: number; y: number }>) {
  const project = vi
    .spyOn(SceneTransforms, 'worldToWindowCoordinates')
    .mockImplementation((_scene, position, result) => {
      const coords = screen.get(position as Cartesian3)
      if (!coords) return undefined
      return Cartesian2.fromElements(coords.x, coords.y, result)
    })

  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    viewer: {
      camera: { positionWC: Cartesian3.ZERO, viewMatrix: Matrix4.clone(Matrix4.IDENTITY) },
      scene: {},
    },
    stopLabels: { show: true },
    stopRecords: stops,
    stopLabelsDirty: true,
    declutterViewMatrix: new Matrix4(),
    renderRequested: false,
  })

  const declutter = () =>
    (map as unknown as { declutterStopLabels: () => void }).declutterStopLabels()
  return { map, declutter, project }
}

describe('stop label declutter', () => {
  it('hides the farther label of an overlapping pair, keeps disjoint ones', () => {
    const screen = new Map<Cartesian3, { x: number; y: number }>()
    const near = makeStop(screen, 500, 200, 300)
    const far = makeStop(screen, 900, 230, 305) // overlaps `near` horizontally
    const clear = makeStop(screen, 700, 600, 300) // far enough to the side
    const { declutter } = harness([far, clear, near], screen)

    declutter()

    expect(near.label.show).toBe(true)
    expect(far.label.show).toBe(false)
    expect(clear.label.show).toBe(true)
  })

  it('re-shows a hidden label once the overlap is gone', () => {
    const screen = new Map<Cartesian3, { x: number; y: number }>()
    const near = makeStop(screen, 500, 200, 300)
    const far = makeStop(screen, 900, 230, 305)
    const { map, declutter } = harness([near, far], screen)

    declutter()
    expect(far.label.show).toBe(false)

    // The camera moved and the stops drifted apart on screen
    screen.set(far.position, { x: 600, y: 300 })
    ;(map as unknown as { stopLabelsDirty: boolean }).stopLabelsDirty = true
    declutter()
    expect(far.label.show).toBe(true)
  })

  it('skips stops beyond the label display range entirely', () => {
    const screen = new Map<Cartesian3, { x: number; y: number }>()
    const distant = makeStop(screen, 5000, 200, 300)
    const { declutter, project } = harness([distant], screen)

    declutter()

    // Not even projected – the DistanceDisplayCondition hides it anyway
    expect(project).not.toHaveBeenCalled()
    expect(distant.label.show).toBe(true)
  })

  it('does not recompute while the camera stands still and nothing changed', () => {
    const screen = new Map<Cartesian3, { x: number; y: number }>()
    const stop = makeStop(screen, 500, 200, 300)
    const { map, declutter, project } = harness([stop], screen)

    declutter()
    expect(project).toHaveBeenCalledTimes(1)

    declutter()
    expect(project).toHaveBeenCalledTimes(1)

    // A camera move re-triggers the pass
    const camera = (map as unknown as { viewer: { camera: { viewMatrix: Matrix4 } } }).viewer
      .camera
    camera.viewMatrix = Matrix4.multiplyByTranslation(
      camera.viewMatrix,
      new Cartesian3(1, 0, 0),
      new Matrix4(),
    )
    declutter()
    expect(project).toHaveBeenCalledTimes(2)
  })
})
