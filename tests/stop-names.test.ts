import { describe, expect, it } from 'vitest'
import { inheritUnnamedStopNames } from '../scripts/fetch-osm-network.mjs'

/**
 * Placeholder-named stops ('Stop', i.e. unnamed OSM stop_positions that
 * the stop_area lookup could not resolve either) inherit the name of the
 * nearest properly named stop within a tight radius – beyond it the
 * nearest neighbor is regularly the wrong station, so the placeholder
 * stays.
 */

// ~1e-4 deg longitude ≈ 6.5 m at Rostock's latitude
const AT = (dLonMeters: number): [number, number] => [12.1 + dLonMeters / 65500, 54.09]

describe('inheritUnnamedStopNames', () => {
  it('inherits from the nearest named stop within the radius', () => {
    const stops = {
      a: { name: 'Doberaner Platz', coord: AT(3) },
      b: { name: 'Volkstheater', coord: AT(40) },
      x: { name: 'Stop', coord: AT(0) },
    }
    inheritUnnamedStopNames(stops)
    expect(stops.x.name).toBe('Doberaner Platz')
  })

  it('keeps the placeholder when no named stop is close enough', () => {
    const stops = {
      far: { name: 'Rostocker Heide', coord: AT(90) },
      x: { name: 'Stop', coord: AT(0) },
    }
    inheritUnnamedStopNames(stops)
    expect(stops.x.name).toBe('Stop')
  })

  it('leaves named stops untouched and never chains placeholders', () => {
    const stops = {
      a: { name: 'Volkstheater', coord: AT(10) },
      x: { name: 'Stop', coord: AT(0) },
      y: { name: 'Stop', coord: AT(2) },
    }
    inheritUnnamedStopNames(stops)
    expect(stops.a.name).toBe('Volkstheater')
    // Both placeholders resolve against the NAMED stop, not each other
    expect(stops.x.name).toBe('Volkstheater')
    expect(stops.y.name).toBe('Volkstheater')
  })
})
