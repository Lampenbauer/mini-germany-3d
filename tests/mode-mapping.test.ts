import { describe, expect, it } from 'vitest'
import { CITIES, cityBySlug } from '@/cities/definitions'
import { cityFromJson } from '@/lib/city'
import { buildQuery, modeByOsmRoute, osmRoutesForMode } from '../scripts/fetch-osm-network.mjs'
import { routeTypesForCity } from '../scripts/fetch-gtfs-schedule.mjs'
import rostockJson from '@/cities/rostock/city.json'

/**
 * The two places where a city and the outside world disagree about what a
 * line is. OSM tags a Stadtbahn `light_rail` in Stuttgart and `tram` in
 * Cologne; the GTFS feed calls Hanover's an underground and Cologne's a
 * tram. Both are decided per city, and both default to the map every
 * other city has always used.
 */

const withOverpass = (overpass: unknown, extra: Record<string, unknown> = {}) =>
  cityFromJson({
    ...rostockJson,
    ...extra,
    network: { ...rostockJson.network, ...(extra.network ?? {}), overpass },
  })

describe('which OSM route=* values a mode takes', () => {
  it('follows the default map where a city says nothing', () => {
    const rostock = cityBySlug('rostock')!
    expect(osmRoutesForMode(rostock, 'tram')).toEqual(['tram'])
    // An S-Bahn is tagged either way, so 'train' takes both by default
    expect(osmRoutesForMode(rostock, 'train')).toEqual(['train', 'light_rail'])
    expect(modeByOsmRoute(rostock).light_rail).toBe('train')
  })

  it('lets a city move light_rail to its subway', () => {
    const stuttgart = cityBySlug('stuttgart')!
    expect(osmRoutesForMode(stuttgart, 'subway')).toEqual(['light_rail'])
    const map = modeByOsmRoute(stuttgart)
    expect(map.light_rail).toBe('subway')
    expect(map.train).toBe('train')
    expect(map.subway).toBeUndefined()
  })

  it('asks the relation for the value the city named', () => {
    const clauses = buildQuery(cityBySlug('stuttgart')!)
      .split('\n')
      .filter((line) => line.includes('relation['))
    expect(clauses.some((c) => c.includes('"route"="light_rail"') && c.includes('U[0-9]'))).toBe(true)
    // …and not under the default one, which would fetch nothing here
    expect(clauses.some((c) => c.includes('"route"="subway"'))).toBe(false)
  })

  it('refuses a value two modes claim', () => {
    // A subway on light_rail while the train still takes it by default:
    // one of the two would silently get the other's relations.
    const city = withOverpass(
      { subway: { osmRoutes: ['light_rail'] }, train: { ref: '^S[0-9]+$' } },
      { network: { ...rostockJson.network, modes: ['subway', 'train'] } },
    )
    expect(() => modeByOsmRoute(city)).toThrow(/light_rail is claimed by both/)
  })

  it('rejects a value OSM does not use', () => {
    expect(() => withOverpass({ tram: { osmRoutes: ['monorail'] } })).toThrow(
      /network.overpass.tram.osmRoutes/,
    )
    expect(() => withOverpass({ tram: { osmRoutes: [] } })).toThrow(/non-empty/)
  })
})

describe('which GTFS route_type values a mode is looked up under', () => {
  it('uses the defaults where a city says nothing', () => {
    const types = routeTypesForCity(cityBySlug('cologne')!)
    expect([...types.tram].sort()).toEqual(['0', '900'])
    expect(types.subway.has('1')).toBe(true)
  })

  it('lets a city add the type its feed uses', () => {
    // Hanover's Stadtbahn is a tram on the map and an underground (1) in
    // the feed – without this its lines would find no departures at all.
    const types = routeTypesForCity(cityBySlug('hanover')!)
    expect(types.tram.has('1')).toBe(true)
    expect(types.tram.has('0')).toBe(true)
    // Everything the city did not name stays as it was
    expect([...types.train].sort()).toEqual(['106', '109', '2'])
  })

  it('rejects an empty or non-string list', () => {
    const city = (routeTypes: unknown) =>
      cityFromJson({ ...rostockJson, gtfs: { ...rostockJson.gtfs, routeTypes } })
    expect(() => city({ tram: [] })).toThrow(/gtfs.routeTypes.tram/)
    expect(() => city({ tram: [0] })).toThrow(/gtfs.routeTypes.tram\[0\]/)
    expect(() => city({ cablecar: ['5'] })).toThrow(/gtfs.routeTypes.cablecar/)
  })
})

describe('every city in the build', () => {
  it('maps each OSM route value to exactly one mode', () => {
    for (const city of CITIES) {
      expect(() => modeByOsmRoute(city), city.slug).not.toThrow()
    }
  })
})
