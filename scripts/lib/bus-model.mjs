/**
 * A 12 m low-floor city bus after the Mercedes-Benz Citaro:
 * https://www.mercedes-benz-bus.com/gb/en/models/citaro.html
 *
 * Y-up, +Z forward, doors on -X. The reference box is the body, excluding
 * mirrors. Keep the road contact at -height/2 and every opaque detail in
 * one primitive. Only `glass` is below the runtime's window-glow cutoff;
 * tyres, seals and radiator grilles must never light up as cabin windows.
 */
import { box, createMesh, extrude, fan, quad, tri } from './vehicle-mesh.mjs'
import { mergeMesh, rod, roundedBox, smoothSurface } from './model-detail.mjs'

/** An outward-facing convex panel. */
function panel(mesh, material, points, outward) {
  // Clipping through a shell vertex can repeat that vertex or put three
  // points on one edge. Remove those before constructing a normal/fan.
  points = points.filter((p, i) => Math.hypot(...p.map((v, k) =>
    v - points[(i + 1) % points.length][k])) > 1e-8)
  let changed = true
  while (changed && points.length >= 3) {
    changed = false
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length]
      const b = points[i], c = points[(i + 1) % points.length]
      const u = b.map((v, k) => v - a[k]), v = c.map((n, k) => n - b[k])
      if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) < 1e-10) {
        points.splice(i, 1)
        changed = true
        break
      }
    }
  }
  if (points.length < 3) return
  const [a, b, c] = points
  const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i])
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const pts = n.reduce((s, x, i) => s + x * outward[i], 0) < 0 ? points.toReversed() : points
  if (points.length === 3) tri(mesh, material, ...pts)
  else if (points.length === 4) quad(mesh, material, ...pts)
  else fan(mesh, material, pts.reduce((s, p) => s.map((v, i) => v + p[i] / pts.length), [0, 0, 0]), pts)
}

/** Rounded rectangle in a plane, with small straight corner chamfers. */
function rectangle(a, b, c, d, r = 0.05) {
  return [[a + r, c], [b - r, c], [b, c + r], [b, d - r],
    [b - r, d], [a + r, d], [a, d - r], [a, c + r]]
}

function sidePanel(mesh, material, side, outline, proud = 0.012) {
  panel(mesh, material, outline.map(([z, y]) => [side * (1.275 + proud), y, z]), [side, 0, 0])
}

/** Sculpted front/rear cap; its actual triangles also carry the glazing. */
function endShell(mesh, front) {
  const direction = front ? 1 : -1
  const us = [-1, -0.94, -0.8, -0.5, 0, 0.5, 0.8, 0.94, 1]
  const ys = [-1.25, -1.11, -0.40, 0.25, 0.85, 1.13, 1.30, 1.38]
  const point = (u, y) => {
    const halfWidth = 1.275 - Math.max(0, y - 1.24, -1.11 - y)
    const rake = front ? Math.max(0, y + 0.25) * 0.10 : 0.02
    return [halfWidth * u, y, direction * (5.65 + (1 - Math.abs(u) ** 6) * (0.35 - rake))]
  }
  const shell = createMesh()
  const triangles = []
  for (let k = 0; k + 1 < ys.length; k++) {
    for (let i = 0; i + 1 < us.length; i++) {
      const corners = [point(us[i], ys[k]), point(us[i + 1], ys[k]),
        point(us[i + 1], ys[k + 1]), point(us[i], ys[k + 1])]
      panel(shell, 'body', corners, [0, 0, direction])
      if (!front) corners.reverse()
      triangles.push([corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]])
    }
  }
  // Close the narrow roof and floor between the curved face and the
  // straight body. A front face alone leaves the bus open from above.
  for (const y of [ys[0], ys.at(-1)]) {
    for (let i = 0; i + 1 < us.length; i++) {
      const a = point(us[i], y), b = point(us[i + 1], y)
      panel(shell, 'body', [a, b, [b[0], y, direction * 5.65],
        [a[0], y, direction * 5.65]], [0, Math.sign(y), 0])
    }
  }
  mergeMesh(mesh, smoothSurface(shell, 55))
  return { triangles, direction }
}

