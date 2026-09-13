/**
 * What a clamp pick (scene.clampToHeight) can be told to look past, and
 * what it actually honours. Cesium matches a pick against the object it
 * picked, that object's `primitive` and its `id` – and for a point that
 * is the PointPrimitive itself, never the PointPrimitiveCollection it
 * sits in (PointPrimitive.getPickId: `{ primitive: this, collection,
 * id }`; Picking.js isExcluded looks at `object`, `object.primitive`,
 * `object.id`). A collection on the list therefore excludes nothing on
 * its own, and every layer here puts its lights on the list as a
 * collection – the ships', the aircraft's, the airfield's, the buoys'.
 *
 * Found 2026-09-13 when the buoys' lanterns came on at 04:00: the pick
 * under a buoy goes straight down through the lantern that stands over
 * it, landed on it, and every load cycle lifted the mark by the
 * lantern's height again – by day, with the lanterns hidden, the marks
 * sat on the water. So the list is expanded before the pick: every
 * PointPrimitiveCollection replaced by its points, cached while the
 * collection holds the same points (the pools reuse theirs, a rebuilt
 * collection has new ones).
 */

import { PointPrimitiveCollection, type PointPrimitive } from 'cesium'

interface ExpandedPoints {
  length: number
  first: PointPrimitive | undefined
  points: PointPrimitive[]
}

/** The cache the expansion keeps per collection – one per map, handed in by the caller. */
export type ExpansionCache = WeakMap<PointPrimitiveCollection, ExpandedPoints>

/**
 * The exclusion list as Cesium can honour it: every
 * PointPrimitiveCollection replaced by its points, everything else as
 * it is. An empty collection contributes nothing.
 */
export function expandClampExclusions(exclude: readonly object[], cache: ExpansionCache): object[] {
  const out: object[] = []
  for (const object of exclude) {
    if (!(object instanceof PointPrimitiveCollection)) {
      out.push(object)
      continue
    }
    const length = object.length
    if (length === 0) continue
    const first = object.get(0)
    let expanded = cache.get(object)
    if (!expanded || expanded.length !== length || expanded.first !== first) {
      const points: PointPrimitive[] = []
      for (let i = 0; i < length; i++) points.push(object.get(i))
      expanded = { length, first, points }
      cache.set(object, expanded)
    }
    for (const point of expanded.points) out.push(point)
  }
  return out
}
