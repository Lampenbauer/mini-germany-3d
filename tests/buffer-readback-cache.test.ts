import { describe, expect, it } from 'vitest'
import {
  READBACK_CACHE_LIMIT_BYTES,
  installBufferReadbackCache,
  readbackCacheInfo,
  type ReadbackBufferPrototype,
} from '@/map/buffer-readback-cache'

/**
 * A stand-in for Cesium's Buffer: the GPU side is a byte array, and
 * getBufferData copies out of it with WebGL's semantics (a byte offset
 * into the buffer, an element offset and length in the view). Each
 * test installs the cache on a fresh prototype.
 */
function stubBuffer(gpu: Uint8Array) {
  let readbacks = 0
  class Stub implements ReadbackBufferPrototype {
    get sizeInBytes() {
      return gpu.byteLength
    }
    getBufferData(view: ArrayBufferView, sourceOffset = 0, destinationOffset = 0, length?: number) {
      readbacks++
      const size = (view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1
      const count = length ? length : view.byteLength / size - destinationOffset
      new Uint8Array(view.buffer, view.byteOffset + destinationOffset * size, count * size).set(
        gpu.subarray(sourceOffset, sourceOffset + count * size),
      )
    }
    copyFromArrayView(view: ArrayBufferView, offsetInBytes = 0) {
      gpu.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offsetInBytes)
    }
  }
  installBufferReadbackCache(Stub.prototype)
  return { buffer: new Stub(), readbacks: () => readbacks }
}

describe('the GPU readback cache', () => {
  it('reads a buffer back from the GPU once and serves every later read from the copy', () => {
    const gpu = new Uint8Array(new Float32Array([1, 2, 3, 4, 5, 6]).buffer)
    const { buffer, readbacks } = stubBuffer(gpu)
    const positions = new Float32Array(6)
    buffer.getBufferData(positions)
    expect(Array.from(positions)).toEqual([1, 2, 3, 4, 5, 6])
    expect(readbacks()).toBe(1)
    // A read from an offset, into an offset, of a length – WebGL's semantics
    const tail = new Float32Array(4)
    buffer.getBufferData(tail, 8, 1, 3)
    expect(Array.from(tail)).toEqual([0, 3, 4, 5])
    // The rest of the view when no length is given
    const rest = new Float32Array(2)
    buffer.getBufferData(rest, 16)
    expect(Array.from(rest)).toEqual([5, 6])
    // The whole buffer as bytes, the way an interleaved read asks for it
    const bytes = new Uint8Array(gpu.byteLength)
    buffer.getBufferData(bytes)
    expect(Array.from(bytes)).toEqual(Array.from(gpu))
    expect(readbacks()).toBe(1)
    const info = readbackCacheInfo()
    expect(info.hits).toBeGreaterThanOrEqual(3)
  })

  it('drops the copy when the buffer is written to', () => {
    const gpu = new Uint8Array(new Uint16Array([10, 20, 30]).buffer)
    const { buffer, readbacks } = stubBuffer(gpu)
    const indices = new Uint16Array(3)
    buffer.getBufferData(indices)
    buffer.getBufferData(indices)
    expect(readbacks()).toBe(1)
    buffer.copyFromArrayView(new Uint16Array([99]), 2)
    buffer.getBufferData(indices)
    expect(Array.from(indices)).toEqual([10, 99, 30])
    expect(readbacks()).toBe(2)
  })

  it('starts over past its size limit rather than growing with the visit', () => {
    const before = readbackCacheInfo().bytes
    const big = new Uint8Array(READBACK_CACHE_LIMIT_BYTES / 2 + 1)
    const a = stubBuffer(big)
    const b = stubBuffer(new Uint8Array(big.byteLength))
    a.buffer.getBufferData(new Uint8Array(4))
    expect(readbackCacheInfo().bytes).toBe(before + big.byteLength)
    // The second copy would exceed the limit: the cache is emptied first
    b.buffer.getBufferData(new Uint8Array(4))
    expect(readbackCacheInfo().bytes).toBe(big.byteLength)
    a.buffer.getBufferData(new Uint8Array(4))
    expect(a.readbacks()).toBe(2)
  })

  it('installs once', () => {
    const { buffer, readbacks } = stubBuffer(new Uint8Array([1, 2, 3, 4]))
    installBufferReadbackCache(Object.getPrototypeOf(buffer))
    buffer.getBufferData(new Uint8Array(4))
    buffer.getBufferData(new Uint8Array(4))
    expect(readbacks()).toBe(1)
  })
})
