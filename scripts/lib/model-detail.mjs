/**
 * Curved surfaces and small fittings for ships, aircraft and the bus:
 * smooth-shaded shells, pipes, bevelled boxes, ellipsoids. Metres, Y-up,
 * on the same mesh and material model as vehicle-mesh.mjs – and kept
 * apart from it on purpose: the rail vehicles are built from
 * the flat-shaded helpers there alone, and their GLBs have to come out
 * byte-identical through any change here (tests/vehicle-models.test.ts
 * pins the fleets' bounds, the build is byte-stable – rebuild and cmp).
 *
 * Smoothing is by crease angle (smoothSurface): coincident vertices
 * average their normals where the faces meet at less than the crease,
 * so a bilge or a fuselage reads as one curved surface while a deck
 * edge or a wing's trailing edge keeps its hard line. The reformat of
 * 2026-09-12 was proved against the built GLBs the same way.
 */
import { createMesh, extrude, fan, quad } from './vehicle-mesh.mjs'

const sub = (a, b) => a.map((v, i) => v - b[i])
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a) => a.map((v) => v / (Math.hypot(...a) || 1))
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0)

export function mergeMesh(target, source) {
  for (const [material, g] of source.groups) {
    let out = target.groups.get(material)
    if (!out) target.groups.set(material, (out = { positions: [], normals: [], indices: [] }))
    const base = out.positions.length / 3
    // Iteration avoids argument-count limits on the larger container mesh.
    for (const v of g.positions) out.positions.push(v)
    for (const v of g.normals) out.normals.push(v)
    for (const v of g.indices) out.indices.push(base + v)
  }
}

/** Average coincident surface normals, keeping corners over `crease` degrees sharp. */
export function smoothSurface(mesh, crease = 65) {
  const threshold = Math.cos(crease * Math.PI / 180)
  for (const g of mesh.groups.values()) {
    const at = new Map()
    for (let i = 0; i < g.positions.length; i += 3) {
      const key = g.positions.slice(i, i + 3).map((v) => v.toFixed(6)).join(',')
      if (!at.has(key)) at.set(key, [])
      at.get(key).push(i)
    }
    const original = [...g.normals]
    for (const indices of at.values()) {
      for (const i of indices) {
        const n = original.slice(i, i + 3)
        const sum = [0, 0, 0]
        for (const j of indices) {
          const other = original.slice(j, j + 3)
          if (dot(n, other) >= threshold) for (let k = 0; k < 3; k++) sum[k] += other[k]
        }
        g.normals.splice(i, 3, ...unit(sum))
      }
    }
  }
  return mesh
}

/** A pipe, mast, strut or handrail between two points, with smooth walls and flat caps. */
export function rod(mesh, material, a, b, radius, sides = 12, endRadius = radius) {
  const axis = unit(sub(b, a))
  const u = unit(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
  const v = cross(axis, u)
  const ring = (p, r) => Array.from({ length: sides }, (_, i) => {
    const angle = i * Math.PI * 2 / sides
    return p.map((n, k) => n + r * (u[k] * Math.cos(angle) + v[k] * Math.sin(angle)))
  })
  const ra = ring(a, radius)
  const rb = ring(b, endRadius)
  const wall = createMesh()
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    quad(wall, material, ra[i], ra[j], rb[j], rb[i])
  }
  mergeMesh(mesh, smoothSurface(wall))
  fan(mesh, material, a, [...ra].reverse())
  fan(mesh, material, b, rb)
}

/** A bevelled enclosure. Large faces stay planar, the edge catches a narrow highlight. */
export function roundedBox(mesh, material, cx, cy, cz, w, h, l, bevel = Math.min(w, h, l) * 0.09) {
  const r = Math.min(bevel, w / 3, h / 3, l / 3)
  const profile = []
  for (const [x, y, angle] of [[w / 2 - r, -h / 2 + r, -90], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180]]) {
    for (let i = 0; i <= 3; i++) {
      const a = (angle + i * 30) * Math.PI / 180
      profile.push([x + r * Math.cos(a), y + r * Math.sin(a)])
    }
  }
  const part = createMesh()
  extrude(part, profile, [
    { z: -l / 2, sx: (w - r) / w, sy: (h - r) / h },
    { z: -l / 2 + r }, { z: l / 2 - r },
    { z: l / 2, sx: (w - r) / w, sy: (h - r) / h },
  ], { material })
  smoothSurface(part, 50)
  for (const g of part.groups.values()) {
    for (let i = 0; i < g.positions.length; i += 3) {
      g.positions[i] += cx; g.positions[i + 1] += cy; g.positions[i + 2] += cz
    }
  }
  mergeMesh(mesh, part)
}

/** Ellipsoidal fairing, radome or liferaft canister, with explicit smooth normals. */
export function ellipsoid(mesh, material, centre, radii, sides = 24, rows = 12) {
  const part = createMesh()
  const point = (i, j) => {
    const a = i * 2 * Math.PI / sides
    const b = -Math.PI / 2 + j * Math.PI / rows
    return [centre[0] + radii[0] * Math.cos(a) * Math.cos(b), centre[1] + radii[1] * Math.sin(b), centre[2] + radii[2] * Math.sin(a) * Math.cos(b)]
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < sides; i++) {
      quad(part, material, point(i, j), point(i, j + 1), point(i + 1, j + 1), point(i + 1, j))
    }
  }
  for (const g of part.groups.values()) {
    for (let i = 0; i < g.positions.length; i += 3) {
      const normal = unit(radii.map((r, k) => (g.positions[i + k] - centre[k]) / (r * r)))
      g.normals.splice(i, 3, ...normal)
    }
  }
  mergeMesh(mesh, part)
}
