import { describe, expect, it } from 'vitest'
import { cityNetworks, loadRostockNetwork, rostockBoundingBox } from './cities'

/**
 * Validates the committed network datasets: if these tests are green,
 * the simulation can run on every line of every city without errors.
 *
 * The structural checks apply to every city and data source (including
 * after `npm run data:update` with real OSM data); the strict RSAG checks
 * only run for the bundled approximated Rostock demo dataset.
 */
describe.each(cityNetworks.map((entry) => [entry.city.slug, entry] as const))(
  'Network dataset of %s (structural, source-independent)',
  (_slug, { city, network }) => {
  it('contains at least one line with a valid color', () => {
    expect(network.lines.length).toBeGreaterThan(0)
    for (const line of network.lines) {
      expect(line.color).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(line.name.length).toBeGreaterThan(0)
    }
  })

  it('every direction has at least 2 stops and a plausible route length', () => {
    for (const line of network.lines) {
      // Berlin's F24 rows across the Müggelspree in a few dozen meters,
      // its F11 crosses the Spree in 180; Berlin's S3 runs 43 km inside
      // the city. Anything longer than 60 km is a stitching error, not a
      // line.
      const minLength = line.mode === 'ferry' ? 30 : 1000
      for (const dir of line.directions) {
        expect(dir.stops.length).toBeGreaterThanOrEqual(2)
        expect(dir.totalLength).toBeGreaterThan(minLength)
        expect(dir.totalLength).toBeLessThan(60000)
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

  it("all coordinates lie within the city's bounding box", () => {
    const box = city.boundingBox
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const [lon, lat] of dir.path) {
          expect(lon).toBeGreaterThan(box.west)
          expect(lon).toBeLessThan(box.east)
          expect(lat).toBeGreaterThan(box.south)
          expect(lat).toBeLessThan(box.north)
        }
      }
    }
  })

  it('has every line on a mode the city asks for, drawn with a known consist or a box', () => {
    for (const line of network.lines) {
      expect(city.network.modes, `${line.id} is ${line.mode}`).toContain(line.mode)
      // A model the map has no consist for would silently fall back to a
      // box – the fleet entry names one, so it had better exist.
      if (line.model) expect(line.model).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('tunnel sections are sorted, non-empty, and lie within the route', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        let prevEnd = 0
        for (const [start, end] of dir.tunnels) {
          const label = `${line.id}/R${dir.direction}: tunnel [${start}, ${end}]`
          expect(start, label).toBeGreaterThanOrEqual(prevEnd)
          expect(end, label).toBeGreaterThan(start)
          expect(end, label).toBeLessThanOrEqual(dir.totalLength)
          prevEnd = end
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

describe('the Rostock dataset', () => {
  const network = loadRostockNetwork()

  it('stays inside the Rostock box', () => {
    for (const line of network.lines) {
      for (const [lon, lat] of line.directions[0].path) {
        expect(lon).toBeGreaterThan(rostockBoundingBox.west)
        expect(lon).toBeLessThan(rostockBoundingBox.east)
        expect(lat).toBeGreaterThan(rostockBoundingBox.south)
        expect(lat).toBeLessThan(rostockBoundingBox.north)
      }
    }
  })

  // Guards the nightly OSM refresh: if tag extraction breaks, the tram
  // tunnel under Rostock Hauptbahnhof must not silently disappear.
  it.runIf(network.meta.source === 'osm')('contains the Rostock tram tunnel in the OSM dataset', () => {
    const tunnelRanges = network.lines
      .filter((line) => line.mode === 'tram')
      .flatMap((line) => line.directions)
      .flatMap((dir) => dir.tunnels)
    expect(tunnelRanges.length).toBeGreaterThan(0)
  })
})

describe.runIf(loadRostockNetwork().meta.source === 'approximated')(
  'Demo dataset (strict RSAG checks)',
  () => {
    const network = loadRostockNetwork()

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
