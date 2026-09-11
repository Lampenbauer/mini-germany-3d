/**
 * Tilt-shift: the miniature look.
 *
 * A photo of a real city taken through a tilted lens has a paper-thin
 * plane of focus, and the eye reads that shallow depth of field as "small
 * object, seen from close up" – which is why the trick turns an aerial
 * shot into a model railway. This fakes it the way photo filters do: one
 * horizontal band stays sharp, everything above and below blurs more the
 * further it is from that band, and the colors are pushed towards how toy
 * plastic reflects light, a little more saturated and a little harder.
 *
 * Deliberately not Cesium's own depth of field
 * (PostProcessStageLibrary.createDepthOfFieldStage): a depth-driven blur
 * is physically right and reads as a *photograph of a city*, while the
 * band is physically wrong and reads as a *model of one*. The band is
 * also the cheaper of the two – it needs no depth texture, and its blur
 * can run on a smaller copy of the frame.
 *
 * What makes the fake convincing is the same thing that makes a real
 * lens convincing: the circle of confusion. A tilted lens does not
 * switch from sharp to one fixed blur; it renders every point as a disc
 * that grows in proportion to its distance from the plane of focus. So
 * the blur here has a per-row radius (BLUR_SHADER) rather than a single
 * radius mixed in by a per-row amount – the mix looks like a double
 * exposure, the growing radius looks like glass. The disc is bright-
 * weighted too: a real lens spreads a highlight into a bright disc
 * instead of averaging it into the grey around it, and those glowing
 * roofs and cars are most of what says "macro photo" to the eye.
 *
 * The band, the blur radius, the bokeh weighting and the sharpening are
 * knobs in the photo popover (see lib/photo-settings.ts); the toy grade
 * and the vignette below are not – they are what makes the look the
 * miniature look, and the photo grade has knobs of its own for the rest.
 *
 * Cost when it is on: two blur passes over a quarter-size frame
 * (TEXTURE_SCALE 0.5 on both axes), plus one full-size composite pass
 * with a handful of taps. Off – switched off by the user, or ramped to
 * zero by the camera pose (see update) – the stages are disabled, and a
 * disabled stage frees its textures and skips its draw entirely. Between
 * frames nothing runs at all: the app renders on demand.
 */

import {
  Math as CesiumMath,
  PostProcessStage,
  PostProcessStageComposite,
  PostProcessStageSampleMode,
  type Viewer,
} from 'cesium'
import { DEFAULT_TILT_SHIFT_SETTINGS, type TiltShiftSettings } from '@/lib/photo-settings'

/**
 * Resolution the blur runs at, as a fraction of the drawing buffer. Its
 * output is unsharp by definition, so it can run below full size while
 * the sharp band never comes from that texture: the composite pass
 * samples the full-size scene for it – the same split Cesium's own
 * depth-of-field stage uses.
 *
 * 0.8 is the maintainer's choice, picked by eye against the real tiles.
 * Two things to know before touching it. The fill rate of the two blur
 * passes goes with its square (0.8 → 64 % of a full frame each, 0.5 →
 * 25 %); measured 2026-09-05 on a 3200×2000 buffer the whole effect at
 * full strength costs ~1.3 ms of GPU per frame at this value. And at
 * anything but an exact half (0.5, 0.25) or 1.0, the composite pass reads
 * the blur texture at a fraction of a texel that drifts across the
 * screen, so the beat between the two grids can lay a fine regular mesh
 * over the blurred areas, repeating every 1/(1 - scale) pixels – 10 px
 * at 0.9, where it was first seen, 5 px here. At 0.8 it was not judged
 * visible; halves would land on texel corners everywhere and avoid it
 * outright.
 */
const TEXTURE_SCALE = 0.8

/**
 * The band, the blur radius, the highlight weighting and the sharpening
 * are the viewer's to set from the photo popover: they live in
 * lib/photo-settings.ts (TiltShiftSettings, with what each one does),
 * start at DEFAULT_TILT_SHIFT_SETTINGS and arrive here through
 * setSettings. What follows are the parts that are not knobs.
 */

