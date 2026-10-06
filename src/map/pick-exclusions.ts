/**
 * Everything in a scene but its tilesets, as an exclusion list for a pick
 * that spans frames and so cannot hide the rest for its pass the way
 * CesiumMap.clampToSurface does (see CesiumMap.tilesOnlyExclusions): every
 * primitive and everything in a collection, walked – Cesium matches a hit
 * against its primitive and its id, never against the collection around
 * it – and the entities given, which outlive the batch primitives they are
 * drawn with. Pure.
 */

/** What a primitive collection – and a billboard, label or point collection – offers. */
export interface PickCollection {
  readonly length: number
  get(index: number): unknown
}

function isCollection(item: object): item is PickCollection {
  const candidate = item as { length?: unknown; get?: unknown }
  return typeof candidate.get === 'function' && typeof candidate.length === 'number'
}

export function exclusionsButTiles(
  primitives: PickCollection,
  entities: readonly object[],
): object[] {
  const excluded: object[] = [...entities]
  const walk = (collection: PickCollection): void => {
    for (let i = 0; i < collection.length; i++) {
      const item = collection.get(i) as { isCesium3DTileset?: boolean } | undefined
      if (!item || item.isCesium3DTileset) continue
      excluded.push(item)
      if (isCollection(item)) walk(item)
    }
  }
  walk(primitives)
  return excluded
}
