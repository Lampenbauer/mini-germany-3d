import { Cartographic, ConstantProperty, JulianDate, type Cartesian3, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import { prepareNetwork } from '@/data/network'
import type { NetworkJson } from '@/data/network-types'
import { RoutesLayer } from '@/map/RoutesLayer'

/**
 * Ferry route lines drape over the tiles' own water (clamped polylines)
 * where every other route is drawn at its profile height – and offline,
 * with no tiles to drape over, lie on the ellipsoid like the rest.
 */

interface AddedRoute {
  id: string
  polyline?: {
    positions?: Cartesian3[] | ConstantProperty
    clampToGround?: boolean
  }
}

/** A tram and a ferry on the same two piers, both with a height profile. */
function network(): NetworkJson {
  const path: [number, number][] = [
    [12.1, 54.0],
    [12.1, 54.009],
  ]
  const line = (id: string, mode: 'tram' | 'ferry', heights: number[]) => ({
    id,
    name: id,
    color: '#00aa88',
    mode,
    directions: [{ from: 'Alpha', to: 'Beta', path, stops: ['a', 'b'], heights }],
  })
  return {
    meta: { source: 'osm', attribution: 'test' },
    stops: {
      a: { name: 'Alpha', coord: [12.1, 54] },
      b: { name: 'Beta', coord: [12.1, 54.009] },
    },
    lines: [line('T', 'tram', [5, 8]), line('F', 'ferry', [0, 0])],
  }
}

function harness(offline: boolean) {
  const added: AddedRoute[] = []
  const viewer = {
    entities: {
      add: (options: AddedRoute) => {
        added.push(options)
        return options
      },
      remove: vi.fn(),
      suspendEvents: vi.fn(),
      resumeEvents: vi.fn(),
    },
    creditDisplay: { addStaticCredit: vi.fn(), removeStaticCredit: vi.fn() },
  } as unknown as Viewer
  const layer = new RoutesLayer(viewer, { requestRender: vi.fn(), offline })
  layer.add(prepareNetwork(network()))
  const piece = (lineId: string) => added.find((e) => e.id.startsWith(`route:${lineId}:`))!
  const heightsOf = (entity: AddedRoute): number[] => {
    const positions = entity.polyline?.positions
    const list =
      positions instanceof ConstantProperty
        ? (positions.getValue(JulianDate.now()) as Cartesian3[])
        : (positions as Cartesian3[])
    return list.map((p) => Cartographic.fromCartesian(p).height)
  }
  return { layer, piece, heightsOf }
}

describe('ferry route lines', () => {
  it('are clamped to the tiles while the tram rides its profile', () => {
    const h = harness(false)
    expect(h.piece('F').polyline?.clampToGround).toBe(true)
    expect(h.piece('T').polyline?.clampToGround).toBeUndefined()
    // The tram's profile: 5 and 8 m NHN plus the first-guess offset and lift
    const tram = h.heightsOf(h.piece('T'))
    expect(tram[1] - tram[0]).toBeCloseTo(3, 3)
  })

  it('lie on the ellipsoid offline like every other route', () => {
    const h = harness(true)
    expect(h.piece('F').polyline?.clampToGround).toBeUndefined()
    const ferry = h.heightsOf(h.piece('F'))
    ferry.forEach((height) => expect(height).toBeLessThan(2))
  })
})