/**
 * Color grade at full strength. Toy models are painted plastic under a
 * hard light: more saturated and more contrasty than a hazy city seen
 * from a kilometer up. Both stay short of garish on purpose – the photo
 * tiles already carry their own grading (see TIME_OF_DAY_SHADER), and
 * pushing these further turns the night view into neon.
 */
const SATURATION = 1.35
const CONTRAST = 1.15

/**
 * Darkening at the corners of the frame, 0 … 1. Macro lenses vignette,
 * and the photo filters that fake the miniature look all add one: it
 * pulls the eye into the sharp middle and makes the frame a picture
 * rather than a window.
 */
const VIGNETTE = 0.28

/**
 * Circle of confusion for a screen row: 0 inside the band, growing
 * linearly across the feather to 1 at the edges. Shared by the blur
 * passes (radius) and the composite (how much of the blurred copy to
 * show, and where the sharpening stops). Kept in one string so the two
 * shaders cannot drift apart.
 */
const COC_GLSL = `
uniform float u_strength;
uniform float u_focusY;
uniform float u_bandHalfHeight;
uniform float u_bandFeather;

float circleOfConfusion(float y)
{
    float distanceFromBand = abs(y - u_focusY);
    return u_strength * clamp((distanceFromBand - u_bandHalfHeight) / u_bandFeather, 0.0, 1.0);
}
`

/**
 * One axis of the disc, at a radius that varies per row. Separable
 * gathers are only exact for a constant radius; with the radius read at
 * the center tap the error is a slightly lopsided disc where the radius
 * changes fastest, which is well inside what a blurred area can hide.
 *
 * The weights are a wide Gaussian cut off at the radius, so the disc is
 * flat-topped with a soft rim – closer to a lens's aperture than the
 * pointed Gaussian a plain blur uses. Each tap is also weighted by its
 * own brightness (u_highlightGain) and the sum renormalized, so a bright
 * spot pulls the disc towards its color instead of being averaged away.
 * The second pass reads the first's output, so a highlight spread along
 * x is spread again along y at its already-raised weight: a rounded
 * square of light, which is what a lens with a few aperture blades makes
 * of it too.
 */
const BLUR_SHADER = `
uniform sampler2D colorTexture;
// 0.0 = horizontal pass, 1.0 = vertical pass
uniform float u_direction;
uniform float u_maxRadius;
uniform float u_highlightGain;

in vec2 v_textureCoordinates;

${COC_GLSL}

// Taps per side at the widest disc. The count follows the radius so that
// two taps never sit more than MAX_TAP_SPACING texels apart: at two texels
// the bilinear samples stop overlapping and the disc comes out combed into
// stripes (seen on a Retina display, where the target is twice as tall).
// Near the band the disc is small and the loop correspondingly short.
#define MAX_TAPS 24
const float MAX_TAP_SPACING = 1.25;
// Gaussian falloff towards the rim: weight at the rim is exp(-RIM_FALLOFF)
const float RIM_FALLOFF = 1.6;

float highlightWeight(vec3 color)
{
    float luma = czm_luminance(color);
    return mix(1.0, u_highlightGain, smoothstep(0.55, 0.95, luma));
}

void main()
{
    vec4 center = texture(colorTexture, v_textureCoordinates);
    float coc = circleOfConfusion(v_textureCoordinates.y);
    // Radius in texels of this pass's own target: czm_viewport is that
    // target, so the fraction of its height is the fraction of the screen
    // whatever the texture scale and the device pixel ratio.
    float radius = coc * u_maxRadius * czm_viewport.w;
    if (radius < 0.5)
    {
        out_FragColor = center;
        return;
    }

    int taps = int(clamp(ceil(radius / MAX_TAP_SPACING), 1.0, float(MAX_TAPS)));
    vec2 axis = vec2(1.0 - u_direction, u_direction);
    vec2 tapStep = axis * radius / (float(taps) * czm_viewport.zw);

    float w0 = highlightWeight(center.rgb);
    vec3 sum = center.rgb * w0;
    float weightSum = w0;
    for (int i = 1; i <= taps; ++i)
    {
        float t = float(i) / float(taps);
        float falloff = exp(-RIM_FALLOFF * t * t);
        vec2 offset = float(i) * tapStep;
        vec3 a = texture(colorTexture, v_textureCoordinates - offset).rgb;
        vec3 b = texture(colorTexture, v_textureCoordinates + offset).rgb;
        float wa = falloff * highlightWeight(a);
        float wb = falloff * highlightWeight(b);
        sum += a * wa + b * wb;
        weightSum += wa + wb;
    }

    out_FragColor = vec4(sum / weightSum, center.a);
}
`

