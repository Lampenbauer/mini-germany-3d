import { describe, expect, it } from 'vitest'
import {
  LIGHT_COLOURS,
  classifyLighthouse,
  countLighthouses,
  leadingNumber,
  lightSectors,
  selectLighthouses,
} from '../scripts/lib/lighthouses.mjs'
import type { LighthouseData } from '@/data/lighthouses'
import { committedDataFiles } from './cities'

/**
 * The lighthouses and pier lights the pipeline takes from OpenStreetMap's
 * seamark tagging: which objects become lights, with which sectors, and
 * in what order they land in the file – on the tags as they really are
 * (surveyed in Rostock and Kiel).
 */

const BOX = { west: 11.6, south: 53.8, east: 12.7, north: 54.5 }

function node(id: number, lon: number, lat: number, tags: Record<string, string>) {
  return { type: 'node', id, lon, lat, tags }
}
function way(id: number, lon: number, lat: number, tags: Record<string, string>) {
  return { type: 'way', id, center: { lon, lat }, tags }
}

/** The Warnemünde lighthouse as OSM has it: a building way, a landmark, one white sector flashing every four seconds. */
const WARNEMUENDE = {
  man_made: 'lighthouse',
  height: '30.13 m',
  'seamark:type': 'landmark',
  'seamark:light:character': 'Fl',
  'seamark:light:colour': 'white',
  'seamark:light:height': '34',
  'seamark:light:period': '4',
  'seamark:light:range': '20',
  'seamark:light:sector_start': '62.6',
  'seamark:light:sector_end': '242.6',
}
/** The west mole light: a lighthouse to man_made, a lateral beacon to the seamark tags, a green sector. */
const WESTMOLE = {
  man_made: 'lighthouse',
  'seamark:type': 'beacon_lateral',
  'seamark:light:1:character': 'Iso',
  'seamark:light:1:colour': 'green',
  'seamark:light:1:height': '14',
  'seamark:light:1:range': '6',
  'seamark:light:category': 'floodlight',
  'seamark:light:colour': 'white',
}

describe('classifyLighthouse', () => {
  it('takes a lighthouse, a mole light and a leading light with their sectors, elevation and range', () => {
    expect(classifyLighthouse(WARNEMUENDE)).toEqual({
      kind: 'major',
      heightM: 34,
      rangeNm: 20,
      sectors: [
        { colour: 'white', start: 62.6, end: 242.6, character: 'Fl', periodS: 4, group: null, heightM: 34, rangeNm: 20 },
      ],
    })
    // The unnumbered set is the mole's floodlight – a work light, no sector;
    // the numbered green one is the mark
    const mole = classifyLighthouse(WESTMOLE)!
    expect(mole.kind).toBe('minor')
    expect(mole.heightM).toBe(14)
    expect(mole.sectors.map((s) => s.colour)).toEqual(['green'])
    // A leading light front: a beacon to man_made, a minor light to the seamark tags, red all round
    expect(
      classifyLighthouse({
        man_made: 'beacon',
        'seamark:type': 'light_minor',
        'seamark:light:character': 'Oc',
        'seamark:light:colour': 'red',
        'seamark:light:height': '24',
        'seamark:light:range': '19',
      }),
    ).toMatchObject({ kind: 'major', heightM: 24, rangeNm: 19, sectors: [{ colour: 'red', start: null, end: null }] })
    expect(classifyLighthouse({ 'seamark:type': 'light_major', 'seamark:light:colour': 'white' })?.kind).toBe('major')
  })

  it('stays dark where OSM names no light – a bare light_minor, a landmark without a tower, a daymark', () => {
    expect(classifyLighthouse({ 'seamark:type': 'light_minor' })).toBeNull()
    expect(classifyLighthouse({ man_made: 'lighthouse', 'seamark:type': 'landmark' })).toBeNull()
    expect(classifyLighthouse({ 'seamark:type': 'landmark', 'seamark:light:colour': 'white' })).toBeNull()
    expect(classifyLighthouse({ 'seamark:type': 'buoy_lateral', 'seamark:light:colour': 'red' })).toBeNull()
    expect(classifyLighthouse(undefined)).toBeNull()
  })

  it('carries the period and the group of a flashing light – a rotating optic – and nothing where OSM has none', () => {
    // Bastorf (Buk): three flashes in 22 seconds, the group as OSM writes it
    const buk = lightSectors({
      'seamark:light:character': 'Fl',
      'seamark:light:colour': 'white',
      'seamark:light:group': '3',
      'seamark:light:period': '22',
    })
    expect(buk).toMatchObject([{ character: 'Fl', periodS: 22, group: '3' }])
    // A composite group, a period with a unit – and a period of 0 is none
    expect(lightSectors({ 'seamark:light:colour': 'red', 'seamark:light:group': '2+1', 'seamark:light:period': '15 s' })).toMatchObject([
      { periodS: 15, group: '2+1' },
    ])
    expect(lightSectors({ 'seamark:light:colour': 'red', 'seamark:light:period': '0' })).toMatchObject([{ periodS: null, group: null }])
  })

  it('reads a value with a unit, a directional light as a narrow sector, and leaves a fog sector out', () => {
    expect(leadingNumber('4 m')).toBe(4)
    expect(leadingNumber('2 M')).toBe(2)
    expect(leadingNumber('062.6')).toBe(62.6)
    expect(leadingNumber('11,5')).toBe(11.5)
    expect(leadingNumber('high')).toBeNull()
    expect(leadingNumber(undefined)).toBeNull()
    const sectors = lightSectors({
      'seamark:light:1:category': 'directional',
      'seamark:light:1:colour': 'green',
      'seamark:light:1:orientation': '239.5',
      'seamark:light:2:colour': 'yellow',
      'seamark:light:2:exhibition': 'fog',
      'seamark:light:2:sector_start': '19',
      'seamark:light:2:sector_end': '39',
      'seamark:light:3:colour': 'yellow;red',
      'seamark:light:3:character': 'Al.Fl',
      'seamark:light:4:colour': 'blue',
      'seamark:light:5:colour': 'amber',
      'seamark:light:5:sector_start': '350',
      'seamark:light:5:sector_end': '010',
    })
    const plain = { periodS: null, group: null, heightM: null, rangeNm: null }
    expect(sectors).toEqual([
      { colour: 'green', start: 237.5, end: 241.5, character: null, ...plain },
      { colour: 'yellow', start: null, end: null, character: 'Al.Fl', ...plain },
      { colour: 'yellow', start: 350, end: 10, character: null, ...plain },
    ])
    for (const sector of sectors) expect(LIGHT_COLOURS).toContain(sector.colour)
  })
})

