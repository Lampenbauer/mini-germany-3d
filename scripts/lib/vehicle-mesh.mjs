/**
 * Low-poly vehicle meshes for Mini Germany 3D, written as self-contained
 * binary glTF (.glb) – no textures, no external assets, PBR materials
 * with muted colors so the models sit believably inside the
 * photorealistic Google tiles instead of reading as toys.
 *
 * Conventions: 1 unit = 1 meter. glTF is Y-up; +Z is the direction of
 * travel (Cesium's glTF pipeline maps that onto the vehicle frame's +X).
 * The origin sits mid-length at half the body height, wheels at
 * y = -height/2 – the layer's `baseLift` equals height/2, the same
 * halfHeight semantics the box bodies had.
 *
 * Everything here is pure geometry/bytes (no I/O), unit tested in
 * tests/vehicle-models.test.ts.
 */

/** Muted PBR palette – the runtime tints the whole model in the line color. */
export const MATERIALS = {
  /** Light warm grey body: takes the line tint without turning candy-colored. */
  body: { color: [0.78, 0.79, 0.775, 1], metallic: 0.1, roughness: 0.5 },
  /** Near-black glazing with a bit of gloss. */
  glass: { color: [0.045, 0.06, 0.075, 1], metallic: 0.0, roughness: 0.18 },
  /** Skirt, bogies, couplers, pantograph. */
  chassis: { color: [0.13, 0.135, 0.14, 1], metallic: 0.15, roughness: 0.85 },
  /** Roof sheet and equipment – the silver-grey top every real vehicle has. */
  roof: { color: [0.6, 0.615, 0.625, 1], metallic: 0.15, roughness: 0.75 },
  /** Door leaves, slightly darker than the body so they read at distance. */
  door: { color: [0.62, 0.63, 0.62, 1], metallic: 0.1, roughness: 0.6 },
  /** Articulation bellows between sections. */
  bellows: { color: [0.09, 0.09, 0.095, 1], metallic: 0.0, roughness: 0.95 },
  /** Muted brick-red cargo hull (weathered anti-fouling paint). */
  hullRed: { color: [0.34, 0.16, 0.13, 1], metallic: 0.05, roughness: 0.8 },
  /** Muted marine-blue hull for coasters and fishing boats. */
  hullBlue: { color: [0.13, 0.19, 0.27, 1], metallic: 0.05, roughness: 0.75 },
  /** Off-white yacht and superstructure shell (no line tint on vessels). */
  hullWhite: { color: [0.82, 0.83, 0.81, 1], metallic: 0.05, roughness: 0.45 },
  /**
   * A turning rotor or propeller: the blurred disc the eye sees, dark
   * and mostly see-through. The one translucent material – the writer
   * turns an alpha under 1 into a blended, double-sided glTF material.
   */
  rotor: { color: [0.1, 0.1, 0.11, 0.3], metallic: 0.0, roughness: 0.9 },
}

/**
 * One mesh under construction: per-material triangle soups. `parts`
 * holds named sub-meshes the writer turns into glTF nodes of their own,
 * so the app can show and hide them by name – an airliner's landing
 * gear is drawn only near the ground (see AircraftLayer).
 */
export function createMesh() {
  return { groups: new Map(), parts: {} }
}

function group(mesh, material) {
  let g = mesh.groups.get(material)
  if (!g) mesh.groups.set(material, (g = { positions: [], normals: [], indices: [] }))
  return g
}

