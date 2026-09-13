import { describe, expect, it } from 'vitest'
import { AIRCRAFT } from '../scripts/lib/aircraft-fleet.mjs'
import { VESSELS } from '../scripts/lib/vessel-fleet.mjs'
import { FLEET, HEIGHTS } from '../scripts/lib/vehicle-fleet.mjs'
import {
  MATERIALS,
  PALETTE_MATERIAL,
  box,
  bodyProfile,
  createMesh,
  extrude,
  paletteTexturePng,
  toGlb,
  triangleCount,
  wheel,
} from '../scripts/lib/vehicle-mesh.mjs'

/** Expected bounding dimensions per generated file (length, width, height). */
const EXPECTED: Record<string, { length: number; width: number; height: number }> = {
  'tram-end': { length: 6.55, width: 2.65, height: HEIGHTS.tram },
  'tram-end-rear': { length: 6.55, width: 2.65, height: HEIGHTS.tram },
  'tram-mid': { length: 6.1, width: 2.65, height: HEIGHTS.tram },
  'tram-mid-panto': { length: 6.1, width: 2.65, height: HEIGHTS.tram },
  'sbahn-end': { length: 18.6, width: 2.92, height: HEIGHTS.train },
  'sbahn-mid-panto': { length: 18.9, width: 2.92, height: HEIGHTS.train },
  bus: { length: 12, width: 2.55, height: HEIGHTS.bus },
  // Per-line vessel dimensions from network.json (FG and FW)
  'ferry-fg': { length: 19.9, width: 6.6, height: 3.5 },
  'ferry-fw': { length: 39, width: 11, height: 6 },
  // Berlin: the third-rail subway sections (U-Bahn BR H, S-Bahn BR 481)
  'ubahn-end': { length: 13.0, width: 2.6, height: HEIGHTS.subway },
  'ubahn-mid': { length: 13.0, width: 2.6, height: HEIGHTS.subway },
}

/** Face normals must point away from the enclosed volume – a face wound
 * the wrong way is simply invisible in glTF's single-sided rendering,
 * which is exactly how the first fleet lost every window. */
function outwardness(group: { positions: number[]; normals: number[] }, center: number[]) {
  const results: number[] = []
  for (let quadIndex = 0; quadIndex * 12 < group.positions.length; quadIndex++) {
    const vi = quadIndex * 4
    const cx = (group.positions[vi * 3] + group.positions[(vi + 2) * 3]) / 2 - center[0]
    const cy = (group.positions[vi * 3 + 1] + group.positions[(vi + 2) * 3 + 1]) / 2 - center[1]
    const cz = (group.positions[vi * 3 + 2] + group.positions[(vi + 2) * 3 + 2]) / 2 - center[2]
    results.push(
      cx * group.normals[vi * 3] + cy * group.normals[vi * 3 + 1] + cz * group.normals[vi * 3 + 2],
    )
  }
  return results
}

describe('mesh primitives', () => {
  it('winds every box face outward', () => {
    const mesh = createMesh()
    box(mesh, 'body', 3, -2, 5, 2, 2, 2)
    for (const dot of outwardness(mesh.groups.get('body')!, [3, -2, 5])) {
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('winds every wheel face outward and puts the contact patch on the ground', () => {
    const mesh = createMesh()
    wheel(mesh, 1.04, -1.05, 3.2, 0.5, 0.3, 1)
    for (const [, g] of mesh.groups) {
      // The first 8 quads are the prism walls; radial outwardness in Y/Z
      // (the axle runs along X)
      for (let f = 0; f < 8; f++) {
        const vi = f * 4
        const dot =
          ((g.positions[vi * 3 + 1] + g.positions[(vi + 2) * 3 + 1]) / 2 - -1.05) *
            g.normals[vi * 3 + 1] +
          ((g.positions[vi * 3 + 2] + g.positions[(vi + 2) * 3 + 2]) / 2 - 3.2) *
            g.normals[vi * 3 + 2]
        expect(dot).toBeGreaterThan(0)
      }
      // After the walls (48 indices) come the two cap fans: their index
      // winding must agree with their stated ±X normal, or glTF's
      // single-sided rendering simply drops the whole cap.
      for (const triStart of [48, 48 + 24]) {
        const [ia, ib, ic] = [g.indices[triStart], g.indices[triStart + 1], g.indices[triStart + 2]]
        const p = (v: number) => [g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]]
        const [a, b, c] = [p(ia), p(ib), p(ic)]
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
        const windingX = u[1] * v[2] - u[2] * v[1]
        expect(Math.sign(windingX)).toBe(Math.sign(g.normals[ia * 3]))
      }
    }
    // The tire's flat bottom is the mesh's ground contact
    let minY = Infinity
    for (const g of mesh.groups.values()) {
      for (let i = 1; i < g.positions.length; i += 3) minY = Math.min(minY, g.positions[i])
    }
    expect(minY).toBeCloseTo(-1.55, 5)
  })

  it('winds extrusion walls outward', () => {
    const mesh = createMesh()
    extrude(mesh, bodyProfile(2, -1, 1, 0.2), [{ z: -2 }, { z: 2 }], { material: 'body' })
    const g = mesh.groups.get('body')!
    // 8 wall quads before the caps; radial outwardness in X/Y only
    for (let f = 0; f < 8; f++) {
      const vi = f * 4
      const dot =
        ((g.positions[vi * 3] + g.positions[(vi + 2) * 3]) / 2) * g.normals[vi * 3] +
        ((g.positions[vi * 3 + 1] + g.positions[(vi + 2) * 3 + 1]) / 2) * g.normals[vi * 3 + 1]
      expect(dot).toBeGreaterThan(0)
    }
  })
})

/** The JSON chunk of a GLB. */
function glbJson(glb: Uint8Array) {
  const view = new DataView(glb.buffer, glb.byteOffset)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)))
}

