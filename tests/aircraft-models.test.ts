import { describe, expect, it } from 'vitest'
import { AIRCRAFT, AIRCRAFT_DIMS } from '../scripts/lib/aircraft-fleet.mjs'
import { MATERIALS, toGlb, triangleCount } from '../scripts/lib/vehicle-mesh.mjs'
import { AIRCRAFT_MODELS } from '@/map/AircraftLayer'
import { ARCHETYPE_SIZE, aircraftSize } from '@/lib/aircraft-info'

/**
 * The ADS-B fleet, same contract as the vessel fleet test: every
 * archetype fills its reference box (the layer stretches exactly these
 * dimensions to the type's size), stays within its polygon budget – a
 * rounder one than the ships', an aircraft being all curves – and the
 * layer's spec and the type table agree with the workshop's reference
 * dimensions and its light positions. The retractable gear is a part of
 * its own, which the extents have to include: the wheels are the ground.
 */

/** Every vertex of a mesh and its parts, for the extents. */
function* vertexGroups(mesh: { groups: Map<string, { positions: number[] }>; parts: Record<string, { groups: Map<string, { positions: number[] }> }> }) {
  yield* mesh.groups.values()
  for (const part of Object.values(mesh.parts)) yield* part.groups.values()
}

describe('the generated aircraft fleet', () => {
  for (const [name, buildMesh] of Object.entries(AIRCRAFT)) {
    describe(name, () => {
      const mesh = buildMesh()
      const glb = toGlb(mesh, { name })
      const expected = AIRCRAFT_DIMS[name as keyof typeof AIRCRAFT_DIMS]

      if (['aircraft-narrowbody', 'aircraft-widebody', 'aircraft-jumbo', 'aircraft-bizjet'].includes(name)) {
        it('has six outward-facing cockpit panes mirrored across the centre pillar', () => {
          const glass = mesh.groups.get('aircraftGlass')!
          const key = (values: number[]) => values.map((v) => Math.round(v * 1e6)).join(',')
          const vertices = new Map<string, number[]>()
          const neighbours = new Map<string, Set<string>>()
          for (let i = 0; i < glass.positions.length; i += 3) {
            const p = glass.positions.slice(i, i + 3)
            if (p[2] <= expected.length * 0.36) continue
            vertices.set(key(p), [...p, ...glass.normals.slice(i, i + 3)])
            neighbours.set(key(p), new Set())
          }
          expect(vertices.size).toBeGreaterThan(0)
          let badMirrors = 0
          let inward = 0
          for (const [x, y, z, nx, ny, nz] of vertices.values()) {
            const mirror = vertices.get(key([-x, y, z]))
            if (!mirror || key(mirror.slice(3)) !== key([-nx, ny, nz])) badMirrors++
            if (nx * x < -1e-6 || nz < -1e-6) inward++
          }
          expect(badMirrors).toBe(0)
          expect(inward).toBe(0)
          // Weld coincident vertices, then count connected glass islands.
          // A window split by white facet seams is more than one pane.
          for (let i = 0; i < glass.indices.length; i += 3) {
            const keys = glass.indices.slice(i, i + 3).map((v) => key(glass.positions.slice(v * 3, v * 3 + 3)))
            if (!keys.every((k) => neighbours.has(k))) continue
            for (const a of keys) {
              for (const b of keys) neighbours.get(a)!.add(b)
            }
          }
          let panes = 0
          const remaining = new Set(vertices.keys())
          while (remaining.size) {
            panes++
            const stack = [remaining.values().next().value!]
            while (stack.length) {
              const at = stack.pop()!
              if (!remaining.delete(at)) continue
              stack.push(...neighbours.get(at)!)
            }
          }
          expect(panes).toBe(6)
          // The windscreens approach the centre line but retain a solid pillar.
          const inner = Math.min(...[...vertices.values()].map(([x]) => Math.abs(x)))
          expect(inner).toBeGreaterThan(0.03)
          expect(inner).toBeLessThan(0.15)
        })
      }

      it('matches its reference dimensions', () => {
        const min = [Infinity, Infinity, Infinity]
        const max = [-Infinity, -Infinity, -Infinity]
        for (const g of vertexGroups(mesh)) {
          for (let i = 0; i < g.positions.length; i += 3) {
            for (let k = 0; k < 3; k++) {
              min[k] = Math.min(min[k], g.positions[i + k])
              max[k] = Math.max(max[k], g.positions[i + k])
            }
          }
        }
        // Nose to tail along Z, wing tip to wing tip along X
        expect(max[2] - min[2]).toBeGreaterThan(expected.length - 0.1)
        expect(max[2] - min[2]).toBeLessThan(expected.length + 0.3)
        expect(max[0] - min[0]).toBeGreaterThan(expected.width - 0.3)
        expect(max[0] - min[0]).toBeLessThan(expected.width + 0.1)
        expect(max[1]).toBeLessThanOrEqual(expected.height / 2 + 1e-6)
        // The wheels or skids on the ground at -height/2 – the layer sets
        // an aircraft on the apron by that plane
        expect(min[1]).toBeCloseTo(-expected.height / 2, 5)
      })

      it('stays within its polygon budget and self-contained', () => {
        // Smooth shells, profiled wings and recessed engines; the four
        // engines and second window deck give the jumbo the larger budget.
        expect(triangleCount(mesh)).toBeLessThan(name === 'aircraft-jumbo' ? 12000 : 8500)
        // The merge costs 8 bytes a vertex (colour and palette coordinate)
        expect(glb.byteLength).toBeLessThan(800 * 1024)
      })

      it('uses only palette materials', () => {
        for (const g of [mesh, ...Object.values(mesh.parts)]) {
          for (const material of g.groups.keys()) {
            expect(MATERIALS).toHaveProperty(material)
          }
        }
      })

      it('keeps its retractable gear in a node of its own, and a fixed one in the body', () => {
        // The layer folds the "gear" node away in the air (AircraftLayer);
        // a light single and a helicopter have nothing to fold
        const retractable = !['aircraft-light', 'aircraft-helicopter'].includes(name)
        expect('gear' in mesh.parts).toBe(retractable)
        // The node is in the GLB under that name
        const json = new TextDecoder().decode(glb.slice(20, 20 + new DataView(glb.buffer).getUint32(12, true)))
        expect(json.includes('"name":"gear"')).toBe(retractable)
      })

      it('places its lights where the layer expects them', () => {
        // The workshop builds Y-up with +Z the nose and +X the port wing;
        // Cesium's glTF pipeline hands the layer x forward, y port, z up
        const spec = AIRCRAFT_MODELS[name as keyof typeof AIRCRAFT_MODELS]
        const lights = (mesh as { lights?: Record<string, [number, number, number]> }).lights!
        expect(lights).toBeDefined()
        for (const key of ['port', 'starboard', 'tail', 'beaconTop', 'beaconBottom'] as const) {
          const [x, y, z] = lights[key]
          expect(spec.lights[key].x).toBeCloseTo(z, 2)
          expect(spec.lights[key].y).toBeCloseTo(x, 2)
          expect(spec.lights[key].z).toBeCloseTo(y, 2)
        }
        // Red to port, green to starboard: port is +y – a hand outboard of
        // the wing tips, or of the cabin on a helicopter, whose width is
        // the rotor's
        expect(spec.lights.port.y).toBeGreaterThan(0)
        expect(spec.lights.starboard.y).toBeLessThan(0)
        expect(spec.lights.starboard.y).toBeCloseTo(-spec.lights.port.y, 5)
        if (name !== 'aircraft-helicopter') {
          expect(spec.lights.port.y).toBeGreaterThanOrEqual(expected.width / 2)
        }
        // The tail light at the tail, the beacons over and under the body
        expect(spec.lights.tail.x).toBeLessThanOrEqual(-expected.length / 2)
        expect(spec.lights.beaconTop.z).toBeGreaterThan(spec.lights.beaconBottom.z)
        expect(spec.lights.beaconTop.z).toBeLessThanOrEqual(expected.height / 2)
        expect(spec.lights.beaconBottom.z).toBeGreaterThanOrEqual(-expected.height / 2)
      })

      it('agrees with the layer spec and the type table', () => {
        const spec = AIRCRAFT_MODELS[name as keyof typeof AIRCRAFT_MODELS]
        expect(spec).toBeDefined()
        expect(spec.uri).toBe(`models/${name}.glb`)
        expect(spec.lengthM).toBe(expected.length)
        expect(spec.spanM).toBe(expected.width)
        expect(spec.heightM).toBe(expected.height)
        expect(ARCHETYPE_SIZE[name as keyof typeof ARCHETYPE_SIZE]).toEqual({
          lengthM: expected.length,
          spanM: expected.width,
          heightM: expected.height,
        })
      })
    })
  }

  it('builds every archetype the type table names', () => {
    for (const archetype of Object.keys(ARCHETYPE_SIZE)) {
      expect(AIRCRAFT).toHaveProperty(archetype)
    }
  })

  it('gives the common types a body of their own size', () => {
    expect(aircraftSize('A320', 'A3')).toEqual({
      archetype: 'aircraft-narrowbody',
      lengthM: 37.6,
      spanM: 35.8,
      heightM: 11.8,
    })
    expect(aircraftSize('a21n', '')).toMatchObject({ archetype: 'aircraft-narrowbody', lengthM: 44.5 })
    expect(aircraftSize('B77W', 'A5').archetype).toBe('aircraft-widebody')
    expect(aircraftSize('A388', 'A5').archetype).toBe('aircraft-jumbo')
    expect(aircraftSize('B748', 'A5').archetype).toBe('aircraft-jumbo')
    expect(aircraftSize('CRJ9', 'A3').archetype).toBe('aircraft-bizjet') // engines on the tail
    expect(aircraftSize('E190', 'A3').archetype).toBe('aircraft-narrowbody') // engines under the wing
    expect(aircraftSize('AT76', 'A2').archetype).toBe('aircraft-turboprop')
    expect(aircraftSize('DH8D', 'A2')).toMatchObject({ archetype: 'aircraft-turboprop', lengthM: 32.8 })
    expect(aircraftSize('C172', 'A1').archetype).toBe('aircraft-light')
    expect(aircraftSize('EC35', 'A7')).toMatchObject({ archetype: 'aircraft-helicopter', spanM: 10.2 })
  })

  it('falls back to the emitter category, and to the callsign without one', () => {
    expect(aircraftSize('', 'A1')).toEqual({ archetype: 'aircraft-light', ...ARCHETYPE_SIZE['aircraft-light'] })
    expect(aircraftSize('ZZZZ', 'A2').archetype).toBe('aircraft-turboprop')
    expect(aircraftSize('', 'A3').archetype).toBe('aircraft-narrowbody')
    expect(aircraftSize('', 'A4').archetype).toBe('aircraft-narrowbody')
    expect(aircraftSize('', 'A5').archetype).toBe('aircraft-widebody')
    expect(aircraftSize('', 'A6').archetype).toBe('aircraft-bizjet')
    expect(aircraftSize('', 'A7').archetype).toBe('aircraft-helicopter')
    expect(aircraftSize('', 'B1').archetype).toBe('aircraft-light') // glider
    expect(aircraftSize('', 'B6').archetype).toBe('aircraft-light') // drone
    // No type, no category: an airline callsign is an airliner, anything else a club aircraft
    expect(aircraftSize('', '', 'DLH2AK').archetype).toBe('aircraft-narrowbody')
    expect(aircraftSize('', '', 'D-EQBK').archetype).toBe('aircraft-light')
    expect(aircraftSize('', '', '').archetype).toBe('aircraft-light')
  })
})