/** Flat-shaded quad a→b→c→d (counter-clockwise seen from the outside). */
export function quad(mesh, material, a, b, c, d) {
  const g = group(mesh, material)
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const len = Math.hypot(...n) || 1
  n = [n[0] / len, n[1] / len, n[2] / len]
  const base = g.positions.length / 3
  for (const p of [a, b, c, d]) {
    g.positions.push(p[0], p[1], p[2])
    g.normals.push(n[0], n[1], n[2])
  }
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

/** Flat-shaded triangle a→b→c (counter-clockwise seen from the outside). */
export function tri(mesh, material, a, b, c) {
  const g = group(mesh, material)
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const len = Math.hypot(...n) || 1
  n = [n[0] / len, n[1] / len, n[2] / len]
  const base = g.positions.length / 3
  for (const p of [a, b, c]) {
    g.positions.push(p[0], p[1], p[2])
    g.normals.push(n[0], n[1], n[2])
  }
  g.indices.push(base, base + 1, base + 2)
}

/**
 * A flat polygon as a fan around `centre`: the ring's points in order,
 * counter-clockwise seen from the outside, one shared normal – nine
 * vertices for an octagon where eight loose triangles would be
 * twenty-four, which is what keeps a row of portholes light.
 */
export function fan(mesh, material, centre, ring) {
  const g = group(mesh, material)
  const u = [ring[0][0] - centre[0], ring[0][1] - centre[1], ring[0][2] - centre[2]]
  const v = [ring[1][0] - centre[0], ring[1][1] - centre[1], ring[1][2] - centre[2]]
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const len = Math.hypot(...n) || 1
  n = [n[0] / len, n[1] / len, n[2] / len]
  const base = g.positions.length / 3
  for (const p of [centre, ...ring]) {
    g.positions.push(p[0], p[1], p[2])
    g.normals.push(n[0], n[1], n[2])
  }
  for (let i = 0; i < ring.length; i++) {
    g.indices.push(base, base + 1 + i, base + 1 + ((i + 1) % ring.length))
  }
}

/** Axis-aligned box, centered at (cx, cy, cz). */
export function box(mesh, material, cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2
  const y0 = cy - sy / 2, y1 = cy + sy / 2
  const z0 = cz - sz / 2, z1 = cz + sz / 2
  quad(mesh, material, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]) // +X
  quad(mesh, material, [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]) // -X
  quad(mesh, material, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]) // +Y
  quad(mesh, material, [x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]) // -Y
  quad(mesh, material, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]) // +Z
  quad(mesh, material, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]) // -Z
}

/**
 * Beveled body cross-section: a rounded-rectangle octagon in the XY
 * plane. y0/y1 = bottom/top of the body shell, w = width, bevel = corner
 * cut. Points ordered counter-clockwise seen from +Z (the nose).
 */
export function bodyProfile(w, y0, y1, bevel) {
  const x = w / 2
  return [
    [x - bevel, y0],
    [x, y0 + bevel],
    [x, y1 - bevel],
    [x - bevel, y1],
    [-x + bevel, y1],
    [-x, y1 - bevel],
    [-x, y0 + bevel],
    [-x + bevel, y0],
  ]
}

/**
 * Extrudes a convex profile through stations along Z. Each station may
 * scale the profile (sx sideways, sy heightways – anchored at yAnchor so
 * a shrinking nose keeps its floor line) and assign the segment to a
 * material. Caps close both ends; capMaterials override them (a glass
 * cap is the whole windscreen of a low-poly nose).
 */
export function extrude(mesh, profile, stations, opts = {}) {
  const yAnchor = opts.yAnchor ?? 0
  const rings = stations.map((st) => {
    const sx = st.sx ?? 1
    const sy = st.sy ?? 1
    return profile.map(([x, y]) => [
      x * sx,
      (y - yAnchor) * sy + yAnchor + (st.yOff ?? 0),
      st.z,
    ])
  })
  const n = profile.length
  for (let s = 0; s < rings.length - 1; s++) {
    const material = stations[s + 1].material ?? opts.material
    const a = rings[s]
    const b = rings[s + 1]
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      quad(mesh, material, a[i], a[j], b[j], b[i])
    }
  }
  const capFan = (ring, material, invert) => {
    const g = group(mesh, material)
    // Fan around the ring centroid; flat normal along ±Z
    const cx = ring.reduce((s, p) => s + p[0], 0) / n
    const cy = ring.reduce((s, p) => s + p[1], 0) / n
    const cz = ring[0][2]
    const normal = invert ? [0, 0, -1] : [0, 0, 1]
    const base = g.positions.length / 3
    g.positions.push(cx, cy, cz)
    g.normals.push(...normal)
    for (const p of ring) {
      g.positions.push(p[0], p[1], p[2])
      g.normals.push(...normal)
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      if (invert) g.indices.push(base, base + 1 + j, base + 1 + i)
      else g.indices.push(base, base + 1 + i, base + 1 + j)
    }
  }
  capFan(rings[0], opts.capMaterials?.[0] ?? opts.material, true)
  capFan(rings[rings.length - 1], opts.capMaterials?.[1] ?? opts.material, false)
}

