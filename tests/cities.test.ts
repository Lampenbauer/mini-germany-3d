import { describe, expect, it } from 'vitest'
import { CITIES, DEFAULT_CITY_SLUG, cityBySlug, isCitySlug } from '@/cities/definitions'
import { haversineMeters } from '@/lib/geo'
import {
  boundingBoxCenter,
  cityFromJson,
  containsLonLat,
  overpassBbox,
  padBoundingBox,
} from '@/lib/city'

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

describe('cityFromJson', () => {
  const minimal = {
    slug: 'testhausen',
    name: 'Testhausen',
    osmRelation: 1,
    cityBounds: { west: 12.0, south: 54.0, east: 12.3, north: 54.2 },
    paddingMeters: 15000,
    boundingBox: { west: 11.7, south: 53.8, east: 12.6, north: 54.4 },
    home: { longitude: 12.1, latitude: 54.1, height: 5000 },
  }

  it('fills in what a minimal definition leaves out', () => {
    const city = cityFromJson(minimal)
    expect(city.home.heading).toBe(0)
    expect(city.home.pitch).toBe(-40)
    expect(city.weather).toEqual(boundingBoxCenter(city.boundingBox))
    expect(city.network.modes).toEqual(['tram', 'subway', 'train', 'bus', 'ferry'])
    expect(city.network.clip).toBe('city')
    expect(city.terrain.provider).toBe('none')
    expect(city.lamps.enabled).toBe(false)
    expect(city.ais.enabled).toBe(true)
    expect(city.ais.ferryLineByMmsi).toEqual({})
  })

  it('names the field that is wrong', () => {
    expect(() => cityFromJson({ ...minimal, slug: 'Test Hausen' })).toThrow(/slug/)
    expect(() => cityFromJson({ ...minimal, home: { longitude: 12.1 } })).toThrow(/home/)
    expect(() =>
      cityFromJson({ ...minimal, cityBounds: { west: 12.3, south: 54.0, east: 12.0, north: 54.2 } }),
    ).toThrow(/cityBounds/)
    expect(() => cityFromJson({ ...minimal, network: { modes: ['zeppelin'] } })).toThrow(
      /network\.modes\[0\]/,
    )
    expect(() =>
      cityFromJson({ ...minimal, ais: { ferryLineByMmsi: { '12': 'FG' } } }),
    ).toThrow(/ferryLineByMmsi/)
  })
})

/** The generated data files next to the definitions, as Vite sees them. */
const networkFiles = Object.keys(import.meta.glob('../src/cities/*/network.json'))

describe('the cities this build knows', () => {
  it('has the default city and unique slugs', () => {
    expect(isCitySlug(DEFAULT_CITY_SLUG)).toBe(true)
    expect(cityBySlug(DEFAULT_CITY_SLUG)?.slug).toBe(DEFAULT_CITY_SLUG)
    expect(new Set(CITIES.map((c) => c.slug)).size).toBe(CITIES.length)
    expect(isCitySlug('atlantis')).toBe(false)
  })

  describe.each(CITIES.map((city) => [city.slug, city] as const))('%s', (_slug, city) => {
    const pad = city.paddingMeters
    const bounds = city.cityBounds
    const box = city.boundingBox

    it('has its box the city limits plus the padding on every side', () => {
      const midLon = (bounds.west + bounds.east) / 2
      const north = haversineMeters([midLon, bounds.north], [midLon, box.north])
      const south = haversineMeters([midLon, bounds.south], [midLon, box.south])
      expect(north).toBeGreaterThanOrEqual(pad)
      expect(north).toBeLessThan(pad * 1.01)
      expect(south).toBeGreaterThanOrEqual(pad)
      expect(south).toBeLessThan(pad * 1.01)
      // East and west: never less than the padding, and the padding
      // exactly (bar the outward rounding) along the box's northern
      // edge, where meridians stand closest.
      for (const lat of [box.south, bounds.south, bounds.north, box.north]) {
        expect(haversineMeters([bounds.east, lat], [box.east, lat])).toBeGreaterThanOrEqual(pad)
        expect(haversineMeters([bounds.west, lat], [box.west, lat])).toBeGreaterThanOrEqual(pad)
      }
      expect(haversineMeters([bounds.east, box.north], [box.east, box.north])).toBeLessThan(
        pad * 1.01,
      )
      expect(haversineMeters([bounds.west, box.north], [box.west, box.north])).toBeLessThan(
        pad * 1.01,
      )
    })

    it('is what cityBounds and paddingMeters of the JSON give', () => {
      // boundingBox in city.json is written out rather than computed, so
      // PHP can read it as it is – this is what keeps it honest. On a
      // mismatch the expected value here is what to paste into the JSON.
      expect(box).toEqual(padBoundingBox(bounds, pad))
    })

    it('contains the city, the home view and the weather point', () => {
      expect(containsLonLat(box, bounds.west, bounds.south)).toBe(true)
      expect(containsLonLat(box, bounds.east, bounds.north)).toBe(true)
      expect(containsLonLat(box, box.west, box.south)).toBe(true) // edges included
      expect(containsLonLat(box, city.home.longitude, city.home.latitude)).toBe(true)
      expect(containsLonLat(box, city.weather.longitude, city.weather.latitude)).toBe(true)
      expect(containsLonLat(box, 11.575, 48.137)).toBe(false) // Munich
    })

    it('spells its box the way Overpass wants it', () => {
      expect(overpassBbox(box)).toBe(`${box.south},${box.west},${box.north},${box.east}`)
    })

    it('has generated network data next to its definition', () => {
      // The registry lists the city, so the app will try to load it –
      // without the network the picker would offer an empty map.
      expect(networkFiles).toContain(`../src/cities/${city.slug}/network.json`)
    })
  })
})
