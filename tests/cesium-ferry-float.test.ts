import { Cartesian3, Entity, Intersect, PrimitiveCollection, type Primitive, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import { VehicleLayer } from '@/map/VehicleLayer'

/**
 * The scheduled ferries float on the tiles' own water: clamped like the
 * AIS fleet, rationed per tick, on the route profile's level until a
 * pick answers, and with their own hull, badge and route kept off the
 * pick.
 */

let clockMs = 0

beforeEach(() => {
  clockMs = 50_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const OFFSET = 36.5

function snapshot(id: string, mode: 'ferry' | 'tram', lon = 12.1): VehicleSnapshot {
  return {
    id,
    lineId: mode === 'ferry' ? 'FG' : '1',
    lineName: mode === 'ferry' ? 'FG' : 'Linie 1',
    color: '#e2001a',
    mode,
    vehicle: config.vehicles[mode],
    direction: 0,
    distance: 0,
    lon,
    lat: 54.0,
    bearing: 0,
    status: 'moving',
    nhn: 0,
    inTunnel: false,
    nextStopName: 'Beta',
    destination: 'Beta',
    origin: 'Alpha',
    delaySeconds: 0,
    realtime: false,
  }
}

function harness(surface: (lon: number, lat: number) => number | undefined) {
  const viewer = {
    scene: {
      primitives: {
        add: (primitive: Primitive) => primitive,
        remove: () => true,
      },
    },
    entities: {
      add: (options: Entity.ConstructorOptions) => new Entity(options),
      remove: () => true,
      suspendEvents: vi.fn(),
      resumeEvents: vi.fn(),
    },
    camera: {
      positionWC: Cartesian3.fromDegrees(12.1, 54.0, 1500),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: {
        computeCullingVolume: () => ({ computeVisibility: () => Intersect.INSIDE }),
      },
    },
  } as unknown as Viewer
  let generation = 0
  const routeEntity = new Entity()
  const clamp = vi.fn(surface)
  const layer = new VehicleLayer(viewer, {
    requestRender: () => {},
    sampleGroundHeight: () => undefined,
    defaultGroundHeight: 30,
    routeHeightOffset: OFFSET,
    clampToSurface: (lon, lat, exclude) => {
      // Her own group's primitives, her badge and her route are kept off
      expect(exclude).toContain(routeEntity)
      return clamp(lon, lat)
    },
    surfaceGeneration: () => generation,
    routeExclusions: () => [routeEntity],
    nightFactor: 0,
    pixelRatio: 1,
    offline: false,
    fixedGroundHeight: undefined,
    noteCameraFlight: () => {},
  })
  const visible = new Set(['FG', '1'])
  const groundOf = (id: string) =>
    (layer as unknown as { vehicles: Map<string, { groundHeight: number; group: PrimitiveCollection }> })
      .vehicles.get(id)!.groundHeight
  return { layer, clamp, visible, groundOf, bumpGeneration: () => generation++ }
}

describe('ferries float on the tiles', () => {
  it('take the clamped water height, the tram its profile', () => {
    const h = harness(() => 37.9)
    h.layer.sync([snapshot('f', 'ferry'), snapshot('t', 'tram')], h.visible)
    expect(h.groundOf('f')).toBe(37.9)
    expect(h.groundOf('t')).toBe(OFFSET)
    expect(h.clamp).toHaveBeenCalledTimes(1)
  })

  it('ride the profile until a pick answers, and pick again only when moved or the tiles changed', () => {
    let answer: number | undefined = undefined
    const h = harness(() => answer)
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.groundOf('f')).toBe(OFFSET)
    answer = 38.2
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.groundOf('f')).toBe(38.2)
    // At rest on the same tiles: no further pick
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(2)
    // 30 m on: a pick; a load cycle: a pick
    h.layer.sync([snapshot('f', 'ferry', 12.1 + 30 / (111_320 * Math.cos(54 * (Math.PI / 180))))], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(3)
    h.bumpGeneration()
    h.layer.sync([snapshot('f', 'ferry', 12.1 + 30 / (111_320 * Math.cos(54 * (Math.PI / 180))))], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(4)
  })

  it('pick at most three ferries a tick, the rest follow next tick', () => {
    const h = harness(() => 37.9)
    const fleet = ['a', 'b', 'c', 'd'].map((id) => snapshot(id, 'ferry'))
    h.layer.sync(fleet, h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(3)
    expect(h.groundOf('d')).toBe(OFFSET)
    h.layer.sync(fleet, h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(4)
    expect(h.groundOf('d')).toBe(37.9)
  })
})