describe('the palette texture', () => {
  it('is a PNG any decoder reads, one RGB texel per material with roughness in green and metalness in blue', () => {
    const names = ['body', 'glass', 'chassis']
    const png = paletteTexturePng(names)
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR: 3 × 1 pixels, 8 bits, RGB
    const view = new DataView(png.buffer, png.byteOffset)
    expect(view.getUint32(16)).toBe(3)
    expect(view.getUint32(20)).toBe(1)
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(2)
    // IDAT: a zlib stream of one stored block – header, block, texels,
    // Adler-32 – one filter byte then the texels (sharp decoded it the
    // same way when the writer was built)
    const idatLength = view.getUint32(33)
    expect(new TextDecoder().decode(png.subarray(37, 41))).toBe('IDAT')
    const zlib = png.subarray(41, 41 + idatLength)
    expect((zlib[0] * 256 + zlib[1]) % 31).toBe(0)
    expect(zlib[2]).toBe(1) // final, stored
    const length = zlib[3] + zlib[4] * 256
    expect(zlib[5] + zlib[6] * 256).toBe(0xffff - length)
    const raw = zlib.subarray(7, 7 + length)
    expect(raw[0]).toBe(0)
    expect(Array.from(raw.subarray(1))).toEqual(
      names.flatMap((n) => [255, Math.round(MATERIALS[n].roughness * 255), Math.round(MATERIALS[n].metallic * 255)]),
    )
    let a = 1
    let b = 0
    for (const byte of raw) {
      a = (a + byte) % 65521
      b = (b + a) % 65521
    }
    expect(new DataView(zlib.buffer, zlib.byteOffset).getUint32(7 + length)).toBe(((b << 16) | a) >>> 0)
    // Byte-stable: the same materials give the same bytes
    expect(Array.from(paletteTexturePng(names))).toEqual(Array.from(png))
  })

  it('keeps a see-through material out of the merge, as a blended primitive of its own', () => {
    const mesh = createMesh()
    box(mesh, 'body', 0, 0, 0, 1, 1, 1)
    box(mesh, 'rotor', 0, 1, 0, 2, 0.1, 2)
    const json = glbJson(toGlb(mesh, { name: 'probe' }))
    expect(json.materials.map((m: { name: string }) => m.name)).toEqual([PALETTE_MATERIAL, 'rotor'])
    expect(json.materials[1]).toMatchObject({ alphaMode: 'BLEND', doubleSided: true })
    const [merged, rotor] = json.meshes[0].primitives
    expect(merged.material).toBe(0)
    expect(rotor.material).toBe(1)
    expect(Object.keys(rotor.attributes).sort()).toEqual(['NORMAL', 'POSITION'])
  })
})