describe('selectLighthouses', () => {
  it('keeps the lit towers inside the box, one per spot, in a fixed order', () => {
    const lights = selectLighthouses(
      [
        way(34329207, 12.08582, 54.18142, WARNEMUENDE),
        // The mole light twice: the node carries the light, the building way does not
        node(9220487639, 12.08726, 54.18681, WESTMOLE),
        way(205192343, 12.08726, 54.18681, { man_made: 'lighthouse', height: '14', name: 'Molenfeuer Westmole' }),
        // A tower mapped twice with the light on both: the node counts
        node(1, 12.2, 54.2, { 'seamark:type': 'light_minor', 'seamark:light:colour': 'white' }),
        way(2, 12.20005, 54.20005, { man_made: 'lighthouse', 'seamark:light:colour': 'red' }),
        // Outside the box; a bare light_minor inside it
        node(3, 12.9, 54.2, { 'seamark:type': 'light_major', 'seamark:light:colour': 'white' }),
        node(4, 12.1, 54.1, { 'seamark:type': 'light_minor' }),
      ],
      BOX,
    )
    expect(lights).toEqual([
      [12.08582, 54.18142, 'major', 34, 20, [['white', 62.6, 242.6, 'Fl', 4, null]]],
      [12.08726, 54.18681, 'minor', 14, 6, [['green', null, null, 'Iso', null, null]]],
      [12.2, 54.2, 'minor', null, null, [['white', null, null, null, null, null]]],
    ])
    // The Warnemünde light turns – a major light flashing with a known period
    expect(countLighthouses(lights)).toEqual({ major: 1, minor: 2, sectored: 1, rotating: 1 })
    expect(selectLighthouses([], BOX)).toEqual([])
  })
})

describe('the committed lighthouses', () => {
  const files = Object.entries(committedDataFiles).filter(([name]) => name.endsWith('/lighthouses.json'))

  it('exist for every city, empty where the box holds no lit tower', () => {
    const cities = Object.keys(committedDataFiles).filter((name) => name.endsWith('/network.json')).length
    expect(files.length).toBe(cities)
    for (const [name, data] of files) {
      const { lights, meta } = data as LighthouseData
      expect(meta.attribution, name).toContain('OpenStreetMap')
      for (const light of lights) {
        expect(light, name).toHaveLength(6)
        expect(['major', 'minor'], name).toContain(light[2])
        expect(light[5].length, name).toBeGreaterThan(0)
        for (const sector of light[5]) {
          expect(sector, name).toHaveLength(6)
          expect(LIGHT_COLOURS, name).toContain(sector[0])
          // A period is seconds, or null – never 0
          if (sector[4] !== null) expect(sector[4], name).toBeGreaterThan(0)
        }
      }
    }
  })

  it('light the harbour entrances', () => {
    const count = (slug: string) => (committedDataFiles[`../src/cities/${slug}/lighthouses.json`] as LighthouseData).lights.length
    expect(count('rostock')).toBeGreaterThan(5)
    expect(count('kiel')).toBeGreaterThan(5)
    expect(count('hamburg')).toBeGreaterThan(5)
  })

  it('turn the beams of the coast’s towers – Warnemünde and Bastorf, Friedrichsort, Travemünde – and no leading light', () => {
    // The Elbe's and the Weser's lights are leading and fixed lights (Oc,
    // Iso): nothing turns in Hamburg and Bremen, by the data; nor does
    // Wilhelmshaven's leading light, whose flashing guide sectors stand
    // among fixed ones – a flashing lamp, not an optic
    const rotating = (slug: string) =>
      countLighthouses((committedDataFiles[`../src/cities/${slug}/lighthouses.json`] as LighthouseData).lights).rotating
    expect(rotating('rostock')).toBe(2)
    expect(rotating('kiel')).toBe(1)
    expect(rotating('lubeck')).toBe(1)
    expect(rotating('hamburg')).toBe(0)
    expect(rotating('bremen')).toBe(0)
    expect(rotating('wilhelmshaven')).toBe(0)
  })
})
