import { describe, expect, it } from 'vitest'
import { loadBundledNetwork } from '@/data/network'

/**
 * Validiert den gebündelten Netzdatensatz: Wenn diese Tests grün sind,
 * kann die Simulation auf jeder Linie fehlerfrei fahren.
 *
 * Strukturelle Prüfungen gelten für jede Datenquelle (auch nach
 * `npm run data:update` mit echten OSM-Daten); die strikten RSAG-Prüfungen
 * laufen nur für den mitgelieferten approximierten Demo-Datensatz.
 */
describe('Netzdatensatz (strukturell, quellenunabhängig)', () => {
  const network = loadBundledNetwork()

  it('enthält mindestens eine Linie mit gültiger Farbe', () => {
    expect(network.lines.length).toBeGreaterThan(0)
    for (const line of network.lines) {
      expect(line.color).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(line.name.length).toBeGreaterThan(0)
    }
  })

  it('jede Richtung hat mindestens 2 Haltestellen und plausible Streckenlänge', () => {
    for (const line of network.lines) {
      // Die Gehlsdorf-Fähre quert die Warnow auf nur ~500 m
      const minLength = line.mode === 'ferry' ? 200 : 1000
      for (const dir of line.directions) {
        expect(dir.stops.length).toBeGreaterThanOrEqual(2)
        expect(dir.totalLength).toBeGreaterThan(minLength)
        expect(dir.totalLength).toBeLessThan(30000)
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
      }
    }
  })

  it('alle Koordinaten liegen im Rostocker Stadtgebiet', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const [lon, lat] of dir.path) {
          expect(lon).toBeGreaterThan(11.9)
          expect(lon).toBeLessThan(12.4)
          expect(lat).toBeGreaterThan(53.9)
          expect(lat).toBeLessThan(54.25)
        }
      }
    }
  })

  it('Haltestellen-Namen sind nicht leer', () => {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          expect(stop.name.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe.runIf(loadBundledNetwork().meta.source === 'approximated')(
  'Demo-Datensatz (strikte RSAG-Prüfungen)',
  () => {
    const network = loadBundledNetwork()

    it('enthält die RSAG-Linien 1, 2, 3, 5, 6', () => {
      expect(network.lines.map((l) => l.id).sort()).toEqual(['1', '2', '3', '5', '6'])
    })

    it('hat eindeutige Linienfarben', () => {
      const colors = network.lines.map((l) => l.color)
      expect(new Set(colors).size).toBe(colors.length)
    })

    it('erste/letzte Haltestelle liegen an Streckenanfang/-ende', () => {
      for (const line of network.lines) {
        for (const dir of line.directions) {
          expect(dir.stops[0].dist).toBeLessThan(50)
          expect(dir.totalLength - dir.stops[dir.stops.length - 1].dist).toBeLessThan(50)
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
  },
)