/**
 * Window band along both sides: thin glass boxes riding 2 cm proud of
 * the wall, split into panes by narrow gaps so the band does not read as
 * one endless strip.
 *
 * `holes` cuts the band around the doors. Without the cut a pane runs on
 * BEHIND every door, its outer face exactly coplanar with the leaf – and
 * two coplanar faces z-fight into the camera-dependent speckle the doors
 * used to show. The cut, not a mere offset, is the fix: door and glazing
 * simply never share a wall segment.
 */
export function windowBand(mesh, w, y0, y1, z0, z1, { panes = 1, holes = [] } = {}) {
  const gap = 0.09
  const paneLength = (z1 - z0 - gap * (panes - 1)) / panes
  for (let i = 0; i < panes; i++) {
    const za = z0 + i * (paneLength + gap)
    // Subtract every hole that exists on the wall at hand from the
    // pane's [za, za+paneLength] interval. A door on the right only
    // (buses, trams) leaves the left wall to the glazing – cutting both
    // walls would put a blind hole where the pane belongs. Loop order
    // (panes outer, sides inner) is what it always was, so meshes whose
    // holes span both sides serialize byte-identically.
    const piecesFor = (side) => {
      let pieces = [[za, za + paneLength]]
      for (const hole of holes) {
        if (hole.sides && !hole.sides.includes(side)) continue
        const h0 = hole.z - hole.width / 2
        const h1 = hole.z + hole.width / 2
        pieces = pieces.flatMap(([a, b]) => {
          if (h1 <= a || h0 >= b) return [[a, b]]
          const kept = []
          if (h0 > a) kept.push([a, h0])
          if (h1 < b) kept.push([h1, b])
          return kept
        })
      }
      return pieces
    }
    for (const side of [-1, 1]) {
      for (const [a, b] of piecesFor(side)) {
        if (b - a < 0.2) continue // sliver panes read as seams, drop them
        box(mesh, 'glass', side * (w / 2 - 0.01), (y0 + y1) / 2, (a + b) / 2, 0.06, y1 - y0, b - a)
      }
    }
  }
}

/**
 * Double-leaf door. Layered strictly outward from the wall – wall <
 * window panes < leaf < door glazing, each step well clear of the last –
 * so no two faces of the assembly are ever coplanar.
 *
 * `sides` picks the walls that get one: road vehicles and unidirectional
 * trams board on the right only, S-Bahn cars on both sides.
 */
export function doors(mesh, w, y0, y1, z, leafWidth = 1.3, sides = [-1, 1]) {
  for (const side of sides) {
    box(mesh, 'door', side * (w / 2 - 0.005), (y0 + y1) / 2, z, 0.06, y1 - y0, leafWidth)
    box(mesh, 'glass', side * (w / 2 + 0.0325), y1 - (y1 - y0) * 0.27, z, 0.015, (y1 - y0) * 0.42, leafWidth - 0.24)
  }
}

/**
 * z-range a door assembly occupies – the hole the window band must cut,
 * on the same `sides` the door was built on.
 */
export function doorHole(z, leafWidth = 1.3, sides = undefined) {
  return { z, width: leafWidth + 0.18, sides }
}

