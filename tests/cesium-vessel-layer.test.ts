import { Cartesian3, Cartographic, Entity, Intersect, Matrix4, Primitive, type Viewer } from 'cesium'
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

function harness({
  cameraLon = 12.106,
  cameraHeight = 1500,
  frustum = Intersect.INTERSECTING,
}: { cameraLon?: number; cameraHeight?: number; frustum?: Intersect } = {}) {
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
    camera: {
      positionWC: Cartesian3.fromDegrees(cameraLon, 54.098, cameraHeight),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: {
        computeCullingVolume: () => ({ computeVisibility: () => frustum }),
      },
    },
  } as unknown as Viewer
  const requestRender = vi.fn()
  const layer = new VesselLayer(viewer, { requestRender, waterSurfaceHeight: 37.75 })
  const record = (mmsi: number) =>
    (
      layer as unknown as {
        vessels: Map<number, { matrix: Matrix4; labelEntity: Entity; labelText: string }>
      }
    ).vessels.get(mmsi)
  return { layer, record, removedPrimitives, removedEntities, requestRender }
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

  it('repaints for movement on screen, but never for ships nobody sees', () => {
    // The map renders on demand – a vessel sailing far outside the view
    // must not keep the GPU awake (that is the trams' rule too).
    const offScreen = harness({ frustum: Intersect.OUTSIDE })
    offScreen.layer.sync([vessel({ sogKn: 8, cogDeg: 90, positionAt: NOW - 5_000 })], NOW)
    // Even the arrival stays silent off screen – the next due frame
    // includes the new box anyway.
    expect(offScreen.requestRender).not.toHaveBeenCalled()
    offScreen.layer.sync([vessel({ sogKn: 8, cogDeg: 90, positionAt: NOW - 5_000 })], NOW + 10_000)
    expect(offScreen.requestRender).not.toHaveBeenCalled()

    const beyondRange = harness({ cameraLon: 12.7 }) // ~39 km east, frustum says visible
    beyondRange.layer.sync([vessel({ sogKn: 8, cogDeg: 90, positionAt: NOW - 5_000 })], NOW)
    beyondRange.requestRender.mockClear()
    beyondRange.layer.sync([vessel({ sogKn: 8, cogDeg: 90, positionAt: NOW - 5_000 })], NOW + 10_000)
    expect(beyondRange.requestRender).not.toHaveBeenCalled()

    const onScreen = harness()
    onScreen.layer.sync([vessel({ sogKn: 8, cogDeg: 90, positionAt: NOW - 5_000 })], NOW)
    onScreen.requestRender.mockClear()
    onScreen.layer.sync([vessel({ sogKn: 8, cogDeg: 90, positionAt: NOW - 5_000 })], NOW + 10_000)
    expect(onScreen.requestRender).toHaveBeenCalled()
  })

  it('reports a ship under way on screen for the tick pacing – steadily', () => {
    const h = harness()
    const underWay = () => vessel({ sogKn: 4, cogDeg: 180, positionAt: NOW })
    expect(h.layer.sync([underWay()], NOW).anyMovingVesselInView).toBe(true)
    // Stable across consecutive 33 ms ticks even though the pose ease
    // advances less than the repaint epsilon per tick – a flickering
    // signal would oscillate the app between its 33 and 500 ms ticks.
    expect(h.layer.sync([underWay()], NOW + 33).anyMovingVesselInView).toBe(true)
    expect(h.layer.sync([underWay()], NOW + 66).anyMovingVesselInView).toBe(true)

    // Moored: converges, then reports quiet
    const moored = harness()
    const anchored = () => vessel({ sogKn: 0, cogDeg: null })
    moored.layer.sync([anchored()], NOW)
    expect(moored.layer.sync([anchored()], NOW + 33).anyMovingVesselInView).toBe(false)

    // Under way but off screen: quiet too
    const offScreen = harness({ frustum: Intersect.OUTSIDE })
    expect(offScreen.layer.sync([underWay()], NOW).anyMovingVesselInView).toBe(false)
  })

  it('glides onto a corrected fix instead of teleporting', () => {
    const h = harness()
    h.layer.sync([vessel()], NOW)
    // A fresh fix 200 m east – after one 33 ms tick the drawn ship has
    // moved only a small first step of the ease, not the full jump …
    const corrected = vessel({ lon: 12.109, positionAt: NOW + 33 })
    h.layer.sync([corrected], NOW + 33)
    const early = positionOf(h.record(211222290)!.matrix)
    const earlyLon = (early.longitude * 180) / Math.PI
    expect(earlyLon).toBeGreaterThan(12.106)
    expect(earlyLon).toBeLessThan(12.1065)
    // … and converges once the ease has run its course.
    for (let t = 66; t <= 3000; t += 33) h.layer.sync([corrected], NOW + t)
    const settled = positionOf(h.record(211222290)!.matrix)
    expect((settled.longitude * 180) / Math.PI).toBeCloseTo(12.109, 5)
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
