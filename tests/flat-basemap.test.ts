import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageryLayer, ImageryProvider, Viewer } from 'cesium'
import { config } from '@/config'
import { flatMapStyleBlend, isBasemap } from '@/lib/basemap'
import { FlatBasemap } from '@/map/FlatBasemap'

/**
 * The flat map's pictures (map/FlatBasemap.ts): two Mapbox styles on the
 * globe, the night one blended over the day one along the sun's ramp,
 * and a style that would be invisible not requested at all.
 */

/** A viewer whose imagery collection records what is added and removed. */
function viewerDouble() {
  const layers: { provider: ImageryProvider; show: boolean; alpha: number; brightness: number }[] = []
  const removed: unknown[] = []
  const viewer = {
    scene: {
      imageryLayers: {
        addImageryProvider: (provider: ImageryProvider) => {
          const layer = { provider, show: true, alpha: 1, brightness: 1 }
          layers.push(layer)
          return layer as unknown as ImageryLayer
        },
        remove: (layer: unknown) => {
          removed.push(layer)
          layers.splice(layers.indexOf(layer as (typeof layers)[number]), 1)
          return true
        },
      },
    },
  } as unknown as Viewer
  return { viewer, layers, removed }
}

/** The config is read-only to the app; the tests set the token as the environment would. */
const flatMapConfig = config.flatMap as { mapboxToken: string }
const originalToken = flatMapConfig.mapboxToken

afterEach(() => {
  flatMapConfig.mapboxToken = originalToken
})

describe('the basemap', () => {
  it('is one of two words', () => {
    expect(isBasemap('3d')).toBe(true)
    expect(isBasemap('flat')).toBe(true)
    expect(isBasemap('2d')).toBe(false)
    expect(isBasemap(null)).toBe(false)
  })

  it('blends the night style over the day one and drops whichever would be invisible', () => {
    expect(flatMapStyleBlend(0)).toEqual({ day: { show: true }, night: { show: false, alpha: 0 } })
    expect(flatMapStyleBlend(0.4)).toEqual({ day: { show: true }, night: { show: true, alpha: 0.4 } })
    expect(flatMapStyleBlend(1)).toEqual({ day: { show: false }, night: { show: true, alpha: 1 } })
    // A ramp value off its range is clamped, never a negative alpha
    expect(flatMapStyleBlend(1.5).night.alpha).toBe(1)
    expect(flatMapStyleBlend(-1).night).toEqual({ show: false, alpha: 0 })
  })
})

describe('FlatBasemap', () => {
  it('puts both styles on the globe at the night level and takes them off again', () => {
    flatMapConfig.mapboxToken = 'pk.test'
    const d = viewerDouble()
    const requestRender = vi.fn()
    const flat = new FlatBasemap(d.viewer, { requestRender, pixelRatio: 2 })
    expect(flat.shown).toBe(false)

    flat.show(0.25)
    expect(flat.shown).toBe(true)
    expect(d.layers).toHaveLength(2)
    expect(flat.state).toEqual({ shown: true, day: true, night: true, nightAlpha: 0.25 })
    // The day style's tiles, at @2x for the pixel ratio, with the token
    const url = (d.layers[0].provider as unknown as { url: string }).url
    expect(url).toContain(
      `/styles/v1/${config.flatMap.day.user}/${config.flatMap.day.styleId}/tiles/512/`,
    )
    expect(url).toContain('@2x')
    expect(url).toContain('access_token=pk.test')
    expect(requestRender).toHaveBeenCalled()

    // Full night: the day style goes off the request list
    flat.applyNight(1)
    expect(flat.state).toEqual({ shown: true, day: false, night: true, nightAlpha: 1 })
    // Day again
    flat.applyNight(0)
    expect(flat.state).toEqual({ shown: true, day: true, night: false, nightAlpha: 0 })

    // The underground view dims both, and the surface lifts them again
    flat.setUnderground(true)
    expect(d.layers.every((layer) => layer.brightness === 0.35)).toBe(true)
    flat.setUnderground(false)
    expect(d.layers.every((layer) => layer.brightness === 1)).toBe(true)

    flat.hide()
    expect(flat.shown).toBe(false)
    expect(d.removed).toHaveLength(2)
    expect(d.layers).toHaveLength(0)
    // A second show is a fresh pair
    flat.show(0)
    expect(d.layers).toHaveLength(2)
  })

  it('requests nothing without a token – the flat map is then the bare globe', () => {
    flatMapConfig.mapboxToken = ''
    const d = viewerDouble()
    const flat = new FlatBasemap(d.viewer, { requestRender: vi.fn(), pixelRatio: 1 })
    expect(FlatBasemap.available).toBe(false)
    flat.show(0)
    expect(flat.shown).toBe(false)
    expect(d.layers).toHaveLength(0)
    flat.hide()
  })

  it('leaves the @2x off at a pixel ratio of one', () => {
    flatMapConfig.mapboxToken = 'pk.test'
    const d = viewerDouble()
    new FlatBasemap(d.viewer, { requestRender: vi.fn(), pixelRatio: 1 }).show(0)
    const url = (d.layers[0].provider as unknown as { url: string }).url
    expect(url).not.toContain('@2x')
  })
})
