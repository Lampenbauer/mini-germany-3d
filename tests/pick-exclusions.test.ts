import { describe, expect, it } from 'vitest'
import { exclusionsButTiles, type PickCollection } from '@/map/pick-exclusions'

/**
 * The calibration's pick sees the tiles alone: everything else in the
 * scene, walked through its collections, goes on the exclusion list.
 */

const collection = (...items: object[]): PickCollection & { items: object[] } => ({
  items,
  length: items.length,
  get: (index: number) => items[index],
})

describe('exclusionsButTiles', () => {
  it('lists every primitive and entity but the tileset, collections walked', () => {
    const tileset = { isCesium3DTileset: true }
    const routeBatch = { name: 'route batch primitive' }
    const dataSources = collection(collection(routeBatch))
    const label = { name: 'stop name' }
    const labels = collection(label)
    const model = { name: 'a hull' }
    const fleet = collection(collection(model))
    const entity = { id: 'route:S1:0:0' }
    const excluded = exclusionsButTiles(collection(tileset, dataSources, labels, fleet), [entity])
    expect(excluded).not.toContain(tileset)
    for (const item of [entity, routeBatch, label, labels, model, fleet, dataSources]) {
      expect(excluded).toContain(item)
    }
  })

  it('leaves a tileset inside a collection out as well, and skips empty slots', () => {
    const replacement = { isCesium3DTileset: true }
    const nested = collection(replacement)
    const excluded = exclusionsButTiles(
      { length: 2, get: (index: number) => (index === 0 ? nested : undefined) },
      [],
    )
    expect(excluded).toEqual([nested])
  })
})
