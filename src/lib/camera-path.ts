/**
 * A camera path: two or more keyframes – poses like the URL carries
 * them, longitude, latitude, height, heading, pitch – and the seconds
 * the camera takes from the first to the last. Made for filming: set a
 * start, set an end, press play, and the camera moves at a constant
 * pace from one to the other while the city goes on underneath. It runs
 * on the wall clock, so the simulation's pause and time-lapse have no
 * say in it, and a recording of a paused city is a steady dolly shot.
 *
 * Not Cesium's own flyTo: that arcs a long flight upwards, eases in and
 * out on its own terms and can neither be scrubbed nor stopped mid-way.
 * The map interpolates per frame instead (CesiumMap.playCameraPath) and
 * this module says where the camera is at any point of the way.
 *
 * The keyframes are a list rather than a pair so that a third one is a
 * change to the interface alone; the segments share the duration in
 * equal parts. The pace eases in and out unless asked not to – a dolly
 * that starts and stops dead reads as a cut. Pure and tested
 * (tests/camera-path.test.ts); the hash form rides beside the pose hash
 * (lib/camera-hash.ts), carrying the pace only where it deviates:
 *   #…&path=54.08,12.13,3000,0,-40;54.09,12.14,800,90,-30&dur=20&ease=linear
 */

import type { CameraView } from '@/lib/camera-hash'

export type CameraPathEase = 'linear' | 'smooth'

export interface CameraPath {
  /** Two at least, in the order they are flown. */
  keyframes: CameraView[]
  /** From the first keyframe to the last, in seconds. */
  durationS: number
  /** Constant pace, or a gentle start and stop (smoothstep over the whole way). */
  ease: CameraPathEase
}

/** How many keyframes a path may carry – the hash has to stay a hash. */
export const MAX_KEYFRAMES = 8
export const MIN_DURATION_S = 1
export const MAX_DURATION_S = 600
export const DEFAULT_DURATION_S = 20
/** The pace a path opens with; the hash names the other one only. */
export const DEFAULT_EASE: CameraPathEase = 'smooth'

/** The shortest turn from one heading to another, in degrees, −180..180. */
export function headingDelta(from: number, to: number): number {
  const delta = (((to - from) % 360) + 540) % 360
  return delta - 180
}

/** The pose `t` of the way (0..1) from one keyframe to the next, headings turned the short way round. */
export function interpolateView(from: CameraView, to: CameraView, t: number): CameraView {
  const k = Math.min(1, Math.max(0, t))
  const mix = (a: number, b: number) => a + (b - a) * k
  const heading = (((from.heading + headingDelta(from.heading, to.heading) * k) % 360) + 360) % 360
  return {
    longitude: mix(from.longitude, to.longitude),
    latitude: mix(from.latitude, to.latitude),
    height: mix(from.height, to.height),
    heading,
    pitch: mix(from.pitch, to.pitch),
  }
}

/** The way's progress after easing: linear as it is, smooth as a smoothstep. */
export function easeProgress(t: number, ease: CameraPathEase): number {
  const k = Math.min(1, Math.max(0, t))
  return ease === 'smooth' ? k * k * (3 - 2 * k) : k
}

/**
 * Where the camera is `t` of the way along the whole path (0..1, before
 * easing): the segments share the time equally, and the pose comes from
 * the segment the moment falls in.
 */
export function viewAlongPath(path: CameraPath, t: number): CameraView {
  const frames = path.keyframes
  if (frames.length === 1) return frames[0]
  const eased = easeProgress(t, path.ease)
  const segments = frames.length - 1
  const position = eased * segments
  const index = Math.min(segments - 1, Math.floor(position))
  return interpolateView(frames[index], frames[index + 1], position - index)
}

/** Whether a path can be flown: two keyframes at least, a duration in range. */
export function isFlyable(path: CameraPath | null): path is CameraPath {
  return (
    path !== null &&
    path.keyframes.length >= 2 &&
    path.keyframes.length <= MAX_KEYFRAMES &&
    path.durationS >= MIN_DURATION_S &&
    path.durationS <= MAX_DURATION_S
  )
}

function formatKeyframe(view: CameraView): string {
  const heading = Math.round(((view.heading % 360) + 360) % 360)
  return [
    view.latitude.toFixed(6),
    view.longitude.toFixed(6),
    String(Math.round(view.height)),
    String(heading === 360 ? 0 : heading),
    String(Math.round(view.pitch)),
  ].join(',')
}

/** The path's hash form, appended to a pose or selection hash ('' for a path that cannot be flown). */
export function formatCameraPathHash(path: CameraPath | null): string {
  if (!isFlyable(path)) return ''
  return (
    `&path=${path.keyframes.map(formatKeyframe).join(';')}` +
    `&dur=${Number.isInteger(path.durationS) ? path.durationS : path.durationS.toFixed(1)}` +
    (path.ease === DEFAULT_EASE ? '' : `&ease=${path.ease}`)
  )
}

function parseKeyframe(text: string): CameraView | null {
  const parts = text.split(',').map(Number)
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return null
  const [latitude, longitude, height, heading, pitch] = parts
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null
  if (height <= 0 || height > 40_000_000) return null
  return {
    longitude,
    latitude,
    height,
    heading: ((heading % 360) + 360) % 360,
    pitch: Math.min(90, Math.max(-90, pitch)),
  }
}

/** The path a hash carries, or null where it carries none or a broken one. */
export function parseCameraPathHash(hash: string): CameraPath | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)
  const path = params.get('path')
  if (!path) return null
  const keyframes: CameraView[] = []
  for (const part of path.split(';')) {
    const view = parseKeyframe(part)
    if (!view) return null
    keyframes.push(view)
  }
  const durationS = Number(params.get('dur') ?? DEFAULT_DURATION_S)
  const candidate: CameraPath = {
    keyframes,
    durationS,
    ease: params.get('ease') === 'linear' ? 'linear' : DEFAULT_EASE,
  }
  return isFlyable(candidate) ? candidate : null
}

/**
 * A keyframe as the interface lists it, on two lines: the place, then
 * the height, heading and pitch – "54.0848° N 12.1162° E" over
 * "7.4 km · 0° · −40°". Two lines because the popover is narrow and one
 * line broke at the pitch.
 */
export function describeKeyframe(view: CameraView): string {
  const ns = view.latitude >= 0 ? 'N' : 'S'
  const ew = view.longitude >= 0 ? 'E' : 'W'
  const height =
    view.height >= 1000 ? `${(view.height / 1000).toFixed(1)} km` : `${Math.round(view.height)} m`
  const heading = Math.round(((view.heading % 360) + 360) % 360) % 360
  const pitch = Math.round(view.pitch)
  return (
    `${Math.abs(view.latitude).toFixed(4)}° ${ns} ${Math.abs(view.longitude).toFixed(4)}° ${ew}` +
    `\n${height} · ${heading}° · ${pitch < 0 ? '−' : ''}${Math.abs(pitch)}°`
  )
}
