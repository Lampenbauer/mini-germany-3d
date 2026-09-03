/**
 * The chase camera, shared by the vehicles and the AIS fleet.
 *
 * Cesium's own trackedEntity is not usable here: it stops tracking as soon
 * as the bounding sphere of an entity with HeightReference cannot be
 * computed. So the camera is repositioned every frame via camera.lookAt
 * instead, which also leaves mouse orbit and zoom working.
 *
 * Following starts with an approach flight rather than a teleport, ending
 * behind the target looking along its direction of travel; only then does
 * the per-frame lookAt engage. From there the camera trails the target's
 * bearing until the user rotates by hand, at which point the chase hands
 * over to free orbit for the rest of that follow (zooming does not count –
 * it is adopted and the chase continues).
 *
 * One instance drives one camera, so only one thing can be followed at a
 * time; CesiumMap releases the other layer before engaging either.
 */

import {
  BoundingSphere,
  Cartesian3,
  HeadingPitchRange,
  Math as CesiumMath,
  Matrix4,
  type Viewer,
} from 'cesium'
import { cameraFramingScale } from './CameraLens'

/** Where the camera should be looking, this frame. */
export interface FollowTarget {
  lon: number
  lat: number
  /** Ellipsoid height the camera centers on – the top of the object. */
  centerHeight: number
  /** Direction of travel in degrees; the chase trails behind it. */
  bearingDeg: number
}

export interface FollowCameraHost {
  requestRender(): void
  /** A camera flight is starting – keeps the render loop at full rate. */
  noteCameraFlight(durationMs: number): void
}

/**
 * Initial offset behind and above the target. The range was measured at
 * Cesium's 60° field of view and follows the lens in force, so the
 * vehicle fills the same part of the frame through either one (see
 * map/CameraLens.ts).
 */
const FOLLOW_PITCH_DEG = -16
const FOLLOW_RANGE_AT_REFERENCE = 140

/** Duration of the approach flight when following starts, in seconds. */
const FOLLOW_FLIGHT_SECONDS = 1.4

/**
 * Per-update easing of the chase heading toward the travel bearing
 * (~0.25 s time constant at the 30 fps tick). The bearing jumps at path
 * segment boundaries – applying it directly would visibly snap the view.
 */
const FOLLOW_CHASE_EASE = 0.12

/**
 * Deviations beyond these thresholds between the camera pose and the pose
 * the chase applied last frame mean the user moved the camera by hand.
 * Rotating (heading/pitch) disengages the chase; a pure range change is
 * zooming and is adopted into the chase instead. Radians for angles,
 * relative for the range; generous against floating-point noise, far
 * below any real mouse input.
 */
const CHASE_BREAK_ANGLE = 0.003
const CHASE_BREAK_RANGE_RATIO = 0.01

export class FollowCamera {
  private offset: HeadingPitchRange | null = null
  private chase = false
  /**
   * Whether this instance currently owns the camera. Everything below
   * reads camera.position as a distance from the subject, which it only
   * is inside our own lookAt reference frame – outside it, that is the
   * distance from the center of the earth. Adopting THAT as the viewing
   * range put the camera 6000 km up looking straight down, which is
   * exactly what a stale chase used to do after its layer was released.
   */
  private engaged = false
  /**
   * Safety cap for the approach flight. The tween only really ends with
   * its complete/cancel callback – under slow rendering that can be well
   * after the nominal duration, and a tween frame landing after the
   * lookAt hand-over would move the camera and trip the chase's
   * manual-input detection.
   */
  private flightUntil = 0

  constructor(
    private readonly viewer: Viewer,
    private readonly host: FollowCameraHost,
  ) {}

  /** Chase distance for the lens the camera wears right now. */
  private get followRange(): number {
    return FOLLOW_RANGE_AT_REFERENCE * cameraFramingScale(this.viewer.camera)
  }

