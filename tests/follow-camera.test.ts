import { Cartesian3, Math as CesiumMath, type Viewer } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FollowCamera, type FollowTarget } from '@/map/FollowCamera'

/**
 * The chase camera, and above all the one way it can go catastrophically
 * wrong: everything in update() reads camera.position as the distance to
 * the subject, which it only is inside our own lookAt reference frame.
 * Outside it, that vector points at the center of the earth – adopting
 * its length as the viewing range threw the camera 6000 km up.
 */

afterEach(() => vi.restoreAllMocks())

const ROSTOCK: FollowTarget = { lon: 12.106, lat: 54.098, centerHeight: 40, bearingDeg: 90 }

/** Distance from the earth's center, i.e. what a DETACHED camera reports. */
const EARTH_RADIUS = 6_378_137

function harness({ detached = false } = {}) {
  const calls: { name: string; range?: number }[] = []
  const camera = {
    // In a lookAt frame the position is relative to the subject; detached
    // it is the world position, which is what this switch models.
    position: detached
      ? new Cartesian3(EARTH_RADIUS, 0, 0)
      : new Cartesian3(140, 0, 0),
    heading: CesiumMath.toRadians(90),
    pitch: CesiumMath.toRadians(-16),
    lookAt: (_center: Cartesian3, offset: { range: number }) =>
      calls.push({ name: 'lookAt', range: offset.range }),
    lookAtTransform: () => calls.push({ name: 'lookAtTransform' }),
    flyToBoundingSphere: () => calls.push({ name: 'flyToBoundingSphere' }),
    cancelFlight: () => calls.push({ name: 'cancelFlight' }),
  }
  const viewer = { camera } as unknown as Viewer
  const cam = new FollowCamera(viewer, { requestRender: () => {}, noteCameraFlight: () => {} })
  return { cam, camera, calls }
}

describe('FollowCamera', () => {
  it('ignores update() before anything was engaged', () => {
    const h = harness()
    h.cam.update(ROSTOCK)
    expect(h.calls).toHaveLength(0)
  })

  it('does not steer the camera after being released', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const h = harness()
    h.cam.engage(null)
    h.cam.update(ROSTOCK) // engaged: this one lands
    expect(h.calls.some((c) => c.name === 'lookAt')).toBe(true)

    h.cam.release()
    h.calls.length = 0
    h.cam.update(ROSTOCK)
    expect(h.calls.some((c) => c.name === 'lookAt')).toBe(false)
  })

  /**
   * The reported bug: following a ship, then clicking the water. The
   * vehicle side released the camera – leaving the lookAt frame, so
   * camera.position became a world vector – while the ship's chase was
   * still engaged and kept updating. It adopted the earth's radius as its
   * viewing range and the camera left for space.
   */
  it('never adopts a world-space position as its viewing range', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const h = harness()
    h.cam.engage(null)
    h.cam.update(ROSTOCK)

    // Whoever else owns the camera detaches it: the position now measures
    // from the earth's center rather than from the ship.
    h.cam.release()
    h.camera.position = new Cartesian3(EARTH_RADIUS, 0, 0)
    h.camera.pitch = CesiumMath.toRadians(-90)
    h.calls.length = 0

    // A layer that still thinks it is following keeps calling update()
    h.cam.update(ROSTOCK)
    h.cam.update(ROSTOCK)

    expect(h.calls).toHaveLength(0)
    // Belt and braces: no lookAt at any range, let alone a planetary one
    const ranges = h.calls.filter((c) => c.name === 'lookAt').map((c) => c.range ?? 0)
    expect(Math.max(0, ...ranges)).toBeLessThan(100_000)
  })

  it('re-engaging after a release chases again', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const h = harness()
    h.cam.engage(null)
    h.cam.release()
    h.calls.length = 0
    h.cam.engage(null)
    h.cam.update(ROSTOCK)
    expect(h.calls.some((c) => c.name === 'lookAt')).toBe(true)
  })

  it('holds still while the approach flight is running', () => {
    let clock = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const h = harness()
    h.cam.engage(ROSTOCK)
    expect(h.calls.some((c) => c.name === 'flyToBoundingSphere')).toBe(true)

    h.calls.length = 0
    h.cam.update(ROSTOCK)
    expect(h.calls.some((c) => c.name === 'lookAt')).toBe(false)

    clock += 10_000
    h.cam.update(ROSTOCK)
    expect(h.calls.some((c) => c.name === 'lookAt')).toBe(true)
  })
})

/**
 * The pitch drift: lookAt does not hand back the pitch it was given. It
 * places the camera by the local vertical at the SUBJECT while
 * camera.pitch measures against the vertical where the camera stands, and
 * the earth curves between the two – a constant 0.0012° at the 140 m
 * chase range, always the same way. update() used to read that back and
 * re-apply it every frame, so a follow left in free orbit climbed about
 * 0.035°/s for as long as it ran.
 */
describe('FollowCamera against the lookAt round trip', () => {
  const CURVATURE_ERROR = CesiumMath.toRadians(0.0012)

  /** A camera that answers lookAt the way Cesium really does. */
  function drifting() {
    const camera = {
      position: new Cartesian3(140, 0, 0),
      heading: CesiumMath.toRadians(90),
      pitch: CesiumMath.toRadians(-16),
      lookAt(_center: Cartesian3, offset: { heading: number; pitch: number; range: number }) {
        camera.heading = offset.heading
        camera.pitch = offset.pitch - CURVATURE_ERROR
        camera.position = new Cartesian3(offset.range, 0, 0)
      },
      lookAtTransform: () => {},
      flyToBoundingSphere: () => {},
      cancelFlight: () => {},
    }
    const viewer = { camera } as unknown as Viewer
    const cam = new FollowCamera(viewer, { requestRender: () => {}, noteCameraFlight: () => {} })
    return { cam, camera }
  }

  it('leaves a hand-set pose where the hand left it', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const h = drifting()
    h.cam.engage(null)
    h.cam.update(ROSTOCK)

    // A drag: enough of a rotation to hand the chase over to free orbit
    h.camera.heading += CesiumMath.toRadians(10)
    h.camera.pitch += CesiumMath.toRadians(5)
    h.cam.update(ROSTOCK)
    const parked = h.camera.pitch

    // …and then nobody touches anything for ten seconds of ticks
    for (let i = 0; i < 300; i++) h.cam.update(ROSTOCK)

    expect(CesiumMath.toDegrees(Math.abs(h.camera.pitch - parked))).toBeLessThan(0.001)
  })

  it('keeps chasing on its own – the round trip is not a hand', () => {
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const h = drifting()
    h.cam.engage(null)
    for (let i = 0; i < 300; i++) h.cam.update(ROSTOCK)

    // Still trailing: the heading eased onto the subject's bearing, and
    // the pitch is the chase's own, not one that walked away from it.
    expect(CesiumMath.toDegrees(h.camera.heading)).toBeCloseTo(ROSTOCK.bearingDeg, 3)
    expect(CesiumMath.toDegrees(h.camera.pitch)).toBeCloseTo(-16 - 0.0012, 3)
  })
})

