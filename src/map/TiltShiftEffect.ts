/**
 * Tilt-shift: the miniature look.
 *
 * A photo of a real city taken through a tilted lens has a paper-thin
 * plane of focus, and the eye reads that shallow depth of field as "small
 * object, seen from close up" – which is why the trick turns an aerial
 * shot into a model railway. This fakes it the way photo filters do: one
 * horizontal band stays sharp, everything above and below fades into a
 * blur, and the colors are pushed towards how toy plastic reflects light,
 * a little more saturated and a little harder.
 *
 * Deliberately not Cesium's own depth of field
 * (PostProcessStageLibrary.createDepthOfFieldStage): a depth-driven blur
 * is physically right and reads as a *photograph of a city*, while the
 * band is physically wrong and reads as a *model of one*. The band is
 * also the cheaper of the two – it needs no depth texture, and its blur
 * can run at half resolution.
 *
 * Cost when it is on: two blur passes over a quarter of the pixels each
 * (TEXTURE_SCALE), plus one full-size composite pass. Off – switched off
 * by the user, or ramped to zero by the camera pose (see update) – the
 * stages are disabled, and a disabled stage frees its textures and skips
 * its draw entirely. Between frames nothing runs at all: the app renders
 * on demand.
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
 * The scale is not free of side effects. At anything but an exact half
 * (0.5, 0.25) or 1.0, the composite pass reads the blur texture at a
 * fraction of a texel that drifts across the screen, and the beat
 * between the two grids lays a fine regular mesh over every blurred
 * area – measured at 0.9 it repeated every 10 pixels, i.e. 1/(1 - scale).
 * Halves land on texel corners everywhere, so their upsample stays even.
 */
const TEXTURE_SCALE = 0.92

/**
 * Half height of the sharp band, in fractions of the viewport, plus the
 * distance it takes to fade from sharp to fully blurred. Together they
 * cover 0.12 + 0.25 = 0.37 of the half screen, so roughly the top and
 * bottom eighth of the frame sits at full blur.
 */
const BAND_HALF_HEIGHT = 0.12
const BAND_FEATHER = 0.25

/**
 * Color grade at full strength. Toy models are painted plastic under a
 * hard light: more saturated and more contrasty than a hazy city seen
 * from a kilometer up. Both are gentle on purpose – the photo tiles
 * already carry their own grading (see TIME_OF_DAY_SHADER), and pushing
 * these further turns the night view into neon.
 */
const SATURATION = 1.25
const CONTRAST = 1.12

/**
 * Separable Gaussian, one pass per axis. The weights are evaluated
 * incrementally (GPU Gems 3, ch. 40) exactly as in Cesium's own blur
 * stage; only the sample spacing is ours.
 */
const BLUR_SHADER = `
uniform sampler2D colorTexture;
// 0.0 = horizontal pass, 1.0 = vertical pass
uniform float u_direction;

in vec2 v_textureCoordinates;

#define SAMPLES 6
const float SIGMA = 2.0;
const float DELTA = 1.0;
// Spacing of two taps in texels of this stage's own target. czm_viewport
// is that target rather than the screen, so at TEXTURE_SCALE 0.5 one
// texel spans two device pixels; together with czm_pixelRatio the kernel
// comes out the same width in CSS pixels on every display.
const float STEP_TEXELS = 1.5;

void main()
{
    vec2 axis = vec2(1.0 - u_direction, u_direction);
    vec2 tapOffset = STEP_TEXELS * axis * czm_pixelRatio / czm_viewport.zw;

    vec3 g;
    g.x = 1.0 / (sqrt(czm_twoPi) * SIGMA);
    g.y = exp((-0.5 * DELTA * DELTA) / (SIGMA * SIGMA));
    g.z = g.y * g.y;

    vec4 result = texture(colorTexture, v_textureCoordinates) * g.x;
    for (int i = 1; i < SAMPLES; ++i)
    {
        g.xy *= g.yz;
        vec2 offset = float(i) * tapOffset;
        result += texture(colorTexture, v_textureCoordinates - offset) * g.x;
        result += texture(colorTexture, v_textureCoordinates + offset) * g.x;
    }

    out_FragColor = result;
}
`

/**
 * Mixes the sharp scene with the blurred copy along the band, then grades
 * the result. Both the blur and the grade ride on u_strength, so a strength
 * of 0 leaves the frame bit-for-bit untouched and the ramp in update() can
 * fade the whole effect in and out without a visible switch-over.
 */
const COMPOSITE_SHADER = `
uniform sampler2D colorTexture;
uniform sampler2D u_blurTexture;
uniform float u_strength;
uniform float u_focusY;
uniform float u_bandHalfHeight;
uniform float u_bandFeather;
uniform float u_saturation;
uniform float u_contrast;

in vec2 v_textureCoordinates;

void main()
{
    vec4 sharp = texture(colorTexture, v_textureCoordinates);
    float distanceFromBand = abs(v_textureCoordinates.y - u_focusY);
    float blurAmount = u_strength * smoothstep(
        u_bandHalfHeight,
        u_bandHalfHeight + u_bandFeather,
        distanceFromBand
    );

    vec3 color = mix(sharp.rgb, texture(u_blurTexture, v_textureCoordinates).rgb, blurAmount);
    color = mix(vec3(czm_luminance(color)), color, mix(1.0, u_saturation, u_strength));
    color = (color - 0.5) * mix(1.0, u_contrast, u_strength) + 0.5;

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
  /** The grading pass; owns every uniform that changes per frame. */
  private readonly grade: PostProcessStage
  private on = false
  /** Last strength pushed into the shader (-1 = nothing pushed yet). */
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
    const blurX = new PostProcessStage({
      name: 'mrt_tilt_shift_blur_x',
      fragmentShader: BLUR_SHADER,
      uniforms: { u_direction: 0 },
      textureScale: TEXTURE_SCALE,
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    const blurY = new PostProcessStage({
      name: 'mrt_tilt_shift_blur_y',
      fragmentShader: BLUR_SHADER,
      uniforms: { u_direction: 1 },
      textureScale: TEXTURE_SCALE,
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    // Chained: the vertical pass blurs what the horizontal one produced.
    const blur = new PostProcessStageComposite({
      name: 'mrt_tilt_shift_blur',
      stages: [blurX, blurY],
    })

    this.grade = new PostProcessStage({
      name: 'mrt_tilt_shift_composite',
      fragmentShader: COMPOSITE_SHADER,
      uniforms: {
        // A uniform holding a stage name resolves to that stage's output
        // texture – this is what lets the blur run at half size while the
        // pass reading it stays full size.
        u_blurTexture: blur.name,
        u_strength: 0,
        // The camera points at the middle of the screen, so the row that
        // shows what the view is aimed at is the middle one. Sharp there,
        // blurred towards both edges.
        u_focusY: 0.5,
        u_bandHalfHeight: BAND_HALF_HEIGHT,
        u_bandFeather: BAND_FEATHER,
        u_saturation: SATURATION,
        u_contrast: CONTRAST,
      },
    })

    // inputPreviousStageTexture: false – both stages take the rendered
    // scene as their input. The grading pass needs the sharp original for
    // the band; it picks the blurred copy up through u_blurTexture.
    this.composite = new PostProcessStageComposite({
      name: 'mrt_tilt_shift',
      stages: [blur, this.grade],
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
   * Strength currently in the shader, 0 … 1 (0 while the stages are off).
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
    this.grade.uniforms.u_strength = strength
  }
}
