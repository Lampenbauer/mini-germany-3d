import { Cartesian3, Entity, Intersect, Primitive, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import { ROUTE_PULSE_DURATION_MS } from '@/map/RoutesLayer'
import { VehicleLayer } from '@/map/VehicleLayer'

/**
 * The Layers panel's "Labels" switch: every name off the map at once.
 * The vehicles' half of it (VesselLayer covers the ships) – and it must
 * outrank the two other things that decide a badge's visibility, the
 * line focus and a vehicle arriving after the switch was thrown.
 */

let clockMs = 0

beforeEach(() => {
  clockMs = 50_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function snapshot(id: string, lineId: string): VehicleSnapshot {
  return {
    id,
    lineId,
    lineName: `Linie ${lineId}`,
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
    gradient: 0,
    nextStopName: 'Beta',
    destination: 'Beta',
    origin: 'Alpha',
    delaySeconds: 0,
    realtime: false,
  }
}

function harness() {
  const viewer = {
    scene: { primitives: { add: (primitive: Primitive) => primitive } },
    entities: {
      suspendEvents: () => {},
      resumeEvents: () => {},
      add: (options: Entity.ConstructorOptions) => new Entity(options),
      remove: () => {},
    },
    camera: {
      positionWC: Cartesian3.fromDegrees(12.1, 54.0, 5000),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: {
        computeCullingVolume: () => ({ computeVisibility: () => Intersect.OUTSIDE }),
      },
    },
  } as unknown as Viewer
  const layer = new VehicleLayer(viewer, {
    requestRender: () => {},
    sampleGroundHeight: () => undefined,
    defaultGroundHeight: 0,
    routeHeightOffset: 36.5,
    nightFactor: 0,
    pixelRatio: 1,
    flatGround: true,
    fixedGroundHeight: 0,
    noteCameraFlight: () => {},
  })
  const visible = new Set(['1', '2'])
  const tick = () => layer.sync([snapshot('a', '1'), snapshot('b', '2')], visible)
  const labelShown = (id: string) =>
    (layer as unknown as { vehicles: Map<string, { labelEntity: Entity }> }).vehicles.get(id)!
      .labelEntity.show
  return { layer, tick, labelShown }
}

describe('the Labels toggle on the vehicle badges', () => {
  it('takes every badge down and puts them back', () => {
    const h = harness()
    h.tick()
    h.layer.setLabelsVisible(false)
    // Down immediately – waiting for the next tick would lag the switch
    expect(h.labelShown('a')).toBe(false)
    expect(h.labelShown('b')).toBe(false)
    h.layer.setLabelsVisible(true)
    h.tick()
    expect(h.labelShown('a')).toBe(true)
    expect(h.labelShown('b')).toBe(true)
  })

  it('keeps them down across ticks and for vehicles arriving later', () => {
    const h = harness()
    h.layer.setLabelsVisible(false)
    h.tick()
    // First sighting of both vehicles happens with the switch already off
    expect(h.labelShown('a')).toBe(false)
    h.tick()
    expect(h.labelShown('a')).toBe(false)
  })

  it('outranks a running line focus in both directions', () => {
    const h = harness()
    h.layer.startLineFocus('1', ROUTE_PULSE_DURATION_MS)
    h.tick()
    expect(h.labelShown('a')).toBe(true) // the focused line's badge

    h.layer.setLabelsVisible(false)
    h.tick()
    expect(h.labelShown('a')).toBe(false)

    // Back on, the focus still running: it decides again which stay up
    h.layer.setLabelsVisible(true)
    h.tick()
    expect(h.labelShown('a')).toBe(true)
    expect(h.labelShown('b')).toBe(false)
  })
})
