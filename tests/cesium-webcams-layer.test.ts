// @vitest-environment jsdom
import { Cartographic, type BillboardCollection, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import type { Webcam } from '@/lib/webcams-extract'
import {
  WEBCAM_FLOAT_METERS,
  WEBCAM_LONG_SIDE_METERS,
  WebcamsLayer,
  pictureSizeMeters,
} from '@/map/WebcamsLayer'

/**
 * Webcam pictures float over their spot as world-sized billboards: the
 * longest side 200 m, the picture's own aspect ratio, the bottom edge
 * 200 m above the ground.
 */

function webcam(id: number, image = `https://img.example/${id}.jpg`): Webcam {
  return {
    id,
    title: `Cam ${id}`,
    lon: 12.1 + id * 0.001,
    lat: 54.09,
    image,
    detailUrl: `https://windy.com/webcams/${id}`,
    updatedAt: '2026-09-05T08:00:00.000Z',
  }
}

function harness(pictures: Record<string, { width: number; height: number }>, groundHeight?: number) {
  const primitives: unknown[] = []
  const viewer = {
    scene: {
      primitives: {
        add: (p: unknown) => primitives.push(p),
        remove: (p: unknown) => {
          const index = primitives.indexOf(p)
          if (index >= 0) primitives.splice(index, 1)
          return index >= 0
        },
      },
    },
    creditDisplay: { addStaticCredit: vi.fn(), removeStaticCredit: vi.fn() },
  } as unknown as Viewer
  const sampleGroundHeight = vi.fn<(lon: number, lat: number) => number | undefined>(
    () => groundHeight,
  )
  const loadPicture = vi.fn(async (url: string) => {
    const size = pictures[url]
    if (!size) throw new Error(`no picture for ${url}`)
    return { image: document.createElement('canvas'), ...size }
  })
  const requestRender = vi.fn()
  let generation = 0
  const layer = new WebcamsLayer(viewer, {
    requestRender,
    sampleGroundHeight,
    surfaceGeneration: () => generation,
    defaultGroundHeight: 45,
    loadPicture,
  })
  /** The tiles changed (CesiumMap.advanceSurfaceGeneration). */
  const bumpGeneration = () => generation++
  const collection = () => primitives[0] as BillboardCollection
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { layer, viewer, collection, sampleGroundHeight, loadPicture, requestRender, settle, bumpGeneration }
}

describe('pictureSizeMeters', () => {
  it('spans the longest side and keeps the ratio', () => {
    const L = WEBCAM_LONG_SIDE_METERS
    expect(pictureSizeMeters(400, 224)).toEqual({ width: L, height: (L * 224) / 400 })
    expect(pictureSizeMeters(300, 400)).toEqual({ width: (L * 300) / 400, height: L })
    expect(pictureSizeMeters(0, 0)).toEqual({ width: 0, height: 0 })
  })
})

describe('WebcamsLayer', () => {
  it('floats each picture 200 m over its spot at the picture size in meters', async () => {
    const h = harness({ 'https://img.example/1.jpg': { width: 400, height: 224 } }, 50)
    h.layer.sync([webcam(1)])
    await h.settle()
    const billboard = h.collection().get(0)
    expect(billboard.id).toBe('webcam:1')
    expect(billboard.sizeInMeters).toBe(true)
    expect(billboard.width).toBe(WEBCAM_LONG_SIDE_METERS)
    expect(billboard.height).toBeCloseTo((WEBCAM_LONG_SIDE_METERS * 224) / 400, 6)
    expect(billboard.show).toBe(true)
    const carto = Cartographic.fromCartesian(billboard.position)
    expect(carto.height).toBeCloseTo(50 + WEBCAM_FLOAT_METERS, 3)
    expect(h.viewer.creditDisplay.addStaticCredit).toHaveBeenCalledTimes(1)
    expect(h.layer.detailUrl(1)).toBe('https://windy.com/webcams/1')
  })

  it('stands on the ground first guess until the tiles answer, then moves', async () => {
    const h = harness({ 'https://img.example/2.jpg': { width: 400, height: 224 } }, undefined)
    h.layer.sync([webcam(2)])
    await h.settle()
    const billboard = h.collection().get(0)
    expect(Cartographic.fromCartesian(billboard.position).height).toBeCloseTo(45 + WEBCAM_FLOAT_METERS, 3)
    // Frames without a change of the tiles ask nothing more
    h.sampleGroundHeight.mockReturnValue(62)
    for (let i = 0; i < 30; i++) h.layer.update()
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(1)
    expect(Cartographic.fromCartesian(billboard.position).height).toBeCloseTo(45 + WEBCAM_FLOAT_METERS, 3)
    // The tiles came in: measured again once, and moved
    h.bumpGeneration()
    h.layer.update()
    h.layer.update()
    expect(h.sampleGroundHeight).toHaveBeenCalledTimes(2)
    expect(Cartographic.fromCartesian(billboard.position).height).toBeCloseTo(62 + WEBCAM_FLOAT_METERS, 3)
  })

  it('takes cameras down that a poll no longer lists, and keeps the rest', async () => {
    const h = harness({
      'https://img.example/1.jpg': { width: 400, height: 224 },
      'https://img.example/3.jpg': { width: 300, height: 400 },
    })
    h.layer.sync([webcam(1), webcam(3)])
    await h.settle()
    expect(h.layer.count).toBe(2)
    expect(h.collection().length).toBe(2)
    h.layer.sync([webcam(3)])
    await h.settle()
    expect(h.layer.count).toBe(1)
    expect(h.collection().length).toBe(1)
    expect(h.collection().get(0).id).toBe('webcam:3')
    expect(h.collection().get(0).height).toBe(WEBCAM_LONG_SIDE_METERS)
    // The picture is reloaded on every poll – the same URL serves a newer one
    expect(h.loadPicture).toHaveBeenCalledTimes(3)
    h.layer.clear()
    expect(h.layer.count).toBe(0)
    expect(h.viewer.creditDisplay.removeStaticCredit).toHaveBeenCalledTimes(1)
  })

  it('takes the pictures off the map underground, whatever the switch says', async () => {
    const h = harness({ 'https://img.example/1.jpg': { width: 400, height: 224 } }, 50)
    h.layer.sync([webcam(1)])
    await h.settle()
    expect(h.collection().show).toBe(true)

    h.layer.setUnderground(true)
    expect(h.collection().show).toBe(false)
    expect(h.layer.screenRects).toEqual([])

    // The switch flipped down there applies once the view surfaces again
    h.layer.setVisible(false)
    h.layer.setUnderground(false)
    expect(h.collection().show).toBe(false)
    h.layer.setVisible(true)
    expect(h.collection().show).toBe(true)
  })

  it('keeps a camera whose picture failed to load off the screen', async () => {
    const h = harness({})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.layer.sync([webcam(9)])
    await h.settle()
    expect(h.collection().get(0).show).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
