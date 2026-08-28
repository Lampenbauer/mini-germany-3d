import { Cartesian3, Cartographic, Entity, Intersect, Matrix4, Primitive, type Viewer } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIS_PLAYBACK_DELAY_MS, type AisTrackPoint, type AisVessel } from '@/lib/ais-extract'
import { VesselLayer } from '@/map/VesselLayer'

/**
 * AIS backdrop fleet: boxes in real ship dimensions that play back four
 * minutes behind the wall clock along their recorded tracks, labels that
 * fall back to the MMSI until a name arrives, and records that leave
 * with their vessel.
 */

afterEach(() => vi.restoreAllMocks())

const NOW = 1_800_000_000_000
/** The instant the playback renders when the wall clock reads NOW. */
const REN = NOW - AIS_PLAYBACK_DELAY_MS

/** A track segment straddling the playback instant – a ship under way
 *  east at ~4 m/s, still inside the segment a few wall seconds later. */
function underWayTrack(): AisTrackPoint[] {
  return [
    [REN - 30_000, 54.0982, 12.106, 8, 90, null],
    [REN + 30_000, 54.0982, 12.1098, 8, 90, null],
  ]
}

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
    draughtM: 3.5,
    positionAt: NOW,
    track: [],
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
  const cameraCalls: unknown[][] = []
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
      position: Cartesian3.fromDegrees(cameraLon, 54.098, cameraHeight),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      heading: 0,
      pitch: -0.3,
      frustum: {
        computeCullingVolume: () => ({ computeVisibility: () => frustum }),
      },
      // The follow camera's Cesium surface – the chase maths is covered by
      // the vehicle layer's own tests, here it only has to be reachable.
      lookAt: (...args: unknown[]) => cameraCalls.push(['lookAt', ...args]),
      lookAtTransform: (...args: unknown[]) => cameraCalls.push(['lookAtTransform', ...args]),
      flyToBoundingSphere: (...args: unknown[]) =>
        cameraCalls.push(['flyToBoundingSphere', ...args]),
      cancelFlight: () => cameraCalls.push(['cancelFlight']),
    },
  } as unknown as Viewer
  const requestRender = vi.fn()
  const layer = new VesselLayer(viewer, {
    requestRender,
    waterSurfaceHeight: 37.75,
    noteCameraFlight: () => {},
  })
  const record = (mmsi: number) =>
    (
      layer as unknown as {
        vessels: Map<number, { matrix: Matrix4; labelEntity: Entity; labelText: string }>
      }
    ).vessels.get(mmsi)
  return { layer, record, removedPrimitives, removedEntities, requestRender, cameraCalls }
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

  it('plays a moving vessel back along its track, four minutes behind', () => {
    const h = harness()
    h.layer.sync([vessel({ track: underWayTrack() })], NOW)
    const carto = positionOf(h.record(211222290)!.matrix)
    const lonDeg = (carto.longitude * 180) / Math.PI
    // Halfway along the 60 s segment straddling the playback instant
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
    offScreen.layer.sync([vessel({ track: underWayTrack() })], NOW)
    // Even the arrival stays silent off screen – the next due frame
    // includes the new box anyway.
    expect(offScreen.requestRender).not.toHaveBeenCalled()
    offScreen.layer.sync([vessel({ track: underWayTrack() })], NOW + 10_000)
    expect(offScreen.requestRender).not.toHaveBeenCalled()

    const beyondRange = harness({ cameraLon: 12.7 }) // ~39 km east, frustum says visible
    beyondRange.layer.sync([vessel({ track: underWayTrack() })], NOW)
    beyondRange.requestRender.mockClear()
    beyondRange.layer.sync([vessel({ track: underWayTrack() })], NOW + 10_000)
    expect(beyondRange.requestRender).not.toHaveBeenCalled()

    const onScreen = harness()
    onScreen.layer.sync([vessel({ track: underWayTrack() })], NOW)
    onScreen.requestRender.mockClear()
    onScreen.layer.sync([vessel({ track: underWayTrack() })], NOW + 10_000)
    expect(onScreen.requestRender).toHaveBeenCalled()
  })

  it('reports a ship under way on screen for the tick pacing – steadily', () => {
    const h = harness()
    const underWay = () => vessel({ track: underWayTrack() })
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

  it('drops the ship names for the Labels toggle, hull untouched', () => {
    const h = harness()
    h.layer.sync([vessel()], NOW)
    h.layer.setLabelsVisible(false)
    const record = h.record(211222290)!
    expect(record.labelEntity.show).toBe(false)
    // Only the name goes – the vessel itself stays on the water
    expect(h.layer.vesselCount).toBe(1)
    expect(h.removedPrimitives).toHaveLength(0)
    h.layer.setLabelsVisible(true)
    expect(record.labelEntity.show).toBe(true)
  })

  it('approaches a followed ship by flight, then chases her every tick', () => {
    // The flight is guarded by the wall clock, not the sync's timestamp
    let clock = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const h = harness()
    h.layer.sync([vessel({ track: underWayTrack() })], NOW)
    expect(h.layer.hasVessel(211222290)).toBe(true)

    h.layer.setFollow(211222290)
    // Following starts with an approach flight, not a teleport
    expect(h.cameraCalls.map((c) => c[0])).toContain('flyToBoundingSphere')

    // While the flight runs, a tick must not cut it short with a lookAt
    h.cameraCalls.length = 0
    h.layer.sync([vessel({ track: underWayTrack() })], NOW + 33)
    expect(h.cameraCalls.map((c) => c[0])).not.toContain('lookAt')

    // Once it is over, every tick aims the camera at the ship again
    clock += 10_000
    h.layer.sync([vessel({ track: underWayTrack() })], NOW + 66)
    expect(h.cameraCalls.map((c) => c[0])).toContain('lookAt')
  })

  it('lets a followed ship go and leaves the camera to the user', () => {
    const h = harness()
    h.layer.sync([vessel({ track: underWayTrack() })], NOW)
    h.layer.setFollow(211222290)
    h.cameraCalls.length = 0

    h.layer.setFollow(null)
    // Releasing resets the reference frame …
    expect(h.cameraCalls.map((c) => c[0])).toContain('lookAtTransform')
    // … and no later tick may grab the camera back
    h.cameraCalls.length = 0
    h.layer.sync([vessel({ track: underWayTrack() })], NOW + 5_000)
    expect(h.cameraCalls.map((c) => c[0])).not.toContain('lookAt')
  })

  it('waits for a ship that is not on the map yet instead of flying nowhere', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const h = harness()
    expect(h.layer.hasVessel(211222290)).toBe(false)
    h.layer.setFollow(211222290)
    // Nothing to fly to – but the chase engages on the sync that draws her
    expect(h.cameraCalls.map((c) => c[0])).not.toContain('flyToBoundingSphere')
    h.layer.sync([vessel({ track: underWayTrack() })], NOW)
    expect(h.cameraCalls.map((c) => c[0])).toContain('lookAt')
  })

  it('keeps names off while the toggle is off, arrivals included', () => {
    const h = harness()
    h.layer.setLabelsVisible(false)
    h.layer.sync([vessel()], NOW)
    // A ship that arrives after the switch must not bring its name along
    expect(h.record(211222290)!.labelEntity.show).toBe(false)
    // …and the underground view must not hand it back on the way up
    h.layer.setVisible(false)
    h.layer.setVisible(true)
    expect(h.record(211222290)!.labelEntity.show).toBe(false)
  })
})
