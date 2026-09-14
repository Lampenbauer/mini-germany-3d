import {
  Color,
  ColorGeometryInstanceAttribute,
  ColorMaterialProperty,
  ConstantProperty,
  Entity,
  GeometryInstance,
  JulianDate,
  PerInstanceColorAppearance,
  Primitive,
  type Viewer,
} from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import { prepareNetwork } from '@/data/network'
import type { VehicleSnapshot } from '@/engine/simulation'
import { RoutesLayer } from '@/map/RoutesLayer'
import { routeTunnelOpacity, TUNNEL_VISIBILITY } from '@/map/tunnel-view'
import { VehicleLayer } from '@/map/VehicleLayer'
import { testAsymmetricTunnelNetworkJson, testTunnelNetworkJson } from './fixtures'

/**
 * Tests for the Cesium-facing tunnel mechanics on synthetic map/record
 * stubs: route piece opacities incl. the mirror check, the shared
 * appearance whose `translucent` flag is toggled, and the appearanceDirty
 * retry for primitives that have not rendered yet.
 */

interface AddedRoute {
  id?: string
  show: boolean
  polyline?: {
    positions?: unknown[]
    material?: ColorMaterialProperty
  }
}

/** Routes layer on a stubbed viewer that records added route entities. */
function routesWithFakeViewer(added: AddedRoute[]): RoutesLayer {
  const viewer = {
    entities: {
      add: (options: Omit<AddedRoute, 'show'>) => {
        const entity = { ...options, show: true }
        added.push(entity)
        return entity
      },
    },
    creditDisplay: { addStaticCredit: vi.fn() },
  } as unknown as Viewer
  // offline: the routes lie on the ellipsoid at 0 m as ordinary polylines
  return new RoutesLayer(viewer, { requestRender: vi.fn(), offline: true })
}

/** Real VehicleLayer on a stub viewer for the appearance/tunnel checks. */
function vehicleLayer(): VehicleLayer {
  const viewer = {
    scene: { primitives: { add: (primitive: Primitive) => primitive } },
    entities: {
      add: (options: Entity.ConstructorOptions) => new Entity(options),
      remove: () => {},
    },
  } as unknown as Viewer
  return new VehicleLayer(viewer, {
    requestRender: () => {},
    sampleGroundHeight: () => undefined,
    defaultGroundHeight: 0,
    routeHeightOffset: 36.5,
    nightFactor: 0,
    pixelRatio: 1,
    flatGround: true,
    fixedGroundHeight: undefined,
    noteCameraFlight: () => {},
  })
}

const routeOpacities = (added: AddedRoute[]): number[] =>
  added.map((entity) => {
    const property = entity.polyline?.material?.color
    return (property?.getValue(JulianDate.now()) as Color).alpha
  })

/** Fake record for applyVehicleAppearance (label as a plain property bag). */
function fakeRecord(overrides: Record<string, unknown> = {}) {
  const attributes = { color: ColorGeometryInstanceAttribute.toValue(Color.RED) }
  return {
    attributes,
    primitive: { getGeometryInstanceAttributes: vi.fn(() => attributes) },
    appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
    labelEntity: {
      // Both variants present so the badge and the text fallback are covered
      billboard: {} as { color?: ConstantProperty },
      label: {} as { fillColor?: ConstantProperty; outlineColor?: ConstantProperty },
    },
    baseColor: Color.RED,
    inTunnel: true,
    highlighted: false,
    appearanceDirty: true,
    ...overrides,
  }
}

const applyVehicleAppearance = (map: VehicleLayer, vehicleId: string): boolean =>
  (
    map as unknown as { applyVehicleAppearance: (vehicleId: string) => boolean }
  ).applyVehicleAppearance(vehicleId)

