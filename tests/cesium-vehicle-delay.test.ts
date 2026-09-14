import { Cartesian3, Color, Entity, Intersect, JulianDate, Primitive, type Viewer } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import { delayBadgeSuffix, VehicleLayer } from '@/map/VehicleLayer'

/**
 * GTFS-RT delays appear on the map badge as a small "+2" after the line
 * number. jsdom has no 2D canvas, so these tests exercise the text-label
 * fallback – the suffix logic and the re-render wiring are shared with the
 * canvas badge path.
 */

function snapshot(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: 'rt-1',
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
    ...overrides,
  }
}

/** Real VehicleLayer on a stub viewer, good enough for sync(). */
function vehicleLayerWithFakeViewer(): VehicleLayer {
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

interface DelayRecord {
  delaySuffix: string
  labelEntity: Entity
}

const labelText = (record: DelayRecord): string =>
  record.labelEntity.label?.text?.getValue(JulianDate.now()) as string

describe('delayBadgeSuffix', () => {
  it('is empty without a GTFS-RT match, even with a delay value', () => {
    expect(delayBadgeSuffix({ realtime: false, delaySeconds: 300 })).toBe('')
  })

  it('treats less than a minute as on time (same threshold as the VehicleCard)', () => {
    expect(delayBadgeSuffix({ realtime: true, delaySeconds: 59 })).toBe('')
    expect(delayBadgeSuffix({ realtime: true, delaySeconds: -59 })).toBe('')
  })

  it('rounds to minutes and keeps the sign', () => {
    expect(delayBadgeSuffix({ realtime: true, delaySeconds: 65 })).toBe('+1')
    expect(delayBadgeSuffix({ realtime: true, delaySeconds: 130 })).toBe('+2')
    expect(delayBadgeSuffix({ realtime: true, delaySeconds: -120 })).toBe('-2')
  })
})

describe('delay suffix on the vehicle label', () => {
  it('bakes the suffix into the label of a newly created vehicle', () => {
    const layer = vehicleLayerWithFakeViewer()
    layer.sync([snapshot({ realtime: true, delaySeconds: 130 })], new Set(['1']))

    const record = (
      layer as unknown as { vehicles: Map<string, DelayRecord> }
    ).vehicles.get('rt-1')!
    expect(record.delaySuffix).toBe('+2')
    expect(labelText(record)).toBe('1 +2')
  })

  it('updates the label only when the rounded minute value changes', () => {
    const layer = vehicleLayerWithFakeViewer()
    const visible = new Set(['1'])
    layer.sync([snapshot({ realtime: true, delaySeconds: 65 })], visible)
    const record = (
      layer as unknown as { vehicles: Map<string, DelayRecord> }
    ).vehicles.get('rt-1')!
    expect(labelText(record)).toBe('1 +1')

    // 70 s still rounds to +1 – the text property must not be replaced
    const textProperty = record.labelEntity.label?.text
    layer.sync([snapshot({ realtime: true, delaySeconds: 70 })], visible)
    expect(record.labelEntity.label?.text).toBe(textProperty)

    layer.sync([snapshot({ realtime: true, delaySeconds: 130 })], visible)
    expect(labelText(record)).toBe('1 +2')

    // Delay resolved (or the GTFS-RT match dropped) → plain line number
    layer.sync([snapshot({ realtime: false, delaySeconds: 0 })], visible)
    expect(record.delaySuffix).toBe('')
    expect(labelText(record)).toBe('1')
  })
})

/**
 * The badge cache is keyed by line number, colour AND delay suffix. It
 * outlives the city switch – the layer does – and line numbers repeat
 * across cities in other colours (Berlin's S1 against Rostock's), so a
 * key without the colour handed the new city the old city's badge while
 * its VehicleCard showed the right one.
 *
 * jsdom has no 2D canvas and the suite runs in Node, so the canvas here is
 * a stub: its data URL carries the colour the plate was filled with, which
 * is all these assertions read.
 */
describe('the line badge cache', () => {
  function stubCanvasDocument(): { created: () => number } {
    let created = 0
    vi.stubGlobal('document', {
      createElement: () => {
        created++
        let plate = ''
        const ctx = {
          font: '',
          textAlign: '',
          textBaseline: '',
          fillStyle: '',
          measureText: (text: string) => ({ width: text.length * 7 }),
          beginPath: () => {},
          roundRect: () => {},
          rect: () => {},
          // The plate is the one fill(); the texts go through fillText()
          fill: () => {
            plate = ctx.fillStyle
          },
          fillText: () => {},
        }
        return {
          width: 0,
          height: 0,
          getContext: () => ctx,
          toDataURL: () => `data:image/png;plate=${plate}`,
        }
      },
    })
    return { created: () => created }
  }

  afterEach(() => vi.unstubAllGlobals())

  /** The badge as the sync loop asks for it. */
  const badgeOf = (layer: VehicleLayer, lineId: string, css: string, suffix = '') =>
    (
      layer as unknown as {
        lineBadge(id: string, color: Color, suffix?: string): { image: string } | undefined
      }
    ).lineBadge(lineId, Color.fromCssColorString(css), suffix)

  it('draws a second badge when the same line number arrives in another colour', () => {
    stubCanvasDocument()
    const layer = vehicleLayerWithFakeViewer()

    const rostock = badgeOf(layer, 'S1', '#66CDAA')
    const berlin = badgeOf(layer, 'S1', '#D474AE')

    expect(rostock!.image).toContain(Color.fromCssColorString('#66CDAA').toCssColorString())
    expect(berlin!.image).toContain(Color.fromCssColorString('#D474AE').toCssColorString())
    expect(berlin!.image).not.toBe(rostock!.image)
  })

  it('still draws one canvas per line number, colour and delay suffix', () => {
    const canvases = stubCanvasDocument()
    const layer = vehicleLayerWithFakeViewer()

    badgeOf(layer, '1', '#e2001a')
    badgeOf(layer, '1', '#e2001a')
    expect(canvases.created()).toBe(1)

    // A delay suffix is a badge of its own, the colour unchanged
    badgeOf(layer, '1', '#e2001a', '+2')
    expect(canvases.created()).toBe(2)
  })
})
