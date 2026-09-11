/**
 * The photo grade: exposure, white balance, contrast, saturation and a
 * vignette, applied to the finished frame the way a camera's picture
 * settings are applied to what its sensor captured.
 *
 * One full-size pass with a handful of multiplies, and none at all at the
 * neutral settings: the stage is disabled then, and a disabled stage
 * frees its texture and skips its draw. It sits in front of the
 * miniature effect (see CesiumMap – stages run in the order they are
 * added), so a raised exposure blows its highlights into that effect's
 * bokeh the way a brighter capture would, rather than brightening an
 * already blurred picture.
 *
 * The frame is low dynamic range by the time it gets here (Cesium's HDR
 * is off), so a positive exposure clips at white like an overexposed
 * photo does. That is the honest result: there is nothing above 1.0 to
 * recover.
 */

import { Cartesian3, PostProcessStage, PostProcessStageSampleMode, type Viewer } from 'cesium'
import { isNeutralGrade, whiteBalanceGain, type PhotoGrade } from '@/lib/photo-settings'

const GRADE_SHADER = `
uniform sampler2D colorTexture;
// Linear gain, exp2 of the EV stops – computed once on the CPU
uniform float u_exposure;
uniform vec3 u_whiteBalance;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_vignette;

in vec2 v_textureCoordinates;

void main()
{
    vec2 uv = v_textureCoordinates;
    vec4 source = texture(colorTexture, uv);

    // Capture: exposure and white balance are gains on the raw frame
    vec3 color = source.rgb * u_exposure * u_whiteBalance;

    // Picture settings: saturation, then contrast about mid-grey – the
    // same order and the same formulas as the miniature grade, so the
    // two agree on what a step of either means
    color = mix(vec3(czm_luminance(color)), color, u_saturation);
    color = (color - 0.5) * u_contrast + 0.5;

    // Vignette: radial in aspect-corrected coordinates, so the corners of
    // a wide window darken the same as those of a tall one
    vec2 centered = (uv - 0.5) * vec2(czm_viewport.z / czm_viewport.w, 1.0);
    float edge = smoothstep(0.45, 1.05, length(centered));
    color *= 1.0 - u_vignette * edge;

    out_FragColor = vec4(clamp(color, 0.0, 1.0), source.a);
}
`

export class PhotoGradeEffect {
  private readonly stage: PostProcessStage

  constructor(viewer: Viewer) {
    this.stage = new PostProcessStage({
      name: 'mg3d_photo_grade',
      fragmentShader: GRADE_SHADER,
      uniforms: {
        u_exposure: 1,
        u_whiteBalance: new Cartesian3(1, 1, 1),
        u_contrast: 1,
        u_saturation: 1,
        u_vignette: 0,
      },
      sampleMode: PostProcessStageSampleMode.LINEAR,
    })
    this.stage.enabled = false
    viewer.scene.postProcessStages.add(this.stage)
  }

  /** Whether the pass runs at all – false at the neutral settings. */
  get enabled(): boolean {
    return this.stage.enabled
  }

  /**
   * Pushes the grade into the shader, or switches the pass off when the
   * grade would leave the frame as it is.
   */
  setSettings(grade: PhotoGrade): void {
    const active = !isNeutralGrade(grade)
    this.stage.enabled = active
    if (!active) return
    const uniforms = this.stage.uniforms
    uniforms.u_exposure = Math.pow(2, grade.exposureEv)
    uniforms.u_whiteBalance = Cartesian3.fromArray(whiteBalanceGain(grade.whiteBalanceK))
    uniforms.u_contrast = grade.contrast
    uniforms.u_saturation = grade.saturation
    uniforms.u_vignette = grade.vignette
  }
}