/** Clip a front-elevation contour onto the cap, preserving every facet bend. */
function endPanel(mesh, end, material, contour, proud = 0.009) {
  const patch = createMesh()
  for (const triangle of end.triangles) {
    let polygon = triangle
    for (let e = 0; e < contour.length && polygon.length; e++) {
      const a = contour[e], b = contour[(e + 1) % contour.length]
      const distance = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
      const clipped = []
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length]
        const dp = distance(p), dq = distance(q)
        if (dp >= 0) clipped.push(p)
        if ((dp >= 0) !== (dq >= 0)) clipped.push(p.map((v, j) => v + (q[j] - v) * dp / (dp - dq)))
      }
      polygon = clipped
    }
    if (polygon.length < 3) continue
    panel(patch, material, polygon.map(([x, y, z]) => [x, y, z + end.direction * proud]), [0, 0, end.direction])
  }
  mergeMesh(mesh, smoothSurface(patch, 55))
}

/** Rounded shoulder, tyre sidewall, annular alloy rim and recessed hub. */
function roadWheel(mesh, side, z, ground) {
  const cy = ground + 0.49
  const ring = (x, radius) => Array.from({ length: 24 }, (_, i) => {
    const angle = (i + 0.5) * Math.PI / 12
    const r = radius / Math.cos(Math.PI / 24)
    return [side * x, cy + r * Math.cos(angle), z + r * Math.sin(angle)]
  })
  const tyre = createMesh()
  const profile = [[0.98, 0.33], [0.99, 0.43], [1.035, 0.49], [1.205, 0.49], [1.255, 0.43], [1.265, 0.295]]
  const rings = profile.map(([x, radius]) => ring(x, radius))
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < 24; i++) {
      const j = (i + 1) % 24
      const radial = [0, rings[k][i][1] - cy, rings[k][i][2] - z]
      // Sidewalls increasingly face outwards as the profile turns inward.
      const normal = k >= 3 ? [side, radial[1], radial[2]] : [-side, radial[1], radial[2]]
      panel(tyre, 'chassis', [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]], normal)
    }
  }
  mergeMesh(mesh, smoothSurface(tyre, 60))
  const lip = ring(1.267, 0.29), recess = ring(1.235, 0.23)
  for (let i = 0; i < 24; i++) {
    const j = (i + 1) % 24
    panel(mesh, 'steel', [lip[i], lip[j], recess[j], recess[i]], [side, 0, 0])
  }
  panel(mesh, 'roof', recess, [side, 0, 0])
  rod(mesh, 'steel', [side * 1.239, cy, z], [side * (z < 0 ? 1.29 : 1.255), cy, z], z < 0 ? 0.13 : 0.10, 12)
  // Plain concentric rims: bolts or holes would reveal the unanimated wheels.
}

