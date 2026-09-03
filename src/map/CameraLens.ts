/**
 * The lens the camera wears: the narrow one while the miniature look is
 * on, the plain wide one while it is off (see config.camera), eased from
 * one to the other in a few frames.
 *
 * Swapping the angle alone would swap what is in frame with it – the plain
 * lens takes in about twice the city, so the switch would drop the viewer
 * somewhere else on the map. So every step of the ease reports what its
 * change costs in distance, tan(before/2)/tan(after/2), and whoever owns
 * the camera pose walks it that much further out or in. Angle and distance
 * moving together is a dolly zoom: the ground in frame stays where it is
 * while the perspective flattens or steepens, which is the whole point –
 * the viewer sees the lens change, not a jump.
 *
 * The camera's frustum is the single source of truth for which lens is on
 * at any moment. Nothing caches it; the distances that depend on it read
 * it back through cameraFramingScale below.
 */

import { Math as CesiumMath, PerspectiveFrustum, type Camera, type Viewer } from 'cesium'
import { config } from '@/config'
import { clampFovDeg, framingDistanceScale, REFERENCE_FOV_DEG } from './camera-fov'

/**
 * Length of the swap in ms. Long enough to read as a lens being turned
 * rather than a cut, short enough that the camera is not still moving
 * when the hand leaves the switch.
 */
const EASE_MS = 400

/** What the lens needs from the map around it. */
export interface CameraLensHost {
  requestRender(): void
  /**
   * Multiply the camera's distance to what it is looking at by this
   * factor – the map decides whether that means the free camera or the
   * leash a chase cam has it on.
   */
  applyDistanceFactor(factor: number): void
}

/**
 * Horizontal field of view the camera is set to right now, in degrees.
 * An orthographic frustum has no angle to report – it cannot occur here
 * (the 2D button tips the pitch, it does not morph the scene), and the
 * reference angle is the harmless answer if it ever did.
 */
export function cameraFovDeg(camera: Camera): number {
  const frustum = camera.frustum
  if (!(frustum instanceof PerspectiveFrustum) || frustum.fov === undefined) {
    return REFERENCE_FOV_DEG
  }
  return CesiumMath.toDegrees(frustum.fov)
}

/**
 * Framing scale of the lens the camera wears right now – the factor a
 * distance measured at the reference angle has to carry to frame the same
 * ground through it (see camera-fov.ts).
 */
export function cameraFramingScale(camera: Camera): number {
  return framingDistanceScale(cameraFovDeg(camera))
}

function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

export class CameraLens {
  /** The angle actually written to the frustum. */
  private applied: number
  private target: number
  private from: number
  private easeStartedAt = 0
  /** No frame has been drawn yet – a swap before that is not worth easing. */
  private everUpdated = false

  constructor(
    private readonly viewer: Viewer,
    private readonly host: CameraLensHost,
    /** Whether the miniature look is on from the start (see config.camera). */
    miniature: boolean = config.camera.miniatureDefault,
  ) {
    // The camera is built wearing the lens of the starting look – and
    // the home view, flown right after this, measures its distance
    // against exactly that.
    this.applied = clampFovDeg(miniature ? config.camera.fovDeg : config.camera.fovOffDeg)
    this.target = this.applied
    this.from = this.applied
    const frustum = this.viewer.camera.frustum
    if (frustum instanceof PerspectiveFrustum) {
      frustum.fov = CesiumMath.toRadians(this.applied)
    }
  }

  /** Which lens to wear from now on (see config.camera). */
  setMiniature(on: boolean): void {
    const target = clampFovDeg(on ? config.camera.fovDeg : config.camera.fovOffDeg)
    if (target === this.target) return
    this.target = target
    // Before the first frame there is nothing to ease in front of, and
    // nothing to walk either: the pose the camera holds now was saved
    // through the lens it is about to get (a hash that opens with the
    // effect off was written with the effect off), or it is the default
    // pose a flight is about to replace. Walking it as well would push a
    // restored pose closer on every reload.
    if (!this.everUpdated) {
      this.writeFov(target)
      return
    }
    this.from = this.applied
    this.easeStartedAt = performance.now()
    this.host.requestRender()
  }

  /** Per rendered frame: carries the swap forward while one is running. */
  update(): void {
    this.everUpdated = true
    if (this.applied === this.target) return
    const t = smoothstep((performance.now() - this.easeStartedAt) / EASE_MS)
    this.applyFov(t >= 1 ? this.target : this.from + (this.target - this.from) * t)
    // The ease is the app's animation for these few frames – without a
    // request per step the event-driven loop would draw the first frame
    // of it and stop.
    if (this.applied !== this.target) this.host.requestRender()
  }

  /** The angle currently in force, in degrees. */
  get fovDeg(): number {
    return this.applied
  }

  /** Sets the angle and walks the camera by what the change cost. */
  private applyFov(fovDeg: number): void {
    const factor =
      Math.tan(CesiumMath.toRadians(this.applied) / 2) /
      Math.tan(CesiumMath.toRadians(fovDeg) / 2)
    if (!this.writeFov(fovDeg)) return
    if (factor !== 1) this.host.applyDistanceFactor(factor)
  }

  /** Sets the angle alone; false when the camera has no perspective frustum. */
  private writeFov(fovDeg: number): boolean {
    this.applied = fovDeg
    const frustum = this.viewer.camera.frustum
    if (!(frustum instanceof PerspectiveFrustum)) return false
    frustum.fov = CesiumMath.toRadians(fovDeg)
    return true
  }
}
