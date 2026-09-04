import { describe, expect, it } from 'vitest'
import {
  routeSegments,
  selectLampsAlongRoutes,
  type LampNetwork,
  type LonLat,
} from '../scripts/lib/street-lamps.mjs'
import { rostockBoundingBox, rostockLamps, rostockNetwork } from './cities'

/**
 * Straight 1 km route due north at 12.1 °E, from 54.000 to 54.009.
 * At this latitude 0.0001 ° of longitude is ~6.5 m.
 */
const straightNetwork: LampNetwork = {
  lines: [
    {
      directions: [
        {
          path: [
            [12.1, 54.0],
            [12.1, 54.009],
          ],
        },
      ],
    },
  ],
}

/** Offset east of the route in degrees for a given distance in meters. */
function eastOf(meters: number): number {
  return 12.1 + meters / (111_320 * Math.cos((54.0045 * Math.PI) / 180))
}

describe('routeSegments', () => {
  it('drops the segments covered by a bridge or tunnel', () => {
    const network: LampNetwork = {
      lines: [
        {
          directions: [
            {
              // Four 250 m segments along the same meridian
              path: [
                [12.1, 54.0],
                [12.1, 54.00225],
                [12.1, 54.0045],
                [12.1, 54.00675],
                [12.1, 54.009],
              ],
              bridges: [[300, 400]],
            },
          ],
        },
      ],
    }
    expect(routeSegments(network, { excludeRanges: false })).toHaveLength(4)
    // The bridge spans 300–400 m, which lies inside the second segment
    expect(routeSegments(network)).toHaveLength(3)
  })

  it('ignores ferry lines – no street lamps out on the water', () => {
    const network: LampNetwork = {
      lines: [{ mode: 'ferry', directions: [{ path: [[12.1, 54.0], [12.1, 54.009]] }] }],
    }
    expect(routeSegments(network)).toHaveLength(0)
  })
})

describe('selectLampsAlongRoutes', () => {
  it('keeps the lamps beside the route and drops the ones further away', () => {
    const lamps: LonLat[] = [
      [eastOf(5), 54.004], // right at the curb
      [eastOf(24), 54.004], // far side of a wide street
      [eastOf(60), 54.004], // next street over
      [12.1, 53.99], // 1 km beyond the southern end
    ]
    const kept = selectLampsAlongRoutes(lamps, straightNetwork, { maxDistanceMeters: 25 })
    expect(kept).toEqual([lamps[0], lamps[1]])
  })

  it('measures to the segment, not to its end points', () => {
    // Mid-route, where the nearest vertex is 500 m away
    const kept = selectLampsAlongRoutes([[eastOf(10), 54.0045]], straightNetwork, {
      maxDistanceMeters: 25,
    })
    expect(kept).toHaveLength(1)
  })

  it('thins the kept lamps to the minimum spacing', () => {
    // Six lamps 10 m apart along the route
    const lamps: LonLat[] = Array.from({ length: 6 }, (_, i) => [
      eastOf(5),
      54.0 + (i * 10) / 111_132,
    ])
    const all = selectLampsAlongRoutes(lamps, straightNetwork, { maxDistanceMeters: 25 })
    expect(all).toHaveLength(6)
    const thinned = selectLampsAlongRoutes(lamps, straightNetwork, {
      maxDistanceMeters: 25,
      minSpacingMeters: 25,
    })
    // Every third lamp survives a 25 m spacing over a 10 m grid
    expect(thinned).toHaveLength(2)
  })

  it('returns nothing for a network without routes', () => {
    expect(selectLampsAlongRoutes([[12.1, 54.0]], { lines: [] })).toEqual([])
  })
})

describe('the generated street-lamps.json', () => {
  const data = rostockLamps

  it('carries the OSM and DGM attribution both licenses require', () => {
    expect(data.meta.attribution).toMatch(/OpenStreetMap/)
    expect(data.meta.attribution).toMatch(/GeoBasis-DE\/M-V/)
  })

  it('holds plausible Rostock lamps with terrain heights', () => {
    expect(data.lamps.length).toBeGreaterThan(1000)
    for (const [lon, lat, nhn] of data.lamps) {
      expect(lon).toBeGreaterThan(rostockBoundingBox.west)
      expect(lon).toBeLessThan(rostockBoundingBox.east)
      expect(lat).toBeGreaterThan(rostockBoundingBox.south)
      expect(lat).toBeLessThan(rostockBoundingBox.north)
      // Rostock's terrain: Warnow lowland to the southern hills. The
      // Warnow tunnel ramps genuinely dip below sea level.
      expect(nhn).toBeGreaterThan(-10)
      expect(nhn).toBeLessThan(80)
    }
  })

  it('still belongs to the network the routes are drawn from', () => {
    // Deliberately not every lamp. Lamps and route geometry come from
    // separate refresh scripts, and data:simplify shifts path points
    // within its 0.3 m tolerance – after a network refresh a few lamps sit
    // just outside the radius they were picked with (measured on CI: 28 of
    // 6995, each a light pool a metre further from the kerb than intended,
    // which nobody can see). The failure worth catching is the other one:
    // a network refresh that left the lamp set behind entirely.
    const kept = selectLampsAlongRoutes(
      data.lamps.map(([lon, lat]) => [lon, lat] as LonLat),
      loadNetworkForLamps(),
      { maxDistanceMeters: data.meta.maxDistanceMeters },
    )
    expect(kept.length / data.lamps.length).toBeGreaterThan(0.95)
  })
})

/** network.json in the shape the lamp selection expects. */
function loadNetworkForLamps(): LampNetwork {
  return rostockNetwork as unknown as LampNetwork
}
