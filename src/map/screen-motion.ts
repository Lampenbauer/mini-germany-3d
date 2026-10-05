/**
 * How far a thing has to move ON SCREEN before the frame it moves in is
 * worth drawing.
 *
 * The render loop is event-driven (see App.tsx): apart from user input,
 * camera flights and rain, a frame is only drawn when something asks for
 * one. The moving fleets used to ask for one every tick, which pinned the
 * loop at 30 fps whenever any vehicle was in view – including the home
 * view, where a tram five kilometers away crawls across the screen at
 * about one CSS pixel per second. Thirty frames a second to move a badge
 * by a fortieth of a pixel each is fill rate spent on nothing the eye can
 * register. Measured: that view cost ~19 ms of GPU per frame.
 *
 * So the layers now measure the motion of what they draw in pixels since
 * the frame that was last rendered, and only ask for a frame once it
 * adds up to the threshold below. Close up, where a vehicle covers many
 * pixels a second, that is every tick and nothing changes; far out, the
 * frames come as slowly as the motion does. Since the position drawn at
 * the last frame is the reference (not the previous tick), slow motion
 * accumulates and is never lost – it merely arrives in whole steps of
 * this size, which is what a display does anyway.
 */

import type { Viewer } from 'cesium'

/**
 * The step, in DEVICE pixels of the drawing buffer. Half a device pixel
 * stays below the grid the frame is rasterized on: a billboard drawn at
 * sub-pixel positions shifts by less than one texel, which is invisible
 * as a jump. In CSS pixels this is half that on a 2× display – convert
 * with the pixel ratio the layer draws at (see cssPixelsPerMeter callers).
 */
export const MOTION_RENDER_DEVICE_PX = 0.5

/**
 * Screen pixels (CSS) that one meter covers at a distance of one meter
 * from the camera – divide by the camera distance of a point to get its
 * own scale. Infinity when the camera cannot tell (no perspective frustum,
 * no canvas – the test doubles), so callers fall back to "every movement
 * is visible" and behave as they did before the threshold existed.
 */
export function cssPixelsPerMeterAtUnitDistance(viewer: Viewer): number {
  const frustum = viewer.camera.frustum as { fovy?: number }
  const height = viewer.scene?.canvas?.clientHeight
  if (typeof frustum.fovy !== 'number' || !(height > 0)) return Number.POSITIVE_INFINITY
  return height / (2 * Math.tan(frustum.fovy / 2))
}

/**
 * The motion threshold in CSS pixels for a layer drawing at `pixelRatio`
 * device pixels per CSS pixel.
 */
export function motionThresholdCssPx(pixelRatio: number): number {
  return MOTION_RENDER_DEVICE_PX / Math.max(1, pixelRatio)
}
