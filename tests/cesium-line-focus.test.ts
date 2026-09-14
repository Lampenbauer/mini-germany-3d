import { Cartesian3, Entity, Intersect, Primitive, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import { ROUTE_PULSE_DURATION_MS } from '@/map/RoutesLayer'
import { VehicleLayer } from '@/map/VehicleLayer'

/**
 * "Zoom to line" clears the stage: for the duration of the route pulse
 * only the focused line's vehicle badges stay up, so the other lines'
 * labels do not cover the route the pulse is pointing at. The other two
 * layers that step aside with them are pinned where they live –
 * cesium-stop-visibility.test.ts for the stops, cesium-vessel-layer.test.ts
 * for the ship names.
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

describe('line focus on the vehicle labels', () => {
  it('leaves every label up without a focus', () => {
    const h = harness()
    h.tick()
    expect(h.labelShown('a')).toBe(true)
    expect(h.labelShown('b')).toBe(true)
  })

  it('hides the labels of the other lines while the focus runs', () => {
    const h = harness()
    h.tick()
    h.layer.startLineFocus('1', ROUTE_PULSE_DURATION_MS)
    h.tick()
    expect(h.labelShown('a')).toBe(true)
    expect(h.labelShown('b')).toBe(false)
  })

  it('brings them back on the first tick after the focus ends', () => {
    const h = harness()
    h.layer.startLineFocus('1', ROUTE_PULSE_DURATION_MS)
    h.tick()
    expect(h.labelShown('b')).toBe(false)

    // Still inside the window – one tick short of the end
    clockMs += ROUTE_PULSE_DURATION_MS - 1
    h.tick()
    expect(h.labelShown('b')).toBe(false)

    clockMs += 1
    h.tick()
    expect(h.labelShown('b')).toBe(true)
  })

  it('a focus on another line swaps which labels stay up', () => {
    const h = harness()
    h.layer.startLineFocus('1', ROUTE_PULSE_DURATION_MS)
    h.tick()
    h.layer.startLineFocus('2', ROUTE_PULSE_DURATION_MS)
    h.tick()
    expect(h.labelShown('a')).toBe(false)
    expect(h.labelShown('b')).toBe(true)
  })

  it('never shows a hidden line just because it is focused', () => {
    const h = harness()
    h.layer.startLineFocus('1', ROUTE_PULSE_DURATION_MS)
    // Line 1 switched off in the panel – the focus must not override that
    h.layer.sync([snapshot('a', '1'), snapshot('b', '2')], new Set(['2']))
    expect(h.labelShown('a')).toBe(false)
    expect(h.labelShown('b')).toBe(false)
  })
})
