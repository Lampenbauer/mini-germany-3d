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

function harness(flat = { flatGround: false }) {
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
  const layer = new RoutesLayer(viewer, {
    requestRender: vi.fn(),
    offline: false,
    get flatGround() {
      return flat.flatGround
    },
  })
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
    expect(h.layer.currentBaseLift).toBe(0.3)
    const low = h.heightsOf(piece)
    low.forEach((height, i) => expect(high[i] - height).toBeCloseTo(0.5, 3))

    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT + 200)
    expect(h.layer.currentBaseLift).toBe(0.8)
    h.heightsOf(piece).forEach((height, i) => expect(height).toBeCloseTo(high[i], 3))
  })

  it('holds the current lift inside the band around the switch height', () => {
    const h = harness()
    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT - 20)
    expect(h.layer.currentBaseLift).toBe(0.8)
    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT - 100)
    expect(h.layer.currentBaseLift).toBe(0.3)
    h.layer.updateForCameraHeight(ROUTE_LIFT_SWITCH_HEIGHT + 20)
    expect(h.layer.currentBaseLift).toBe(0.3)
  })
})

describe('the flat map', () => {
  it('flattens every height-based piece to the lift alone, and relayout() brings the profile back', () => {
    const flat = { flatGround: false }
    const h = harness(flat)
    const piece = h.added.find((e) => e.polyline?.positions)!
    // The profile plus the offset plus the far lift, as drawn
    const profiled = h.heightsOf(piece)
    expect(profiled[1] - profiled[0]).toBeCloseTo(3, 3)

    // The ground became a plane (CesiumMap.setBasemap): 0 m plus the lift
    flat.flatGround = true
    h.layer.relayout()
    h.heightsOf(piece).forEach((height) => expect(height).toBeCloseTo(0.8, 3))
    // The lift still follows the camera on the plane
    h.layer.updateForCameraHeight(100)
    h.heightsOf(piece).forEach((height) => expect(height).toBeCloseTo(0.3, 3))

    // And the tiles again: the profile is where it was, at the near lift
    flat.flatGround = false
    h.layer.relayout()
    h.heightsOf(piece).forEach((height, i) => expect(height).toBeCloseTo(profiled[i] - 0.5, 3))
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