export function detailedBus(height) {
  const mesh = createMesh()
  const ground = -height / 2
  const axleY = ground + 0.49
  const axles = [-2.85, 3.15]
  // The upper shell stops ABOVE the wheel arches. The lower side walls
  // are built around actual cut-outs, never hidden under dark circles.
  const upper = createMesh()
  extrude(upper, [[-1.275, -0.35], [1.275, -0.35], [1.275, 1.24],
    [1.135, 1.38], [-1.135, 1.38], [-1.275, 1.24]],
  [{ z: -5.65 }, { z: 5.65 }], { material: 'body' })
  mergeMesh(mesh, smoothSurface(upper, 55))
  box(mesh, 'chassis', 0, -1.17, -0.15, 1.70, 0.17, 10.6)
  for (const side of [-1, 1]) {
    const wall = (z0, y0, z1, y1) => sidePanel(mesh, 'body', side,
      [[z0, y0], [z1, y1], [z1, -0.35], [z0, -0.35]], 0)
    let start = -5.65
    for (const z of axles) {
      wall(start, -1.25, z - 0.59, -1.25)
      for (let i = 0; i < 12; i++) {
        const a = Math.PI - i * Math.PI / 12, b = Math.PI - (i + 1) * Math.PI / 12
        const p = [z + 0.59 * Math.cos(a), axleY + 0.59 * Math.sin(a)]
        const q = [z + 0.59 * Math.cos(b), axleY + 0.59 * Math.sin(b)]
        wall(p[0], p[1], q[0], q[1])
        sidePanel(mesh, 'bellows', side, [p, q,
          [z + 0.63 * Math.cos(b), axleY + 0.63 * Math.sin(b)],
          [z + 0.63 * Math.cos(a), axleY + 0.63 * Math.sin(a)]], 0.005)
        // The return into the wheel well gives the arch thickness.
        panel(mesh, 'chassis', [[side * 1.275, p[1], p[0]], [side * 1.275, q[1], q[0]],
          [side * 0.94, q[1], q[0]], [side * 0.94, p[1], p[0]]],
        [0, -Math.sin((a + b) / 2), -Math.cos((a + b) / 2)])
      }
      start = z + 0.59
      roadWheel(mesh, side, z, ground)
    }
    wall(start, -1.25, 5.65, -1.25)
    // Continuous dark window surround; individual glass panes retain the
    // pillars. Doors interrupt the waist only on the boarding side (-X).
    sidePanel(mesh, 'bellows', side, rectangle(-5.54, 5.52, -0.22, 1.18, 0.06), 0.008)
    const windows = side < 0
      ? [[-5.35, -3.65], [-3.51, -2.20], [-0.53, 1.1], [1.24, 3.69]]
      : [[-5.35, -3.65], [-3.51, -1.65], [-1.51, 0.36], [0.50, 2.35], [2.49, 3.83], [3.97, 5.47]]
    for (const [a, b] of windows) {
      sidePanel(mesh, 'glass', side, rectangle(a, b, -0.15, 1.10, 0.045), 0.017)
      // Small opening lights in alternate panes.
      if (b - a > 1.6) sidePanel(mesh, 'bellows', side, [[a, 0.77], [b, 0.77], [b, 0.795], [a, 0.795]], 0.022)
    }
    // Lower access-panel seams, side markers and the belt moulding.
    for (const z of [-4.6, -1.9, 0.2, 1.6, 4.6]) {
      if (side < 0 && (z < -0.5 && z > -2.2 || z > 3.8)) continue
      sidePanel(mesh, 'roof', side, [[z, -1.19], [z + 0.009, -1.19], [z + 0.009, -0.29], [z, -0.29]], 0.006)
    }
    for (const z of [-5.2, -0.1, 2.1, 5.5]) {
      sidePanel(mesh, 'vehicleAmber', side, rectangle(z - 0.065, z + 0.065, -0.94, -0.88, 0.016), 0.026)
    }
  }
  for (const [a, b] of [[3.82, 5.39], [-2.06, -0.68]]) {
    sidePanel(mesh, 'bellows', -1, rectangle(a, b, -1.18, 1.15, 0.045), 0.028)
    for (const [z0, z1] of [[a + 0.06, (a + b) / 2 - 0.035], [(a + b) / 2 + 0.035, b - 0.06]]) {
      sidePanel(mesh, 'glass', -1, rectangle(z0, z1, -1.06, 1.08, 0.04), 0.035)
      sidePanel(mesh, 'chassis', -1, [[z0, -0.45], [z1, -0.45], [z1, -0.415], [z0, -0.415]], 0.041)
    }
    sidePanel(mesh, 'steel', -1, [[a, -1.20], [b, -1.20], [b, -1.16], [a, -1.16]], 0.039)
  }
  const front = endShell(mesh, true), rear = endShell(mesh, false)
  endPanel(mesh, front, 'bellows', rectangle(-1.19, 1.19, -0.42, 1.30, 0.13))
  endPanel(mesh, front, 'glass', rectangle(-1.10, 1.10, -0.34, 0.86, 0.09), 0.018)
  // Destination displays are blank: the live line belongs to the app's badge.
  endPanel(mesh, front, 'chassis', rectangle(-0.98, 0.98, 0.95, 1.21, 0.035), 0.020)
  endPanel(mesh, front, 'roof', rectangle(-0.66, 0.66, -0.77, -0.69, 0.03))
  endPanel(mesh, front, 'bellows', rectangle(-1.03, 1.03, -1.17, -1.07, 0.035))
  endPanel(mesh, front, 'bellows', rectangle(-0.32, 0.32, -1.04, -0.86, 0.025))
  endPanel(mesh, front, 'hullWhite', rectangle(-0.26, 0.26, -1.00, -0.90, 0.012), 0.018)
  for (const side of [-1, 1]) {
    const x = side * 0.94
    endPanel(mesh, front, 'bellows', rectangle(x - 0.21, x + 0.21, -0.84, -0.52, 0.10))
    endPanel(mesh, front, 'hullWhite', rectangle(x - 0.16, x + 0.16, -0.72, -0.58, 0.055), 0.020)
    endPanel(mesh, front, 'vehicleAmber', rectangle(x - 0.10, x + 0.10, -0.80, -0.755, 0.015), 0.020)
    // Compact mirror housings on swept arms, beyond the body width.
    rod(mesh, 'bellows', [side * 1.18, 1.01, 5.75], [side * 1.46, 0.99, 5.89], 0.025, 8)
    roundedBox(mesh, 'chassis', side * 1.46, 0.76, 5.91, 0.14, 0.46, 0.18, 0.045)
    panel(mesh, 'steel', rectangle(-0.045, 0.045, 0.58, 0.93, 0.02)
      .map(([dx, y]) => [side * 1.46 + dx, y, 5.812]), [0, 0, -1])
    // Two parked windscreen wipers, following the front's rake.
    rod(mesh, 'bellows', [side * 0.40, -0.30, 6.02], [side * 0.70, 0.15, 5.97], 0.014, 6)
    rod(mesh, 'bellows', [side * 0.72, 0.10, 5.985], [side * 0.59, 0.64, 5.93], 0.017, 6)
  }
  endPanel(mesh, rear, 'bellows', rectangle(-1.10, 1.10, 0.26, 1.20, 0.10))
  endPanel(mesh, rear, 'glass', rectangle(-1.01, 1.01, 0.35, 1.12, 0.07), 0.018)
  endPanel(mesh, rear, 'bellows', rectangle(-0.88, 0.88, -0.80, 0.12, 0.05))
  for (let i = 0; i < 9; i++) {
    const y = -0.72 + i * 0.09
    endPanel(mesh, rear, 'roof', [[-0.82, y], [0.82, y], [0.82, y + 0.025], [-0.82, y + 0.025]], 0.018)
  }
  for (const x of [-1.07, 1.07]) {
    endPanel(mesh, rear, 'bellows', rectangle(x - 0.105, x + 0.105, -0.91, 0.14, 0.05))
    for (const [y, material] of [[-0.76, 'vehicleRed'], [-0.49, 'hullWhite'], [-0.25, 'vehicleAmber'], [-0.02, 'vehicleRed']]) {
      endPanel(mesh, rear, material, rectangle(x - 0.07, x + 0.07, y, y + 0.13, 0.035), 0.022)
    }
  }
  endPanel(mesh, rear, 'bellows', rectangle(-1.03, 1.03, -1.17, -1.05, 0.03))
  endPanel(mesh, rear, 'hullWhite', rectangle(-0.26, 0.26, -1.00, -0.90, 0.012), 0.018)
  // Engine intake on the driver's side at the rear.
  sidePanel(mesh, 'bellows', 1, rectangle(-5.46, -4.10, -1.05, -0.36, 0.04), 0.012)
  for (let i = 0; i < 7; i++) {
    const y = -0.99 + i * 0.085
    sidePanel(mesh, 'roof', 1, [[-5.4, y], [-4.16, y], [-4.16, y + 0.018], [-5.4, y + 0.018]], 0.020)
  }
  // Low-profile roof equipment, visible from the map's usual viewpoint.
  roundedBox(mesh, 'roof', 0, 1.42, -0.65, 1.65, 0.22, 2.75, 0.075)
  for (const z of [2.75, -3.65]) roundedBox(mesh, 'roof', 0, 1.41, z, 0.75, 0.12, 0.80, 0.045)
  for (let i = 0; i < 6; i++) box(mesh, 'chassis', 0, 1.536, -1.40 + i * 0.27, 1.10, 0.008, 0.035)
  return mesh
}