  /**
   * Start following. `target` is where the subject stands right now; pass
   * null when it is not on the map yet – the chase then simply engages on
   * the first update() without an approach flight.
   */
  engage(target: FollowTarget | null): void {
    this.offset = null
    this.chase = true
    this.engaged = true
    if (target) {
      this.viewer.camera.lookAtTransform(Matrix4.IDENTITY)
      const center = Cartesian3.fromDegrees(target.lon, target.lat, target.centerHeight)
      this.flightUntil = performance.now() + FOLLOW_FLIGHT_SECONDS * 1000 + 2000
      const endFlight = () => {
        this.flightUntil = 0
      }
      // Render at full rate during the flight (see getRenderHints)
      this.host.noteCameraFlight(FOLLOW_FLIGHT_SECONDS * 1000 + 200)
      this.viewer.camera.flyToBoundingSphere(new BoundingSphere(center, 0), {
        duration: FOLLOW_FLIGHT_SECONDS,
        offset: new HeadingPitchRange(
          CesiumMath.toRadians(target.bearingDeg),
          CesiumMath.toRadians(FOLLOW_PITCH_DEG),
          this.followRange,
        ),
        complete: endFlight,
        cancel: endFlight,
      })
    }
    this.host.requestRender()
  }

  /**
   * Keeps the chase framing when the lens changes: the leash the camera
   * hangs on is multiplied by the factor the new angle costs in distance.
   * Answers whether a chase is running at all – if none is, the map walks
   * the free camera instead.
   */
  applyLensDistance(factor: number): boolean {
    if (!this.engaged) return false
    if (this.offset) this.offset.range *= factor
    return true
  }

  /** Stop following and give the camera back to the user. */
  release(): void {
    this.offset = null
    this.chase = false
    this.engaged = false
    // Also abort a still-running approach flight (e.g. "Stop following"
    // clicked mid-flight), otherwise it lands on the abandoned subject.
    if (performance.now() < this.flightUntil) this.viewer.camera.cancelFlight()
    this.flightUntil = 0
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY)
    this.host.requestRender()
  }

  /** One frame of chasing. Call while the subject is being synced. */
  update(target: FollowTarget): void {
    // Released, or never engaged: the camera belongs to the user or to
    // the other layer, and touching it here is how it ends up in orbit.
    if (!this.engaged) return
    // The approach flight is still running – lookAt would cut it short.
    if (performance.now() < this.flightUntil) return
    const camera = this.viewer.camera
    const center = Cartesian3.fromDegrees(target.lon, target.lat, target.centerHeight)

    if (!this.offset) {
      // First frame: the approach flight ends in exactly this pose, so the
      // lookAt hand-over continues seamlessly from it. A tween that hit the
      // safety cap without completing must not keep animating into the
      // engaged lookAt.
      camera.cancelFlight()
      this.offset = new HeadingPitchRange(
        camera.heading,
        CesiumMath.toRadians(FOLLOW_PITCH_DEG),
        this.followRange,
      )
    } else if (this.chase) {
      // Chase: any camera pose that deviates from what the chase applied
      // last frame must come from the user (drag/zoom between our ticks) –
      // hand control over to manual orbit for the rest of this follow.
      const headingMoved =
        Math.abs(CesiumMath.negativePiToPi(camera.heading - this.offset.heading)) >
        CHASE_BREAK_ANGLE
      const pitchMoved = Math.abs(camera.pitch - this.offset.pitch) > CHASE_BREAK_ANGLE
      const rangeMoved =
        Math.abs(Cartesian3.magnitude(camera.position) - this.offset.range) >
        this.offset.range * CHASE_BREAK_RANGE_RATIO
      if (headingMoved || pitchMoved) {
        this.chase = false
        this.offset.heading = camera.heading
        this.offset.pitch = camera.pitch
        this.offset.range = Cartesian3.magnitude(camera.position)
      } else {
        // Zooming (range change only) does not break the chase: adopt the
        // new distance and keep trailing the subject.
        if (rangeMoved) {
          this.offset.range = Cartesian3.magnitude(camera.position)
        }
        // Stay behind it: ease the heading toward the travel bearing (it
        // jumps at path segment boundaries).
        const turn = CesiumMath.negativePiToPi(
          CesiumMath.toRadians(target.bearingDeg) - this.offset.heading,
        )
        this.offset.heading = CesiumMath.zeroToTwoPi(this.offset.heading + turn * FOLLOW_CHASE_EASE)
      }
    } else {
      // Adopt user orbit/zoom: in the lookAt reference frame heading/pitch
      // are relative and the subject sits at the origin.
      this.offset.heading = camera.heading
      this.offset.pitch = camera.pitch
      this.offset.range = Cartesian3.magnitude(camera.position)
    }
    camera.lookAt(center, this.offset)
    // The camera moved with the subject – must reach the screen even when
    // the render pacing is otherwise idle.
    this.host.requestRender()
  }
}
