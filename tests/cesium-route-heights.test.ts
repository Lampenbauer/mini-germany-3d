import { Cartesian3, Cartographic, Entity } from 'cesium'
import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { CesiumMap } from '@/map/CesiumMap'
import { testNetworkJson } from './fixtures'

/**
 * Route polylines are no longer clamped onto the 3D tiles (that draped
 * them over tree canopies) – they follow the street baseline interpolated
 * from the measured stop heights.
 */

interface FakePolylineEntity {
  id?: string
  polyline?: {
    positions: Cartesian3[] | { getValue: (t?: unknown) => Cartesian3[] }
    depthFailMaterial?: unknown
    clampToGround?: boolean
  }
}

const network = prepareNetwork(testNetworkJson)

function harness() {
  const added: FakePolylineEntity[] = []
  const map = Object.create(CesiumMap.prototype) as CesiumMap
  Object.assign(map, {
    viewer: {
      entities: {
        add: (options: FakePolylineEntity) => {
          added.push(options)
          return options as unknown as Entity
        },
      },
    },
    routeEntities: new Map(),
    routePieces: [],
    defaultGroundHeight: 45,
    stopHeights: new Map(),
    heightProfilesDirty: false,
    network: null,
  })
  return { map, added }
}

const positionHeights = (entity: FakePolylineEntity): number[] => {
  const p = entity.polyline!.positions
  const positions = Array.isArray(p) ? p : p.getValue()
  return positions.map((c) => Cartographic.fromCartesian(c).height)
}

const internals = (map: CesiumMap) =>
  map as unknown as {
    network: unknown
    recordStopHeight: (stopId: string, height: number) => void
    refreshRouteHeights: () => void
    baselineHeightAt: (lineId: string, direction: 0 | 1, distance: number) => number | undefined
  }

describe('route polylines on the street baseline', () => {
  it('draws flat at the fallback height first, without ground clamping', () => {
    const { map, added } = harness()
    map.addRoutes(network)

    expect(added).toHaveLength(1) // direction 1 is a mirror
    expect(added[0].polyline!.clampToGround).toBeUndefined()
    expect(added[0].polyline!.depthFailMaterial).toBeDefined()
    for (const h of positionHeights(added[0])) {
      expect(h).toBeCloseTo(45.4, 1)
    }
  })

  it('follows the interpolated stop heights after the bootstrap', () => {
    const { map, added } = harness()
    map.addRoutes(network)
    const inner = internals(map)
    inner.network = network

    // Alpha 50 m, Beta 55 m (hill crest), Gamma 50 m (stops at ~0/1000/2000 m)
    inner.recordStopHeight('a', 50)
    inner.recordStopHeight('b', 55)
    inner.recordStopHeight('c', 50)
    inner.refreshRouteHeights()

    const heights = positionHeights(added[0])
    expect(heights[0]).toBeCloseTo(50.4, 0)
    expect(heights[1]).toBeCloseTo(55.4, 0)
    expect(heights[2]).toBeCloseTo(50.4, 0)

    // The baseline serves the vehicles too – halfway up the slope
    expect(inner.baselineHeightAt('T', 0, 500)).toBeCloseTo(52.5, 0)
    // Mirrored direction: same street, mirrored distances
    expect(inner.baselineHeightAt('T', 1, 500)).toBeCloseTo(52.5, 0)
  })

  it('ignores a canopy-contaminated stop anchor', () => {
    const { map } = harness()
    map.addRoutes(network)
    const inner = internals(map)
    inner.network = network

    inner.recordStopHeight('a', 50)
    inner.recordStopHeight('b', 63) // tree over the platform
    inner.recordStopHeight('c', 52)

    expect(inner.baselineHeightAt('T', 0, 1000)).toBeCloseTo(51, 0)
  })
})
