/**
 * A cache in front of Cesium's GPU buffer readback.
 *
 * tileset.getHeight() – the camera collision on every frame the camera
 * moves (Cesium3DTileset.enableCollision), the bridge decks, the stops,
 * the webcams – answers with a CPU ray through the loaded tiles
 * (pickModel), and for every tile primitive whose bounding sphere the
 * ray hits it reads the positions and the indices back from the GPU
 * (Buffer.getBufferData → gl.getBufferSubData): Google's tiles keep no
 * copy of their vertex data in memory. Every read is a synchronous
 * round trip that drains the GPU pipeline – measured 2026-09-13 in
 * Chrome on this Mac at 2.2 ms for a tile's positions, nine to fifteen
 * of them a frame during a camera flight, a quarter of the flight's
 * wall time; in Firefox a round trip to the process that runs WebGL.
 * And the same tiles are read again on the next frame, and the next.
 *
 * So the first read of a buffer takes the whole buffer and keeps it;
 * later reads are served from the copy. A buffer is written to only
 * before its first draw (the tile's upload), so the copy cannot go
 * stale – and the writes Cesium has (copyFromArrayView, copyFromBuffer)
 * drop it all the same. The copies hang on the buffer objects (a
 * WeakMap) and go with them when the tiles unload; past
 * READBACK_CACHE_LIMIT_BYTES the whole cache is let go of and refilled
 * on demand, so a long visit cannot grow the heap by more than that.
 *
 * Installed once on Cesium's Buffer prototype by CesiumMap; the shape
 * it patches is the renderer's (cesium-renderer.ts) and pinned in
 * tests/buffer-readback-cache.test.ts on a stub.
 */

/** What the cache needs of Cesium's Buffer (Renderer/Buffer.js). */
export interface ReadbackBufferPrototype {
  readonly sizeInBytes: number
  /**
   * Cesium's signature: `sourceOffset` in bytes into the GPU buffer,
   * `destinationOffset` and `length` in elements of `arrayView`; no
   * length (or 0, WebGL's convention) is the rest of the view.
   */
  getBufferData(
    arrayView: ArrayBufferView,
    sourceOffset?: number,
    destinationOffset?: number,
    length?: number,
  ): void
  copyFromArrayView(arrayView: ArrayBufferView, offsetInBytes?: number): void
  copyFromBuffer?(...args: unknown[]): void
}

/** Copies held at most; past it the cache starts over. */
export const READBACK_CACHE_LIMIT_BYTES = 64 * 1024 * 1024

const INSTALLED = Symbol('buffer-readback-cache')

/** The cache's counters – for the debug API and the tests. */
export interface ReadbackCacheInfo {
  hits: number
  misses: number
  bytes: number
}

const info: ReadbackCacheInfo = { hits: 0, misses: 0, bytes: 0 }
let copies = new WeakMap<object, Uint8Array>()

export function readbackCacheInfo(): ReadbackCacheInfo {
  return { ...info }
}

/** Installs the cache on `proto` (Cesium's Buffer.prototype); a second call does nothing. */
export function installBufferReadbackCache(proto: ReadbackBufferPrototype): void {
  const flagged = proto as ReadbackBufferPrototype & { [INSTALLED]?: true }
  if (flagged[INSTALLED]) return
  flagged[INSTALLED] = true

  const readback = proto.getBufferData
  proto.getBufferData = function (
    this: ReadbackBufferPrototype,
    arrayView: ArrayBufferView,
    sourceOffset = 0,
    destinationOffset = 0,
    length?: number,
  ): void {
    let bytes = copies.get(this)
    if (bytes === undefined) {
      info.misses++
      bytes = new Uint8Array(this.sizeInBytes)
      readback.call(this, bytes)
      if (info.bytes + bytes.byteLength > READBACK_CACHE_LIMIT_BYTES) {
        copies = new WeakMap()
        info.bytes = 0
      }
      copies.set(this, bytes)
      info.bytes += bytes.byteLength
    } else {
      info.hits++
    }
    const elementSize = (arrayView as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1
    const viewLength = arrayView.byteLength / elementSize
    const count = length ? length : viewLength - destinationOffset
    new Uint8Array(
      arrayView.buffer,
      arrayView.byteOffset + destinationOffset * elementSize,
      count * elementSize,
    ).set(bytes.subarray(sourceOffset, sourceOffset + count * elementSize))
  }

  const forget = (buffer: object) => {
    const bytes = copies.get(buffer)
    if (bytes === undefined) return
    copies.delete(buffer)
    info.bytes -= bytes.byteLength
  }
  const write = proto.copyFromArrayView
  proto.copyFromArrayView = function (this: ReadbackBufferPrototype, ...args) {
    forget(this)
    return write.apply(this, args)
  }
  const copy = proto.copyFromBuffer
  if (copy) {
    proto.copyFromBuffer = function (this: ReadbackBufferPrototype, ...args) {
      forget(this)
      return copy.apply(this, args)
    }
  }
}