/**
 * Joins the sharp scene and the blurred copy along the band, crisps the
 * band, then grades and vignettes the result. Everything rides on
 * u_strength (through the circle of confusion and the mixes below), so a
 * strength of 0 leaves the frame bit-for-bit untouched and the ramp in
 * update() can fade the whole effect in and out without a visible
 * switch-over.
 */
const COMPOSITE_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D u_blurTexture;
uniform float u_maxRadius;
uniform float u_sharpen;
uniform float u_saturation;
uniform float u_contrast;
uniform float u_vignette;

in vec2 v_textureCoordinates;

${COC_GLSL}

void main()
{
    vec2 uv = v_textureCoordinates;
    vec4 sharp = texture(colorTexture, uv);
    float coc = circleOfConfusion(uv.y);

    // The blurred copy takes over as soon as its radius exceeds what its
    // own half resolution blurs anyway (about a screen pixel), so the
    // hand-over from the full-size scene is invisible.
    float radiusPx = coc * u_maxRadius * czm_viewport.w;
    float blurAmount = smoothstep(0.0, 2.0, radiusPx);
    vec3 blurred = texture(u_blurTexture, uv).rgb;

    // Unsharp mask inside the band: the sharp scene minus its own
    // 4-neighbour average, added back in. Fades out with the blur.
    vec2 px = czm_pixelRatio / czm_viewport.zw;
    vec3 around = 0.25 * (
        texture(colorTexture, uv + vec2(px.x, 0.0)).rgb +
        texture(colorTexture, uv - vec2(px.x, 0.0)).rgb +
        texture(colorTexture, uv + vec2(0.0, px.y)).rgb +
        texture(colorTexture, uv - vec2(0.0, px.y)).rgb);
    float sharpen = u_strength * u_sharpen * (1.0 - blurAmount);
    vec3 crisp = sharp.rgb + (sharp.rgb - around) * sharpen;

    vec3 color = mix(crisp, blurred, blurAmount);

    // Grade: saturation, then contrast about mid-grey
    color = mix(vec3(czm_luminance(color)), color, mix(1.0, u_saturation, u_strength));
    color = (color - 0.5) * mix(1.0, u_contrast, u_strength) + 0.5;

    // Vignette: radial in aspect-corrected coordinates, so the corners of
    // a wide window darken the same as those of a tall one
    vec2 centered = (uv - 0.5) * vec2(czm_viewport.z / czm_viewport.w, 1.0);
    float edge = smoothstep(0.45, 1.05, length(centered));
    color *= 1.0 - u_strength * u_vignette * edge;

    out_FragColor = vec4(clamp(color, 0.0, 1.0), sharp.a);
}
`

/** The camera pose the effect judges itself by (see tiltShiftStrength). */
export interface TiltShiftView {
  /** Camera pitch in degrees: 0 = horizon, -90 = straight down. */
  pitchDeg: number
  /** Camera height above the ground in meters. */
  heightMeters: number
}

/**
 * Below this the camera is down on the cobbles, where the view is a
 * pedestrian's rather than a model builder's and the blur takes away the
 * little that is left of it. Everything above is fair game: a close view
 * of a few blocks is where the houses read most like a model kit, so the
 * ramp is over and done with well below the chase cam's ~40 m above the
 * tram.
 */
const HEIGHT_FADE_IN_METERS = 4
const HEIGHT_FULL_METERS = 20

/**
 * Down-angle in degrees the horizontal band still matches the geometry
 * at. Looking straight down, every pixel of the frame is roughly the same
 * distance away, so a band that blurs the top and bottom contradicts what
 * the image shows – the miniature illusion needs the oblique view a model
 * is looked at from. Full strength up to PITCH_FULL_DEG, gone by
 * PITCH_OFF_DEG.
 */
const PITCH_FULL_DEG = 55
const PITCH_OFF_DEG = 90

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * How much of the effect a camera pose can carry, 0 … 1. Kept free of
 * Cesium so the two ramps can be reasoned about – and unit tested – as
 * the plain geometry they are.
 */
export function tiltShiftStrength(view: TiltShiftView): number {
  const heightRamp = smoothstep(HEIGHT_FADE_IN_METERS, HEIGHT_FULL_METERS, view.heightMeters)
  const pitchRamp = 1 - smoothstep(PITCH_FULL_DEG, PITCH_OFF_DEG, -view.pitchDeg)
  return heightRamp * pitchRamp
}

export class TiltShiftEffect {
  /** Blur and grade in one composite – added to the scene, off until enabled. */
  private readonly composite: PostProcessStageComposite
  /** Every stage that reads the strength; all get it pushed per frame. */
  private readonly strengthStages: readonly PostProcessStage[]
  /** The two blur passes – the only readers of the highlight gain. */
  private readonly blurStages: readonly PostProcessStage[]
  /** The composite pass – the only reader of the sharpening amount. */
  private readonly gradeStage: PostProcessStage
  private settings: TiltShiftSettings = DEFAULT_TILT_SHIFT_SETTINGS
  private on = false
  /** Last strength pushed into the shaders (-1 = nothing pushed yet). */
  private appliedStrength = -1

  constructor(
    private readonly viewer: Viewer,
    /**
     * Ellipsoidal height of the ground under the city. The ramps below
     * are about the camera's height *above the roofs*, and the map is the
     * only place that knows where the ground ended up (see
     * CesiumMap.defaultGroundHeight).
     */
    private readonly groundHeight: () => number,
  ) {
    // The band, as the circle-of-confusion function reads it: sharp along
    // the focus row, blurred towards both edges. Built at the defaults;
    // setSettings pushes whatever the viewer turns the knobs to.
    const defaults = DEFAULT_TILT_SHIFT_SETTINGS
    const band = {
      u_strength: 0,
      u_focusY: defaults.focusY,
      u_bandHalfHeight: defaults.bandHalfHeight,
      u_bandFeather: defaults.bandFeather,
      u_maxRadius: defaults.maxBlurRadius,
    }
    const blurX = new PostProcessStage({
      name: 'mg3d_tilt_shift_blur_x',
      fragmentShader: BLUR_SHADER,
      uniforms: { ...band, u_direction: 0, u_highlightGain: defaults.highlightGain },
      textureScale: TEXTURE_SCALE,
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    const blurY = new PostProcessStage({
      name: 'mg3d_tilt_shift_blur_y',
      fragmentShader: BLUR_SHADER,
      uniforms: { ...band, u_direction: 1, u_highlightGain: defaults.highlightGain },
      textureScale: TEXTURE_SCALE,
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    // Chained: the vertical pass blurs what the horizontal one produced.
    const blur = new PostProcessStageComposite({
      name: 'mg3d_tilt_shift_blur',
      stages: [blurX, blurY],
    })

    const grade = new PostProcessStage({
      name: 'mg3d_tilt_shift_composite',
      fragmentShader: COMPOSITE_SHADER,
      uniforms: {
        ...band,
        // A uniform holding a stage name resolves to that stage's output
        // texture – this is what lets the blur run at half size while the
        // pass reading it stays full size.
        u_blurTexture: blur.name,
        u_sharpen: defaults.sharpen,
        u_saturation: SATURATION,
        u_contrast: CONTRAST,
        u_vignette: VIGNETTE,
      },
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    this.strengthStages = [blurX, blurY, grade]
    this.blurStages = [blurX, blurY]
    this.gradeStage = grade

    // inputPreviousStageTexture: false – both stages take the rendered
    // scene as their input. The grading pass needs the sharp original for
    // the band; it picks the blurred copy up through u_blurTexture.
    this.composite = new PostProcessStageComposite({
      name: 'mg3d_tilt_shift',
      stages: [blur, grade],
      inputPreviousStageTexture: false,
    })
    this.composite.enabled = false
    this.viewer.scene.postProcessStages.add(this.composite)
  }

  /** Whether the user has the effect switched on. */
  get enabled(): boolean {
    return this.on
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.on) return
    this.on = enabled
    if (!enabled) {
      this.composite.enabled = false
      this.appliedStrength = -1
      return
    }
    this.update()
  }

  /**
   * The knobs, as the photo popover has them – pushed straight into the
   * uniforms, on/off included. The pose ramp (update) is untouched: the
   * settings say how the effect draws, the pose says how much of it.
   */
  setSettings(settings: TiltShiftSettings): void {
    const previous = this.settings
    this.settings = settings
    if (settings.enabled !== this.on) this.setEnabled(settings.enabled)
    if (
      settings.focusY === previous.focusY &&
      settings.bandHalfHeight === previous.bandHalfHeight &&
      settings.bandFeather === previous.bandFeather &&
      settings.maxBlurRadius === previous.maxBlurRadius &&
      settings.highlightGain === previous.highlightGain &&
      settings.sharpen === previous.sharpen
    ) {
      return
    }
    for (const stage of this.strengthStages) {
      stage.uniforms.u_focusY = settings.focusY
      stage.uniforms.u_bandHalfHeight = settings.bandHalfHeight
      // A feather of zero would divide the circle of confusion by zero
      stage.uniforms.u_bandFeather = Math.max(settings.bandFeather, 1e-3)
      stage.uniforms.u_maxRadius = settings.maxBlurRadius
    }
    for (const stage of this.blurStages) stage.uniforms.u_highlightGain = settings.highlightGain
    this.gradeStage.uniforms.u_sharpen = settings.sharpen
  }

  /**
   * Strength currently in the shaders, 0 … 1 (0 while the stages are off).
   * Debug and tests read the effect through this.
   */
  get strength(): number {
    return Math.max(this.appliedStrength, 0)
  }

  /**
   * Whether the three passes are compiled and actually running. Cesium
   * builds a post-process stage's shader asynchronously and skips the
   * stage until it is done, so a frame drawn right after the switch can
   * still be the unblurred one – which looks like the effect failing
   * rather than like it not being there yet. Tests wait on this.
   */
  get ready(): boolean {
    return this.composite.enabled && this.composite.ready
  }

  /**
   * Re-derives the strength from the current camera pose. Called once per
   * rendered frame, before the frame is drawn: the pose is what the ramps
   * depend on, and a pose change always brings a frame with it – so this
   * never needs a render of its own.
   */
  update(): void {
    if (!this.on) return
    const camera = this.viewer.camera
    const strength = tiltShiftStrength({
      pitchDeg: CesiumMath.toDegrees(camera.pitch),
      heightMeters: camera.positionCartographic.height - this.groundHeight(),
    })
    if (strength === this.appliedStrength) return
    this.appliedStrength = strength
    // Zero strength is a no-op shader – skip the three passes instead of
    // paying for a copy of the frame onto itself.
    this.composite.enabled = strength > 0
    for (const stage of this.strengthStages) stage.uniforms.u_strength = strength
  }
}
