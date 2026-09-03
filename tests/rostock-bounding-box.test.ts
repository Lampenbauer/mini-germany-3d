import { describe, expect, it } from 'vitest'
import { haversineMeters } from '@/lib/geo'
import { config } from '@/config'
import {
  ROSTOCK_BOUNDING_BOX_PADDING_METERS,
  boundingBoxCenter,
  containsLonLat,
  padBoundingBox,
  rostockBoundingBox,
  rostockCityBounds,
} from '@/lib/rostock-bounding-box'

describe('padBoundingBox', () => {
  // A straight north–south route at 12.1 °E, padded by 100 km
  const box = padBoundingBox({ west: 12.1, south: 54.0, east: 12.1, north: 54.018 }, 100_000)

  it('pads north and south by the requested distance', () => {
    const north = haversineMeters([12.1, 54.018], [12.1, box.north])
    const south = haversineMeters([12.1, 54.0], [12.1, box.south])
    expect(north).toBeGreaterThanOrEqual(100_000)
    expect(north).toBeLessThan(100_000 * 1.01)
    expect(south).toBeGreaterThanOrEqual(100_000)
    expect(south).toBeLessThan(100_000 * 1.01)
  })

  it('keeps the east–west padding at least that wide at every latitude', () => {
    // Meridians converge northwards – the padding is dimensioned for the
    // box's outermost latitude and is therefore wider further south.
    for (const lat of [box.south, 54.0, box.north]) {
      expect(haversineMeters([12.1, lat], [box.east, lat])).toBeGreaterThanOrEqual(100_000)
      expect(haversineMeters([12.1, lat], [box.west, lat])).toBeGreaterThanOrEqual(100_000)
    }
  })

  it('rounds the edges outward to four decimals', () => {
    for (const edge of Object.values(box)) {
      expect(edge).toBe(Math.round(edge * 1e4) / 1e4)
    }
    const unrounded = { west: 12.12345, south: 54.12345, east: 12.12345, north: 54.12345 }
    expect(padBoundingBox(unrounded, 0)).toEqual({
      west: 12.1234,
      south: 54.1234,
      east: 12.1235,
      north: 54.1235,
    })
  })
})

describe('rostockBoundingBox', () => {
  const pad = ROSTOCK_BOUNDING_BOX_PADDING_METERS
  const city = rostockCityBounds
  const box = rostockBoundingBox
  const midLon = (city.west + city.east) / 2

  it('is the city limits plus 15 km on every side', () => {
    const north = haversineMeters([midLon, city.north], [midLon, box.north])
    const south = haversineMeters([midLon, city.south], [midLon, box.south])
    expect(north).toBeGreaterThanOrEqual(pad)
    expect(north).toBeLessThan(pad * 1.01)
    expect(south).toBeGreaterThanOrEqual(pad)
    expect(south).toBeLessThan(pad * 1.01)
    // East and west: never less than 15 km, and 15 km exactly (bar the
    // outward rounding) along the box's northern edge, where meridians
    // stand closest.
    for (const lat of [box.south, city.south, city.north, box.north]) {
      expect(haversineMeters([city.east, lat], [box.east, lat])).toBeGreaterThanOrEqual(pad)
      expect(haversineMeters([city.west, lat], [box.west, lat])).toBeGreaterThanOrEqual(pad)
    }
    expect(haversineMeters([city.east, box.north], [box.east, box.north])).toBeLessThan(pad * 1.01)
    expect(haversineMeters([city.west, box.north], [box.west, box.north])).toBeLessThan(pad * 1.01)
  })

  it('contains the city and tells inside from outside', () => {
    expect(containsLonLat(box, city.west, city.south)).toBe(true)
    expect(containsLonLat(box, city.east, city.north)).toBe(true)
    expect(containsLonLat(box, box.west, box.south)).toBe(true) // edges included
    expect(containsLonLat(box, 12.14, 54.09)).toBe(true) // city center
    expect(containsLonLat(box, 11.575, 48.137)).toBe(false) // Munich
    expect(containsLonLat(box, box.east + 0.001, 54.09)).toBe(false)
  })

  it('has its center where the weather is queried', () => {
    const center = boundingBoxCenter(box)
    // The midpoint may sit exactly between two four-decimal values, so
    // the rounding moves it by up to 0.00005°
    expect(center.longitude).toBeCloseTo((box.west + box.east) / 2, 3)
    expect(center.latitude).toBeCloseTo((box.south + box.north) / 2, 3)
    expect(containsLonLat(box, center.longitude, center.latitude)).toBe(true)
    // Four decimals: the point goes into a request URL as is
    expect(center.longitude).toBe(Math.round(center.longitude * 1e4) / 1e4)
    expect(center.latitude).toBe(Math.round(center.latitude * 1e4) / 1e4)
    expect(config.weather.longitude).toBe(center.longitude)
    expect(config.weather.latitude).toBe(center.latitude)
  })

  it('is what cityBounds and paddingMeters of the JSON give', () => {
    // boundingBox in src/data/rostock-bounding-box.json is written out
    // rather than computed, so PHP can read it as it is – this is what
    // keeps it honest. On a mismatch the expected value here is what to
    // paste into the JSON.
    expect(box).toEqual(padBoundingBox(city, pad))
  })
})
