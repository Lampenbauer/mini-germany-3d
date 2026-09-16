import { Cartesian3, Cartographic, Intersect, type CustomShader, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import type { LighthouseData } from '@/data/lighthouses'
import { BEAM_LENGTH_M, beamDistanceFade, LIGHTHOUSE_BEAM_UNIFORMS, type LighthouseBeams } from '@/map/LighthouseBeams'
import { BEAM_MAX_RATE, BEAM_MIN_FRAME_MS, LighthousesLayer } from '@/map/LighthousesLayer'

/**
 * The lighthouses on the tiles' towers (src/map/LighthousesLayer.ts):
 * set on the top the pick finds, or on OSM's elevation where the mesh
 * lost the mast; shown in the colour of the sector the camera stands
 * in, hidden where no sector reaches; lit along the night – and the
 * rotating optics' beams, turned on the simulated clock, a shaft and a
 * shader slot per lit lens, paced against the screen.
 */

/** The fallback water surface – NHN 0 plus the geoid over Rostock, plus the ships' lift. */
const WATER = 37.75

function data(lights: LighthouseData['lights']): LighthouseData {
  return { meta: { attribution: '© OpenStreetMap contributors' }, lights }
}

/** The Warnemünde lighthouse: white towards the sea, obscured from the land side; Fl(3+1) 24s – four lenses, a turn in 24 s. */
const TOWER: LighthouseData['lights'][number] = [12.0858, 54.1814, 'major', 34, 20, [['white', 62.6, 242.6, 'Fl', 24, '3+1']]]
/** Bastorf (Buk): three lenses in 22 seconds, white to sea and red over the shallows to the west. */
const BUK: LighthouseData['lights'][number] = [11.6937, 54.1319, 'major', 95, 24, [['white', 73, 265, 'LFl', 22, '3'], ['red', 40, 73, 'LFl', 22, '3']]]
/** The west mole light: green all round, 14 m up. */
const MOLE: LighthouseData['lights'][number] = [12.0873, 54.1868, 'minor', 14, 6, [['green', null, null, 'Iso']]]
/** A pier light OSM gives no elevation for. */
const PIER: LighthouseData['lights'][number] = [12.09, 54.19, 'minor', null, null, [['red', null, null, null]]]

function harness(options: {
  camera: [number, number, number]
  clamp?: (lon: number, lat: number) => number | undefined
  night?: number
  visibility?: number | null
}) {
  let generation = 0
  const viewer = {
    scene: { primitives: { add: (p: object) => p, remove: () => true } },
    camera: {
      positionWC: Cartesian3.fromDegrees(...options.camera),
      positionCartographic: Cartographic.fromDegrees(...options.camera),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: { computeCullingVolume: () => ({ computeVisibility: () => Intersect.INSIDE }) },
    },
    creditDisplay: { addStaticCredit: vi.fn(), removeStaticCredit: vi.fn() },
    isDestroyed: () => false,
  } as unknown as Viewer
  const clamp = vi.fn(options.clamp ?? (() => undefined))
  const requestRender = vi.fn()
  const layer = new LighthousesLayer(viewer, {
    requestRender,
    waterSurfaceHeight: WATER,
    clampToSurface: (lon: number, lat: number) => clamp(lon, lat),
    surfaceGeneration: () => generation,
    nightFactor: options.night ?? 0,
    visibilityM: options.visibility ?? null,
  })
  const lights = (layer as unknown as {
    lights: { show: boolean; length: number; get(i: number): { show: boolean; position: Cartesian3; color: { red: number; green: number; blue: number; alpha: number } } }
  }).lights
  const beams = (layer as unknown as { beams: LighthouseBeams }).beams
  return {
    layer,
    clamp,
    lights,
    beams,
    requestRender,
    bumpGeneration: () => generation++,
    moveCamera: (lon: number, lat: number, height: number) => {
      ;(viewer.camera as { positionWC: Cartesian3 }).positionWC = Cartesian3.fromDegrees(lon, lat, height)
      ;(viewer.camera as { positionCartographic: Cartographic }).positionCartographic = Cartographic.fromDegrees(lon, lat, height)
    },
    heightOf: (i: number) => Cartographic.fromCartesian(lights.get(i).position).height,
  }
}

describe('the lights stand on their towers', () => {
  it('start at OSM’s elevation over the water, then take the top the pick finds', () => {
    let answer: number | undefined
    const h = harness({ camera: [12.086, 54.181, 300], clamp: () => answer })
    h.layer.add(data([TOWER, MOLE, PIER]))
    expect(h.heightOf(0)).toBeCloseTo(WATER + 34, 3)
    expect(h.heightOf(1)).toBeCloseTo(WATER + 14, 3)
    // No elevation in OSM: ten metres over the water until the tiles say
    expect(h.heightOf(2)).toBeCloseTo(WATER + 10, 3)
    h.layer.sync()
    h.layer.sync()
    expect(h.layer.info.clamped).toBe(0)
    // Two a tick, none of them answered – and none asked again until the
    // tiles change. They come in: the tower's top is 31 m over the water
    // in the mesh
    expect(h.clamp).toHaveBeenCalledTimes(3)
    answer = WATER + 31
    h.bumpGeneration()
    h.layer.sync()
    h.layer.sync()
    expect(h.layer.info.clamped).toBe(3)
    expect(h.heightOf(0)).toBeCloseTo(WATER + 31 + 0.6, 3)
    // At rest: no further pick; a load cycle: picked again
    const picks = h.clamp.mock.calls.length
    h.layer.sync()
    expect(h.clamp).toHaveBeenCalledTimes(picks)
    h.bumpGeneration()
    h.layer.sync()
    expect(h.clamp).toHaveBeenCalledTimes(picks + 2)
  })

  it('keeps OSM’s elevation where the mesh lost the mast, and rations the picks to two a tick near the camera', () => {
    // The pick lands on the pier, 2 m over the water – the mole's mast is 14 m
    const h = harness({ camera: [12.087, 54.187, 200], clamp: () => WATER + 2 })
    h.layer.add(data([MOLE, PIER, TOWER]))
    h.layer.sync()
    expect(h.clamp).toHaveBeenCalledTimes(2)
    expect(h.heightOf(0)).toBeCloseTo(WATER + 14, 3)
    // No elevation to hold it: the pier light takes the pick
    expect(h.heightOf(1)).toBeCloseTo(WATER + 2 + 0.6, 3)

    // 6 km away: not picked, the elevation stands
    const far = harness({ camera: [12.16, 54.19, 200], clamp: () => WATER + 31 })
    far.layer.add(data([TOWER]))
    far.layer.sync()
    expect(far.clamp).not.toHaveBeenCalled()
    expect(far.layer.info.clamped).toBe(0)
  })
})

describe('the lights show their sector', () => {
  it('are white from the sea, obscured from the land, green all round at the mole', () => {
    // At sea, north of the tower: the bearing to the tower is about 180
    const sea = harness({ camera: [12.0858, 54.19, 100], night: 1 })
    sea.layer.add(data([TOWER, MOLE]))
    sea.layer.update()
    expect(sea.lights.show).toBe(true)
    expect(sea.lights.get(0).show).toBe(true)
    expect(sea.lights.get(0).color.red).toBeCloseTo(1, 3)
    expect(sea.lights.get(0).color.green).toBeCloseTo(1, 3)
    expect(sea.lights.get(1).show).toBe(true)
    expect(sea.lights.get(1).color.green).toBeGreaterThan(0.8)
    expect(sea.lights.get(1).color.red).toBeLessThan(0.3)
    expect(sea.layer.info).toMatchObject({ lights: 2, shown: 2, alpha: 1 })
    // Inland, south of the tower: the bearing is about 0 – no sector
    sea.moveCamera(12.0858, 54.17, 100)
    sea.layer.update()
    expect(sea.lights.get(0).show).toBe(false)
    expect(sea.lights.get(1).show).toBe(true)
    expect(sea.layer.info.shown).toBe(1)
    // Back to the sea: shown again
    sea.moveCamera(12.0858, 54.19, 100)
    sea.layer.update()
    expect(sea.lights.get(0).show).toBe(true)
  })

  it('burn along the night ramp and in poor visibility by day, and go out underground', () => {
    const day = harness({ camera: [12.0858, 54.19, 100], night: 0 })
    day.layer.add(data([TOWER]))
    day.layer.update()
    expect(day.lights.show).toBe(false)
    expect(day.layer.info).toMatchObject({ shown: 0, alpha: 0 })

    const night = harness({ camera: [12.0858, 54.19, 100], night: 1 })
    night.layer.add(data([TOWER]))
    night.layer.update()
    expect(night.layer.info.alpha).toBe(1)
    night.layer.setUnderground(true)
    night.layer.update()
    expect(night.layer.info).toMatchObject({ shown: 0, alpha: 0 })
    night.layer.setUnderground(false)
    night.layer.update()
    expect(night.layer.info.alpha).toBe(1)

    const fog = harness({ camera: [12.0858, 54.19, 100], night: 0, visibility: 2000 })
    fog.layer.add(data([TOWER]))
    fog.layer.update()
    expect(fog.layer.info.alpha).toBe(1)
  })

  it('takes every light down with clear, and the credit', () => {
    const h = harness({ camera: [12.0858, 54.19, 100], night: 1 })
    h.layer.add(data([TOWER, MOLE]))
    h.layer.update()
    h.layer.clear()
    expect(h.layer.info).toMatchObject({ lights: 0, clamped: 0, shown: 0, alpha: 0 })
    expect(h.lights.length).toBe(0)
    expect((h.layer as unknown as { viewer: Viewer }).viewer.creditDisplay.removeStaticCredit).toHaveBeenCalled()
  })
})

describe('the rotating optics turn their beams', () => {
  /** A stand-in for the tiles' CustomShader: the uniforms as last set. */
  function shaderDouble() {
    const uniforms = new Map<string, unknown>()
    const shader = { setUniform: (name: string, value: unknown) => uniforms.set(name, value) } as unknown as CustomShader
    const vec4 = (name: string) => uniforms.get(name) as { x: number; y: number; z: number; w: number }
    return { shader, uniforms, vec4 }
  }

  it('recognise the flashing major lights and turn them on the simulated clock, held by a pause and capped under the time-lapse', () => {
    const h = harness({ camera: [12.0858, 54.19, 300], night: 1 })
    h.layer.add(data([TOWER, BUK, MOLE]))
    expect(h.layer.info.rotating).toBe(2)
    const nowSpy = vi.spyOn(performance, 'now')
    const base = 50_000
    // The first tick sets the clock, the second turns it by the simulated seconds
    nowSpy.mockReturnValue(base)
    h.layer.sync(1_000_000)
    expect(h.layer.info.opticTime).toBe(0)
    nowSpy.mockReturnValue(base + 1_000)
    h.layer.sync(1_000_500)
    expect(h.layer.info.opticTime).toBeCloseTo(0.5, 9)
    // The time-lapse: a simulated minute in a real tenth of a second turns
    // the optic by no more than BEAM_MAX_RATE times the tenth
    nowSpy.mockReturnValue(base + 1_100)
    h.layer.sync(1_060_500)
    expect(h.layer.info.opticTime).toBeCloseTo(0.5 + 0.1 * BEAM_MAX_RATE, 9)
    // Paused: the same simulated instant again turns nothing
    const before = h.layer.info.opticTime
    nowSpy.mockReturnValue(base + 1_200)
    h.layer.sync(1_060_500)
    expect(h.layer.info.opticTime).toBe(before)
    expect(h.layer.sync(1_060_500).beamInView).toBe(false)
    // A test without a clock turns nothing either
    expect(h.layer.sync()).toEqual({ beamInView: false, tickMotionPx: 0 })
    nowSpy.mockRestore()
  })

  it('draw a shaft per lens pointing into a lit sector, in the sector’s colour, and hand the same lenses to the tiles’ shader', () => {
    // A camera over the bay between the two towers, within the beams'
    // reach of both (about 12 and 14 km – on the fade's ramp, see below)
    const h = harness({ camera: [11.9, 54.16, 300], night: 1 })
    const { shader, uniforms, vec4 } = shaderDouble()
    h.layer.attachTileShader(shader)
    h.layer.add(data([TOWER, BUK, MOLE]))
    h.layer.update()
    // The clock at zero: Warnemünde's four lenses stand at 0°, 90°, 180° and
    // 270°, and two point out to sea (north and east) – white; the two over
    // the town are screened. Bastorf's three stand at 0°, 120° and 240°:
    // north is white, 120° (over the land, bearing 300 from seaward) is
    // screened, 240° is red
    expect(h.beams.drawn).toBe(4)
    expect(h.layer.info.beams).toBe(4)
    const first = h.beams.instanceAt(0)
    expect(first.azimuthRad).toBeCloseTo(0, 6)
    expect(first.color).toEqual([1, 1, 1])
    expect(first.lengthM).toBe(BEAM_LENGTH_M)
    // Faded with the camera's distance: full at 10 km, gone at 20, so a
    // tower 12.4 km off shows at about three quarters – shaft and tiles alike
    const cameraPosition = Cartesian3.fromDegrees(11.9, 54.16, 300)
    const toWarnemuende = Cartesian3.distance(cameraPosition, first.anchor)
    expect(toWarnemuende).toBeGreaterThan(10_000)
    expect(toWarnemuende).toBeLessThan(20_000)
    expect(first.intensity).toBeCloseTo(beamDistanceFade(toWarnemuende), 6)
    expect(first.intensity).toBeCloseTo((20_000 - toWarnemuende) / 10_000, 6)
    expect(Cartographic.fromCartesian(first.anchor).height).toBeCloseTo(WATER + 34, 2)
    expect(Math.round((h.beams.instanceAt(1).azimuthRad * 180) / Math.PI)).toBe(270)
    const bukLenses = [h.beams.instanceAt(2), h.beams.instanceAt(3)]
    expect(bukLenses.map((lens) => Math.round((lens.azimuthRad * 180) / Math.PI))).toEqual([0, 240])
    expect(bukLenses[1].color[0]).toBeCloseTo(1, 2)
    expect(bukLenses[1].color[1]).toBeLessThan(0.3)
    // The shader: the night level, and slots 0–3 filled, 4 and up empty –
    // the slot's colour carries the distance fade
    expect(uniforms.get(LIGHTHOUSE_BEAM_UNIFORMS.light)).toBe(1)
    expect(vec4(LIGHTHOUSE_BEAM_UNIFORMS.a(0)).w).toBeCloseTo(0, 6)
    expect(vec4(LIGHTHOUSE_BEAM_UNIFORMS.b(0)).w).toBe(6_000)
    expect(vec4(LIGHTHOUSE_BEAM_UNIFORMS.b(0)).x).toBeCloseTo(first.intensity, 6)
    expect(vec4(LIGHTHOUSE_BEAM_UNIFORMS.b(3)).x).toBeCloseTo(bukLenses[1].intensity, 6)
    expect(uniforms.has(LIGHTHOUSE_BEAM_UNIFORMS.a(4))).toBe(false)
    // Positions in one local east-north-up frame, in metres: the two
    // lanterns stand as far apart in it as on the ground
    const a0 = vec4(LIGHTHOUSE_BEAM_UNIFORMS.a(0))
    const a1 = vec4(LIGHTHOUSE_BEAM_UNIFORMS.a(2))
    const apart = Cartesian3.distance(first.anchor, bukLenses[0].anchor)
    expect(Math.hypot(a1.x - a0.x, a1.y - a0.y)).toBeCloseTo(apart, -1)
    expect(apart).toBeGreaterThan(25_000)
  })

  it('go out by day, underground and with the city, and light nothing from a steady light', () => {
    const day = harness({ camera: [12.0858, 54.19, 300], night: 0 })
    const { shader, uniforms } = shaderDouble()
    day.layer.attachTileShader(shader)
    day.layer.add(data([TOWER]))
    day.layer.update()
    expect(day.beams.drawn).toBe(0)
    expect(uniforms.get(LIGHTHOUSE_BEAM_UNIFORMS.light)).toBe(0)

    const night = harness({ camera: [12.0858, 54.19, 300], night: 1 })
    night.layer.add(data([TOWER, MOLE]))
    night.layer.update()
    expect(night.beams.drawn).toBe(2)
    night.layer.setUnderground(true)
    night.layer.update()
    expect(night.beams.drawn).toBe(0)
    night.layer.setUnderground(false)
    night.layer.update()
    expect(night.beams.drawn).toBe(2)
    night.layer.clear()
    expect(night.beams.drawn).toBe(0)
    expect(night.layer.info.rotating).toBe(0)

    // The distance ramp itself: full to 10 km, gone at 20, and a camera
    // beyond it draws no shaft at all
    expect(beamDistanceFade(3_000)).toBe(1)
    expect(beamDistanceFade(10_000)).toBe(1)
    expect(beamDistanceFade(15_000)).toBeCloseTo(0.5, 9)
    expect(beamDistanceFade(20_000)).toBe(0)
    expect(beamDistanceFade(25_000)).toBe(0)
    const far = harness({ camera: [12.0858, 54.4, 300], night: 1 })
    far.layer.add(data([TOWER]))
    far.layer.update()
    expect(far.beams.drawn).toBe(0)

    // A steady light – the mole's Iso, a tower without a period – turns nothing
    const steady = harness({ camera: [12.0858, 54.19, 300], night: 1 })
    steady.layer.add(data([MOLE, [12.0858, 54.1814, 'major', 34, 20, [['white', 62.6, 242.6, 'Fl', null, null]]]]))
    steady.layer.update()
    expect(steady.layer.info.rotating).toBe(0)
    expect(steady.beams.drawn).toBe(0)
  })

  it('ask for frames while a lit beam turns in view, and report the motion for the ticks capped at their pace', () => {
    const h = harness({ camera: [12.0858, 54.19, 300], night: 1 })
    h.layer.add(data([TOWER]))
    const nowSpy = vi.spyOn(performance, 'now')
    const base = 50_000
    nowSpy.mockReturnValue(base)
    h.layer.sync(0)
    h.requestRender.mockClear()
    // A second of the simulated clock goes by in 400 real ms – under the
    // real-time cap, so the optic turns the whole second, and that is motion
    nowSpy.mockReturnValue(base + 400)
    const paced = h.layer.sync(1_000)
    expect(paced.beamInView).toBe(true)
    expect(paced.tickMotionPx).toBeGreaterThan(0)
    // The frame was asked for, and the motion reported is capped so the
    // loop's tick stays at BEAM_MIN_FRAME_MS or over
    expect(h.requestRender).toHaveBeenCalled()
    expect(paced.tickMotionPx).toBeLessThanOrEqual((0.5 * 400) / BEAM_MIN_FRAME_MS + 1e-9)
    // Right after a frame nothing has moved since it: no request until it does
    h.layer.markRendered()
    h.requestRender.mockClear()
    nowSpy.mockReturnValue(base + 420)
    h.layer.sync(1_000)
    expect(h.requestRender).not.toHaveBeenCalled()
    nowSpy.mockReturnValue(base + 460)
    h.layer.sync(1_040)
    expect(h.requestRender).toHaveBeenCalled()
    nowSpy.mockRestore()
    // By day the beam is no motion at all
    const day = harness({ camera: [12.0858, 54.19, 300], night: 0 })
    day.layer.add(data([TOWER]))
    day.layer.sync(0)
    expect(day.layer.sync(1_000).beamInView).toBe(false)
  })
})
