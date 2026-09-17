import { type Cartesian3, type PostProcessStage, type Viewer } from 'cesium'
import { describe, expect, it } from 'vitest'
import { NIGHT_GRADE, PhotoGradeEffect } from '@/map/PhotoGradeEffect'
import { DEFAULT_PHOTO_SETTINGS } from '@/lib/photo-settings'

/**
 * Real effect on a fake viewer: like the miniature effect's harness, the
 * stage is Cesium's own class and can be inspected without a GL context.
 */
function gradeHarness() {
  const added: PostProcessStage[] = []
  const viewer = {
    scene: { postProcessStages: { add: (stage: PostProcessStage) => added.push(stage) } },
  } as unknown as Viewer
  const effect = new PhotoGradeEffect(viewer)
  return { effect, stage: added[0] }
}

describe('PhotoGradeEffect', () => {
  it('adds its stage switched off', () => {
    const { effect, stage } = gradeHarness()
    expect(stage.name).toBe('mg3d_photo_grade')
    expect(stage.enabled).toBe(false)
    expect(effect.enabled).toBe(false)
  })

  it('stays off at the neutral grade – the pass would only copy the frame', () => {
    const { effect, stage } = gradeHarness()
    effect.setSettings(DEFAULT_PHOTO_SETTINGS)
    expect(stage.enabled).toBe(false)
  })

  it('switches on and pushes the grade at the first knob turned', () => {
    const { effect, stage } = gradeHarness()
    effect.setSettings({
      ...DEFAULT_PHOTO_SETTINGS,
      exposureEv: 1,
      whiteBalanceK: 9000,
      contrast: 1.2,
      saturation: 0.8,
      vignette: 0.4,
    })
    expect(effect.enabled).toBe(true)
    // One stop is twice the light
    expect(stage.uniforms.u_exposure).toBe(2)
    const balance = stage.uniforms.u_whiteBalance as Cartesian3
    expect(balance.x).toBeGreaterThan(balance.z)
    expect(stage.uniforms.u_contrast).toBe(1.2)
    expect(stage.uniforms.u_saturation).toBe(0.8)
    expect(stage.uniforms.u_vignette).toBe(0.4)
  })

  it('switches off again once every knob is back at neutral', () => {
    const { effect, stage } = gradeHarness()
    effect.setSettings({ ...DEFAULT_PHOTO_SETTINGS, exposureEv: -0.5 })
    expect(stage.enabled).toBe(true)
    effect.setSettings(DEFAULT_PHOTO_SETTINGS)
    expect(stage.enabled).toBe(false)
  })

  it('grades the night on its own, with the knobs at neutral', () => {
    const { effect, stage } = gradeHarness()
    effect.setSettings(DEFAULT_PHOTO_SETTINGS)
    effect.setNightLevel(1)
    expect(effect.enabled).toBe(true)
    expect(stage.uniforms.u_contrast).toBe(NIGHT_GRADE.contrast)
    expect(stage.uniforms.u_saturation).toBe(NIGHT_GRADE.saturation)
    // The rest of the grade stays as rendered
    expect(stage.uniforms.u_exposure).toBe(1)
    expect(stage.uniforms.u_vignette).toBe(0)
    // Halfway along the ramp, halfway there; by day the pass is off again
    effect.setNightLevel(0.5)
    expect(stage.uniforms.u_contrast).toBeCloseTo(1 + (NIGHT_GRADE.contrast - 1) / 2)
    expect(stage.uniforms.u_saturation).toBeCloseTo(1 + (NIGHT_GRADE.saturation - 1) / 2)
    effect.setNightLevel(0)
    expect(effect.enabled).toBe(false)
  })

  it('lays the knobs over the night grade, in whichever order they come', () => {
    const { effect, stage } = gradeHarness()
    effect.setNightLevel(1)
    effect.setSettings({ ...DEFAULT_PHOTO_SETTINGS, contrast: 1.2, saturation: 0.5 })
    expect(stage.uniforms.u_contrast).toBeCloseTo(1.2 * NIGHT_GRADE.contrast)
    expect(stage.uniforms.u_saturation).toBeCloseTo(0.5 * NIGHT_GRADE.saturation)
    // Knobs back at neutral at night: the pass stays on for the night's grade
    effect.setSettings(DEFAULT_PHOTO_SETTINGS)
    expect(effect.enabled).toBe(true)
    expect(stage.uniforms.u_contrast).toBe(NIGHT_GRADE.contrast)
  })
})
