import { Cartesian3, TextureUniform, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cityBySlug } from '@/cities'
import {
  CLOUD_BASE_M,
  CLOUD_SHADOW_UNIFORMS,
  CloudLayer,
  cloudLight,
  cloudShadowStrength,
  cloudVeil,
} from '@/map/CloudLayer'
import type { FrameState } from '@/map/cesium-renderer'

let clockMs = 0

beforeEach(() => {
  clockMs = 10_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const rostock = cityBySlug('rostock')!
/** Straight up over the city – the sun at its highest. */
const zenith = Cartesian3.normalize(
  Cartesian3.fromDegrees(rostock.home.longitude, rostock.home.latitude),
  new Cartesian3(),
)

/**
 * Real layer on a fake viewer. Nothing here needs a GL context: the
 * fields, the slab's frame, the drift and the shadow uniforms are plain
 * arithmetic, and the layer only reaches for the renderer once a frame
 * has to show a cloud – which these tests keep out of view by pointing
 * the camera at the ground from below the cloud base.
 */
function layerHarness(
  options: { cameraHeight?: number; skyInView?: boolean; enabled?: boolean } = {},
) {
  const primitives: unknown[] = []
  const camera = {
    positionCartographic: { height: options.cameraHeight ?? 40 + 200 },
    // A 0.5 rad vertical field of view on an 800 px canvas: 1566 px per
    // meter at one meter, so the motion threshold can be reasoned about
    frustum: { fovy: 0.5 },
  }
  const viewer = {
    scene: { primitives: { add: (p: unknown) => primitives.push(p) }, canvas: { clientHeight: 800 } },
    camera,
  } as unknown as Viewer
  const requestRender = vi.fn()
  const setUniform = vi.fn()
  /** Whether the sky is in the frame – flipped by a test mid-way. */
  const view = { skyInView: options.skyInView ?? false }
  const host = {
    requestRender,
    groundHeight: 40,
    sunDirection: zenith as Cartesian3 | null,
    overcast: 0,
    horizonMayBeInView: () => view.skyInView,
    pixelRatio: 1,
  }
  const layer = new CloudLayer(viewer, host, rostock, options.enabled ?? true)
  const frameState = (): FrameState => ({
    context: {
      webgl2: true,
      instancedArrays: true,
      createPickId: () => {
        throw new Error('no GL context in this test')
      },
    },
    commandList: [],
    passes: { render: true },
  })
  /** One rendered frame, `ms` after the last. */
  const frame = (ms: number) => {
    clockMs += ms
    const state = frameState()
    layer.update(state)
    layer.markRendered()
    return state.commandList
  }
  /** Last value pushed for a tile-shader uniform. */
  const uniform = (name: string) => {
    const call = [...setUniform.mock.calls].reverse().find((c) => c[0] === name)
    return call?.[1]
  }
  return { layer, host, view, camera, primitives, requestRender, setUniform, frame, uniform }
}

describe('CloudLayer', () => {
  it('joins the scene and draws nothing under a clear sky', () => {
    const { layer, primitives, frame } = layerHarness()
    expect(primitives).toEqual([layer])
    expect(frame(16)).toEqual([])
    expect(layer.state.drawn).toBe(false)
    expect(layer.state.coverPercent).toBe(0)
  })

  it('builds its fields at the first cover and hands the coverage to the tile shader', () => {
    const { layer, setUniform, uniform } = layerHarness()
    layer.attachTileShader({ setUniform } as never)
    // Without clouds the shadow is off and there is no field to hand over
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBe(0)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.coverage)).toBeUndefined()

    layer.setCloudCover(60)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.coverage)).toBeInstanceOf(TextureUniform)
  })

  it('starts another city with an empty sky and fades the cover back in there', () => {
    const { layer, frame } = layerHarness()
    layer.setCloudCover(50)
    frame(6100)
    expect(layer.state.coverApplied).toBe(50)
    // The map arrives over Hamburg: the sky it brought along is not
    // Hamburg's, and the clouds come in over the six seconds again
    layer.setCity(cityBySlug('hamburg')!)
    expect(layer.state.coverApplied).toBe(0)
    frame(3000)
    expect(layer.state.coverApplied).toBeCloseTo(25, 5)
    frame(3100)
    expect(layer.state.coverApplied).toBe(50)
  })

  it('clears the sky of the city being left within a second', () => {
    const { layer, frame } = layerHarness()
    layer.setCloudCover(80)
    frame(6100)
    expect(layer.state.coverApplied).toBe(80)

    // The picker sends the camera elsewhere. The app lets the live
    // weather of the city being left go in the same breath, and that push
    // lands first – the departure has to take the fade over anyway.
    layer.setCloudCover(0)
    layer.clearForDeparture()
    frame(500)
    expect(layer.state.coverApplied).toBeCloseTo(40, 5)
    frame(500)
    expect(layer.state.coverApplied).toBe(0)

    // The next city fades in at the weather's own pace again
    layer.setCity(cityBySlug('hamburg')!)
    layer.setCloudCover(60)
    frame(3000)
    expect(layer.state.coverApplied).toBeCloseTo(30, 5)
  })

  it('eases the cover in over six seconds of wall clock, however many frames that takes', () => {
    const { layer, frame, requestRender } = layerHarness()
    layer.setCloudCover(50)
    expect(requestRender).toHaveBeenCalled()
    requestRender.mockClear()

    frame(100)
    const first = layer.state.coverApplied
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(5)
    // Still fading: the layer keeps the frames coming
    expect(requestRender).toHaveBeenCalled()
    // A frame that arrives late lands where the clock says, rather than
    // taking a step of its own: the ray march makes these frames slow,
    // and a step-per-frame ease would stretch the fade to the frame rate
    frame(2900)
    expect(layer.state.coverApplied).toBeCloseTo(25, 5)

    // Six seconds in, whatever the frames did in between
    frame(3100)
    expect(layer.state.coverApplied).toBe(50)
    requestRender.mockClear()
    frame(100)
    // Settled: nothing more to ask for
    expect(requestRender).not.toHaveBeenCalled()
  })

  it('lands on the target in a handful of frames on a slow renderer', () => {
    // What CI does under SwiftShader: seconds per frame. The fade is over
    // in six seconds of wall clock, so it takes the frames it takes.
    const { layer, frame } = layerHarness()
    layer.setCloudCover(100)
    frame(2300)
    frame(2300)
    expect(layer.state.coverApplied).toBeGreaterThan(70)
    frame(2300)
    expect(layer.state.coverApplied).toBe(100)
  })

  it('cuts the coverage field lower as the cover rises', () => {
    const { layer, frame } = layerHarness()
    expect(layer.state.threshold).toBeGreaterThan(1)
    layer.setCloudCover(30)
    for (let i = 0; i < 80; i++) frame(100)
    const thirty = layer.state.threshold
    expect(thirty).toBeLessThan(1)
    layer.setCloudCover(90)
    for (let i = 0; i < 80; i++) frame(100)
    expect(layer.state.threshold).toBeLessThan(thirty)
  })

  it('shadows the streets while the sun is up, not at night or underground', () => {
    const { layer, host, setUniform, uniform, frame } = layerHarness()
    layer.attachTileShader({ setUniform } as never)
    layer.setCloudCover(70)
    for (let i = 0; i < 80; i++) frame(100)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBeCloseTo(1, 5)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.threshold)).toBe(layer.state.threshold)

    // A closed sky throws a fainter shadow – the light is diffuse
    host.overcast = 0.5
    frame(100)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBeCloseTo(0.7, 5)
    host.overcast = 0

    // Sun below the horizon: no shadow to throw
    host.sunDirection = Cartesian3.negate(zenith, new Cartesian3())
    frame(100)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBe(0)
    host.sunDirection = zenith
    frame(100)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBeCloseTo(1, 5)

    layer.setUnderground(true)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBe(0)
    layer.setUnderground(false)
    frame(100)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBeCloseTo(1, 5)
  })

  it('goes dark at once when switched off, and comes back as the sky is', () => {
    // Frames with the sky out of view: the shadow is pushed without a
    // cloud being drawn (drawing would need a GL context)
    const { layer, view, setUniform, uniform, frame, requestRender } = layerHarness()
    layer.attachTileShader({ setUniform } as never)
    layer.setCloudCover(70)
    for (let i = 0; i < 80; i++) frame(100)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBeCloseTo(1, 5)
    expect(layer.state.enabled).toBe(true)

    view.skyInView = true
    layer.setEnabled(false)
    // The shadow is gone with the switch, no fade – and no frames for the drift
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBe(0)
    expect(layer.state.enabled).toBe(false)
    expect(layer.state.drawn).toBe(false)
    layer.setWind(10, 270)
    requestRender.mockClear()
    layer.advance(0)
    layer.advance(60_000)
    expect(requestRender).not.toHaveBeenCalled()
    // The cover was tracked all along: switching on shows it without a fade
    expect(layer.state.coverApplied).toBe(70)

    layer.setEnabled(true)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBeCloseTo(1, 5)
    expect(requestRender).toHaveBeenCalled()
  })

  it('drifts with the wind on the simulated clock', () => {
    const { layer } = layerHarness()
    layer.setCloudCover(50)
    // A westerly: the clouds go east, at cloud level faster than at 10 m
    layer.setWind(5, 270)
    layer.advance(1_000_000)
    expect(layer.state.driftMeters).toEqual({ east: 0, north: 0 })
    layer.advance(1_010_000)
    expect(layer.state.driftMeters.east).toBeCloseTo(90, 6)
    expect(layer.state.driftMeters.north).toBeCloseTo(0, 6)
    // Time standing still or running backwards moves nothing
    layer.advance(1_010_000)
    layer.advance(900_000)
    expect(layer.state.driftMeters.east).toBeCloseTo(90, 6)
    // …and the clock picks up again from where it was set to
    layer.advance(901_000)
    expect(layer.state.driftMeters.east).toBeCloseTo(99, 6)
  })

  it('asks for a frame once the drift adds up to a visible step on screen', () => {
    const { layer, requestRender } = layerHarness({ skyInView: true })
    layer.setCloudCover(50)
    requestRender.mockClear()
    // 0.018 m/s at cloud level; the nearest cloud is 900 m up, where a
    // meter is 1.74 CSS px – half a pixel is about 0.29 m, 16 s of drift
    layer.setWind(0.01, 270)
    layer.advance(0)
    layer.advance(1000)
    expect(requestRender).not.toHaveBeenCalled()
    layer.advance(20_000)
    expect(requestRender).toHaveBeenCalledTimes(1)
    // Drawn: the motion counts from here
    layer.markRendered()
    layer.advance(21_000)
    expect(requestRender).toHaveBeenCalledTimes(1)
  })

  it('tells the pacing how fast its drift moves on screen at the clock speed, nothing unseen', () => {
    const { layer } = layerHarness({ skyInView: true })
    layer.setCloudCover(50)
    // A westerly of 5 m/s: 9 m/s at cloud level, 900 m up where a metre is 1.74 px
    layer.setWind(5, 270)
    expect(layer.screenMotionPxPerSecond(1)).toBeCloseTo(9 * 1.74, 0)
    // Sixty times as fast under the time-lapse
    expect(layer.screenMotionPxPerSecond(60)).toBeCloseTo(60 * 9 * 1.74, -1)
    // A clock standing still moves nothing
    expect(layer.screenMotionPxPerSecond(0)).toBe(0)
    // …and neither does a sky out of the frame
    const below = layerHarness({ skyInView: false })
    below.layer.setCloudCover(50)
    below.layer.setWind(5, 270)
    expect(below.layer.screenMotionPxPerSecond(60)).toBe(0)
  })

  it('does not ask for frames for clouds nobody can see', () => {
    // Below the base with the camera on the ground: the sky is out of frame
    const below = layerHarness({ skyInView: false })
    below.layer.setCloudCover(50)
    below.layer.setWind(10, 270)
    below.requestRender.mockClear()
    below.layer.advance(0)
    below.layer.advance(60_000)
    expect(below.requestRender).not.toHaveBeenCalled()

    // Underground there is no sky at all
    const under = layerHarness({ cameraHeight: 40 + CLOUD_BASE_M + 3000 })
    under.layer.setCloudCover(50)
    under.layer.setWind(10, 270)
    under.layer.setUnderground(true)
    under.requestRender.mockClear()
    under.layer.advance(0)
    under.layer.advance(60_000)
    expect(under.requestRender).not.toHaveBeenCalled()
  })

  it('starts in the position the switch is built with', () => {
    const { layer, setUniform, uniform } = layerHarness({ enabled: false })
    layer.attachTileShader({ setUniform } as never)
    layer.setCloudCover(80)
    expect(layer.state.enabled).toBe(false)
    expect(layer.state.drawn).toBe(false)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBe(0)
  })

  it('does no work at all while switched off, and catches up when switched on', () => {
    const { layer, view, setUniform, uniform, frame, requestRender } = layerHarness({
      enabled: false,
    })
    layer.attachTileShader({ setUniform } as never)
    requestRender.mockClear()
    // A closed sky arrives: remembered, but no fields, no fade, no frames
    layer.setCloudCover(90)
    expect(requestRender).not.toHaveBeenCalled()
    expect(uniform(CLOUD_SHADOW_UNIFORMS.coverage)).toBeUndefined()
    for (let i = 0; i < 20; i++) frame(100)
    expect(layer.state.coverApplied).toBe(0)
    expect(requestRender).not.toHaveBeenCalled()
    // …and the wind moves nothing anyone would have to see
    view.skyInView = true
    layer.setWind(10, 270)
    layer.advance(0)
    layer.advance(60_000)
    expect(requestRender).not.toHaveBeenCalled()

    // Switched on: the fields are built now, the cover fades in from here
    layer.setEnabled(true)
    expect(requestRender).toHaveBeenCalled()
    expect(uniform(CLOUD_SHADOW_UNIFORMS.coverage)).toBeInstanceOf(TextureUniform)
    view.skyInView = false
    frame(100)
    expect(layer.state.coverApplied).toBeGreaterThan(0)
    expect(layer.state.coverApplied).toBeLessThan(90)
    for (let i = 0; i < 80; i++) frame(100)
    expect(layer.state.coverApplied).toBe(90)
    expect(uniform(CLOUD_SHADOW_UNIFORMS.strength)).toBeCloseTo(1, 5)
  })

  it('survives being destroyed twice – Cesium and the map both let go of it', () => {
    const { layer } = layerHarness()
    layer.destroy()
    layer.destroy()
    expect(layer.isDestroyed()).toBe(true)
    expect(layer.state.drawn).toBe(false)
  })
})

