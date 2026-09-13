import { Cartesian3, Cartographic, Intersect, Matrix4, type Model, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import type { BuoyData } from '@/data/buoys'
import { BODY_RANGE_M, BUOY_MODELS, BuoysLayer } from '@/map/BuoysLayer'

/**
 * The buoys on the water (src/map/BuoysLayer.ts): built per cell as the
 * camera comes near and hidden again as it leaves, set down on the
 * tiles by rationed clamps that are made again when the tiles change,
 * on the fallback surface until then, their own models off the pick,
 * and the lanterns lit along the night.
 */

const FALLBACK = 37.75

function data(buoys: BuoyData['buoys']): BuoyData {
  return { meta: { attribution: '© OpenStreetMap contributors' }, buoys }
}

/** A cluster of marks in the Warnow (12.09–12.10 E, 54.17–54.18 N) and a lone one 8 km south. */
const WARNOW: BuoyData['buoys'] = [
  [12.09, 54.17, 'red', 'can', null, null, null],
  [12.092, 54.171, 'green', 'conical', null, null, null],
  [12.094, 54.172, 'green', 'pillar', 'green', 'Fl', 4],
  [12.096, 54.173, 'red', 'pillar', 'red', 'Q', null],
  [12.098, 54.174, 'yellow', 'spar', 'yellow', 'Fl', 5],
  [12.1, 54.175, 'yellow', 'barrel', null, null, null],
  [12.102, 54.176, 'red', 'spherical', null, null, null],
]
const FAR_SOUTH: BuoyData['buoys'][number] = [12.1, 54.1, 'red', 'spar', null, null, null]

function harness(options: {
  camera: [number, number, number]
  clamp?: (lon: number, lat: number) => number | undefined
  night?: number
  visibility?: number | null
  /** Whether a buoy is on screen – everything by default. */
  visible?: boolean
}) {
  let generation = 0
  const added: object[] = []
  const viewer = {
    scene: {
      primitives: {
        add: (primitive: object) => {
          added.push(primitive)
          return primitive
        },
        remove: () => true,
      },
      // The cull test sees everything or nothing, as the option says
    },
    camera: {
      positionWC: Cartesian3.fromDegrees(...options.camera),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: {
        computeCullingVolume: () => ({
          computeVisibility: () => (options.visible === false ? Intersect.OUTSIDE : Intersect.INSIDE),
        }),
      },
    },
    creditDisplay: { addStaticCredit: vi.fn(), removeStaticCredit: vi.fn() },
    isDestroyed: () => false,
  } as unknown as Viewer
  const clamp = vi.fn(options.clamp ?? (() => undefined))
  const loads: { url: string; model: Model }[] = []
  const requestRender = vi.fn()
  /** What the last pick was told to look past. */
  let lastExclude: object[] = []
  const host = {
    requestRender,
    waterSurfaceHeight: FALLBACK,
    clampToSurface: (lon: number, lat: number, exclude: object[]) => {
      lastExclude = [...exclude]
      return clamp(lon, lat)
    },
    surfaceGeneration: () => generation,
    nightFactor: options.night ?? 0,
    visibilityM: options.visibility ?? null,
    loadModel: (url: string, modelMatrix: Matrix4) => {
      const model = { modelMatrix: Matrix4.clone(modelMatrix), destroy: vi.fn(), show: true } as unknown as Model
      loads.push({ url, model })
      return Promise.resolve(model)
    },
  }
  const layer = new BuoysLayer(viewer, host)
  return {
    layer,
    host,
    clamp,
    loads,
    requestRender,
    bumpGeneration: () => generation++,
    lastExclude: () => lastExclude,
    /** The model's ellipsoid height, as its matrix places it. */
    heightOf: (index: number) =>
      Cartographic.fromCartesian(Matrix4.getTranslation(loads[index].model.modelMatrix, new Cartesian3())).height,
    /** Every load has settled. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

describe('the buoys come and go with the camera', () => {
  it('builds the cells within range of the camera and none further out', async () => {
    const h = harness({ camera: [12.095, 54.172, 500] })
    h.layer.add(data([...WARNOW, FAR_SOUTH]))
    expect(h.layer.info).toMatchObject({ buoys: 8, built: 0, shown: 0, lit: 3 })
    h.layer.sync()
    await h.settle()
    // The seven in the Warnow, not the one 8 km south
    expect(h.loads).toHaveLength(7)
    expect(h.loads.map((l) => l.url)).toContain('/models/buoy-pillar-green.glb')
    expect(h.loads.map((l) => l.url)).toContain('/models/buoy-spherical-red.glb')
    expect(h.layer.info).toMatchObject({ built: 7, shown: 7 })
  })

  it('loads nothing while the camera stands over the city centre, and hides a cell it leaves', async () => {
    const far = harness({ camera: [12.13, 54.09, 6000] })
    far.layer.add(data(WARNOW))
    far.layer.sync()
    await far.settle()
    expect(far.loads).toHaveLength(0)
    expect(Cartesian3.distance(Cartesian3.fromDegrees(12.13, 54.09, 6000), Cartesian3.fromDegrees(12.095, 54.172, 0))).toBeGreaterThan(BODY_RANGE_M)

    const near = harness({ camera: [12.095, 54.172, 500] })
    near.layer.add(data(WARNOW))
    near.layer.sync()
    await near.settle()
    expect(near.layer.info.shown).toBe(7)
    // The camera flies off: the cell is hidden, its models kept for the way back
    ;(near.layer as unknown as { viewer: { camera: { positionWC: Cartesian3 } } }).viewer.camera.positionWC =
      Cartesian3.fromDegrees(12.13, 54.09, 6000)
    near.layer.sync()
    expect(near.layer.info).toMatchObject({ built: 7, shown: 0 })
    expect(near.loads).toHaveLength(7)
  })
})

describe('the buoys float on the tiles', () => {
  it('ride the fallback surface until a pick answers, then the water plus the lift', async () => {
    let answer: number | undefined
    const h = harness({ camera: [12.095, 54.172, 500], clamp: () => answer })
    h.layer.add(data(WARNOW.slice(0, 2)))
    h.layer.sync()
    await h.settle()
    expect(h.heightOf(0)).toBeCloseTo(FALLBACK + 0.25, 3)
    expect(h.layer.info.clamped).toBe(0)
    // The tiles come in: the pick is asked again every tick until it answers
    answer = 39.1
    h.layer.sync()
    expect(h.layer.info.clamped).toBe(2)
    expect(h.heightOf(0)).toBeCloseTo(39.1 + 0.25, 3)
    expect(h.heightOf(1)).toBeCloseTo(39.1 + 0.25, 3)
    // At rest on the same tiles: no further pick; a load cycle: picked again
    const picks = h.clamp.mock.calls.length
    h.layer.sync()
    expect(h.clamp).toHaveBeenCalledTimes(picks)
    h.bumpGeneration()
    h.layer.sync()
    expect(h.clamp).toHaveBeenCalledTimes(picks + 2)
    // The models built and the lanterns are off the pick, or a buoy would
    // be set on its own top – the lanterns as their collection, which the
    // map expands to the points (see clamp-exclusions.ts)
    for (const load of h.loads) expect(h.lastExclude()).toContain(load.model)
    const lanterns = (h.layer as unknown as { lights: object }).lights
    expect(h.lastExclude()).toContain(lanterns)
    expect(h.lastExclude().length).toBe(h.loads.length + 1)
  })

  it('clamps only the marks near the camera – a far one keeps its height, or the fallback', () => {
    // Two cells within the body range, one of them past the clamp range
    const h = harness({ camera: [12.095, 54.172, 300], clamp: () => 39 })
    h.layer.add(
      data([
        [12.095, 54.172, 'red', 'can', null, null, null],
        // 2.4 km north: drawn, not clamped
        [12.095, 54.1935, 'green', 'conical', null, null, null],
      ]),
    )
    h.layer.sync()
    expect(h.clamp).toHaveBeenCalledTimes(1)
    expect(h.layer.info).toMatchObject({ clamped: 1 })
    expect(h.layer.info.heightSpanM).toBe(0)
  })

  it('rations the picks per tick, to buoys on screen, and asks a pick that failed again', () => {
    const h = harness({ camera: [12.095, 54.172, 500], clamp: () => 39 })
    h.layer.add(data(WARNOW))
    h.layer.sync()
    // Six a tick, the seventh the tick after
    expect(h.clamp).toHaveBeenCalledTimes(6)
    h.layer.sync()
    expect(h.clamp).toHaveBeenCalledTimes(7)
    expect(h.layer.info.clamped).toBe(7)

    const off = harness({ camera: [12.095, 54.172, 500], clamp: () => 39, visible: false })
    off.layer.add(data(WARNOW))
    off.layer.sync()
    expect(off.clamp).not.toHaveBeenCalled()

    // No tiles under it yet: asked again every tick, never written off –
    // and once answered, left alone until the tiles change
    let answer: number | undefined
    const later = harness({ camera: [12.095, 54.172, 500], clamp: () => answer })
    later.layer.add(data(WARNOW.slice(0, 1)))
    later.layer.sync()
    later.layer.sync()
    expect(later.clamp).toHaveBeenCalledTimes(2)
    answer = 38
    later.layer.sync()
    expect(later.layer.info.clamped).toBe(1)
    later.layer.sync()
    expect(later.clamp).toHaveBeenCalledTimes(3)
  })

  it('costs nothing offline – no pick, the fallback for good', () => {
    const h = harness({ camera: [12.095, 54.172, 500] })
    delete (h.host as { clampToSurface?: unknown }).clampToSurface
    h.layer.add(data(WARNOW))
    h.layer.sync()
    expect(h.clamp).not.toHaveBeenCalled()
    expect(h.layer.info.clamped).toBe(0)
  })
})

describe('the lanterns', () => {
  it('sit at the shape’s lantern height over the water, moving with the clamp', () => {
    let answer: number | undefined
    const h = harness({ camera: [12.095, 54.172, 500], clamp: () => answer })
    h.layer.add(data([WARNOW[2]]))
    const lights = (
      h.layer as unknown as {
        lights: { get(i: number): { position: Cartesian3; disableDepthTestDistance: number }; length: number }
      }
    ).lights
    expect(lights.length).toBe(1)
    expect(Cartographic.fromCartesian(lights.get(0).position).height).toBeCloseTo(
      FALLBACK + 0.25 + BUOY_MODELS.pillar.lightHeight,
      3,
    )
    // Inside its housing, so up close it is drawn through it – the glow
    expect(lights.get(0).disableDepthTestDistance).toBeGreaterThan(100)
    expect(lights.get(0).disableDepthTestDistance).toBeLessThan(5000)
    // Full from the quay, faint from high up: the strength falls with the camera's distance
    const fade = (lights.get(0) as unknown as { translucencyByDistance: { near: number; nearValue: number; far: number; farValue: number } })
      .translucencyByDistance
    expect(fade.nearValue).toBe(1)
    expect(fade.near).toBeLessThan(3000)
    expect(fade.far).toBeGreaterThan(8000)
    expect(fade.farValue).toBeGreaterThan(0)
    expect(fade.farValue).toBeLessThan(0.5)
    answer = 39
    h.layer.sync()
    expect(Cartographic.fromCartesian(lights.get(0).position).height).toBeCloseTo(39.25 + BUOY_MODELS.pillar.lightHeight, 3)
  })

  it('burn along the night ramp and in poor visibility by day, and go out underground', () => {
    const lights = (layer: BuoysLayer) =>
      (layer as unknown as { lights: { show: boolean; get(i: number): { color: { alpha: number } } } }).lights
    const day = harness({ camera: [12.095, 54.172, 500], night: 0 })
    day.layer.add(data(WARNOW))
    day.layer.update()
    expect(lights(day.layer).show).toBe(false)
    expect(day.layer.info.lightAlpha).toBe(0)

    const night = harness({ camera: [12.095, 54.172, 500], night: 1 })
    night.layer.add(data(WARNOW))
    night.layer.update()
    expect(lights(night.layer).show).toBe(true)
    expect(night.layer.info.lightAlpha).toBe(1)
    expect(lights(night.layer).get(0).color.alpha).toBe(1)
    night.layer.setUnderground(true)
    night.layer.update()
    expect(night.layer.info.lightAlpha).toBe(0)
    night.layer.setUnderground(false)
    night.layer.update()
    expect(night.layer.info.lightAlpha).toBe(1)

    const fog = harness({ camera: [12.095, 54.172, 500], night: 0, visibility: 2000 })
    fog.layer.add(data(WARNOW))
    fog.layer.update()
    expect(fog.layer.info.lightAlpha).toBe(1)
  })

  it('are none where no buoy has one', () => {
    const h = harness({ camera: [12.095, 54.172, 500], night: 1 })
    h.layer.add(data([WARNOW[0], WARNOW[1]]))
    h.layer.update()
    expect(h.layer.info).toMatchObject({ lit: 0, lightAlpha: 0 })
  })
})

describe('the city moves on', () => {
  it('takes every model and lantern down with clear, and the credit', async () => {
    const h = harness({ camera: [12.095, 54.172, 500], clamp: () => 39 })
    h.layer.add(data(WARNOW))
    h.layer.sync()
    await h.settle()
    expect(h.layer.info.built).toBe(7)
    h.layer.clear()
    expect(h.layer.info).toMatchObject({ buoys: 0, built: 0, shown: 0, clamped: 0, lit: 0 })
    for (const load of h.loads) expect(load.model.destroy).toHaveBeenCalled()
    expect((h.layer as unknown as { viewer: Viewer }).viewer.creditDisplay.removeStaticCredit).toHaveBeenCalled()
  })
})
