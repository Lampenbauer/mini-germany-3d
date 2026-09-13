import { describe, expect, it } from 'vitest'
import {
  BUOY_COLOURS,
  BUOY_LIGHT_COLOURS,
  BUOY_SHAPES,
  classifyBuoy,
  classifyLight,
  countBuoys,
  selectBuoys,
} from '../scripts/lib/buoys.mjs'
import type { BuoyData } from '@/data/buoys'
import { committedDataFiles } from './cities'

/**
 * The buoys the pipeline takes from OpenStreetMap's seamark tagging:
 * which nodes become buoys, in which colour and shape, with which light,
 * and in what order they land in the file. The selection is pure; the
 * fetch script around it is a thin wrapper.
 */

const BOX = { west: 12.0, south: 54.0, east: 12.4, north: 54.3 }

function node(id: number, lon: number, lat: number, tags: Record<string, string>) {
  return { type: 'node', id, lon, lat, tags }
}

const lateral = (colour: string, extra: Record<string, string> = {}) => ({
  'seamark:type': 'buoy_lateral',
  'seamark:buoy_lateral:colour': colour,
  ...extra,
})

describe('classifyBuoy', () => {
  it('takes a red or green lateral and a yellow special mark, shape and all', () => {
    expect(classifyBuoy(lateral('red', { 'seamark:buoy_lateral:shape': 'can' }))).toEqual({
      colour: 'red',
      shape: 'can',
      light: null,
    })
    expect(classifyBuoy(lateral('green', { 'seamark:buoy_lateral:shape': 'conical' }))).toEqual({
      colour: 'green',
      shape: 'conical',
      light: null,
    })
    expect(
      classifyBuoy({
        'seamark:type': 'buoy_special_purpose',
        'seamark:buoy_special_purpose:colour': 'yellow',
        'seamark:buoy_special_purpose:shape': 'barrel',
      }),
    ).toEqual({ colour: 'yellow', shape: 'barrel', light: null })
    // OSM's spelling is not always tidy
    expect(classifyBuoy(lateral(' Red', { 'seamark:buoy_lateral:shape': 'Spar ' }))?.shape).toBe('spar')
    expect(classifyBuoy({ 'seamark:type': 'buoy_special_purpose', 'seamark:buoy_special_purpose:colour': 'amber' })?.colour).toBe('yellow')
  })

  it('reads the light with its colour, character and period', () => {
    const lit = classifyBuoy(
      lateral('green', {
        'seamark:buoy_lateral:shape': 'pillar',
        'seamark:light:colour': 'green',
        'seamark:light:character': 'Fl',
        'seamark:light:period': '4',
      }),
    )
    expect(lit).toEqual({ colour: 'green', shape: 'pillar', light: { colour: 'green', character: 'Fl', period: 4 } })
    // A lantern without a colour of its own shows the buoy's; a period
    // that is no number is none; a sectored light's first colour counts
    expect(classifyLight({ 'seamark:light:character': 'Q' }, 'red')).toEqual({ colour: 'red', character: 'Q', period: null })
    expect(classifyLight({ 'seamark:light:colour': 'white', 'seamark:light:period': 'long' }, 'yellow')).toEqual({
      colour: 'white',
      character: null,
      period: null,
    })
    expect(classifyLight({ 'seamark:light:1:colour': 'white;red', 'seamark:light:1:character': 'Oc' }, 'green')).toEqual({
      colour: 'white',
      character: 'Oc',
      period: null,
    })
    expect(classifyLight({ 'seamark:light:colour': 'purple' }, 'green')?.colour).toBe('green')
    expect(classifyLight({}, 'green')).toBeNull()
  })

  it('draws a shape it has no model for as the pillar buoy when lit, the spar buoy otherwise', () => {
    expect(classifyBuoy(lateral('red'))?.shape).toBe('spar')
    expect(classifyBuoy(lateral('red', { 'seamark:buoy_lateral:shape': 'super-buoy' }))?.shape).toBe('spar')
    expect(classifyBuoy(lateral('red', { 'seamark:light:colour': 'red' }))?.shape).toBe('pillar')
  })

  it('has no buoy for the banded marks, the white ones, the beacons or anything else', () => {
    expect(classifyBuoy(lateral('green;red;green'))).toBeNull()
    expect(classifyBuoy({ 'seamark:type': 'buoy_cardinal', 'seamark:buoy_cardinal:colour': 'yellow;black' })).toBeNull()
    expect(classifyBuoy({ 'seamark:type': 'buoy_safe_water', 'seamark:buoy_safe_water:colour': 'red;white' })).toBeNull()
    expect(classifyBuoy({ 'seamark:type': 'buoy_special_purpose', 'seamark:buoy_special_purpose:colour': 'white' })).toBeNull()
    expect(classifyBuoy({ 'seamark:type': 'beacon_lateral', 'seamark:beacon_lateral:colour': 'red' })).toBeNull()
    expect(classifyBuoy({ 'seamark:type': 'buoy_lateral' })).toBeNull()
    expect(classifyBuoy({ 'seamark:type': 'light_minor' })).toBeNull()
    expect(classifyBuoy({ highway: 'street_lamp' })).toBeNull()
    expect(classifyBuoy(undefined)).toBeNull()
  })
})

