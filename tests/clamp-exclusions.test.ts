import { Cartesian3, PointPrimitiveCollection } from 'cesium'
import { describe, expect, it } from 'vitest'
import { expandClampExclusions, type ExpansionCache } from '@/map/clamp-exclusions'

/**
 * A clamp pick's exclusion list as Cesium honours it: a
 * PointPrimitiveCollection excludes nothing by itself (a pick matches the
 * point, its `primitive`, its `id`), so the list is expanded to the
 * points before the pick – the lanterns over the buoys taught this
 * (see clamp-exclusions.ts).
 */

function collectionOf(n: number): PointPrimitiveCollection {
  const collection = new PointPrimitiveCollection()
  for (let i = 0; i < n; i++) collection.add({ position: Cartesian3.fromDegrees(12 + i * 0.001, 54, 10) })
  return collection
}

describe('expandClampExclusions', () => {
  it('replaces a collection by its points and leaves everything else as it is', () => {
    const lights = collectionOf(3)
    const model = { name: 'a hull' }
    const cache: ExpansionCache = new WeakMap()
    const expanded = expandClampExclusions([model, lights], cache)
    expect(expanded).toHaveLength(4)
    expect(expanded[0]).toBe(model)
    for (let i = 0; i < 3; i++) expect(expanded[1 + i]).toBe(lights.get(i))
    // An empty collection contributes nothing
    expect(expandClampExclusions([collectionOf(0)], cache)).toEqual([])
  })

  it('keeps the expansion while the collection holds the same points, and rebuilds it when they change', () => {
    const lights = collectionOf(2)
    const cache: ExpansionCache = new WeakMap()
    const first = expandClampExclusions([lights], cache)
    const again = expandClampExclusions([lights], cache)
    expect(again).toEqual(first)
    expect(cache.get(lights)!.points).toBe(cache.get(lights)!.points)
    const before = cache.get(lights)!.points
    // A pool that grew: the new point joins
    lights.add({ position: Cartesian3.fromDegrees(12.5, 54, 10) })
    const grown = expandClampExclusions([lights], cache)
    expect(grown).toHaveLength(3)
    expect(cache.get(lights)!.points).not.toBe(before)
    // A collection rebuilt with the same count but new points: rebuilt too
    lights.removeAll()
    for (let i = 0; i < 3; i++) lights.add({ position: Cartesian3.fromDegrees(12 + i * 0.001, 54, 10) })
    const rebuilt = expandClampExclusions([lights], cache)
    expect(rebuilt).toHaveLength(3)
    for (let i = 0; i < 3; i++) expect(rebuilt[i]).toBe(lights.get(i))
  })
})