describe('cloud lighting', () => {
  it('lights the tops white by day and lets them go dark at night', () => {
    const day = cloudLight(0.6, 0)
    // Sun and sky add up to about white on a lit top – and not past it,
    // or every top clips to the same flat white
    expect(day.sun.x + day.ambient.x).toBeGreaterThan(0.9)
    expect(day.sun.x + day.ambient.x).toBeLessThan(1.3)
    expect(day.sun.x).toBeGreaterThan(0.5)
    expect(day.ambient.z).toBeGreaterThan(day.ambient.x)
    const night = cloudLight(-0.3, 0)
    expect(night.sun.x).toBe(0)
    expect(night.ambient.x).toBeLessThan(0.1)
  })

  it('turns the sun warm at the golden hour', () => {
    const golden = cloudLight(0.03, 0)
    expect(golden.sun.x).toBeGreaterThan(golden.sun.z * 1.5)
  })

  it('flattens the light under a closed sky', () => {
    const clear = cloudLight(0.6, 0)
    const overcast = cloudLight(0.6, 1)
    expect(overcast.sun.x).toBeLessThan(clear.sun.x * 0.5)
    expect(overcast.ambient.x).toBeLessThan(clear.ambient.x)
  })
})

describe('cloud shadow strength', () => {
  it('needs the sun a few degrees up', () => {
    expect(cloudShadowStrength(-0.1, 0)).toBe(0)
    expect(cloudShadowStrength(0.02, 0)).toBe(0)
    expect(cloudShadowStrength(0.1, 0)).toBeGreaterThan(0)
    expect(cloudShadowStrength(0.1, 0)).toBeLessThan(1)
    expect(cloudShadowStrength(0.5, 0)).toBe(1)
  })

  it('fades under a closed sky', () => {
    expect(cloudShadowStrength(0.5, 1)).toBeCloseTo(0.4, 6)
  })
})

describe('the veil far above the clouds', () => {
  it('draws the clouds in full up close and thins them from high up', () => {
    // Below and just above the tops: the real thing
    expect(cloudVeil(-2000)).toBe(1)
    expect(cloudVeil(500)).toBe(1)
    // The home view sits kilometers above the tops: a veil, never nothing
    // (how thin a veil is the maintainer's tuning – see VEIL_DENSITY)
    const high = cloudVeil(4000)
    expect(high).toBeLessThan(1)
    expect(high).toBeGreaterThan(0.2)
    expect(cloudVeil(20_000)).toBe(high)
    // …and it thins smoothly on the way up
    expect(cloudVeil(1500)).toBeLessThan(1)
    expect(cloudVeil(1500)).toBeGreaterThan(cloudVeil(2500))
  })
})
