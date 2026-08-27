import { describe, expect, it } from 'vitest'
import { VESSELS, VESSEL_DIMS } from '../scripts/lib/vessel-fleet.mjs'
import { MATERIALS, toGlb, triangleCount } from '../scripts/lib/vehicle-mesh.mjs'
import { VESSEL_MODELS, archetypeFor } from '@/map/VesselLayer'

/**
 * The AIS backdrop fleet, same contract as the vehicle fleet test: every
 * archetype stays inside its reference bounding box (the layer stretches
 * exactly these dimensions to the reported ship size), stays low-poly,
 * and the layer's spec agrees with the shipyard's reference dimensions.
 */

describe('the generated backdrop fleet', () => {
  for (const [name, buildMesh] of Object.entries(VESSELS)) {
    describe(name, () => {
      const mesh = buildMesh()
      const glb = toGlb(mesh, { name })
      const expected = VESSEL_DIMS[name as keyof typeof VESSEL_DIMS]

      it('matches its reference dimensions', () => {
        const min = [Infinity, Infinity, Infinity]
        const max = [-Infinity, -Infinity, -Infinity]
        for (const g of mesh.groups.values()) {
          for (let i = 0; i < g.positions.length; i += 3) {
            for (let k = 0; k < 3; k++) {
              min[k] = Math.min(min[k], g.positions[i + k])
              max[k] = Math.max(max[k], g.positions[i + k])
            }
          }
        }
        expect(max[2] - min[2]).toBeGreaterThan(expected.length - 0.1)
        expect(max[2] - min[2]).toBeLessThan(expected.length + 0.3)
        expect(max[0] - min[0]).toBeLessThan(expected.width + 0.1)
        expect(max[1]).toBeLessThanOrEqual(expected.height / 2 + 1e-6)
        // Waterline at -height/2 – the layer floats the hull on it
        expect(min[1]).toBeCloseTo(-expected.height / 2, 5)
      })

      it('stays low-poly and self-contained', () => {
        expect(triangleCount(mesh)).toBeLessThan(800)
        expect(glb.byteLength).toBeLessThan(64 * 1024)
      })

      it('uses only palette materials', () => {
        for (const material of mesh.groups.keys()) {
          expect(MATERIALS).toHaveProperty(material)
        }
      })

      it('agrees with the layer spec', () => {
        const spec = VESSEL_MODELS[name]
        expect(spec).toBeDefined()
        expect(spec.uri).toBe(`models/${name}.glb`)
        expect(spec.length).toBe(expected.length)
        expect(spec.width).toBe(expected.width)
        expect(spec.height).toBe(expected.height)
      })
    })
  }

  it('maps every AIS type group onto an existing hull', () => {
    expect(archetypeFor(70)).toBe('vessel-cargo')
    expect(archetypeFor(89)).toBe('vessel-tanker')
    expect(archetypeFor(60)).toBe('vessel-passenger')
    expect(archetypeFor(40)).toBe('vessel-passenger') // high-speed craft
    expect(archetypeFor(52)).toBe('vessel-tug')
    expect(archetypeFor(30)).toBe('vessel-fishing')
    expect(archetypeFor(36)).toBe('vessel-sail')
    expect(archetypeFor(37)).toBe('vessel-motor')
    expect(archetypeFor(0)).toBe('vessel-generic')
    expect(archetypeFor(31)).toBe('vessel-tug') // towing
    // Untyped and "other" ships of real size get the cargo silhouette
    expect(archetypeFor(0, 135)).toBe('vessel-cargo')
    expect(archetypeFor(90, 52)).toBe('vessel-cargo')
    expect(archetypeFor(0, 20)).toBe('vessel-generic')
    for (let code = 0; code <= 99; code++) {
      expect(VESSEL_MODELS).toHaveProperty(archetypeFor(code))
    }
  })
})