/**
 * Folded single-arm pantograph: base frame, low raked arms, contact bar.
 * `maxY` caps the whole assembly – the configured vehicle height includes
 * the folded pantograph, and a bar poking beyond it would float above
 * the height every other part of the app (labels, follow camera) assumes.
 */
export function pantograph(mesh, roofY, z, maxY) {
  const head = maxY - roofY
  box(mesh, 'chassis', 0, roofY + 0.04, z, 1.1, 0.08, 1.5)
  for (const dir of [-1, 1]) {
    box(mesh, 'chassis', 0, roofY + head * 0.35, z + dir * 0.45, 0.09, head * 0.5, 0.1)
    box(mesh, 'chassis', 0, roofY + head * 0.7, z + dir * 0.18, 0.07, head * 0.35, 0.09)
  }
  box(mesh, 'chassis', 0, maxY - 0.03, z, 1.6, 0.05, 0.12)
}

/**
 * Road wheel: an octagonal tire prism along X with a flat bottom (the
 * contact patch – the fleet's bounding test insists the mesh's lowest
 * plane sits exactly on the wheel plane), plus a silver hub cap proud of
 * the outboard face. Nothing rotates: at map distance a crisp dark
 * octagon with a bright hub reads as a wheel, a spinning one would not
 * read at all.
 *
 * `side` is the sign of cx – it decides which cap face gets the hub.
 */
export function wheel(mesh, cx, cy, cz, radius, thickness, side) {
  const octagon = (x, r) => {
    const circum = r / Math.cos(Math.PI / 8)
    const points = []
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * 2 * Math.PI
      points.push([x, cy - circum * Math.cos(a), cz + circum * Math.sin(a)])
    }
    return points
  }
  const capFan = (ring, material, invert) => {
    const g = group(mesh, material)
    const cyr = ring.reduce((sum, p) => sum + p[1], 0) / ring.length
    const czr = ring.reduce((sum, p) => sum + p[2], 0) / ring.length
    const normal = invert ? [-1, 0, 0] : [1, 0, 0]
    const base = g.positions.length / 3
    g.positions.push(ring[0][0], cyr, czr)
    g.normals.push(...normal)
    for (const p of ring) {
      g.positions.push(p[0], p[1], p[2])
      g.normals.push(...normal)
    }
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length
      // The octagon ring runs clockwise seen from +X, so the fan winding
      // is the mirror of extrude()'s – checked by the winding test.
      if (invert) g.indices.push(base, base + 1 + i, base + 1 + j)
      else g.indices.push(base, base + 1 + j, base + 1 + i)
    }
  }
  const prism = (material, x0, x1, r, yCenter = cy) => {
    const a = octagon(x0, r).map(([x, y, z]) => [x, y - cy + yCenter, z])
    const b = octagon(x1, r).map(([x, y, z]) => [x, y - cy + yCenter, z])
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8
      quad(mesh, material, a[j], a[i], b[i], b[j])
    }
    capFan(a, material, true)
    capFan(b, material, false)
  }
  prism('chassis', cx - thickness / 2, cx + thickness / 2, radius)
  // Hub cap: 1 mm clear of the tire face so the two never share a plane
  const face = cx + (side * thickness) / 2
  const hub = [face + side * 0.001, face + side * 0.021].sort((p, q) => p - q)
  prism('roof', hub[0], hub[1], radius * 0.4, cy)
}

/** Bogie: dark under-floor block with hinted wheel discs. */
export function bogie(mesh, y0, z, width) {
  box(mesh, 'chassis', 0, y0 + 0.28, z, width - 0.5, 0.56, 1.9)
  for (const side of [-1, 1]) {
    for (const dz of [-0.62, 0.62]) {
      box(mesh, 'chassis', side * (width / 2 - 0.18), y0 + 0.33, z + dz, 0.14, 0.66, 0.66)
    }
  }
}

// ---------------------------------------------------------------------------
// GLB writer

