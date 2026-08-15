import { describe, expect, it } from 'vitest'
import { loadBundledNetwork } from '@/data/network'

/**
 * Validiert den gebündelten Rostock-Datensatz: Wenn diese Tests grün sind,
 * kann die Simulation auf jeder Linie fehlerfrei fahren.
 */
describe('gebündeltes Rostocker Netz', () => {
  const network = loadBundledNetwork()

  it('enthält die RSAG-Linien 1, 2, 3, 5, 6', () => {
    expect(network.lines.map((l) => l.id).sort()).toEqual(['1', '2', '3', '5', '6'])
  })

  it('hat eindeutige, gültige Linienfarben', () => {
    const colors = network.lines.map((l) => l.color)
    expect(new Set(colors).size).toBe(colors.length)
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('jede Richtung hat mindestens 2 Haltestellen und plausible Streckenlänge', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        expect(dir.stops.length).toBeGreaterThanOrEqual(2)
        expect(dir.totalLength).toBeGreaterThan(2000)
        expect(dir.totalLength).toBeLessThan(20000)
      }
    }
  })

  it('Haltestellen liegen monoton entlang der Strecke (beide Richtungen)', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (let i = 1; i < dir.stops.length; i++) {
          expect(
            dir.stops[i].dist,
            `${line.id}/R${dir.direction}: ${dir.stops[i - 1].id} → ${dir.stops[i].id}`,
          ).toBeGreaterThan(dir.stops[i - 1].dist)
        }
        // Erste/letzte Haltestelle nahe Streckenanfang/-ende
        expect(dir.stops[0].dist).toBeLessThan(50)
        expect(dir.totalLength - dir.stops[dir.stops.length - 1].dist).toBeLessThan(50)
      }
    }
  })

  it('alle Koordinaten liegen im Rostocker Stadtgebiet', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const [lon, lat] of dir.path) {
          expect(lon).toBeGreaterThan(11.95)
          expect(lon).toBeLessThan(12.3)
          expect(lat).toBeGreaterThan(53.99)
          expect(lat).toBeLessThan(54.22)
        }
      }
    }
  })

  it('Endhaltestellen entsprechen dem realen RSAG-Netz', () => {
    const byId = Object.fromEntries(
      network.lines.map((l) => [l.id, [l.directions[0].from, l.directions[0].to]]),
    )
    expect(byId['1']).toEqual(['Mecklenburger Allee', 'Hafenallee'])
    expect(byId['2']).toEqual(['Reutershagen', 'Kurt-Schumacher-Ring'])
    expect(byId['3']).toEqual(['Neuer Friedhof', 'Kurt-Schumacher-Ring'])
    expect(byId['5']).toEqual(['Mecklenburger Allee', 'Südblick'])
    expect(byId['6']).toEqual(['Neuer Friedhof', 'Campus Südstadt'])
  })
})