describe('Cesium tunnel rendering', () => {
  it('renders route pieces at full / tunnel-dimmed / full opacity (mirrored line drawn once)', () => {
    const added: AddedRoute[] = []
    const routes = routesWithFakeViewer(added)

    routes.add(prepareNetwork(testTunnelNetworkJson))

    // Direction 1 is an exact mirror (path and tunnel ranges) → only
    // direction 0 is drawn, split at the tunnel portals.
    expect(added.map((entity) => entity.id)).toEqual([
      'route:U:0:0',
      'route:U:0:1',
      'route:U:0:2',
    ])
    expect(added.map((entity) => entity.polyline?.positions?.length)).toEqual([2, 2, 3])
    const opacities = routeOpacities(added)
    expect(opacities[0]).toBeCloseTo(0.85)
    expect(opacities[1]).toBeCloseTo(0.85 * TUNNEL_VISIBILITY)
    expect(opacities[2]).toBeCloseTo(0.85)

    routes.setLineVisible('U', false)
    expect(added.every((entity) => !entity.show)).toBe(true)
  })

  it('draws both directions when their tunnel layouts differ', () => {
    const added: AddedRoute[] = []
    const routes = routesWithFakeViewer(added)

    routes.add(prepareNetwork(testAsymmetricTunnelNetworkJson))

    // Identical (reversed) geometry, but asymmetric tunnel tagging: the old
    // length/endpoint heuristic collapsed this into one direction and lost
    // direction 1's tunnel piece.
    expect(added.map((entity) => entity.id)).toEqual([
      'route:V:0:0',
      'route:V:0:1',
      'route:V:0:2',
      'route:V:1:0',
      'route:V:1:1',
      'route:V:1:2',
    ])
    const tunnelPieces = routeOpacities(added).filter(
      (alpha) => Math.abs(alpha - 0.85 * TUNNEL_VISIBILITY) < 1e-9,
    )
    expect(tunnelPieces).toHaveLength(2)
  })

  it('keeps the tunnel alpha on body and label while selecting and deselecting in a tunnel', () => {
    const record = fakeRecord()
    const { attributes } = record
    const map = vehicleLayer()
    ;(map as unknown as { vehicles: Map<string, unknown> }).vehicles.set('vehicle', record)

    expect(applyVehicleAppearance(map, 'vehicle')).toBe(true)
    expect(record.appearance.translucent).toBe(true)
    expect(attributes.color[3]).toBe(Math.round(TUNNEL_VISIBILITY * 255))
    expect(record.labelEntity.label.fillColor?.getValue().alpha).toBeCloseTo(TUNNEL_VISIBILITY)
    // The badge billboard ghosts via its color multiplier
    expect(record.labelEntity.billboard.color?.getValue().alpha).toBeCloseTo(TUNNEL_VISIBILITY)
    const baseColor = [...attributes.color]

    map.setSelected('vehicle')
    expect(attributes.color[1]).toBeGreaterThan(baseColor[1])
    expect(attributes.color[2]).toBeGreaterThan(baseColor[2])
    expect(attributes.color[3]).toBe(Math.round(TUNNEL_VISIBILITY * 255))

    map.setSelected(null)
    expect([...attributes.color]).toEqual(baseColor)
  })

  it('uses an opaque base render state when a vehicle spawns inside a tunnel', () => {
    const map = vehicleLayer()
    // Every real mode ships a glTF consist now, whose appearance path has
    // no appearance/render state (covered by the model branch). The box
    // body remains the defensive fallback for a mode without a model –
    // an invented mode pins that branch open for this test.
    const snapshot: VehicleSnapshot = {
      id: 'tunnel-spawn',
      lineId: 'U',
      lineName: 'Tunnellinie',
      color: '#ff0000',
      mode: 'zeppelin' as VehicleSnapshot['mode'],
      vehicle: config.vehicles.ferry,
      direction: 0,
      distance: 0,
      lon: 12.1,
      lat: 54.0,
      bearing: 0,
      status: 'moving',
      inTunnel: true,
      nextStopName: 'Gamma',
      destination: 'Gamma',
      origin: 'Alpha',
      delaySeconds: 0,
      realtime: false,
    }

    const record = (
      map as unknown as {
        createVehicleEntity: (snap: VehicleSnapshot) => {
          primitive: Primitive
          appearance: PerInstanceColorAppearance
        }
      }
    ).createVehicleEntity(snapshot)
    const instance = record.primitive.geometryInstances as GeometryInstance
    const color = instance.attributes?.color as ColorGeometryInstanceAttribute

    expect(record.appearance.translucent).toBe(true)
    expect(color.value[3]).toBe(Math.round(TUNNEL_VISIBILITY * 255))
    // The base render state was built opaque, so leaving the tunnel removes
    // the blending again (a translucent base state would keep it forever).
    record.appearance.translucent = false
    expect(record.appearance.getRenderState().blending).toBeUndefined()
  })

  it('retries an appearance change after the primitive becomes ready', () => {
    const attributes = { color: ColorGeometryInstanceAttribute.toValue(Color.RED) }
    let ready = false
    const record = fakeRecord({
      primitive: {
        getGeometryInstanceAttributes: vi.fn(() => {
          if (!ready) throw new Error('not rendered')
          return attributes
        }),
      },
    })
    const map = vehicleLayer()
    ;(map as unknown as { vehicles: Map<string, unknown> }).vehicles.set('vehicle', record)

    expect(applyVehicleAppearance(map, 'vehicle')).toBe(false)
    // The translucent flag is applied even before the first render.
    expect(record.appearance.translucent).toBe(true)

    ready = true
    expect(applyVehicleAppearance(map, 'vehicle')).toBe(true)
    expect(attributes.color[3]).toBe(Math.round(TUNNEL_VISIBILITY * 255))
  })
})