function align(n, pad) {
  return Math.ceil(n / pad) * pad
}

/**
 * Serializes the mesh into a self-contained binary glTF: one node per
 * part – the mesh itself first, named `name`, then every entry of
 * `mesh.parts` under its own name – all in one scene, the materials
 * shared between them.
 */
export function toGlb(mesh, { name }) {
  const parts = [{ name, mesh }, ...Object.entries(mesh.parts ?? {}).map(([n, m]) => ({ name: n, mesh: m }))]
  const materialNames = []
  for (const part of parts) {
    for (const materialName of part.mesh.groups.keys()) {
      if (!materialNames.includes(materialName)) materialNames.push(materialName)
    }
  }
  const buffers = []
  const bufferViews = []
  const accessors = []
  const meshes = []
  let offset = 0

  const pushView = (bytes, target) => {
    buffers.push(bytes)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target })
    offset += align(bytes.byteLength, 4)
    return bufferViews.length - 1
  }

  for (const part of parts) {
    const primitives = []
    for (const [materialName, g] of part.mesh.groups) {
      const positions = new Float32Array(g.positions)
      const normals = new Float32Array(g.normals)
      const indices = new Uint16Array(g.indices)
      if (g.positions.length / 3 > 65535) {
        throw new Error(`${part.name}/${materialName}: too many vertices for uint16 indices`)
      }
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (positions[i + k] < min[k]) min[k] = positions[i + k]
          if (positions[i + k] > max[k]) max[k] = positions[i + k]
        }
      }
      const posView = pushView(new Uint8Array(positions.buffer), 34962)
      const normView = pushView(new Uint8Array(normals.buffer), 34962)
      const idxView = pushView(new Uint8Array(indices.buffer), 34963)
      accessors.push(
        { bufferView: posView, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
        { bufferView: normView, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
        { bufferView: idxView, componentType: 5123, count: indices.length, type: 'SCALAR' },
      )
      primitives.push({
        attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 },
        indices: accessors.length - 1,
        material: materialNames.indexOf(materialName),
      })
    }
    meshes.push({ primitives, name: part.name })
  }

  const binLength = offset
  const bin = new Uint8Array(binLength)
  let cursor = 0
  for (const bytes of buffers) {
    bin.set(bytes, cursor)
    cursor += align(bytes.byteLength, 4)
  }

  const json = {
    asset: { version: '2.0', generator: 'mini-germany-3d vehicle-mesh' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((m, i) => ({ mesh: i, name: m.name })),
    meshes,
    materials: materialNames.map((materialName) => {
      const m = MATERIALS[materialName]
      if (!m) throw new Error(`unknown material "${materialName}"`)
      return {
        name: materialName,
        pbrMetallicRoughness: {
          baseColorFactor: m.color,
          metallicFactor: m.metallic,
          roughnessFactor: m.roughness,
        },
        // A see-through material is blended and shows its back – a rotor
        // disc is looked at from below as often as from above
        ...(m.color[3] < 1 ? { alphaMode: 'BLEND', doubleSided: true } : {}),
      }
    }),
    buffers: [{ byteLength: binLength }],
    bufferViews,
    accessors,
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPadded = align(jsonBytes.length, 4)
  const binPadded = align(binLength, 4)
  const total = 12 + 8 + jsonPadded + 8 + binPadded
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonPadded, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(jsonBytes, 20)
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded) // pad with spaces
  const binStart = 20 + jsonPadded
  view.setUint32(binStart, binPadded, true)
  view.setUint32(binStart + 4, 0x004e4942, true) // 'BIN'
  out.set(bin, binStart + 8)
  return out
}

/** Triangle count across all materials and parts (budget checks in tests). */
export function triangleCount(mesh) {
  let count = 0
  for (const g of mesh.groups.values()) count += g.indices.length / 3
  for (const part of Object.values(mesh.parts ?? {})) count += triangleCount(part)
  return count
}
