import { describe, expect, it } from 'vitest'
import { loadBundledNetwork } from '@/data/network'

/**
 * Validates the bundled network dataset: if these tests are green,
 * the simulation can run on every line without errors.
 *
 * The structural checks apply to any data source (including after
 * `npm run data:update` with real OSM data); the strict RSAG checks
 * only run for the bundled approximated demo dataset.
 */
describe('Network dataset (structural, source-independent)', () => {
  const network = loadBundledNetwork()

  it('contains at least one line with a valid color', () => {
    expect(network.lines.length).toBeGreaterThan(0)
    for (const line of network.lines) {
      expect(line.color).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(line.name.length).toBeGreaterThan(0)
    }
  })

  it('every direction has at least 2 stops and a plausible route length', () => {
    for (const line of network.lines) {
      // The Gehlsdorf ferry crosses the Warnow in only ~500 m
      const minLength = line.mode === 'ferry' ? 200 : 1000
      for (const dir of line.directions) {
        expect(dir.stops.length).toBeGreaterThanOrEqual(2)
        expect(dir.totalLength).toBeGreaterThan(minLength)
        expect(dir.totalLength).toBeLessThan(30000)
      }
    }
  })

  it('stops are ordered monotonically along the route (both directions)', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (let i = 1; i < dir.stops.length; i++) {
          expect(
            dir.stops[i].dist,
            `${line.id}/R${dir.direction}: ${dir.stops[i - 1].id} → ${dir.stops[i].id}`,
          ).toBeGreaterThan(dir.stops[i - 1].dist)
        }
      }
    }
  })

  it('all coordinates lie within the Rostock city area', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const [lon, lat] of dir.path) {
          expect(lon).toBeGreaterThan(11.9)
          expect(lon).toBeLessThan(12.4)
          expect(lat).toBeGreaterThan(53.9)
          expect(lat).toBeLessThan(54.25)
        }
      }
    }
  })

  it('stop names are not empty', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          expect(stop.name.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe.runIf(loadBundledNetwork().meta.source === 'approximated')(
  'Demo dataset (strict RSAG checks)',
  () => {
    const network = loadBundledNetwork()

    it('contains the RSAG lines 1, 2, 3, 5, 6', () => {
      expect(network.lines.map((l) => l.id).sort()).toEqual(['1', '2', '3', '5', '6'])
    })

    it('has unique line colors', () => {
      const colors = network.lines.map((l) => l.color)
      expect(new Set(colors).size).toBe(colors.length)
    })

    it('first/last stop lie at the start/end of the route', () => {
      for (const line of network.lines) {
        for (const dir of line.directions) {
          expect(dir.stops[0].dist).toBeLessThan(50)
          expect(dir.totalLength - dir.stops[dir.stops.length - 1].dist).toBeLessThan(50)
        }
      }
    })

    it('terminal stops match the real RSAG network', () => {
      const byId = Object.fromEntries(
        network.lines.map((l) => [l.id, [l.directions[0].from, l.directions[0].to]]),
      )
      expect(byId['1']).toEqual(['Mecklenburger Allee', 'Hafenallee'])
      expect(byId['2']).toEqual(['Reutershagen', 'Kurt-Schumacher-Ring'])
      expect(byId['3']).toEqual(['Neuer Friedhof', 'Kurt-Schumacher-Ring'])
      expect(byId['5']).toEqual(['Mecklenburger Allee', 'Südblick'])
      expect(byId['6']).toEqual(['Neuer Friedhof', 'Campus Südstadt'])
    })
  },
)
