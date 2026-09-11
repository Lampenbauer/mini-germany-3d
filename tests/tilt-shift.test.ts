import { Math as CesiumMath, type PostProcessStage, type Viewer } from 'cesium'
import { describe, expect, it } from 'vitest'
import { TiltShiftEffect, tiltShiftStrength } from '@/map/TiltShiftEffect'
import { DEFAULT_TILT_SHIFT_SETTINGS } from '@/lib/photo-settings'

/** A pose the effect is meant for: a few hundred meters up, looking down. */
const oblique = { pitchDeg: -45, heightMeters: 900 }

describe('tilt-shift strength', () => {
  it('runs at full strength on an oblique view from above the roofs', () => {
    expect(tiltShiftStrength(oblique)).toBe(1)
  })

  it('is off at street level and fades in over the first few meters', () => {
    expect(tiltShiftStrength({ ...oblique, heightMeters: 2 })).toBe(0)
    expect(tiltShiftStrength({ ...oblique, heightMeters: 4 })).toBe(0)
    const midway = tiltShiftStrength({ ...oblique, heightMeters: 12 })
    expect(midway).toBeGreaterThan(0.4)
    expect(midway).toBeLessThan(0.6)
    expect(tiltShiftStrength({ ...oblique, heightMeters: 20 })).toBe(1)
  })

  it('holds up at the close-in heights a few blocks are looked at from', () => {
    // A view of a neighborhood from ~100–300 m is where the houses read
    // most like a model kit – the effect has to be at full strength there.
    for (const heightMeters of [100, 150, 300]) {
      expect(tiltShiftStrength({ ...oblique, heightMeters })).toBe(1)
    }
  })

  it('fades out as the view tips towards straight down', () => {
    // A horizontal sharp band only matches a view that still has a
    // foreground and a background – looking down it has neither.
    expect(tiltShiftStrength({ ...oblique, pitchDeg: -55 })).toBe(1)
    expect(tiltShiftStrength({ ...oblique, pitchDeg: -90 })).toBe(0)
    const tipping = tiltShiftStrength({ ...oblique, pitchDeg: -70 })
    expect(tipping).toBeGreaterThan(0)
    expect(tipping).toBeLessThan(1)
  })

  it('keeps the effect on for a view that looks up at the horizon', () => {
    expect(tiltShiftStrength({ ...oblique, pitchDeg: 5 })).toBe(1)
  })

  it('multiplies both ramps instead of letting either one win', () => {
    // Halfway up and halfway tipped over: neither ramp alone would take
    // the effect this far down.
    const both = tiltShiftStrength({ pitchDeg: -72.5, heightMeters: 12 })
    expect(both).toBeGreaterThan(0.2)
    expect(both).toBeLessThan(0.3)
  })

  it('stays inside 0…1 for poses far outside the ramps', () => {
    for (const view of [
      { pitchDeg: -90, heightMeters: -50 },
      { pitchDeg: 90, heightMeters: 25_000 },
      { pitchDeg: -180, heightMeters: 1e6 },
    ]) {
      const strength = tiltShiftStrength(view)
      expect(strength).toBeGreaterThanOrEqual(0)
      expect(strength).toBeLessThanOrEqual(1)
    }
  })
})

/**
 * Real effect on a fake viewer: everything it touches at construction
 * time is plain object graph, so the stages – Cesium's own classes – can
 * be inspected without a GL context.
 */
function effectHarness(groundHeight = 0) {
  const camera = { pitch: CesiumMath.toRadians(-45), positionCartographic: { height: 900 } }
  const added: { name: string; enabled: boolean; get(i: number): PostProcessStage }[] = []
  const viewer = {
    camera,
    scene: { postProcessStages: { add: (s: (typeof added)[number]) => added.push(s) } },
  } as unknown as Viewer
  const effect = new TiltShiftEffect(viewer, () => groundHeight)
  const composite = added[0]
  // The blur is a composite of its own inside the outer one
  const blur = composite.get(0) as unknown as { get(i: number): PostProcessStage }
  return {
    effect,
    camera,
    composite,
    /** The three passes: blur x, blur y, composite. */
    passes: { blurX: blur.get(0), blurY: blur.get(1), grade: composite.get(1) },
    /** Strength the grading pass would run with. */
    uniformStrength: () => composite.get(1).uniforms.u_strength as number,
  }
}