describe('selectBuoys', () => {
  it('keeps the buoys inside the box, one per spot, in a fixed order', () => {
    const buoys = selectBuoys(
      [
        node(1, 12.2, 54.1, { 'seamark:type': 'buoy_special_purpose', 'seamark:buoy_special_purpose:colour': 'yellow', 'seamark:buoy_special_purpose:shape': 'spar' }),
        node(2, 12.1, 54.1, lateral('red', { 'seamark:buoy_lateral:shape': 'can' })),
        node(3, 12.1, 54.2, lateral('green', { 'seamark:buoy_lateral:shape': 'pillar', 'seamark:light:colour': 'green', 'seamark:light:character': 'Fl', 'seamark:light:period': '4' })),
        // The same spot twice – a duplicated node – is one buoy
        node(4, 12.1000004, 54.1000003, lateral('red')),
        // Outside the box, and a cardinal mark inside it
        node(5, 12.5, 54.1, lateral('red')),
        node(6, 12.2, 54.2, { 'seamark:type': 'buoy_cardinal', 'seamark:buoy_cardinal:colour': 'black;yellow' }),
        { type: 'way', id: 7, tags: { waterway: 'fairway' } },
        node(8, 12.05, 54.05, lateral('red', { 'seamark:buoy_lateral:shape': 'spar' })),
      ],
      BOX,
    )
    expect(buoys).toEqual([
      [12.1, 54.2, 'green', 'pillar', 'green', 'Fl', 4],
      [12.05, 54.05, 'red', 'spar', null, null, null],
      [12.1, 54.1, 'red', 'can', null, null, null],
      [12.2, 54.1, 'yellow', 'spar', null, null, null],
    ])
    expect(countBuoys(buoys)).toEqual({ byColour: { green: 1, red: 2, yellow: 1 }, lit: 1 })
    expect(selectBuoys([], BOX)).toEqual([])
  })

  it('rounds the positions to a decimetre – the file must not change with a mirror’s float noise', () => {
    const [buoy] = selectBuoys([node(1, 12.1234567891, 54.1234567891, lateral('red'))], BOX)
    expect(buoy[0]).toBe(12.123457)
    expect(buoy[1]).toBe(54.123457)
  })
})

describe('the committed buoys', () => {
  const files = Object.entries(committedDataFiles).filter(([name]) => name.endsWith('/buoys.json'))

  it('exist for every city, empty where the box holds no marked water', () => {
    const cities = Object.keys(committedDataFiles).filter((name) => name.endsWith('/network.json')).length
    expect(files.length).toBe(cities)
    for (const [name, data] of files) {
      const { buoys, meta } = data as BuoyData
      expect(meta.attribution, name).toContain('OpenStreetMap')
      for (const buoy of buoys) {
        expect(buoy, name).toHaveLength(7)
        expect(BUOY_COLOURS, name).toContain(buoy[2])
        expect(BUOY_SHAPES, name).toContain(buoy[3])
        if (buoy[4] !== null) expect(BUOY_LIGHT_COLOURS, name).toContain(buoy[4])
        else expect([buoy[5], buoy[6]], name).toEqual([null, null])
      }
    }
  })

  it('mark the fairways of the harbour cities by the hundred', () => {
    const count = (slug: string) => (committedDataFiles[`../src/cities/${slug}/buoys.json`] as BuoyData).buoys.length
    expect(count('rostock')).toBeGreaterThan(150)
    expect(count('kiel')).toBeGreaterThan(80)
    expect(count('hamburg')).toBeGreaterThan(100)
  })
})
