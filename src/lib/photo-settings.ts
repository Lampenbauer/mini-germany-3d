/**
 * The photo mode: what the camera the city is shot with is set to.
 *
 * Everything in here is a knob the viewer can turn from the photo popover
 * (see components/PhotoModePopover.tsx) – the lens, the exposure and the
 * grade of the picture, and the miniature effect with its own set of
 * tunables. The map applies a whole settings object at once (see
 * CesiumMap.setPhotoSettings), so this module is the one place that says
 * what the knobs are, where they start and what "back to default" means.
 *
 * Deliberately free of Cesium: the conversions – a field of view into a
 * focal length, a white balance in kelvin into a per-channel gain – are
 * plain arithmetic, and they are unit tested as that.
 */

import { config } from '@/config'
import { clampFovDeg } from '@/map/camera-fov'

/**
 * How the miniature effect draws (see map/TiltShiftEffect.ts for what the
 * three passes do with these). All lengths are fractions of the viewport,
 * so a bigger window shows the same city bigger and the effect scales
 * with it – a 4K display must not get the blur of a thumbnail.
 */
export interface TiltShiftSettings {
  /** Whether the effect is on at all. */
  enabled: boolean
  /**
   * Blur radius at the top and bottom edges, as a fraction of the
   * viewport height. 0.03 is 24 px on an 800 px tall window – a strong
   * blur, which is the point: the timid version reads as a slightly soft
   * photo, not as a model.
   */
  maxBlurRadius: number
  /**
   * How far from the focus line the frame stays sharp, as a fraction of
   * the viewport height. Together with the feather it is measured against
   * half the screen: whatever is left over at the top and bottom edges is
   * the part that carries the blur undiluted – raising either leaves
   * less of it.
   */
  bandHalfHeight: number
  /**
   * How far past the sharp band the blur takes to reach its full radius,
   * as a fraction of the viewport height. The radius grows linearly
   * across it, as it does behind a real lens: the circle of confusion is
   * proportional to the distance from the plane of focus.
   */
  bandFeather: number
  /**
   * The screen row the sharp band is centred on, 0 = bottom edge, 1 =
   * top edge. The camera points at the middle of the screen, so the
   * middle row is what the view is aimed at.
   */
  focusY: number
  /**
   * How much brighter than average a highlight is weighted inside the
   * blur disc (1 = plain average). A lens does not average a bright roof
   * into the street around it, it spreads it into a bright disc – the
   * bokeh. Pushed far the blurred areas start to sparkle with white
   * squares.
   */
  highlightGain: number
  /**
   * Unsharp-mask amount inside the band. A miniature photograph is not
   * only blurred outside the plane of focus, it is crisp inside it – the
   * contrast between the two is what the eye measures the depth by.
   */
  sharpen: number
}

/**
 * The grade of the picture: what a camera's exposure and picture settings
 * do to the frame it captured. Neutral values leave the frame untouched,
 * and the grading pass is skipped outright at them (see
 * map/PhotoGradeEffect.ts).
 */
export interface PhotoGrade {
  /** Exposure compensation in EV stops; 0 = as rendered, +1 = twice as bright. */
  exposureEv: number
  /**
   * White balance in kelvin, as the setting on a camera: a higher value
   * warms the picture, a lower one cools it (the camera compensates for
   * a light of that colour). NEUTRAL_WHITE_BALANCE_K leaves it alone.
   */
  whiteBalanceK: number
  /** Contrast about mid-grey, 1 = as rendered. */
  contrast: number
  /** Saturation, 1 = as rendered, 0 = black and white. */
  saturation: number
  /** Darkening at the corners of the frame, 0 … 1. */
  vignette: number
}

export interface PhotoSettings extends PhotoGrade {
  /**
   * Horizontal field of view in degrees – the lens. Held inside the
   * guard rails of camera-fov.ts; presented to the viewer as a focal
   * length (see focalLengthMm).
   */
  fovDeg: number
  tiltShift: TiltShiftSettings
}

/**
 * The lens each look is shot with: the long one for the miniature effect,
 * Cesium's plain wide one without it (see config.camera for why).
 */
export function lensFovDeg(miniature: boolean): number {
  return clampFovDeg(miniature ? config.camera.fovDeg : config.camera.fovOffDeg)
}

/** White balance at which the colours are left as rendered (sRGB's D65). */
export const NEUTRAL_WHITE_BALANCE_K = 6500

export const DEFAULT_TILT_SHIFT_SETTINGS: TiltShiftSettings = {
  enabled: config.camera.miniatureDefault,
  maxBlurRadius: 0.03,
  bandHalfHeight: 0.18,
  bandFeather: 0.44,
  focusY: 0.5,
  highlightGain: 3.0,
  sharpen: 0.35,
}