describe('TiltShiftEffect', () => {
  it('adds its stages switched off', () => {
    const { composite, effect } = effectHarness()
    expect(composite.name).toBe('mg3d_tilt_shift')
    expect(composite.enabled).toBe(false)
    expect(effect.enabled).toBe(false)
  })

  it('pushes the pose strength into the shader once enabled', () => {
    const { effect, composite, uniformStrength } = effectHarness()
    effect.setEnabled(true)
    expect(composite.enabled).toBe(true)
    expect(uniformStrength()).toBe(1)
    expect(effect.strength).toBe(1)
  })

  it('skips the passes at a pose the effect has ramped to zero', () => {
    const { effect, camera, composite, uniformStrength } = effectHarness()
    effect.setEnabled(true)
    // Straight down from just above the roofs – both ramps bottom out
    camera.pitch = CesiumMath.toRadians(-90)
    effect.update()
    expect(uniformStrength()).toBe(0)
    expect(composite.enabled).toBe(false)
  })

  it('measures the camera height above the ground, not above the ellipsoid', () => {
    // Rostock's streets sit ~45 m up in ellipsoidal terms, so a camera at
    // 47 m stands 2 m over the cobbles – below the fade-in, where the
    // ellipsoidal number alone would have cleared it many times over.
    const { effect, camera, uniformStrength } = effectHarness(45)
    camera.positionCartographic.height = 47
    effect.setEnabled(true)
    expect(uniformStrength()).toBe(0)
  })

  it('stops updating while it is switched off', () => {
    const { effect, camera, composite } = effectHarness()
    effect.setEnabled(true)
    effect.setEnabled(false)
    camera.pitch = CesiumMath.toRadians(-30)
    effect.update()
    expect(composite.enabled).toBe(false)
    expect(effect.strength).toBe(0)
  })
})

describe('TiltShiftEffect settings', () => {
  it('opens at the defaults of the photo settings', () => {
    const { passes } = effectHarness()
    const d = DEFAULT_TILT_SHIFT_SETTINGS
    for (const stage of Object.values(passes)) {
      expect(stage.uniforms.u_maxRadius).toBe(d.maxBlurRadius)
      expect(stage.uniforms.u_bandHalfHeight).toBe(d.bandHalfHeight)
      expect(stage.uniforms.u_bandFeather).toBe(d.bandFeather)
      expect(stage.uniforms.u_focusY).toBe(d.focusY)
    }
    expect(passes.blurX.uniforms.u_highlightGain).toBe(d.highlightGain)
    expect(passes.grade.uniforms.u_sharpen).toBe(d.sharpen)
  })

  it('pushes every knob into every pass that reads it', () => {
    const { effect, passes } = effectHarness()
    effect.setSettings({
      enabled: true,
      maxBlurRadius: 0.05,
      bandHalfHeight: 0.1,
      bandFeather: 0.3,
      focusY: 0.6,
      highlightGain: 4,
      sharpen: 0.5,
    })
    expect(effect.enabled).toBe(true)
    // The band is shared by all three – the blur sizes its disc by it,
    // the composite decides where the sharp scene ends by it
    for (const stage of Object.values(passes)) {
      expect(stage.uniforms.u_maxRadius).toBe(0.05)
      expect(stage.uniforms.u_bandHalfHeight).toBe(0.1)
      expect(stage.uniforms.u_bandFeather).toBe(0.3)
      expect(stage.uniforms.u_focusY).toBe(0.6)
    }
    expect(passes.blurX.uniforms.u_highlightGain).toBe(4)
    expect(passes.blurY.uniforms.u_highlightGain).toBe(4)
    expect(passes.grade.uniforms.u_sharpen).toBe(0.5)
  })

  it('never hands the shader a feather of zero', () => {
    // (distance - band) / feather – a zero would be a division by zero
    const { effect, passes } = effectHarness()
    effect.setSettings({ ...DEFAULT_TILT_SHIFT_SETTINGS, bandFeather: 0 })
    expect(passes.grade.uniforms.u_bandFeather as number).toBeGreaterThan(0)
  })

  it('switches the effect on and off through the settings too', () => {
    const { effect, composite } = effectHarness()
    effect.setSettings({ ...DEFAULT_TILT_SHIFT_SETTINGS, enabled: true })
    expect(composite.enabled).toBe(true)
    effect.setSettings({ ...DEFAULT_TILT_SHIFT_SETTINGS, enabled: false })
    expect(composite.enabled).toBe(false)
    expect(effect.enabled).toBe(false)
  })
})