describe('the generated fleet', () => {
  it('has expected dimensions declared for every mesh', () => {
    // A new mesh without a row above would otherwise fail three tests
    // with a TypeError instead of saying what is missing
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(FLEET).sort())
  })

  for (const [name, buildMesh] of Object.entries(FLEET)) {
    describe(name, () => {
      const mesh = buildMesh()
      const glb = toGlb(mesh, { name })
      const expected = EXPECTED[name]

      it('matches the real vehicle dimensions', () => {
        let min = [Infinity, Infinity, Infinity]
        let max = [-Infinity, -Infinity, -Infinity]
        for (const g of mesh.groups.values()) {
          for (let i = 0; i < g.positions.length; i += 3) {
            for (let k = 0; k < 3; k++) {
              min[k] = Math.min(min[k], g.positions[i + k])
              max[k] = Math.max(max[k], g.positions[i + k])
            }
          }
        }
        // Length along Z within a bellows/mirror tolerance, width along X
        // (window panes ride 2 cm proud), height centered on the origin
        expect(max[2] - min[2]).toBeGreaterThan(expected.length - 0.1)
        expect(max[2] - min[2]).toBeLessThan(expected.length + 0.3)
        expect(max[0] - min[0]).toBeLessThan(expected.width + 0.1)
        expect(max[1]).toBeLessThanOrEqual(expected.height / 2 + 1e-6)
        expect(min[1]).toBeCloseTo(-expected.height / 2, 5)
      })

      it('stays within its geometry and file-size budget', () => {
        const ferry = name.startsWith('ferry-')
        expect(triangleCount(mesh)).toBeLessThan(ferry ? 4500 : 800)
        expect(glb.byteLength).toBeLessThan((ferry ? 240 : 64) * 1024)
      })

      it('is a well-formed binary glTF', () => {
        const view = new DataView(glb.buffer, glb.byteOffset)
        expect(view.getUint32(0, true)).toBe(0x46546c67) // 'glTF'
        expect(view.getUint32(8, true)).toBe(glb.byteLength)
        const jsonLength = view.getUint32(12, true)
        expect(jsonLength % 4).toBe(0)
        const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)))
        expect(json.asset.version).toBe('2.0')
        // Every material is the merged palette material or a defined
        // palette entry (a blended one, drawn on its own)
        for (const material of json.materials) {
          if (material.name !== PALETTE_MATERIAL) expect(MATERIALS).toHaveProperty(material.name)
        }
        // Buffer views stay inside the binary chunk
        const binLength = view.getUint32(20 + jsonLength, true)
        for (const bufferView of json.bufferViews) {
          expect(bufferView.byteOffset + bufferView.byteLength).toBeLessThanOrEqual(binLength)
        }
      })

      it('draws every opaque material of a part in one primitive, coloured per vertex', () => {
        const json = glbJson(glb)
        // None of the land fleet is see-through: one primitive per node
        for (const m of json.meshes) expect(m.primitives).toHaveLength(1)
        const primitive = json.meshes[0].primitives[0]
        expect(primitive.material).toBe(json.materials.findIndex((m: { name: string }) => m.name === PALETTE_MATERIAL))
        expect(Object.keys(primitive.attributes).sort()).toEqual(['COLOR_0', 'NORMAL', 'POSITION', 'TEXCOORD_0'])
        const color = json.accessors[primitive.attributes.COLOR_0]
        expect(color).toMatchObject({ componentType: 5121, normalized: true, type: 'VEC4' })
        const uv = json.accessors[primitive.attributes.TEXCOORD_0]
        expect(uv).toMatchObject({ componentType: 5123, normalized: true, type: 'VEC2' })
        expect(color.count).toBe(json.accessors[primitive.attributes.POSITION].count)
        // The palette material reads its metalness and roughness off the texture
        const palette = json.materials.find((m: { name: string }) => m.name === PALETTE_MATERIAL)
        expect(palette.pbrMetallicRoughness).toEqual({
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 1,
          roughnessFactor: 1,
          metallicRoughnessTexture: { index: 0 },
        })
        // One texel per material, sampled nearest so a texel is never a blend
        expect(json.images).toHaveLength(1)
        expect(json.samplers[0]).toEqual({ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 })
        expect(json.images[0].mimeType).toBe('image/png')
        const group = mesh.groups.get('body')!
        const vertexCount = group.positions.length / 3
        expect(vertexCount).toBeGreaterThan(0)
      })
    })
  }

  /**
   * Two faces on the same plane, facing the same way, overlapping in
   * area, z-fight into camera-dependent speckle – exactly how the doors
   * used to flicker: the window band ran on behind every door with its
   * outer face exactly coplanar with the leaf. Triangles that merely tile
   * a surface share edges at zero overlap area, so only real double-draws
   * trip this.
   */
  it('has no coplanar overlapping faces on any car', () => {
    for (const [name, buildMesh] of Object.entries(FLEET)) {
      type Tri = { sign: number; poly: [number, number][]; material: string }
      /** plane key "axis:coord" → triangles on it */
      const planes = new Map<string, Tri[]>()
      for (const [material, g] of buildMesh().groups) {
        for (let i = 0; i < g.indices.length; i += 3) {
          const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]]
          const p = (v: number) => [g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]]
          const n = [g.normals[a * 3], g.normals[a * 3 + 1], g.normals[a * 3 + 2]]
          // Only axis-aligned faces can be exactly coplanar by construction
          const axis = n.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-6)
          if (axis === -1) continue
          const [pa, pb, pc] = [p(a), p(b), p(c)]
          // A smooth vertex normal may be axial on a curved surface;
          // only triangles actually lying on that plane belong here.
          if (Math.abs(pa[axis] - pb[axis]) > 1e-7 || Math.abs(pa[axis] - pc[axis]) > 1e-7) continue
          const u = (axis + 1) % 3
          const w = (axis + 2) % 3
          const key = `${axis}:${pa[axis].toFixed(5)}`
          let list = planes.get(key)
          if (!list) planes.set(key, (list = []))
          list.push({
            sign: Math.sign(n[axis]),
            poly: [[pa[u], pa[w]], [pb[u], pb[w]], [pc[u], pc[w]]],
            material,
          })
        }
      }
      /** Area of `subject` clipped to convex `clip` (Sutherland–Hodgman). */
      const overlapArea = (subject: [number, number][], clip: [number, number][]) => {
        let output = subject
        const clipPoly = area2(clip) < 0 ? [...clip].reverse() : clip
        for (let i = 0; i < clipPoly.length && output.length > 2; i++) {
          const [ex0, ey0] = clipPoly[i]
          const [ex1, ey1] = clipPoly[(i + 1) % clipPoly.length]
          const input = output
          output = []
          for (let j = 0; j < input.length; j++) {
            const cur = input[j]
            const prev = input[(j + input.length - 1) % input.length]
            const side = (pt: [number, number]) =>
              (ex1 - ex0) * (pt[1] - ey0) - (ey1 - ey0) * (pt[0] - ex0)
            const curIn = side(cur) >= -1e-9
            const prevIn = side(prev) >= -1e-9
            if (curIn !== prevIn) {
              const t = side(prev) / (side(prev) - side(cur))
              output.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])])
            }
            if (curIn) output.push(cur)
          }
        }
        return output.length > 2 ? Math.abs(area2(output)) / 2 : 0
      }
      const area2 = (poly: [number, number][]) =>
        poly.reduce((sum, [x, y], i) => {
          const [nx, ny] = poly[(i + 1) % poly.length]
          return sum + x * ny - nx * y
        }, 0)

      for (const [key, tris] of planes) {
        for (let i = 0; i < tris.length; i++) {
          for (let j = i + 1; j < tris.length; j++) {
            if (tris[i].sign !== tris[j].sign) continue
            const overlap = overlapArea(tris[i].poly, tris[j].poly)
            expect(
              overlap,
              `${name}: ${tris[i].material}/${tris[j].material} overlap on plane ${key}`,
            ).toBeLessThan(1e-6)
          }
        }
      }
    }
  })

  it('exports finite unit normals agreeing with the triangle winding across the detailed fleets', () => {
    // Smooth normals and concave engine intakes cannot be checked against
    // the model's centroid. Check against each triangle's own winding.
    for (const [name, build] of Object.entries({ ...AIRCRAFT, ...VESSELS, 'ferry-fg': FLEET['ferry-fg'], 'ferry-fw': FLEET['ferry-fw'] })) {
      const mesh = build()
      let invalid = 0
      for (const part of [mesh, ...Object.values(mesh.parts)]) for (const g of part.groups.values()) {
        for (let i = 0; i < g.positions.length; i += 3) {
          if (!g.positions.slice(i, i + 3).every(Number.isFinite)) invalid++
          if (Math.abs(Math.hypot(...g.normals.slice(i, i + 3)) - 1) > 1e-5) invalid++
        }
        for (let i = 0; i < g.indices.length; i += 3) {
          const [a, b, c] = g.indices.slice(i, i + 3).map((j) => j * 3)
          const u = [0, 1, 2].map((k) => g.positions[b + k] - g.positions[a + k])
          const v = [0, 1, 2].map((k) => g.positions[c + k] - g.positions[a + k])
          const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
          if (Math.hypot(...n) < 1e-9) continue
          const agreement = n.reduce((sum, value, k) => sum + value * (g.normals[a + k] + g.normals[b + k] + g.normals[c + k]), 0)
          if (agreement <= 0) invalid++
        }
      }
      expect(invalid, name).toBe(0)
    }
  })

  it('keeps window glazing on every car', () => {
    for (const [name, buildMesh] of Object.entries(FLEET)) {
      const glassTriangles = buildMesh().groups.get('glass')?.indices.length ?? 0
      expect(glassTriangles, `${name} has no glazing`).toBeGreaterThan(0)
    }
  })
})
