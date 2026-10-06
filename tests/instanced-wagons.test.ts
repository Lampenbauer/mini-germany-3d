// @ts-expect-error the app's tsconfig carries no node types; the GLBs are read from disk here alone
import { readFileSync } from 'node:fs'
import { Color, Matrix4, Transforms, Cartesian3 } from 'cesium'
import { describe, expect, it } from 'vitest'
import { InstancedWagons, WagonBatch, parseWagonGlb } from '@/map/InstancedWagons'

/**
 * The instanced wagons (see src/map/InstancedWagons.ts): the GLB read
 * into one primitive, and the per-instance buffer packed the way the
 * shader reads it. Nothing here touches a GL context – the batches build
 * their resources on the first frame drawn, which no test draws.
 */
const host = { requestRender: () => {}, tintAmount: 0.25, windowGlow: 0, night: 0 }
const never = new Promise<ArrayBuffer>(() => {})

function glb(name: string): ArrayBuffer {
  const buf = readFileSync(`public/models/${name}.glb`)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('parseWagonGlb', () => {
  it('reads the one primitive of a wagon, its axes turned the way Cesium turns a glTF', () => {
    const g = parseWagonGlb(glb('tram-mid'))
    expect(g.positions.length / 3).toBe(434)
    expect(g.normals.length).toBe(g.positions.length)
    expect(g.colors.length).toBe(434 * 4)
    expect(g.uvs.length).toBe(434 * 2)
    expect(g.indices.length).toBe(672)
    expect(g.palettePng.subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]))
    // glTF's Y up and Z forward became Cesium's Z up and X forward: the
    // 6 m long tram wagon runs along x, stands 3.5 m tall along z
    let maxX = 0
    let maxZ = 0
    for (let i = 0; i < g.positions.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(g.positions[i]))
      maxZ = Math.max(maxZ, Math.abs(g.positions[i + 2]))
    }
    expect(maxX).toBeGreaterThan(3)
    expect(maxZ).toBeLessThan(3)
    expect(maxZ).toBeGreaterThan(1)
    expect(g.radius).toBeGreaterThan(3)
  })

  it('refuses anything but a GLB', () => {
    expect(() => parseWagonGlb(new ArrayBuffer(32))).toThrow()
  })
})

describe('WagonBatch', () => {
  it('packs the pose, the tint and the opacity per slot, and frees a slot for the next wagon', () => {
    const batch = new WagonBatch('models/tram-mid.glb', host, never)
    const a = batch.allocate({ id: 'vehicle:a' })
    const b = batch.allocate({ id: 'vehicle:b' })
    expect([a, b]).toEqual([0, 1])
    expect(batch.count).toBe(2)
    // Hidden until written
    expect(batch.alphaOf(a)).toBe(0)
    const matrix = Transforms.headingPitchRollToFixedFrame(
      Cartesian3.fromDegrees(12.1, 54.1, 40),
      { heading: 0.5, pitch: 0, roll: 0 } as never,
    )
    Matrix4.multiplyByUniformScale(matrix, 2, matrix)
    batch.write(a, matrix, Color.fromCssColorString('#8040c0'), 1)
    expect(batch.alphaOf(a)).toBe(1)
    expect(batch.tintOf(a).red).toBeCloseTo(0x80 / 255, 6)
    const base = a * 20
    // The translation as high and low floats, exact in float32 together
    expect(batch.instances[base] + batch.instances[base + 3]).toBeCloseTo(matrix[12], 2)
    expect(batch.instances[base + 1] + batch.instances[base + 4]).toBeCloseTo(matrix[13], 2)
    expect(batch.instances[base + 2] + batch.instances[base + 5]).toBeCloseTo(matrix[14], 2)
    // The rotation's columns, scale included
    expect(batch.instances[base + 6]).toBeCloseTo(matrix[0], 6)
    expect(batch.instances[base + 10]).toBeCloseTo(matrix[5], 6)
    expect(batch.instances[base + 14]).toBeCloseTo(matrix[10], 6)
    // A ghost, then hidden, then released – and the slot comes back
    batch.write(b, matrix, Color.WHITE, 0.2)
    expect(batch.alphaOf(b)).toBeCloseTo(0.2, 6)
    batch.hide(b)
    expect(batch.alphaOf(b)).toBe(0)
    batch.release(b)
    expect(batch.allocate({ id: 'vehicle:c' })).toBe(b)
  })

  it('packs the shown wagons for the GPU, opaque first, ghosts after, the hidden ones not at all', () => {
    const batch = new WagonBatch('models/tram-mid.glb', host, never)
    const matrix = Matrix4.fromTranslation(Cartesian3.fromDegrees(12.1, 54.1, 40))
    const ghost = batch.allocate({ id: 'vehicle:ghost' })
    const hidden = batch.allocate({ id: 'vehicle:hidden' })
    const solid = batch.allocate({ id: 'vehicle:solid' })
    batch.write(ghost, matrix, Color.WHITE, 0.2)
    batch.write(hidden, matrix, Color.WHITE, 1)
    batch.hide(hidden)
    batch.write(solid, matrix, Color.WHITE, 1)
    batch.pack()
    // The opaque command draws the head, the translucent one the whole
    // (WebGL 2 has no base instance): the order is what makes both right
    expect(batch.drawnCount).toEqual({ opaque: 1, translucent: 1 })
    expect(batch.drawnAlphaAt(0)).toBe(1)
    expect(batch.drawnAlphaAt(1)).toBeCloseTo(0.2, 6)
  })

  it('grows past its first capacity', () => {
    const batch = new WagonBatch('models/bus.glb', host, never)
    for (let i = 0; i < 200; i++) batch.allocate({ id: `vehicle:${i}` })
    expect(batch.count).toBe(200)
    expect(batch.instances.length).toBeGreaterThanOrEqual(200 * 20)
  })

  it('is made once per model and listed', () => {
    const attached: WagonBatch[] = []
    const wagons = new InstancedWagons(host, () => never, (batch) => attached.push(batch))
    const first = wagons.batch('models/bus.glb')
    expect(wagons.batch('models/bus.glb')).toBe(first)
    wagons.batch('models/tram-end.glb')
    expect(attached).toHaveLength(2)
    expect(wagons.all.map((b) => b.uri)).toEqual(['models/bus.glb', 'models/tram-end.glb'])
    expect(first.ready).toBe(false)
  })
})
