import { describe, expect, it } from 'vitest'
import { renderer } from '@/map/cesium-renderer'
import { installHeapTrailingReferenceFix } from '@/map/heap-trailing-reference'

/**
 * On Cesium's own Heap, the one RequestScheduler queues tile requests in:
 * an element an insert pushes out past the cap stays in the backing array
 * until the next one overwrites it, and through a request's closure a
 * tileset the map had let go of stayed alive (heap-trailing-reference.ts).
 * The first half is Cesium's behaviour itself – it fails the day Cesium
 * clears the slot on its own, and the fix can go then.
 */
interface Request {
  priority: number
}

const capped = () => {
  const heap = new renderer.Heap<Request>({ comparator: (a, b) => a.priority - b.priority })
  heap.maximumLength = 2
  return heap
}

describe('the request heap’s trailing reference', () => {
  it('Cesium keeps what an insert pushes out, the fix lets it go', () => {
    const near = { priority: 1 }
    const mid = { priority: 2 }
    const far = { priority: 3 }

    const before = capped()
    before.insert(near)
    before.insert(mid)
    expect(before.insert(far)).toBe(far)
    expect(before.length).toBe(2)
    expect(before.internalArray[2]).toBe(far)

    installHeapTrailingReferenceFix(renderer.Heap.prototype)
    const wrapped = renderer.Heap.prototype.insert
    installHeapTrailingReferenceFix(renderer.Heap.prototype)
    expect(renderer.Heap.prototype.insert).toBe(wrapped)

    const after = capped()
    after.insert(near)
    after.insert(mid)
    expect(after.insert(far)).toBe(far)
    expect(after.length).toBe(2)
    expect(after.internalArray[2]).toBeUndefined()
    // The queue itself is what it was
    expect(after.pop()).toBe(near)
    expect(after.pop()).toBe(mid)
    expect(after.pop()).toBeUndefined()
  })

  it('clears the slot whichever element the cap pushes out', () => {
    installHeapTrailingReferenceFix(renderer.Heap.prototype)
    const heap = capped()
    const first = { priority: 1 }
    const second = { priority: 2 }
    const urgent = { priority: 0 }
    heap.insert(first)
    heap.insert(second)
    // The urgent one sifts to the top, and what stands at the cap goes
    const out = heap.insert(urgent)
    expect(out).toBeDefined()
    expect(out).not.toBe(urgent)
    expect(heap.length).toBe(2)
    expect(heap.internalArray[2]).toBeUndefined()
    expect(heap.pop()).toBe(urgent)
  })
})
