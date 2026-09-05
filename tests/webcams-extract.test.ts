import { describe, expect, it } from 'vitest'
import { extractWebcams, windyNearby } from '@/lib/webcams-extract'
import { rostockBoundingBox } from './cities'

/** A Windy /webcams answer the way the API sends it, trimmed to what matters. */
function windyCam(overrides: Record<string, unknown> = {}) {
  return {
    webcamId: 1350031803,
    title: 'Rostock: Stork Cam',
    status: 'active',
    lastUpdatedOn: '2026-09-05T06:52:13.000Z',
    location: { latitude: 54.0887, longitude: 12.14049 },
    images: {
      current: {
        icon: 'https://imgproxy.windy.com/_/icon/plain/current/1350031803/original.jpg?v=2',
        preview: 'https://imgproxy.windy.com/_/preview/plain/current/1350031803/original.jpg?v=2',
      },
      sizes: { preview: { width: 400, height: 224 } },
    },
    urls: { detail: 'https://windy.com/webcams/1350031803' },
    ...overrides,
  }
}

describe('extractWebcams', () => {
  it('keeps the active cameras inside the box with their preview and page', () => {
    const [cam] = extractWebcams({ webcams: [windyCam()] }, rostockBoundingBox)
    expect(cam).toEqual({
      id: 1350031803,
      title: 'Rostock: Stork Cam',
      lon: 12.14049,
      lat: 54.0887,
      image: 'https://imgproxy.windy.com/_/preview/plain/current/1350031803/original.jpg?v=2',
      detailUrl: 'https://windy.com/webcams/1350031803',
      updatedAt: '2026-09-05T06:52:13.000Z',
    })
  })

  it('drops inactive cameras, ones outside the box and ones without a picture', () => {
    const list = [
      windyCam({ webcamId: 1, status: 'inactive' }),
      windyCam({ webcamId: 2, location: { latitude: 53.55, longitude: 10.0 } }),
      windyCam({ webcamId: 3, images: { current: {} } }),
      windyCam({ webcamId: 4, urls: {} }),
      windyCam({ webcamId: 5 }),
    ]
    expect(extractWebcams({ webcams: list }, rostockBoundingBox).map((c) => c.id)).toEqual([5])
  })

  it('leaves the ids a city excludes off the map', () => {
    const list = [windyCam({ webcamId: 7 }), windyCam({ webcamId: 8 })]
    expect(extractWebcams({ webcams: list }, rostockBoundingBox, [7]).map((c) => c.id)).toEqual([8])
  })

  it('tolerates an answer without cameras', () => {
    expect(extractWebcams(null, rostockBoundingBox)).toEqual([])
    expect(extractWebcams({}, rostockBoundingBox)).toEqual([])
    expect(extractWebcams({ webcams: 'nope' }, rostockBoundingBox)).toEqual([])
  })
})

describe('windyNearby', () => {
  it('asks for the circle around the box that reaches its corners', () => {
    const { lat, lon, radiusKm } = windyNearby(rostockBoundingBox)
    expect(lat).toBeCloseTo(54.1477, 3)
    expect(lon).toBeCloseTo(12.1469, 3)
    // Half the diagonal of a ~50 × 52 km box
    expect(radiusKm).toBeGreaterThan(33)
    expect(radiusKm).toBeLessThan(38)
  })
})
