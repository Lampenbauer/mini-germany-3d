import { Cartesian2, Cartesian3, Entity, Intersect, Matrix4, Primitive, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import type { Webcam } from '@/lib/webcams-extract'
import { keepNonOverlappingLabels } from '@/map/StopsLayer'
import { VehicleLayer } from '@/map/VehicleLayer'
import { WEBCAM_LONG_SIDE_METERS, WebcamsLayer } from '@/map/WebcamsLayer'
import { rectCoversPoint } from '@/map/screen-rects'

/**
 * Labels step aside for the webcam pictures: the pictures report their
 * screen rectangles, the stop declutter treats them as taken, and a
 * vehicle badge that would sit on one is not shown.
 */

beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => 50_000)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rectCoversPoint', () => {
  const rects = [{ left: 100, right: 300, top: 50, bottom: 162 }]
  it('tells inside from outside, edges included', () => {
    expect(rectCoversPoint(rects, 200, 100)).toBe(true)
    expect(rectCoversPoint(rects, 100, 50)).toBe(true)
    expect(rectCoversPoint(rects, 99, 100)).toBe(false)
    expect(rectCoversPoint(rects, 200, 163)).toBe(false)
    expect(rectCoversPoint([], 200, 100)).toBe(false)
  })
})

describe('the stop declutter around pictures', () => {
  it('keeps a stop name off a picture and lets the next one through', () => {
    // A picture spanning x 100–300, y 50–162; a stop whose label sits in it
    // and one beside it
    const picture = { left: 100, right: 300, top: 50, bottom: 162 }
    const visible = keepNonOverlappingLabels(
      [
        { x: 200, y: 150, halfWidth: 30 },
        { x: 400, y: 150, halfWidth: 30 },
      ],
      [picture],
    )
    expect(visible).toEqual([false, true])
    expect(keepNonOverlappingLabels([{ x: 200, y: 150, halfWidth: 30 }])).toEqual([true])
  })
})

function webcam(id: number): Webcam {
  return {
    id,
    title: `Cam ${id}`,
    lon: 12.1,
    lat: 54.09,
    image: `https://img.example/${id}.jpg`,
    detailUrl: `https://windy.com/webcams/${id}`,
    updatedAt: '',
  }
}

describe('WebcamsLayer.screenRects', () => {
  function harness() {
    const primitives: unknown[] = []
    const camera = { viewMatrix: Matrix4.clone(Matrix4.IDENTITY) }
    const viewer = {
      camera,
      scene: { primitives: { add: (p: unknown) => primitives.push(p) } },
      creditDisplay: { addStaticCredit: vi.fn(), removeStaticCredit: vi.fn() },
    } as unknown as Viewer
    const windowPosition = vi.fn(() => new Cartesian2(500, 300))
    const metersPerPixel = vi.fn(() => 1)
    const layer = new WebcamsLayer(viewer, {
      requestRender: vi.fn(),
      sampleGroundHeight: () => 50,
      defaultGroundHeight: 45,
      loadPicture: async () => ({ image: document.createElement('canvas'), width: 400, height: 224 }),
      windowPosition,
      metersPerPixel,
    })
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    return { layer, camera, windowPosition, metersPerPixel, settle, primitives }
  }

  it('reports each picture as the rectangle it covers, anchored at its bottom edge', async () => {
    const h = harness()
    h.layer.sync([webcam(1)])
    await h.settle()
    const L = WEBCAM_LONG_SIDE_METERS
    expect(h.layer.screenRects).toEqual([
      { left: 500 - L / 2, right: 500 + L / 2, top: 300 - (L * 224) / 400, bottom: 300 },
    ])
    // Two meters per pixel: half the size on screen
    h.metersPerPixel.mockReturnValue(2)
    const before = h.layer.screenRectsVersion
    // Nothing changed for the layer: same camera, same pictures – cached
    expect(h.layer.screenRects[0].right - h.layer.screenRects[0].left).toBe(L)
    expect(h.layer.screenRectsVersion).toBe(before)
    // The camera moved: refreshed, and the version says so
    h.camera.viewMatrix = Matrix4.clone(Matrix4.IDENTITY)
    Matrix4.setTranslation(h.camera.viewMatrix, new Cartesian3(1, 0, 0), h.camera.viewMatrix)
    expect(h.layer.screenRects[0].right - h.layer.screenRects[0].left).toBe(L / 2)
    expect(h.layer.screenRectsVersion).toBe(before + 1)
  })

  it('leaves out pictures behind the camera and not loaded yet', async () => {
    const h = harness()
    h.layer.sync([webcam(1)])
    // Not loaded: nothing to keep clear of
    expect(h.layer.screenRects).toEqual([])
    await h.settle()
    h.windowPosition.mockReturnValue(undefined as unknown as Cartesian2)
    h.layer.clear()
    expect(h.layer.screenRects).toEqual([])
  })
})

describe('a vehicle badge over a picture', () => {
  function snapshot(id: string): VehicleSnapshot {
    return {
      id,
      lineId: '1',
      lineName: 'Linie 1',
      color: '#e2001a',
      mode: 'tram',
      vehicle: config.vehicles.tram,
      direction: 0,
      distance: 0,
      lon: 12.1,
      lat: 54.0,
      bearing: 0,
      status: 'moving',
      inTunnel: false,
      nextStopName: 'Beta',
      destination: 'Beta',
      origin: 'Alpha',
      delaySeconds: 0,
      realtime: false,
    }
  }

  function harness(obstacles: () => { left: number; right: number; top: number; bottom: number }[]) {
    const entities: Entity[] = []
    const viewer = {
      scene: { primitives: { add: (primitive: Primitive) => primitive, remove: () => true } },
      entities: {
        suspendEvents: () => {},
        resumeEvents: () => {},
        add: (options: Entity.ConstructorOptions) => {
          const entity = new Entity(options)
          entities.push(entity)
          return entity
        },
        remove: () => true,
      },
      camera: {
        positionWC: Cartesian3.fromDegrees(12.1, 54.0, 2000),
        directionWC: new Cartesian3(0, 0, -1),
        upWC: new Cartesian3(0, 1, 0),
        frustum: { computeCullingVolume: () => ({ computeVisibility: () => Intersect.INSIDE }) },
      },
    } as unknown as Viewer
    const layer = new VehicleLayer(viewer, {
      requestRender: () => {},
      sampleGroundHeight: () => undefined,
      defaultGroundHeight: 0,
      routeHeightOffset: 36.5,
      nightFactor: 0,
      pixelRatio: 1,
      offline: true,
      fixedGroundHeight: 0,
      noteCameraFlight: () => {},
      obstacles,
      // The vehicle projects to (200, 180): its badge, 30 px up, to (200, 150)
      windowPosition: () => new Cartesian2(200, 180),
    })
    return { layer, entities }
  }

  it('is hidden while the picture covers it and back once it does not', () => {
    const picture = { left: 100, right: 300, top: 50, bottom: 162 }
    let rects = [picture]
    const h = harness(() => rects)
    h.layer.sync([snapshot('a')], new Set(['1']))
    expect(h.entities[0].show).toBe(false)
    rects = []
    h.layer.sync([snapshot('a')], new Set(['1']))
    expect(h.entities[0].show).toBe(true)
    // A picture ending above the badge's box (its top edge at 139) does not cover it
    rects = [{ ...picture, bottom: 130 }]
    h.layer.sync([snapshot('a')], new Set(['1']))
    expect(h.entities[0].show).toBe(true)
  })
})
