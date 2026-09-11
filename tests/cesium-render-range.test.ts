import { Cartesian3, Entity, Intersect, Math as CesiumMath, PerspectiveFrustum, Primitive, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import { VehicleLayer } from '@/map/VehicleLayer'

/**
 * The vehicle layer counts a vehicle as in view out to a range that
 * follows the lens the camera wears – through the miniature lens the same
 * ground lies further out.
 */

let clockMs = 0

beforeEach(() => {
  clockMs = 50_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function snapshot(id: string, lon = 12.1): VehicleSnapshot {
  return {
    id,
    lineId: '1',
    lineName: 'Linie 1',
    color: '#e2001a',
    mode: 'tram',
    vehicle: config.vehicles.tram,
    direction: 0,
    distance: 0,
    lon,
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

/** A frustum the culling volume of which sees everything, at the given angle. */
function lens(fovDeg: number): PerspectiveFrustum {
  const frustum = new PerspectiveFrustum({
    fov: CesiumMath.toRadians(fovDeg),
    aspectRatio: 1.6,
    near: 1,
    far: 1e7,
  })
  Object.assign(frustum, {
    computeCullingVolume: () => ({ computeVisibility: () => Intersect.INSIDE }),
  })
  return frustum
}

function harness(fovDeg: number, cameraHeight: number, paceWholeView = false) {
  const primitives = new Set<unknown>()
  const entities = new Set<Entity>()
  const viewer = {
    scene: {
      primitives: {
        add: (primitive: Primitive) => {
          primitives.add(primitive)
          return primitive
        },
        remove: (primitive: unknown) => primitives.delete(primitive),
      },
    },
    entities: {
      add: (options: Entity.ConstructorOptions) => {
        const entity = new Entity(options)
        entities.add(entity)
        return entity
      },
      remove: (entity: Entity) => entities.delete(entity),
      suspendEvents: vi.fn(),
      resumeEvents: vi.fn(),
    },
    camera: {
      positionWC: Cartesian3.fromDegrees(12.1, 54.0, cameraHeight),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: lens(fovDeg),
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
    paceWholeView,
  })
  const visible = new Set(['1'])
  return { layer, primitives, entities, visible }
}

describe('the render range follows the lens', () => {
  // The camera stands 25 km above the vehicle: beyond the 20 km range of
  // the plain 60° lens, inside the 52 km the miniature lens reaches.
  it('counts a vehicle 25 km away as out of view through the plain lens', () => {
    const h = harness(60, 25_000)
    const { anyVehicleInView } = h.layer.sync([snapshot('a')], h.visible)
    expect(anyVehicleInView).toBe(false)
  })

  it('and as in view through the miniature lens', () => {
    const h = harness(config.camera.fovDeg, 25_000)
    const { anyVehicleInView } = h.layer.sync([snapshot('a')], h.visible)
    expect(anyVehicleInView).toBe(true)
  })

  it('reaches as far as the labels while the whole view is paced – the time-lapse, a camera path', () => {
    // 25 km through the plain lens: out of the render range, inside the
    // label range – under the time-lapse the label must not step along
    const h = harness(60, 25_000, true)
    expect(h.layer.sync([snapshot('a')], h.visible).anyVehicleInView).toBe(true)
    // …and no further than the labels are drawn
    const far = harness(60, 100_000, true)
    expect(far.layer.sync([snapshot('a')], far.visible).anyVehicleInView).toBe(false)
  })
})
