import { BoundingSphere, Cartesian3, Entity, Intersect, JulianDate, Primitive } from 'cesium'
import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import { CesiumMap, delayBadgeSuffix } from '@/map/CesiumMap'

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

/** Stub viewer good enough for createVehicleEntity and syncVehicles. */
function mapWithFakeViewer(): CesiumMap {
  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    defaultGroundHeight: 0,
    frameCounter: 0,
    frustumSphere: new BoundingSphere(),
    vehicles: new Map(),
    opts: { offline: true },
    followId: null,
    nightFactor: 0,
    renderRequested: false,
    // The stops layer has its own test files (see StopsLayer)
    stops: { update: () => {} },
    viewer: {
      scene: { primitives: { add: (primitive: Primitive) => primitive } },
      entities: {
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
    },
  })
  return map
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
    const map = mapWithFakeViewer()
    map.syncVehicles([snapshot({ realtime: true, delaySeconds: 130 })], new Set(['1']))

    const record = (
      map as unknown as { vehicles: Map<string, DelayRecord> }
    ).vehicles.get('rt-1')!
    expect(record.delaySuffix).toBe('+2')
    expect(labelText(record)).toBe('1 +2')
  })

  it('updates the label only when the rounded minute value changes', () => {
    const map = mapWithFakeViewer()
    const visible = new Set(['1'])
    map.syncVehicles([snapshot({ realtime: true, delaySeconds: 65 })], visible)
    const record = (
      map as unknown as { vehicles: Map<string, DelayRecord> }
    ).vehicles.get('rt-1')!
    expect(labelText(record)).toBe('1 +1')

    // 70 s still rounds to +1 – the text property must not be replaced
    const textProperty = record.labelEntity.label?.text
    map.syncVehicles([snapshot({ realtime: true, delaySeconds: 70 })], visible)
    expect(record.labelEntity.label?.text).toBe(textProperty)

    map.syncVehicles([snapshot({ realtime: true, delaySeconds: 130 })], visible)
    expect(labelText(record)).toBe('1 +2')

    // Delay resolved (or the GTFS-RT match dropped) → plain line number
    map.syncVehicles([snapshot({ realtime: false, delaySeconds: 0 })], visible)
    expect(record.delaySuffix).toBe('')
    expect(labelText(record)).toBe('1')
  })
})
