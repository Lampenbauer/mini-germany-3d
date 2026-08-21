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
} from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import { prepareNetwork } from '@/data/network'
import type { TramSnapshot } from '@/engine/simulation'
import { CesiumMap, TUNNEL_VISIBILITY } from '@/map/CesiumMap'
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

/** CesiumMap with a stubbed viewer that records added route entities. */
function mapWithFakeRouteViewer(added: AddedRoute[]): CesiumMap {
  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    viewer: {
      entities: {
        add: (options: Omit<AddedRoute, 'show'>) => {
          const entity = { ...options, show: true }
          added.push(entity)
          return entity
        },
      },
      creditDisplay: { addStaticCredit: vi.fn() },
    },
    routeEntities: new Map(),
    linePaths: new Map(),
    heightRoutePieces: [],
    // offline: keeps the ground-clamped route branch these tests inspect
    opts: { offline: true },
  })
  return map
}

const routeOpacities = (added: AddedRoute[]): number[] =>
  added.map((entity) => {
    const property = entity.polyline?.material?.color
    return (property?.getValue(JulianDate.now()) as Color).alpha
  })

/** Fake record for applyTramAppearance (label as a plain property bag). */
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

const applyTramAppearance = (map: CesiumMap, tramId: string): boolean =>
  (
    map as unknown as { applyTramAppearance: (tramId: string) => boolean }
  ).applyTramAppearance(tramId)

describe('Cesium tunnel rendering', () => {
  it('renders route pieces at full / tunnel-dimmed / full opacity (mirrored line drawn once)', () => {
    const added: AddedRoute[] = []
    const map = mapWithFakeRouteViewer(added)

    map.addRoutes(prepareNetwork(testTunnelNetworkJson))

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

    map.setLineRouteVisible('U', false)
    expect(added.every((entity) => !entity.show)).toBe(true)
  })

  it('draws both directions when their tunnel layouts differ', () => {
    const added: AddedRoute[] = []
    const map = mapWithFakeRouteViewer(added)

    map.addRoutes(prepareNetwork(testAsymmetricTunnelNetworkJson))

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
    const map = Object.create(CesiumMap.prototype) as CesiumMap
    Object.assign(map, { selectedId: null, trams: new Map([['vehicle', record]]) })

    expect(applyTramAppearance(map, 'vehicle')).toBe(true)
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
    const map = Object.create(CesiumMap.prototype) as CesiumMap
    Object.assign(map, {
      defaultGroundHeight: 0,
      selectedId: null,
      viewer: {
        scene: {
          primitives: { add: (primitive: Primitive) => primitive },
        },
        entities: {
          add: (options: Entity.ConstructorOptions) => new Entity(options),
        },
      },
    })
    // A box-body mode: tram/train use glTF models, whose appearance path
    // has no appearance/render state (covered by the model branch).
    const snapshot: TramSnapshot = {
      id: 'tunnel-spawn',
      lineId: 'U',
      lineName: 'Tunnellinie',
      color: '#ff0000',
      mode: 'bus',
      vehicle: config.vehicles.bus,
      direction: 0,
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
        createTramEntity: (snap: TramSnapshot) => {
          primitive: Primitive
          appearance: PerInstanceColorAppearance
        }
      }
    ).createTramEntity(snapshot)
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
    const map = Object.create(CesiumMap.prototype) as CesiumMap
    Object.assign(map, { trams: new Map([['vehicle', record]]) })

    expect(applyTramAppearance(map, 'vehicle')).toBe(false)
    // The translucent flag is applied even before the first render.
    expect(record.appearance.translucent).toBe(true)

    ready = true
    expect(applyTramAppearance(map, 'vehicle')).toBe(true)
    expect(attributes.color[3]).toBe(Math.round(TUNNEL_VISIBILITY * 255))
  })
})
