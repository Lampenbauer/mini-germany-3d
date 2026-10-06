/**
 * Cesium's Heap keeps a reference past its end.
 *
 * RequestScheduler queues a frame's tile requests in a Heap capped at
 * priorityHeapLength (20). An insert past the cap pushes a request out –
 * cancelled and handed back – but Heap.insert only shortens the heap's
 * length and leaves the request in the backing array, at the index of the
 * cap, until the next insert past the cap overwrites it (Core/Heap.js,
 * Cesium 1.144 and 1.146). A request holds its priorityFunction, a closure
 * over its tile, and a tile holds its tileset: the tileset a city switch
 * left behind – destroyed, its content freed – stayed alive through that
 * one slot with its whole tree, 255 000 tiles and some 600 MB of heap after
 * Rostock → Berlin at 1600×1000 CSS px, until a later view queued more than
 * twenty requests at once and overwrote it. Smaller windows (1400×875 and
 * down) never filled the queue and never showed it. Found with a heap
 * snapshot – the window → Cesium's module scope → requestHeap → _array[20]
 * → Request → priorityFunction → tile → _tileset; a search through the
 * objects' properties could not see it, the queue being a module variable
 * (see replaceTileset in CesiumMap for the swap that lets a tileset go).
 *
 * The insert is wrapped to clear the slot it vacates. Installed once on
 * Heap.prototype by CesiumMap; tests/heap-trailing-reference.test.ts pins
 * it on Cesium's own Heap, and fails the day Cesium clears the slot itself
 * – then this module can go.
 */

/** What the fix needs of Cesium's Heap (Core/Heap.js). */
export interface HeapPrototype {
  insert(element: unknown): unknown
}

/** The fields of a Heap the fix writes to. */
interface HeapFields {
  _array: unknown[]
  _length: number
}

const INSTALLED = Symbol('heap-trailing-reference')

/** Installs the fix on `proto` (Cesium's Heap.prototype); a second call does nothing. */
export function installHeapTrailingReferenceFix(proto: HeapPrototype): void {
  const flagged = proto as HeapPrototype & { [INSTALLED]?: true }
  if (flagged[INSTALLED]) return
  flagged[INSTALLED] = true

  const insert = proto.insert
  proto.insert = function (this: HeapPrototype & HeapFields, element: unknown): unknown {
    const removed = insert.call(this, element)
    // Pushed out by the cap: it sat at the index the length came back to
    if (removed !== undefined) this._array[this._length] = undefined
    return removed
  }
}
