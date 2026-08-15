import { describe, expect, it } from 'vitest'
import { prepareNetwork } from '@/data/network'
import { loadBundledNetwork } from '@/data/network'
import { computeHomeView } from '@/lib/camera'
import { testNetworkJson } from './fixtures'

describe('computeHomeView', () => {
  it('zentriert die Kamera südlich des Netz-Mittelpunkts', () => {
    const network = prepareNetwork(testNetworkJson)
    const view = computeHomeView(network)
    // Fixture: Nord-Süd-Strecke bei lon 12.1, lat 54.0–54.018
    expect(view.longitude).toBeCloseTo(12.1, 3)
    expect(view.latitude).toBeLessThan(54.0)
    expect(view.heading).toBe(0)
    expect(view.pitch).toBeLessThan(0)
    expect(view.height).toBeGreaterThanOrEqual(2500)
    expect(view.height).toBeLessThanOrEqual(9000)
  })

  it('liefert für das gebündelte Netz eine Ansicht über Rostock', () => {
    const view = computeHomeView(loadBundledNetwork())
    expect(view.longitude).toBeGreaterThan(11.95)
    expect(view.longitude).toBeLessThan(12.3)
    expect(view.latitude).toBeGreaterThan(53.9)
    expect(view.latitude).toBeLessThan(54.2)
    expect(view.height).toBeGreaterThanOrEqual(2500)
    expect(view.height).toBeLessThanOrEqual(9000)
  })
})
