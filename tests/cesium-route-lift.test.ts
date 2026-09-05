import { Cartographic, ConstantProperty, JulianDate, type Cartesian3, type Viewer } from 'cesium'
import { describe, expect, it, vi } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { ROUTE_LIFT_SWITCH_HEIGHT, RoutesLayer } from '@/map/RoutesLayer'
import { testNetworkJson } from './fixtures'
import type { NetworkJson } from '@/data/network-types'

/**
 * The routes ride higher above the terrain the further up the camera is.
 */

interface AddedRoute {
  id: string
  polyline?: { positions?: Cartesian3[] | ConstantProperty }
}

function harness() {
  const added: AddedRoute[] = []
  const removed: AddedRoute[] = []
  const viewer = {
    entities: {
      add: (options: AddedRoute) => {
        added.push(options)
        return options
      },
      remove: (entity: AddedRoute) => {
        removed.push(entity)
        return true
      },
      suspendEvents: vi.fn(),
      resumeEvents: vi.fn(),
    },
    creditDisplay: { addStaticCredit: vi.fn(), removeStaticCredit: vi.fn() },
  } as unknown as Viewer
  const layer = new RoutesLayer(viewer, { requestRender: vi.fn(), offline: false })
  // A network with terrain heights: its pieces are drawn at absolute heights
  const withHeights: NetworkJson = JSON.parse(JSON.stringify(testNetworkJson))
  withHeights.lines[0].directions[0].heights = [5, 8, 11]
  layer.add(prepareNetwork(withHeights))
  const heightsOf = (entity: AddedRoute): number[] => {
    const positions = entity.polyline?.positions
    const list =
      positions instanceof ConstantProperty
        ? (positions.getValue(JulianDate.now()) as Cartesian3[])
        : (positions as Cartesian3[])
    return list.map((p) => Cartographic.fromCartesian(p).height)
  }
  return { layer, added, removed, viewer, heightsOf }
}

describe('route lift by camera height', () => {
  it('starts high, drops onto the road close to the ground and rises again further up', () => {
    const h = harness()
    const piece = h.added.find((e) => Array.isArray(e.polyline?.positions) || e.polyline?.positions)!
    const high = h.heightsOf(piece)
    expect(h.layer.currentBaseLift).toBe(0.8)

    h.layer.updateForCameraHeight(100)
    expect(h.layer.currentBaseLift).toBe(0.15)
    const low = h.heightsOf(piece)
    low.forEach((height, i) => expect(high[i] - height).toBeCloseTo(0.65, 3))

    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT + 200)
    expect(h.layer.currentBaseLift).toBe(0.8)
    h.heightsOf(piece).forEach((height, i) => expect(height).toBeCloseTo(high[i], 3))
  })

  it('holds the current lift inside the band around the switch height', () => {
    const h = harness()
    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT - 20)
    expect(h.layer.currentBaseLift).toBe(0.8)
    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT - 100)
    expect(h.layer.currentBaseLift).toBe(0.15)
    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT + 20)
    expect(h.layer.currentBaseLift).toBe(0.15)
  })
})

describe('clear()', () => {
  it('takes the routes down at once', () => {
    const h = harness()
    const count = h.added.length
    h.layer.clear()
    expect(h.removed).toHaveLength(count)
  })
})
