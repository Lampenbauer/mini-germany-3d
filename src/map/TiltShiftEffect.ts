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

/**
 * Resolution the blur runs at, as a fraction of the drawing buffer. Its
 * output is unsharp by definition, so halving it is invisible while it
 * costs a quarter of the fill rate. The sharp band never comes from that
 * texture: the composite pass samples the full-size scene for it – the
 * same split Cesium's own depth-of-field stage uses.
 *
 * Exactly one half on purpose. At anything but an exact half (0.5, 0.25)
 * or 1.0, the composite pass reads the blur texture at a fraction of a
 * texel that drifts across the screen, and the beat between the two
 * grids lays a fine regular mesh over every blurred area – measured at
 * 0.9 it repeated every 10 pixels, i.e. 1/(1 - scale). Halves land on
 * texel corners everywhere, so their upsample stays even.
 */
const TEXTURE_SCALE = 0.8

/**
 * The band, in fractions of the viewport: how far from the focus line the
 * frame stays sharp, and how far it then takes to reach the full blur
 * radius. Their sum is measured against half the screen, so whatever is
 * left over at the top and bottom edges is the part that carries the
 * blur undiluted – raising either number leaves less of it.
 *
 * The radius grows linearly across the feather, as it does behind a real
 * lens: the circle of confusion is proportional to the distance from the
 * plane of focus. An eased ramp would keep the rows next to the band
 * nearly sharp and make the band look wider than it is set to.
 */
const BAND_HALF_HEIGHT = 0.18
const BAND_FEATHER = 0.44

/**
 * Blur radius at the top and bottom edges, as a fraction of the viewport
 * height. Sized against the frame rather than in pixels: a bigger window
 * shows the same city bigger, and the discs have to scale with it or a
 * 4K display gets the blur of a thumbnail. 0.03 is 24 px on an 800 px
 * tall window – a strong blur, which is the point: the timid version
 * reads as a slightly soft photo, not as a model.
 */
const MAX_BLUR_RADIUS = 0.03

/**
 * How much brighter than average a highlight is weighted inside the
 * disc (1 = plain average). A lens does not average a bright roof into
 * the street around it, it spreads it into a bright disc – the bokeh.
 * Kept moderate: pushed further the blurred areas start to sparkle with
 * white squares.
 */
const HIGHLIGHT_GAIN = 3.0

/**
 * Unsharp-mask amount inside the band. A miniature photograph is not only
 * blurred outside the plane of focus, it is crisp inside it – the
 * contrast between the two is what the eye measures the depth by. Small:
 * the photo tiles are already sharp, this only crisps the edges.
 */
const BAND_SHARPEN = 0.35

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
 * own brightness (HIGHLIGHT_GAIN) and the sum renormalized, so a bright
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
    // The band, as the circle-of-confusion function reads it. The camera
    // points at the middle of the screen, so the row that shows what the
    // view is aimed at is the middle one: sharp there, blurred towards
    // both edges.
    const band = {
      u_strength: 0,
      u_focusY: 0.5,
      u_bandHalfHeight: BAND_HALF_HEIGHT,
      u_bandFeather: BAND_FEATHER,
      u_maxRadius: MAX_BLUR_RADIUS,
    }
    const blurX = new PostProcessStage({
      name: 'mrt_tilt_shift_blur_x',
      fragmentShader: BLUR_SHADER,
      uniforms: { ...band, u_direction: 0, u_highlightGain: HIGHLIGHT_GAIN },
      textureScale: TEXTURE_SCALE,
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    const blurY = new PostProcessStage({
      name: 'mrt_tilt_shift_blur_y',
      fragmentShader: BLUR_SHADER,
      uniforms: { ...band, u_direction: 1, u_highlightGain: HIGHLIGHT_GAIN },
      textureScale: TEXTURE_SCALE,
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    // Chained: the vertical pass blurs what the horizontal one produced.
    const blur = new PostProcessStageComposite({
      name: 'mrt_tilt_shift_blur',
      stages: [blurX, blurY],
    })

    const grade = new PostProcessStage({
      name: 'mrt_tilt_shift_composite',
      fragmentShader: COMPOSITE_SHADER,
      uniforms: {
        ...band,
        // A uniform holding a stage name resolves to that stage's output
        // texture – this is what lets the blur run at half size while the
        // pass reading it stays full size.
        u_blurTexture: blur.name,
        u_sharpen: BAND_SHARPEN,
        u_saturation: SATURATION,
        u_contrast: CONTRAST,
        u_vignette: VIGNETTE,
      },
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    this.strengthStages = [blurX, blurY, grade]

    // inputPreviousStageTexture: false – both stages take the rendered
    // scene as their input. The grading pass needs the sharp original for
    // the band; it picks the blurred copy up through u_blurTexture.
    this.composite = new PostProcessStageComposite({
      name: 'mrt_tilt_shift',
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
   * Strength currently in the shaders, 0 … 1 (0 while the stages are off).
   * Debug and tests read the effect through this.
   */
  get strength(): number {
    return Math.max(this.appliedStrength, 0)
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
