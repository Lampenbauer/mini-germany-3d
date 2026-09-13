import { describe, expect, it } from 'vitest'
import {
  AIRFIELD_LIGHT_COLOURS,
  AIRFIELD_LIGHT_KINDS,
  classifyAirfieldLight,
  countByKind,
  selectAirfieldLights,
} from '../scripts/lib/airfield-lights.mjs'
import type { AirfieldLightData } from '@/data/airfield-lights'
import { committedDataFiles } from './cities'

/**
 * The airfield lighting the pipeline takes from OpenStreetMap: which
 * navigationaid nodes become lights, in which colour, and in what order
 * they land in the file. The selection is pure; the fetch script around
 * it is a thin wrapper.
 */

const BOX = { west: 12.0, south: 54.0, east: 12.4, north: 54.3 }

function node(id: number, lon: number, lat: number, tags: Record<string, string>) {
  return { type: 'node', id, lon, lat, tags }
}

describe('classifyAirfieldLight', () => {
  it('gives every kind the colour ICAO gives it', () => {
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'rwe' })).toEqual({ kind: 'rwe', colour: 'white' })
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'rwt' })).toEqual({ kind: 'rwt', colour: 'green' })
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'txe' })).toEqual({ kind: 'txe', colour: 'blue' })
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'txc' })).toEqual({ kind: 'txc', colour: 'green' })
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'sbl' })).toEqual({ kind: 'sbl', colour: 'red' })
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'rgl' })).toEqual({ kind: 'rgl', colour: 'yellow' })
    for (const colour of Object.values(AIRFIELD_LIGHT_KINDS)) expect(AIRFIELD_LIGHT_COLOURS).toContain(colour)
  })

  it('lets the node say otherwise – a threshold seen from the runway is the red end, amber is yellow', () => {
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'rwt', 'light:colour': 'red' })).toEqual({ kind: 'rwt', colour: 'red' })
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'als', 'light:colour': 'Red ' })).toEqual({ kind: 'als', colour: 'red' })
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'rgl', 'light:colour': 'amber' })).toEqual({ kind: 'rgl', colour: 'yellow' })
    // A colour the map has no light for falls back to the kind's own
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'rwe', 'light:colour': 'purple' })).toEqual({ kind: 'rwe', colour: 'white' })
  })

  it('has no light for a radio aid, an unknown kind or something that is not a navigation aid', () => {
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'vor' })).toBeNull()
    expect(classifyAirfieldLight({ aeroway: 'navigationaid', navigationaid: 'ils' })).toBeNull()
    expect(classifyAirfieldLight({ aeroway: 'navigationaid' })).toBeNull()
    expect(classifyAirfieldLight({ highway: 'street_lamp' })).toBeNull()
    expect(classifyAirfieldLight(undefined)).toBeNull()
  })
})

describe('selectAirfieldLights', () => {
  it('keeps the lights inside the box, one per spot, in a fixed order', () => {
    const lights = selectAirfieldLights(
      [
        node(1, 12.2, 54.1, { aeroway: 'navigationaid', navigationaid: 'txe' }),
        node(2, 12.1, 54.1, { aeroway: 'navigationaid', navigationaid: 'rwe' }),
        node(3, 12.1, 54.2, { aeroway: 'navigationaid', navigationaid: 'rwe' }),
        // The same spot twice – a duplicated node – is one light
        node(4, 12.100004, 54.100003, { aeroway: 'navigationaid', navigationaid: 'rwe' }),
        // Outside the box, and a radio aid inside it
        node(5, 12.5, 54.1, { aeroway: 'navigationaid', navigationaid: 'rwe' }),
        node(6, 12.2, 54.2, { aeroway: 'navigationaid', navigationaid: 'dme' }),
        { type: 'way', id: 7, tags: { aeroway: 'runway' } },
      ],
      BOX,
    )
    expect(lights).toEqual([
      [12.1, 54.1, 'rwe', 'white'],
      [12.1, 54.2, 'rwe', 'white'],
      [12.2, 54.1, 'txe', 'blue'],
    ])
    expect(countByKind(lights)).toEqual({ rwe: 2, txe: 1 })
    expect(selectAirfieldLights([], BOX)).toEqual([])
  })

  it('rounds the positions to a metre – the file must not change with a mirror’s float noise', () => {
    const [light] = selectAirfieldLights(
      [node(1, 12.123456789, 54.123456789, { aeroway: 'navigationaid', navigationaid: 'papi' })],
      BOX,
    )
    expect(light).toEqual([12.12346, 54.12346, 'papi', 'white'])
  })
})

describe('the committed airfield lighting', () => {
  const files = Object.entries(committedDataFiles).filter(([name]) => name.endsWith('/airfield-lights.json'))

  it('exists for every city, empty where the box holds no airfield', () => {
    const cities = Object.keys(committedDataFiles).filter((name) => name.endsWith('/network.json')).length
    expect(files.length).toBe(cities)
    for (const [name, data] of files) {
      const { lights, meta } = data as AirfieldLightData
      expect(meta.attribution, name).toContain('OpenStreetMap')
      for (const light of lights) {
        expect(light, name).toHaveLength(5)
        expect(AIRFIELD_LIGHT_COLOURS, name).toContain(light[4])
        expect(light[3] in AIRFIELD_LIGHT_KINDS, name).toBe(true)
      }
    }
  })

  it('lights the big airports by the thousand', () => {
    const count = (slug: string) =>
      (committedDataFiles[`../src/cities/${slug}/airfield-lights.json`] as AirfieldLightData).lights.length
    expect(count('frankfurt')).toBeGreaterThan(5000)
    expect(count('hamburg')).toBeGreaterThan(2000)
    expect(count('berlin')).toBeGreaterThan(2000)
    // Parchim lies outside Schwerin's box
    expect(count('schwerin')).toBe(0)
  })
})
