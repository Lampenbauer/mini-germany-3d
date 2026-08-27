import { Cartographic, Entity, Matrix4, Primitive, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import type { AisVessel } from '@/lib/ais-extract'
import { VesselLayer } from '@/map/VesselLayer'

/**
 * AIS backdrop fleet: boxes in real ship dimensions that dead-reckon
 * between polls, labels that fall back to the MMSI until a name arrives,
 * and records that leave with their vessel.
 */

const NOW = 1_800_000_000_000

function vessel(overrides: Partial<AisVessel> = {}): AisVessel {
  return {
    mmsi: 211222290,
    name: 'DENEB',
    lat: 54.0982,
    lon: 12.106,
    sogKn: 0,
    cogDeg: null,
    headingDeg: 163,
    navStatus: 0,
    typeCode: 0,
    lengthM: 52,
    widthM: 12,
    positionAt: NOW,
    ...overrides,
  }
}

function harness() {
  const removedPrimitives: Primitive[] = []
  const removedEntities: Entity[] = []
  const viewer = {
    scene: {
      primitives: {
        add: (primitive: Primitive) => primitive,
        remove: (primitive: Primitive) => removedPrimitives.push(primitive),
      },
    },
    entities: {
      add: (options: Entity.ConstructorOptions) => new Entity(options),
      remove: (entity: Entity) => removedEntities.push(entity),
    },
  } as unknown as Viewer
  const layer = new VesselLayer(viewer, { requestRender: vi.fn(), waterSurfaceHeight: 37.75 })
  const record = (mmsi: number) =>
    (
      layer as unknown as {
        vessels: Map<number, { matrix: Matrix4; labelEntity: Entity; labelText: string }>
      }
    ).vessels.get(mmsi)
  return { layer, record, removedPrimitives, removedEntities }
}

function positionOf(matrix: Matrix4): Cartographic {
  return Cartographic.fromCartesian(Matrix4.getTranslation(matrix, { x: 0, y: 0, z: 0 } as never))
}

describe('VesselLayer', () => {
  it('creates a box and a name label per vessel', () => {
    const h = harness()
    h.layer.sync([vessel()], NOW)
    expect(h.layer.vesselCount).toBe(1)
    const carto = positionOf(h.record(211222290)!.matrix)
    expect((carto.latitude * 180) / Math.PI).toBeCloseTo(54.0982, 4)
    expect(h.record(211222290)!.labelText).toBe('DENEB')
  })

  it('labels a nameless vessel with its MMSI until static data arrives', () => {
    const h = harness()
    h.layer.sync([vessel({ name: '' })], NOW)
    expect(h.record(211222290)!.labelText).toBe('211222290')
    h.layer.sync([vessel()], NOW)
    expect(h.record(211222290)!.labelText).toBe('DENEB')
  })

  it('dead-reckons a moving vessel between polls', () => {
    const h = harness()
    const moving = vessel({ sogKn: 8, cogDeg: 90, positionAt: NOW - 30_000 })
    h.layer.sync([moving], NOW)
    const carto = positionOf(h.record(211222290)!.matrix)
    const lonDeg = (carto.longitude * 180) / Math.PI
    // 8 kn east for 30 s ≈ 123 m ≈ 0.0019° at this latitude
    expect(lonDeg).toBeGreaterThan(12.1075)
    expect(lonDeg).toBeLessThan(12.108)
  })

  it('drops vessels that expired or vanished from the list', () => {
    const h = harness()
    h.layer.sync([vessel(), vessel({ mmsi: 42, name: 'CLARA' })], NOW)
    expect(h.layer.vesselCount).toBe(2)
    h.layer.sync([vessel()], NOW)
    expect(h.layer.vesselCount).toBe(1)
    expect(h.removedPrimitives).toHaveLength(1)
    expect(h.removedEntities).toHaveLength(1)
    h.layer.sync([vessel({ positionAt: NOW - 31 * 60_000 })], NOW)
    expect(h.layer.vesselCount).toBe(0)
  })

  it('rebuilds the box when the real dimensions arrive', () => {
    const h = harness()
    h.layer.sync([vessel({ lengthM: null, widthM: null })], NOW)
    const before = h.record(211222290)
    h.layer.sync([vessel()], NOW)
    const after = h.record(211222290)
    expect(after).not.toBe(before)
    expect(h.removedPrimitives).toHaveLength(1)
    expect(h.layer.vesselCount).toBe(1)
  })

  it('hides and reveals the fleet with the underground view', () => {
    const h = harness()
    h.layer.sync([vessel()], NOW)
    h.layer.setVisible(false)
    expect(h.record(211222290)!.labelEntity.show).toBe(false)
    h.layer.setVisible(true)
    expect(h.record(211222290)!.labelEntity.show).toBe(true)
  })
})