describe('underground view', () => {
  it('swaps ghosted and solid route pieces', () => {
    const added: AddedRoute[] = []
    const routes = routesWithFakeViewer(added)
    routes.add(prepareNetwork(testTunnelNetworkJson))

    // Normal: surface solid, the tunnel piece in the middle ghosted
    expect(routeOpacities(added)).toEqual([
      expect.closeTo(0.85, 5),
      expect.closeTo(0.85 * TUNNEL_VISIBILITY, 5),
      expect.closeTo(0.85, 5),
    ])

    routes.setUnderground(true)
    // Underground: the other way round – and the ghosted surface goes
    // fainter than a ghosted tunnel does, because it now lies on a
    // darkened city instead of a bright one.
    const ghost = 0.85 * routeTunnelOpacity(false, true)
    expect(ghost).toBeLessThan(0.85 * TUNNEL_VISIBILITY)
    expect(routeOpacities(added)).toEqual([
      expect.closeTo(ghost, 5),
      expect.closeTo(0.85, 5),
      expect.closeTo(ghost, 5),
    ])

    routes.setUnderground(false)
    expect(routeOpacities(added)[1]).toBeCloseTo(0.85 * TUNNEL_VISIBILITY, 5)
  })

  it('swaps the vehicle opacity and marks the records for repaint', () => {
    const map = vehicleLayer()
    const surface = fakeRecord({ inTunnel: false, appearanceDirty: false })
    const tunnel = fakeRecord({ inTunnel: true, appearanceDirty: false })
    const vehicles = (map as unknown as { vehicles: Map<string, unknown> }).vehicles
    vehicles.set('surface', surface)
    vehicles.set('tunnel', tunnel)

    applyVehicleAppearance(map, 'surface')
    applyVehicleAppearance(map, 'tunnel')
    expect(surface.attributes.color[3]).toBe(255)
    expect(tunnel.attributes.color[3]).toBe(Math.round(TUNNEL_VISIBILITY * 255))

    map.setUnderground(true)
    // Every record needs repainting – sync() picks that up
    expect(surface.appearanceDirty).toBe(true)
    expect(tunnel.appearanceDirty).toBe(true)

    applyVehicleAppearance(map, 'surface')
    applyVehicleAppearance(map, 'tunnel')
    expect(surface.attributes.color[3]).toBe(Math.round(TUNNEL_VISIBILITY * 255))
    expect(tunnel.attributes.color[3]).toBe(255)
    // The ghosted half is the translucent one, whichever side that is
    expect(surface.appearance.translucent).toBe(true)
    expect(tunnel.appearance.translucent).toBe(false)
  })
})
