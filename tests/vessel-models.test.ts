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

  it('gives the working craft of a port their own hulls', () => {
    // Each of these carries a type code of its own, and the vessel card
    // has always named them – only the map drew them all as tugs.
    expect(archetypeFor(33)).toBe('vessel-dredger')
    expect(archetypeFor(53)).toBe('vessel-tender') // port tender: the barkasse
    expect(archetypeFor(50)).toBe('vessel-pilot')
    expect(archetypeFor(51)).toBe('vessel-pilot') // search and rescue
    expect(archetypeFor(55)).toBe('vessel-pilot') // law enforcement
    // What stays a tug stays a tug
    expect(archetypeFor(52)).toBe('vessel-tug')
    expect(archetypeFor(54)).toBe('vessel-tug') // anti-pollution
  })

  it('reads the hull off the codes ITU-R M.1371-6 spells out', () => {
    // The 2026 table splits the cargo group and names the launch, the
    // trawler and the patrol boat – where a ship says so, believe it
    expect(archetypeFor(76)).toBe('vessel-container')
    expect(archetypeFor(76, 90, 14)).toBe('vessel-container') // even a small one
    expect(archetypeFor(75, 250, 43)).toBe('vessel-cargo') // bulk carrier: no boxes
    expect(archetypeFor(77, 200, 32)).toBe('vessel-cargo') // ro-ro: no boxes either
    expect(archetypeFor(78, 40, 10)).toBe('vessel-barge') // landing craft
    expect(archetypeFor(67, 45, 10)).toBe('vessel-tender') // harbour cruise boat
    expect(archetypeFor(38, 25)).toBe('vessel-fishing') // trawler
    expect(archetypeFor(39, 30)).toBe('vessel-pilot') // patrol vessel
    // A big working ship is a ship, but never a box carrier
    expect(archetypeFor(4, 90, 20)).toBe('vessel-cargo') // ice breaker
    expect(archetypeFor(6, 160, 24)).toBe('vessel-cargo') // cable layer
    expect(archetypeFor(14, 20, 8)).toBe('vessel-generic') // small support vessel
  })

  it('tells a container ship from a coaster by size, having no code for it', () => {
    // AIS 70–79 is every dry cargo ship there is; the length decides
    expect(archetypeFor(70, 330, 48)).toBe('vessel-container') // a ULCV on the Elbe
    expect(archetypeFor(79, 170, 27)).toBe('vessel-container') // a feeder
    expect(archetypeFor(70, 90, 14)).toBe('vessel-cargo') // a coaster
    expect(archetypeFor(70, 149, 22)).toBe('vessel-cargo')
    expect(archetypeFor(70, 150, 22)).toBe('vessel-container')
    // An untyped contact of that size is drawn as one too
    expect(archetypeFor(0, 330, 48)).toBe('vessel-container')
  })

  it('tells an inland ship from a seagoing one by its beam', () => {
    // The Europaschiff is 85 × 9.5 m; no coaster is that narrow
    expect(archetypeFor(70, 85, 9.5)).toBe('vessel-barge')
    expect(archetypeFor(80, 86, 9.6)).toBe('vessel-barge') // inland tanker
    expect(archetypeFor(0, 105, 11)).toBe('vessel-barge')
    // Without a reported beam the question cannot be asked
    expect(archetypeFor(70, 85, null)).toBe('vessel-cargo')
    // Inland ships hand their type code out freely – these three were on
    // the Elbe calling themselves wing-in-ground craft and "not available"
    expect(archetypeFor(20, 177, 12)).toBe('vessel-barge') // RHENUS BRAUNSCHWEIG
    expect(archetypeFor(20, 100, 9)).toBe('vessel-barge') // STADT FUERTH
    expect(archetypeFor(0, 85, 11)).toBe('vessel-barge')
    // A seagoing coaster of the same length is beamier
    expect(archetypeFor(70, 88, 13)).toBe('vessel-cargo')
    // And a short narrow boat is not a barge either
    expect(archetypeFor(70, 40, 8)).toBe('vessel-cargo')
  })

  it('draws a harbour launch as one, whatever it calls itself', () => {
    // Hamburg's barkassen mostly broadcast type 60; a cruise-ship
    // silhouette squeezed to 20 m reads as a toy of the wrong thing
    expect(archetypeFor(60, 22, 5)).toBe('vessel-tender')
    expect(archetypeFor(69, 30)).toBe('vessel-tender')
    expect(archetypeFor(40, 25)).toBe('vessel-tender') // small high-speed craft
    expect(archetypeFor(60, 35)).toBe('vessel-passenger')
    expect(archetypeFor(60, 160, 24)).toBe('vessel-passenger')
    // No length reported: the group's own hull, as before
    expect(archetypeFor(60)).toBe('vessel-passenger')
  })
})
