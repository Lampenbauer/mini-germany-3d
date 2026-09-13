import { describe, expect, it } from 'vitest'
import { BUOYS, BUOY_COLOURS, BUOY_SHAPES } from '../scripts/lib/buoy-fleet.mjs'
import { MATERIALS, toGlb, triangleCount } from '../scripts/lib/vehicle-mesh.mjs'
import { BUOY_MODELS, buoyModelUri } from '@/map/BuoysLayer'

/**
 * The buoy fleet, same contract as the ships': every mark stands as high
 * over the waterline as its shape says, keeps inside its radius, sits in
 * the water rather than on it, stays within a small geometry budget, and
 * the layer's table of where the lanterns are is the shipyard's.
 */

function bounds(mesh: ReturnType<(typeof BUOYS)[string]>) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let radius = 0
  for (const g of mesh.groups.values()) {
    for (let i = 0; i < g.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], g.positions[i + k])
        max[k] = Math.max(max[k], g.positions[i + k])
      }
      radius = Math.max(radius, Math.hypot(g.positions[i], g.positions[i + 2]))
    }
  }
  return { min, max, radius }
}

describe('the generated buoy fleet', () => {
  it('has a model for every shape in every colour, named as the layer asks for it', () => {
    for (const shape of Object.keys(BUOY_SHAPES) as (keyof typeof BUOY_SHAPES)[]) {
      for (const colour of BUOY_COLOURS) {
        expect(BUOYS, `${shape} ${colour}`).toHaveProperty(`buoy-${shape}-${colour}`)
        expect(buoyModelUri(shape, colour)).toBe(`models/buoy-${shape}-${colour}.glb`)
      }
    }
    expect(Object.keys(BUOYS)).toHaveLength(Object.keys(BUOY_SHAPES).length * BUOY_COLOURS.length)
  })

  it('agrees with the layer on where every shape’s lantern is', () => {
    for (const [shape, spec] of Object.entries(BUOY_SHAPES)) {
      expect(BUOY_MODELS[shape as keyof typeof BUOY_MODELS].lightHeight, shape).toBe(spec.lightHeight)
    }
  })

  for (const [name, buildMesh] of Object.entries(BUOYS)) {
    describe(name, () => {
      const mesh = buildMesh()
      const glb = toGlb(mesh, { name })
      const shape = name.split('-')[1] as keyof typeof BUOY_SHAPES
      const colour = name.split('-')[2]
      const spec = BUOY_SHAPES[shape]
      const { min, max, radius } = bounds(mesh)

      it('stands as high over the waterline as its shape says, and no wider', () => {
        // The tallest colour reaches the shape's height, the other
        // topmarks a hand less
        expect(max[1]).toBeGreaterThan(spec.height - 0.35)
        expect(max[1]).toBeLessThan(spec.height + 0.05)
        expect(radius).toBeLessThan(spec.radius + 0.05)
        expect(radius).toBeGreaterThan(spec.radius * 0.8)
        // Origin on the waterline: something of every mark is in the water
        expect(min[1]).toBeLessThan(-0.2)
        expect(min[1]).toBeGreaterThan(-2)
      })

      it('carries its lantern inside the model, over the water', () => {
        expect(spec.lightHeight).toBeGreaterThan(spec.height * 0.6)
        expect(spec.lightHeight).toBeLessThan(spec.height + 0.3)
      })

      it('wears its colour and no other mark’s', () => {
        const materials = [...mesh.groups.keys()]
        expect(materials).toContain(`buoy${colour[0].toUpperCase()}${colour.slice(1)}`)
        for (const other of BUOY_COLOURS.filter((c) => c !== colour)) {
          expect(materials).not.toContain(`buoy${other[0].toUpperCase()}${other.slice(1)}`)
        }
        for (const material of materials) expect(MATERIALS, material).toHaveProperty(material)
      })

      it('stays within its geometry and file-size budget', () => {
        expect(triangleCount(mesh)).toBeLessThan(500)
        expect(glb.byteLength).toBeLessThan(30_000)
      })
    })
  }
})
