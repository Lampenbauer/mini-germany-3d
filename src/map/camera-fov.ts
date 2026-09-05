/**
 * The camera's field of view, and the one thing it changes everywhere
 * else: how far away the camera has to sit to frame the same ground.
 *
 * Halving the angle halves what a given distance covers, so every
 * distance the app flies to is a distance *at a particular field of
 * view*. The values were picked at Cesium's default 60°, which is why
 * that angle is the reference here and a scale of 1: change the field of
 * view alone and the home view, the chase cam and the stop flight would
 * all zoom in by the same factor nobody asked for.
 *
 * The same factor governs every range that decides whether something is
 * worth drawing. Those read as distances but mean an on-screen size: a
 * thing of size s at distance d covers s/(d·tan(fov/2)) of the frame, so
 * the distance at which it becomes too small to bother with moves with
 * the angle exactly like the flight distances do. Leaving them put is
 * what makes half the stop discs vanish from the home view at 30°.
 *
 * Deliberately free of Cesium – it is one triangle, and it is unit tested
 * as that. The one distance in the app that needs none of this is the
 * line flight: it hands Cesium a bounding sphere with range 0, and Cesium
 * derives that range from the frustum itself.
 */
import { config } from '@/config'

/** Field of view the app's distances were measured at (Cesium's default). */
export const REFERENCE_FOV_DEG = 60

/**
 * Sane bounds for the knob. Below ~25° the view is a telescope in which
 * dragging the mouse throws the city across the screen; past ~60° the
 * projection stretches the frame edges into a fisheye. Both ends are far
 * outside anything usable – this is a guard rail, not a preference.
 */
const MIN_FOV_DEG = 25
const MAX_FOV_DEG = 60

/** The configured field of view, held inside what a camera can show. */
export function clampFovDeg(fovDeg: number): number {
  if (!Number.isFinite(fovDeg)) return REFERENCE_FOV_DEG
  return Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, fovDeg))
}

/**
 * Factor every distance tuned at REFERENCE_FOV_DEG has to be multiplied
 * by to keep its framing at `fovDeg`: 1 at the reference, ~1.4 at 45°,
 * ~2.2 at 30°. The frame's half width at distance d is d·tan(fov/2), so
 * holding it constant makes the distance go as 1/tan(fov/2).
 */
export function framingDistanceScale(fovDeg: number): number {
  const half = (clampFovDeg(fovDeg) * Math.PI) / 360
  return Math.tan((REFERENCE_FOV_DEG * Math.PI) / 360) / Math.tan(half)
}

/**
 * The scale at the miniature lens – the one the visibility ranges are
 * written against.
 *
 * They are the distances that cannot follow the lens from frame to frame:
 * each is baked into a DistanceDisplayCondition on thousands of
 * billboards, and rebuilding those on a toggle would cost more than the
 * toggle is worth. So they stay pinned to the narrower angle, the
 * demanding one. With the plain lens on, things therefore stay drawn
 * further out than that angle would ask for – a few more discs at the
 * horizon, never one missing.
 *
 * Distances that a flight computes on the spot do follow the lens, and
 * so do the vehicles' and ships' render ranges – comparisons made per
 * tick: they read it off the camera (see cameraFramingScale in
 * CameraLens.ts).
 */
export const FRAMING_SCALE = framingDistanceScale(config.camera.fovDeg)
