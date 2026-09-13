import { Cartesian3, Cartographic, Intersect, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import type { LighthouseData } from '@/data/lighthouses'
import { LighthousesLayer } from '@/map/LighthousesLayer'

/**
 * The lighthouses on the tiles' towers (src/map/LighthousesLayer.ts):
 * set on the top the pick finds, or on OSM's elevation where the mesh
 * lost the mast; shown in the colour of the sector the camera stands
 * in, hidden where no sector reaches; lit along the night.
 */

/** The fallback water surface – NHN 0 plus the geoid over Rostock, plus the ships' lift. */
const WATER = 37.75

function data(lights: LighthouseData['lights']): LighthouseData {
  return { meta: { attribution: '© OpenStreetMap contributors' }, lights }
}

/** The Warnemünde lighthouse: white towards the sea, obscured from the land side. */
const TOWER: LighthouseData['lights'][number] = [12.0858, 54.1814, 'major', 34, 20, [['white', 62.6, 242.6, 'Fl']]]
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
  const layer = new LighthousesLayer(viewer, {
    requestRender: () => {},
    waterSurfaceHeight: WATER,
    clampToSurface: (lon: number, lat: number) => clamp(lon, lat),
    surfaceGeneration: () => generation,
    nightFactor: options.night ?? 0,
    visibilityM: options.visibility ?? null,
  })
  const lights = (layer as unknown as {
    lights: { show: boolean; length: number; get(i: number): { show: boolean; position: Cartesian3; color: { red: number; green: number; blue: number; alpha: number } } }
  }).lights
  return {
    layer,
    clamp,
    lights,
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
