import { type BillboardCollection, Cartesian3, Matrix4, type Viewer } from 'cesium'
import { vi } from 'vitest'
import type { PreparedNetwork } from '@/data/network-types'
import { StopsLayer } from '@/map/StopsLayer'

export interface FakeStopSpec {
  id: string
  name: string
  lon: number
  lat: number
  /** Lines serving this stop – drives the line-visibility rules. */
  lines: string[]
  nhn?: number
}

/**
 * Minimal PreparedNetwork for the stops layer: it only ever reads the line
 * ids and each direction's stops, so the rest of a real network (paths,
 * cumulative distances, tunnels) would be dead weight here.
 */
export function networkOf(stops: FakeStopSpec[]): PreparedNetwork {
  const lineIds = [...new Set(stops.flatMap((s) => s.lines))]
  const lines = lineIds.map((id) => {
    const served = stops
      .filter((s) => s.lines.includes(id))
      .map((s) => ({ id: s.id, name: s.name, coord: [s.lon, s.lat], dist: 0, nhn: s.nhn }))
    const direction = { stops: served }
    return { id, directions: [direction, direction] }
  })
  return { lines } as unknown as PreparedNetwork
}

/**
 * A real StopsLayer on a fake viewer. Discs and name plates land in a real
 * BillboardCollection, so the tests read the layer's output the same way
 * the scene would.
 */
export function stopsHarness(
  stops: FakeStopSpec[],
  opts: { cameraHeight?: number; hasTileset?: boolean } = {},
) {
  const primitives: unknown[] = []
  const camera = {
    positionWC: Cartesian3.fromDegrees(stops[0]?.lon ?? 12.1, stops[0]?.lat ?? 54.0, opts.cameraHeight ?? 500),
    // The declutter skips a pass while this matrix is unchanged
    viewMatrix: Matrix4.clone(Matrix4.IDENTITY),
  }
  const viewer = {
    camera,
    scene: { primitives: { add: (p: unknown) => primitives.push(p) } },
  } as unknown as Viewer

  const sampleGroundHeight = vi.fn<(lon: number, lat: number) => number | undefined>(
    () => undefined,
  )
  const requestRender = vi.fn()
  const layer = new StopsLayer(viewer, {
    requestRender,
    sampleGroundHeight,
    defaultGroundHeight: 45,
    hasTileset: opts.hasTileset ?? true,
    pixelRatio: 1,
  })
  layer.add(networkOf(stops))

  const collection = primitives[0] as BillboardCollection
  const count = stops.length
  /** Disc billboard of the nth stop (discs are added before all names). */
  const disc = (index: number) => collection.get(index)
  /** Name plate of the nth stop (added after every disc). */
  const label = (index: number) => collection.get(count + index)

  return { layer, collection, disc, label, camera, sampleGroundHeight, requestRender, count }
}
