import { Cartesian3, Cartographic, Entity, Intersect, Matrix4, Primitive, type Viewer } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIS_PLAYBACK_DELAY_MS, type AisTrackPoint, type AisVessel } from '@/lib/ais-extract'
import { FunnelSmoke } from '@/map/FunnelSmoke'
import { ROUTE_PULSE_DURATION_MS } from '@/map/RoutesLayer'
import { VesselLayer } from '@/map/VesselLayer'
import { Wake } from '@/map/Wake'

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
    lastCourseDeg: null,
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
  clamp,
  smoke,
  wake,
  paceWholeView,
  cameraAtRest,
  knownWater,
  tilesLoading,
}: {
  cameraLon?: number
  cameraHeight?: number
  frustum?: Intersect
  /** The tiles under the ships: a height per pick and the load generation. */
  clamp?: { surface: (lon: number, lat: number) => number | undefined; generation: () => number }
  /** The water level the city knows – a coast; absent, an inland city. */
  knownWater?: number
  /** Tiles still loading for the view – a pick made now is not read fine. */
  tilesLoading?: boolean
  /** The exhaust plumes the layer feeds (see FunnelSmoke), where the profile has them. */
  smoke?: FunnelSmoke
  /** The fleet's wakes (see Wake), where the profile has them. */
  wake?: Wake
  /** The time-lapse or a camera path: every ship drawn counts as in view. */
  paceWholeView?: boolean
  /** The camera moving between ticks – the picks wait (see CesiumMap.cameraAtRest). */
  cameraAtRest?: boolean
} = {}) {
  const removedEntities: Entity[] = []
  const cameraCalls: unknown[][] = []
  const viewer = {
    scene: {
      // The layer puts its own root collection here and everything else
      // under that (see VesselLayer.root)
      primitives: {
        add: (primitive: Primitive) => primitive,
        remove: (primitive: Primitive) => primitive,
      },
    },
    entities: {
      suspendEvents: () => {},
      resumeEvents: () => {},
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
    ...(smoke ? { funnelSmoke: smoke } : {}),
    ...(wake ? { wake } : {}),
    ...(paceWholeView ? { paceWholeView } : {}),
    ...(cameraAtRest === undefined ? {} : { cameraAtRest }),
    ...(knownWater === undefined ? {} : { knownWaterHeight: knownWater }),
    ...(tilesLoading === undefined ? {} : { tilesLoading }),
    ...(clamp
      ? {
          clampToSurface: (lon: number, lat: number) => clamp.surface(lon, lat),
          surfaceGeneration: () => clamp.generation(),
        }
      : {}),
  })
  const record = (mmsi: number) =>
    (
      layer as unknown as {
        vessels: Map<number, { matrix: Matrix4; labelEntity: Entity; labelText: string }>
      }
    ).vessels.get(mmsi)
  return { layer, record, removedEntities, requestRender, cameraCalls, viewer }
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
    // Her box went with her – the root holds the one ship left
    expect(h.layer.root.length).toBe(1 + 1) // one box, the lights' collection
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
    // The first box is gone, the rebuilt one stands in the root beside the lights
    expect(h.layer.root.length).toBe(2)
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
    expect(h.layer.root.length).toBe(2)
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

  describe('the exhaust over the funnel', () => {
    /** A 180 m box ship – the container hull – making 12 knots north-east. */
    const boxship = (overrides: Partial<AisVessel> = {}) =>
      vessel({
        mmsi: 211000001,
        typeCode: 70,
        lengthM: 180,
        widthM: 28,
        sogKn: 12,
        cogDeg: 45,
        headingDeg: 45,
        track: underWayTrack(),
        ...overrides,
      })
    const smokeHost = { sunDirection: null, overcast: 0 }

    it('starts the plume at the funnel of a hull that has one, trailing with her way', () => {
      const smoke = new FunnelSmoke(smokeHost)
      const h = harness({ cameraHeight: 600, smoke })
      h.layer.sync([boxship()], NOW)
      expect(smoke.drawn).toBe(1)
      const plume = smoke.instanceAt(0)
      // The funnel stands aft of amidships and above the deck: some fifty
      // metres from the hull's origin, at the model's ceiling
      const origin = Matrix4.getTranslation(h.record(211000001)!.matrix, new Cartesian3())
      const offset = Cartesian3.distance(plume.anchor, origin)
      expect(offset).toBeGreaterThan(40)
      expect(offset).toBeLessThan(70)
      expect(Cartographic.fromCartesian(plume.anchor).height).toBeGreaterThan(
        Cartographic.fromCartesian(origin).height + 5,
      )
      // 12 knots on 045°: the puffs are left behind to the south-west
      expect(plume.velocityEast).toBeCloseTo(12 * 0.514444 * Math.SQRT1_2, 3)
      expect(plume.velocityNorth).toBeCloseTo(12 * 0.514444 * Math.SQRT1_2, 3)
      expect(plume.intensity).toBe(1)
      // The funnel of the stretched hull: 6 m across on the 40 m reference, 28 m here
      expect(plume.size).toBeCloseTo(6 * (28 / 40), 5)
      // A plume in view paces the ticks like a hull under way does
      expect(h.layer.sync([boxship()], NOW + 33).anyMovingVesselInView).toBe(true)
    })

    it('shows none for a ship at her berth, a hull without a funnel, or one too far to see', () => {
      const smoke = new FunnelSmoke(smokeHost)
      const h = harness({ cameraHeight: 600, smoke })
      h.layer.sync([boxship({ sogKn: 0.3, track: [] })], NOW)
      expect(smoke.drawn).toBe(0)
      // A yacht (type 36) has no funnel to smoke from
      h.layer.sync([boxship({ typeCode: 36, lengthM: 14, widthM: 4 })], NOW)
      expect(smoke.drawn).toBe(0)
      // From five kilometres up the plume would be pixels
      const far = harness({ cameraHeight: 5000, smoke })
      far.layer.sync([boxship()], NOW)
      expect(smoke.drawn).toBe(0)
    })

    it('goes with the hulls underground and comes back with them', () => {
      const smoke = new FunnelSmoke(smokeHost)
      const h = harness({ cameraHeight: 600, smoke })
      h.layer.sync([boxship()], NOW)
      expect(smoke.drawn).toBe(1)
      h.layer.setVisible(false)
      expect(smoke.drawn).toBe(0)
      h.layer.sync([boxship()], NOW + 33)
      expect(smoke.drawn).toBe(0)
      h.layer.setVisible(true)
      h.layer.sync([boxship()], NOW + 66)
      expect(smoke.drawn).toBe(1)
    })

    it('asks for a frame once the puffs have moved a visible step, on the ships’ clock', () => {
      const smoke = new FunnelSmoke(smokeHost)
      const h = harness({ cameraHeight: 300, smoke })
      // A screen to measure on: 800 px tall through a 34° lens, so that a
      // metre at 300 m is four pixels (the harness otherwise counts every
      // motion as visible)
      const scene = h.viewer.scene as unknown as { canvas: { clientHeight: number } }
      scene.canvas = { clientHeight: 800 }
      ;(h.viewer.camera.frustum as { fovy?: number }).fovy = 0.6
      // A ship that stands still on screen but has way on (a stale track):
      // only the plume moves, and only it can ask for the frames
      const standing = () => boxship({ track: [] })
      // The plume's pace is capped against real time (see FunnelSmoke.advance)
      const real = vi.spyOn(performance, 'now').mockReturnValue(0)
      h.layer.sync([standing()], NOW)
      h.layer.sync([standing()], NOW)
      h.layer.markRendered()
      h.requestRender.mockClear()
      real.mockReturnValue(20)
      h.layer.sync([standing()], NOW + 20)
      // Two metres a second: 20 ms of plume is 4 cm, nothing to see yet
      expect(h.requestRender).not.toHaveBeenCalled()
      real.mockReturnValue(2_000)
      h.layer.sync([standing()], NOW + 2_000)
      expect(h.requestRender).toHaveBeenCalled()
      // …and the layer's own clock is the plume's: a rendered frame resets it
      h.layer.markRendered()
      expect(smoke.metersSinceRendered).toBe(0)
    })
  })

  describe('pacing far out', () => {
    it('leaves a ship beyond the render range to the heartbeat, unless the whole view is paced', () => {
      // Twenty kilometres up: beyond the 5 km render range of the plain
      // lens (the harness wears none), inside the 35 km her name is drawn
      const far = harness({ cameraHeight: 20_000 })
      far.layer.sync([vessel({ track: underWayTrack() })], NOW)
      far.requestRender.mockClear()
      expect(far.layer.sync([vessel({ track: underWayTrack() })], NOW + 33).anyMovingVesselInView).toBe(false)
      expect(far.requestRender).not.toHaveBeenCalled()
      // The time-lapse: her name must not step along – she counts as in view
      const paced = harness({ cameraHeight: 20_000, paceWholeView: true })
      paced.layer.sync([vessel({ track: underWayTrack() })], NOW)
      paced.requestRender.mockClear()
      expect(paced.layer.sync([vessel({ track: underWayTrack() })], NOW + 33).anyMovingVesselInView).toBe(true)
      expect(paced.requestRender).toHaveBeenCalled()
    })
  })

  describe('the wake', () => {
    const wakeHost = { sunDirection: null, overcast: 0 }
    /** A 52 m coaster heading east at ~4 m/s along her track (see underWayTrack). */
    const coaster = (overrides: Partial<AisVessel> = {}) =>
      vessel({ sogKn: 8, cogDeg: 90, headingDeg: 90, track: underWayTrack(), ...overrides })

    it('lays foam behind a ship under way, from her stern back along her track', () => {
      const wake = new Wake(wakeHost)
      const h = harness({ cameraHeight: 600, wake })
      h.layer.sync([coaster()], NOW)
      // The wash, the bow wave and the arms of a wake read off her track
      expect(wake.drawn).toBeGreaterThan(20)
      const centre = Cartographic.fromCartesian(
        Matrix4.getTranslation(h.record(211222290)!.matrix, new Cartesian3()),
      )
      const fresh = Cartographic.fromCartesian(wake.segmentAt(0).from)
      // Her stern, 26 m west of her centre, on the water she floats on
      const westM = ((centre.longitude - fresh.longitude) * 180) / Math.PI * 111_320 * Math.cos(centre.latitude)
      expect(westM).toBeGreaterThan(24)
      expect(westM).toBeLessThan(28)
      expect(fresh.height).toBeLessThan(centre.height)
      // …and the wash runs on astern of it
      const older = Cartographic.fromCartesian(wake.segmentAt(0).to)
      expect(older.longitude).toBeLessThan(fresh.longitude)
    })

    it('leaves none for a ship at her berth, and none beyond the wake range', () => {
      const wake = new Wake(wakeHost)
      const h = harness({ cameraHeight: 600, wake })
      h.layer.sync([vessel({ sogKn: 0, track: [] })], NOW)
      expect(wake.drawn).toBe(0)
      const far = harness({ cameraHeight: 6000, wake })
      far.layer.sync([coaster()], NOW)
      expect(wake.drawn).toBe(0)
    })

    it('keeps laying it for a while after she stops, so it fades where she left it', () => {
      const wake = new Wake(wakeHost)
      const h = harness({ cameraHeight: 600, wake })
      // Her track: under way until thirty seconds past the rendered
      // instant, standing at that point from then on
      const track = underWayTrack()
      const stopping = coaster({
        track: [track[0], track[1], [track[1][0] + 60_000, track[1][1], track[1][2], 0, 90, 90]],
      })
      h.layer.sync([stopping], NOW + 10_000)
      expect(wake.drawn).toBeGreaterThan(0)
      // Ten seconds after she stopped: the wash she left is still laid
      // (read off the track), without a bow wave or arms
      const underWay = wake.drawn
      h.layer.sync([stopping], NOW + 40_000)
      expect(wake.drawn).toBeGreaterThan(0)
      expect(wake.drawn).toBeLessThan(underWay)
      // A wake's length after her last tick under way, no longer
      h.layer.sync([stopping], NOW + 60_000)
      expect(wake.drawn).toBe(0)
    })

    it('goes with the hulls underground', () => {
      const wake = new Wake(wakeHost)
      const h = harness({ cameraHeight: 600, wake })
      h.layer.sync([coaster()], NOW)
      expect(wake.drawn).toBeGreaterThan(0)
      h.layer.setVisible(false)
      expect(wake.drawn).toBe(0)
    })
  })

  describe('clamping to the tiles', () => {
    it('sets a ship on the tiles once and leaves it there while nothing changes', () => {
      const surface = vi.fn(() => 50)
      let generation = 1
      const h = harness({ clamp: { surface, generation: () => generation } })
      h.layer.sync([vessel()], NOW)
      h.layer.sync([vessel()], NOW + 100)
      h.layer.sync([vessel()], NOW + 5000)
      expect(surface).toHaveBeenCalledTimes(1)
      // Keel on the picked height: the box stands half its height above it
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(50 + 3 / 2, 1)
    })

    it('reads the height again after the ship moved, and after the tiles under it changed', () => {
      const surface = vi.fn(() => 50)
      let generation = 1
      const h = harness({ clamp: { surface, generation: () => generation } })
      h.layer.sync([vessel()], NOW)
      // 10 m north: within the tolerance, no second pick
      h.layer.sync([vessel({ lat: 54.0982 + 10 / 111_132 })], NOW + 100)
      expect(surface).toHaveBeenCalledTimes(1)
      // 40 m north: a fresh pick
      h.layer.sync([vessel({ lat: 54.0982 + 40 / 111_132 })], NOW + 200)
      expect(surface).toHaveBeenCalledTimes(2)
      // The tiles refined under a resting ship: picked again, once
      generation = 2
      h.layer.sync([vessel({ lat: 54.0982 + 40 / 111_132 })], NOW + 300)
      h.layer.sync([vessel({ lat: 54.0982 + 40 / 111_132 })], NOW + 400)
      expect(surface).toHaveBeenCalledTimes(3)
    })

    it('re-reads a ship after the tiles changed only near the camera, where they refine', () => {
      const surface = vi.fn(() => 50)
      let generation = 1
      // The camera 1.5 km up; the ship 3.5 km north – on screen (within the
      // render range), but the tiles under her are not what a load cycle
      // near the camera refines
      const h = harness({ clamp: { surface, generation: () => generation } })
      const far = { lat: 54.098 + 3500 / 111_132 }
      h.layer.sync([vessel(far)], NOW)
      expect(surface).toHaveBeenCalledTimes(1)
      generation = 2
      h.layer.sync([vessel(far)], NOW + 100)
      expect(surface).toHaveBeenCalledTimes(1)
      // Moved: read again wherever she is
      h.layer.sync([vessel({ lat: far.lat + 40 / 111_132 })], NOW + 200)
      expect(surface).toHaveBeenCalledTimes(2)
      // A ship whose tiles never answered is asked again at any distance
      const none = vi.fn<(lon: number, lat: number) => number | undefined>(() => undefined)
      let gen2 = 1
      const h2 = harness({ clamp: { surface: none, generation: () => gen2 } })
      h2.layer.sync([vessel(far)], NOW)
      gen2 = 2
      h2.layer.sync([vessel(far)], NOW + 100)
      expect(none).toHaveBeenCalledTimes(2)
    })

    it('waits with the picks while the camera moves, but not for the ship it follows', () => {
      const surface = vi.fn(() => 50)
      const moving = harness({ clamp: { surface, generation: () => 1 }, cameraAtRest: false })
      moving.layer.sync([vessel()], NOW)
      moving.layer.sync([vessel()], NOW + 100)
      expect(surface).not.toHaveBeenCalled()
      // The chase camera never rests: the followed ship is picked all the same
      moving.layer.setFollow(211222290)
      moving.layer.sync([vessel()], NOW + 200)
      expect(surface).toHaveBeenCalledTimes(1)
    })

    it('does not pick for a ship off screen, and rides the fallback surface until it is seen', () => {
      const surface = vi.fn(() => 50)
      const h = harness({ frustum: Intersect.OUTSIDE, clamp: { surface, generation: () => 1 } })
      h.layer.sync([vessel()], NOW)
      h.layer.sync([vessel()], NOW + 100)
      expect(surface).not.toHaveBeenCalled()
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(37.75 + 3 / 2, 1)
    })

    it('keeps the fallback where the pick finds no tile, and asks again once the tiles changed', () => {
      const surface = vi.fn<(lon: number, lat: number) => number | undefined>(() => undefined)
      let generation = 1
      const h = harness({ clamp: { surface, generation: () => generation } })
      h.layer.sync([vessel()], NOW)
      surface.mockReturnValue(52)
      // The same tiles cannot answer differently – not asked again
      h.layer.sync([vessel()], NOW + 100)
      h.layer.sync([vessel()], NOW + 1000)
      expect(surface).toHaveBeenCalledTimes(1)
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(37.75 + 3 / 2, 1)
      // The tiles changed: asked, and answered. A long pause snaps the
      // eased pose, so the height can be read off directly
      generation = 2
      h.layer.sync([vessel()], NOW + 4000)
      expect(surface).toHaveBeenCalledTimes(2)
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(52 + 3 / 2, 1)
    })

    /**
     * The answer is judged, not taken (see water-clamp.ts): the tiles
     * carry the ships Google photographed at their berths and every
     * bridge deck, and a pick landing on one is held back.
     */
    it('holds a pick on a photographed twin at the coast and rides the known water instead', () => {
      const surface = vi.fn(() => 58) // a box ship's deck, 20 m over the tide
      let generation = 1
      const h = harness({ clamp: { surface, generation: () => generation }, knownWater: 37.75 })
      h.layer.sync([vessel()], NOW)
      h.layer.sync([vessel()], NOW + 4000)
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(37.75 + 3 / 2, 1)
      expect(h.layer.clampReport.ships).toEqual([
        expect.objectContaining({ mmsi: 211222290, pickedM: 58, acceptedM: null, referenceM: 37.8 }),
      ])
      expect(h.layer.clampReport.counts).toEqual({ accepted: 0, confirmed: 0, held: 1 })
      // A held answer waits for the tiles like an accepted one: no re-read
      // on the same generation, one on the next – and the water within the
      // tide's band is taken
      h.layer.sync([vessel()], NOW + 4100)
      expect(surface).toHaveBeenCalledTimes(1)
      surface.mockReturnValue(39)
      generation = 2
      h.layer.sync([vessel()], NOW + 4200)
      h.layer.sync([vessel()], NOW + 9000)
      expect(surface).toHaveBeenCalledTimes(2)
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(39 + 3 / 2, 1)
    })

    it('keeps a ship under way on her water across a bridge deck, in a city without a known level', () => {
      let answer = 38
      const surface = vi.fn(() => answer)
      // The camera 800 m up: her level is read fine and vouches
      const h = harness({ cameraHeight: 800, clamp: { surface, generation: () => 1 } })
      h.layer.sync([vessel()], NOW)
      // The deck, 15 m up, under her next pick: held – she keeps her water
      answer = 53
      h.layer.sync([vessel({ lat: 54.0982 + 40 / 111_132 })], NOW + 100)
      h.layer.sync([vessel({ lat: 54.0982 + 40 / 111_132 })], NOW + 4000)
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(38 + 3 / 2, 1)
      expect(h.layer.clampReport.ships[0]).toMatchObject({ pickedM: 53, acceptedM: 38, heldM: 53, heldPicks: 1 })
      // The water past it, a shade higher: taken
      answer = 38.4
      h.layer.sync([vessel({ lat: 54.0982 + 80 / 111_132 })], NOW + 4100)
      h.layer.sync([vessel({ lat: 54.0982 + 80 / 111_132 })], NOW + 9000)
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(38.4 + 3 / 2, 1)
      expect(h.layer.clampReport.ships[0]).toMatchObject({ acceptedM: 38.4, heldM: null, heldPicks: 0 })
    })

    it('sets an inland ship at her berth on her neighbours’ water where her own pick is a twin’s deck', () => {
      // Two ships 60 m apart, in one cell: the first on the water, the
      // second on the photographed ship at her berth, 20 m up. The camera
      // 800 m up: the picks are read fine, and the first is a floor
      const berth = 54.0982 + 60 / 111_132
      const surface = vi.fn((_lon: number, lat: number) => (lat > 54.0984 ? 110 : 90))
      const h = harness({ cameraHeight: 800, clamp: { surface, generation: () => 1 } })
      const fleet = [vessel(), vessel({ mmsi: 211333330, name: 'TWIN', lat: berth })]
      h.layer.sync(fleet, NOW)
      h.layer.sync(fleet, NOW + 4000)
      expect(positionOf(h.record(211222290)!.matrix).height).toBeCloseTo(90 + 3 / 2, 1)
      expect(positionOf(h.record(211333330)!.matrix).height).toBeCloseTo(90 + 3 / 2, 1)
      expect(h.layer.clampReport.ships).toEqual([
        expect.objectContaining({ mmsi: 211222290, acceptedM: 90, fine: true }),
        expect.objectContaining({ mmsi: 211333330, pickedM: 110, acceptedM: null, referenceM: 90 }),
      ])
      // Alone, with nothing to judge her by, she takes the deck – provisionally
      const alone = harness({ cameraHeight: 800, clamp: { surface: vi.fn(() => 110), generation: () => 1 } })
      alone.layer.sync([vessel({ lat: berth })], NOW)
      alone.layer.sync([vessel({ lat: berth })], NOW + 4000)
      expect(positionOf(alone.record(211222290)!.matrix).height).toBeCloseTo(110 + 3 / 2, 1)
      expect(alone.layer.clampReport.ships[0]).toMatchObject({ acceptedM: 110, provisional: true })
      // The first hull picked stood on the deck; the second, on the water,
      // becomes the floor that brings the first down at her next re-read
      let generation = 1
      const twinFirst = harness({ cameraHeight: 800, clamp: { surface, generation: () => generation } })
      const reversed = [fleet[1], fleet[0]]
      twinFirst.layer.sync(reversed, NOW)
      expect(twinFirst.layer.clampReport.ships).toEqual([
        expect.objectContaining({ mmsi: 211333330, acceptedM: 110, provisional: true }),
        expect.objectContaining({ mmsi: 211222290, acceptedM: 90, provisional: false }),
      ])
      generation = 2
      twinFirst.layer.sync(reversed, NOW + 100)
      twinFirst.layer.sync(reversed, NOW + 5000)
      expect(positionOf(twinFirst.record(211333330)!.matrix).height).toBeCloseTo(90 + 3 / 2, 1)
      expect(twinFirst.layer.clampReport.ships[0]).toMatchObject({ acceptedM: null, referenceM: 90 })
    })

    it('reads no floor and no vouching level off a far ship, or while the tiles load', () => {
      // The ship on the water 2 km from the camera: her level is not a
      // floor, and the twin's deck beside her is taken provisionally
      const far = 54.098 + 2000 / 111_132
      const surface = vi.fn((_lon: number, lat: number) => (lat > far + 0.0003 ? 110 : 90))
      const h = harness({ clamp: { surface, generation: () => 1 } })
      const fleet = [vessel({ lat: far }), vessel({ mmsi: 211333330, name: 'TWIN', lat: far + 60 / 111_132 })]
      h.layer.sync(fleet, NOW)
      expect(h.layer.clampReport.ships).toEqual([
        expect.objectContaining({ mmsi: 211222290, acceptedM: 90, fine: false }),
        expect.objectContaining({ mmsi: 211333330, acceptedM: 110, provisional: true }),
      ])
      // Near, but the tiles still loading: the same
      const loading = harness({ cameraHeight: 800, clamp: { surface: () => 82, generation: () => 1 }, tilesLoading: true })
      loading.layer.sync([vessel()], NOW)
      expect(loading.layer.clampReport.ships[0]).toMatchObject({ acceptedM: 82, fine: false })
    })

    it('forgets the verdicts with the heights when the ground changes', () => {
      const surface = vi.fn(() => 58)
      const h = harness({ clamp: { surface, generation: () => 1 }, knownWater: 37.75 })
      h.layer.sync([vessel()], NOW)
      h.layer.resetClamps()
      expect(h.layer.clampReport.ships).toEqual([])
    })
  })

  /**
   * "Zoom to line" clears the stage: the ship names step aside for the
   * route pulse like the other lines' vehicle badges, and the hulls stay.
   */
  /**
   * The picked ship lights up like the picked tram: her hull washed toward
   * white and rimmed in it (VesselLayer.setSelected). The glTF hulls never
   * load in Node, so the box placeholder stands in for the model here – and
   * the model's own fields are written on a stand-in of their own.
   */
  describe('the selected ship', () => {
    /** RGBA the box was built with, straight off its geometry instance. */
    const boxColor = (h: ReturnType<typeof harness>, mmsi: number) => {
      const record = h.record(mmsi) as unknown as {
        primitive: { geometryInstances: { attributes: { color: { value: Uint8Array } } } }
      }
      return Array.from(record.primitive.geometryInstances.attributes.color.value)
    }

    it('builds a ship who is already picked with a lit hull', () => {
      const plain = harness()
      plain.layer.sync([vessel()], NOW)

      const lit = harness()
      // Picked before she was ever reported – the #vessel= link's case
      lit.layer.setSelected(211222290)
      lit.layer.sync([vessel()], NOW)

      const before = boxColor(plain, 211222290)
      const after = boxColor(lit, 211222290)
      expect(after).not.toEqual(before)
      // Washed toward white: every channel lighter, alpha untouched
      for (let i = 0; i < 3; i++) expect(after[i]).toBeGreaterThan(before[i])
      expect(after[3]).toBe(before[3])
      expect(lit.layer.selectedVesselMmsi).toBe(211222290)
    })

    it('leaves the rest of the fleet alone', () => {
      const h = harness()
      h.layer.setSelected(211222290)
      h.layer.sync([vessel(), vessel({ mmsi: 211333440, name: 'AURORA' })], NOW)
      const plain = harness()
      plain.layer.sync([vessel({ mmsi: 211333440, name: 'AURORA' })], NOW)
      expect(boxColor(h, 211333440)).toEqual(boxColor(plain, 211333440))
    })

    it('writes the wash and the rim onto the hull, and takes both back', () => {
      const h = harness()
      h.layer.sync([vessel()], NOW)
      // Stand-in for the glTF hull, which never loads in Node
      const model = { colorBlendMode: 0, color: null, colorBlendAmount: 0, silhouetteColor: null, silhouetteSize: 0 }
      ;(h.record(211222290) as unknown as { model: unknown }).model = model

      h.layer.setSelected(211222290)
      expect(model.colorBlendAmount).toBeGreaterThan(0)
      expect(model.silhouetteSize).toBeGreaterThan(0)

      h.layer.setSelected(null)
      expect(model.colorBlendAmount).toBe(0)
      expect(model.silhouetteSize).toBe(0)
      expect(h.layer.selectedVesselMmsi).toBeNull()
    })
  })

  describe('line focus on the ship names', () => {
    /** The layer reads performance.now(); the ships' own clock is nowMs. */
    let clockMs = 0
    const OTHER = 211333440

    function focused() {
      clockMs = 50_000
      vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
      const h = harness()
      h.layer.sync([vessel()], NOW)
      expect(h.record(211222290)!.labelEntity.show).toBe(true)
      h.layer.startLineFocus(ROUTE_PULSE_DURATION_MS)
      return h
    }

    it('takes the names off at once and keeps the hulls', () => {
      const h = focused()
      expect(h.record(211222290)!.labelEntity.show).toBe(false)
      h.layer.sync([vessel()], NOW + 100)
      expect(h.record(211222290)!.labelEntity.show).toBe(false)
      // Only the names step aside – the fleet itself stays on the water
      expect(h.layer.vesselCount).toBe(1)
      expect(h.layer.root.length).toBe(2)
    })

    it('lets a ship that arrives during the focus arrive without her name', () => {
      const h = focused()
      h.layer.sync([vessel(), vessel({ mmsi: OTHER, name: 'AURORA' })], NOW + 100)
      expect(h.record(OTHER)!.labelEntity.show).toBe(false)
    })

    it('brings the names back on the first sync after the focus ends', () => {
      const h = focused()

      clockMs += ROUTE_PULSE_DURATION_MS - 1
      h.layer.sync([vessel()], NOW + 100)
      expect(h.record(211222290)!.labelEntity.show).toBe(false)

      clockMs += 1
      h.layer.sync([vessel()], NOW + 200)
      expect(h.record(211222290)!.labelEntity.show).toBe(true)
    })

    it('leaves the names off when the Labels switch is off anyway', () => {
      const h = focused()
      h.layer.setLabelsVisible(false)
      clockMs += ROUTE_PULSE_DURATION_MS
      h.layer.sync([vessel()], NOW + 100)
      expect(h.record(211222290)!.labelEntity.show).toBe(false)
    })
  })
})