export const DEFAULT_PHOTO_SETTINGS: PhotoSettings = {
  fovDeg: lensFovDeg(config.camera.miniatureDefault),
  exposureEv: 0,
  whiteBalanceK: NEUTRAL_WHITE_BALANCE_K,
  contrast: 1,
  saturation: 1,
  vignette: 0,
  tiltShift: DEFAULT_TILT_SHIFT_SETTINGS,
}

/**
 * The miniature effect switched on or off – and with it the lens: the
 * effect is built on the long-lens look, so the switch brings its lens
 * along, eased as a dolly zoom by the map (see CameraLens). A focal
 * length set by hand is given up in the process; the slider is there to
 * set it again.
 */
export function withTiltShift(settings: PhotoSettings, enabled: boolean): PhotoSettings {
  return {
    ...settings,
    fovDeg: lensFovDeg(enabled),
    tiltShift: { ...settings.tiltShift, enabled },
  }
}

/** Whether the grade leaves the frame as rendered. */
export function isNeutralGrade(grade: PhotoGrade): boolean {
  return (
    grade.exposureEv === 0 &&
    grade.whiteBalanceK === NEUTRAL_WHITE_BALANCE_K &&
    grade.contrast === 1 &&
    grade.saturation === 1 &&
    grade.vignette === 0
  )
}

/** Whether every knob stands where the app opens with it. */
export function isDefaultPhotoSettings(settings: PhotoSettings): boolean {
  const d = DEFAULT_PHOTO_SETTINGS
  const ts = settings.tiltShift
  const dts = d.tiltShift
  return (
    settings.fovDeg === d.fovDeg &&
    settings.exposureEv === d.exposureEv &&
    settings.whiteBalanceK === d.whiteBalanceK &&
    settings.contrast === d.contrast &&
    settings.saturation === d.saturation &&
    settings.vignette === d.vignette &&
    ts.enabled === dts.enabled &&
    ts.maxBlurRadius === dts.maxBlurRadius &&
    ts.bandHalfHeight === dts.bandHalfHeight &&
    ts.bandFeather === dts.bandFeather &&
    ts.focusY === dts.focusY &&
    ts.highlightGain === dts.highlightGain &&
    ts.sharpen === dts.sharpen
  )
}

/**
 * Width of a full-frame sensor in mm – what "a 50 mm lens" is measured
 * against. The field of view here is the horizontal one, so it is the
 * width that converts it.
 */
const FULL_FRAME_WIDTH_MM = 36

/**
 * The 35 mm-equivalent focal length of a horizontal field of view: the
 * number a photographer reads a lens by. 60° is a 31 mm wide angle, 25°
 * an 81 mm short telephoto.
 */
export function focalLengthMm(fovDeg: number): number {
  return FULL_FRAME_WIDTH_MM / 2 / Math.tan((fovDeg * Math.PI) / 360)
}

/** The inverse: the horizontal field of view a focal length takes in. */
export function fovDegFromFocalLength(focalLengthMm: number): number {
  return (2 * Math.atan(FULL_FRAME_WIDTH_MM / 2 / focalLengthMm) * 180) / Math.PI
}

/**
 * Colour of a black body at the given temperature, linear-ish 0 … 1 per
 * channel (Tanner Helland's fit to the CIE data, good to a few percent
 * between 1000 and 40000 K – ample for a grade).
 */
function blackbodyColor(kelvin: number): [number, number, number] {
  const t = Math.min(40_000, Math.max(1000, kelvin)) / 100
  const unit = (v: number) => Math.min(1, Math.max(0, v / 255))
  const red = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const green =
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  return [unit(red), unit(green), unit(blue)]
}

/**
 * Per-channel gain a white balance setting applies to the frame. A camera
 * set to K kelvin divides the picture by the colour of a K-kelvin light so
 * that light comes out white – which is why a high setting warms a
 * daylight scene and a low one cools it. Relative to the neutral setting,
 * so that one is exactly a gain of 1, and normalised to keep white at the
 * same luminance: the balance shifts the colour, the exposure knob the
 * brightness.
 */
export function whiteBalanceGain(kelvin: number): [number, number, number] {
  const neutral = blackbodyColor(NEUTRAL_WHITE_BALANCE_K)
  const light = blackbodyColor(kelvin)
  const gain = neutral.map((n, i) => n / Math.max(light[i], 1e-3)) as [number, number, number]
  const luminance = 0.2126 * gain[0] + 0.7152 * gain[1] + 0.0722 * gain[2]
  return gain.map((g) => g / luminance) as [number, number, number]
}
