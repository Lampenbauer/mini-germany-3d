import { expect, test, type Page } from '@playwright/test'

/**
 * Funktionale E2E-Tests gegen die echte App (Cesium via SwiftShader).
 * Die Simulation startet eingefroren um 08:30 → deterministische Zustände.
 *
 * Alle Tests teilen sich eine Page (Cesium-Start unter Software-Rendering ist
 * teuer); der Zustand wird vor jedem Test über die Test-API zurückgesetzt.
 */

declare global {
  interface Window {
    __mrt?: {
      ready: boolean
      tramCount: () => number
      visibleTramCount: () => number
      trams: () => { id: string; lineId: string; nextStopName: string }[]
      setTime: (hhmm: string) => void
      setSpeed: (speed: number) => void
      setPaused: (paused: boolean) => void
      selectTram: (id: string | null) => void
      dataSource: string
      lineIds: () => string[]
    }
  }
}

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.tramCount() > 0,
    undefined,
    { timeout: 60_000 },
  )
})

test.afterAll(async () => {
  await page.close()
})

test.beforeEach(async () => {
  // Simulationszustand normalisieren
  await page.evaluate(() => {
    window.__mrt!.selectTram(null)
    window.__mrt!.setPaused(true)
    window.__mrt!.setTime('08:30')
    window.__mrt!.setSpeed(1)
  })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.tramCount()))
    .toBeGreaterThan(0)
})

test('lädt die App mit Karte und Control-Panel', async () => {
  await expect(page).toHaveTitle('Mini Rostock 3D')
  await expect(page.getByText('Mini Rostock 3D')).toBeVisible()
  await expect(page.getByText('Straßenbahnnetz der RSAG – Fahrplansimulation')).toBeVisible()
  await expect(page.locator('[data-testid=cesium-container] canvas')).toBeVisible()
  await expect(page.getByTestId('tileset-status')).toHaveText('Offline-Modus')
  const source = await page.evaluate(() => window.__mrt!.dataSource)
  await expect(page.getByTestId('data-source')).toHaveText(
    source === 'osm' ? 'OSM-Geometrie' : 'Demo-Daten (approximiert)',
  )
})

test('zeigt die eingefrorene Simulationszeit 08:30', async () => {
  await expect(page.getByTestId('sim-clock')).toHaveText('08:30:00')
})

test('zeigt aktive Bahnen auf allen Linien des Netzes', async () => {
  const expected = await page.evaluate(() => window.__mrt!.lineIds())
  const activeLineIds = await page.evaluate(() => [
    ...new Set(window.__mrt!.trams().map((t) => t.lineId)),
  ])
  expect(activeLineIds.sort()).toEqual(expected.sort())

  await expect(page.getByTestId('tram-count')).toContainText(/\d+ Bahnen unterwegs/)
  const count = await page.evaluate(() => window.__mrt!.visibleTramCount())
  await expect(page.getByTestId('tram-count')).toContainText(`${count} Bahnen unterwegs`)
})

test('Linien-Switch blendet Bahnen der Linie aus', async () => {
  const before = await page.evaluate(() => window.__mrt!.visibleTramCount())
  await page.getByRole('switch', { name: 'Linie 1 anzeigen' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleTramCount()))
    .toBeLessThan(before)
  await page.getByRole('switch', { name: 'Linie 1 anzeigen' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleTramCount()))
    .toBe(before)
})

test('Auswahl einer Bahn öffnet die Info-Karte', async () => {
  const tram = await page.evaluate(() => window.__mrt!.trams()[0])
  await page.evaluate((id) => window.__mrt!.selectTram(id), tram.id)

  const card = page.getByTestId('tram-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('tram-next-stop')).toHaveText(tram.nextStopName)
  await expect(card.getByRole('button', { name: 'Bahn folgen' })).toBeVisible()

  await card.getByRole('button', { name: 'Auswahl schließen' }).click()
  await expect(card).not.toBeVisible()
})

test('nachts fahren keine Bahnen, morgens wieder', async () => {
  // 02:30: sicher vor der ersten Abfahrt (real wie synthetisch)
  await page.evaluate(() => window.__mrt!.setTime('02:30'))
  await expect.poll(() => page.evaluate(() => window.__mrt!.tramCount())).toBe(0)
  await expect(page.getByTestId('tram-count')).toContainText('0 Bahnen unterwegs')

  await page.evaluate(() => window.__mrt!.setTime('08:30'))
  await expect.poll(() => page.evaluate(() => window.__mrt!.tramCount())).toBeGreaterThan(0)
})

test('Zeitraffer bewegt die Bahnen', async () => {
  const before = await page.evaluate(() =>
    JSON.stringify(window.__mrt!.trams().map((x) => x.id)),
  )
  await page.evaluate(() => {
    window.__mrt!.setPaused(false)
    window.__mrt!.setSpeed(300)
  })
  // Nach ein paar Sekunden ×300 müssen sich die aktiven Fahrten geändert haben
  await expect
    .poll(
      () =>
        page.evaluate(
          (prev) => JSON.stringify(window.__mrt!.trams().map((x) => x.id)) !== prev,
          before,
        ),
      { timeout: 20_000 },
    )
    .toBe(true)
})

test('Pause-Button und Kamera-Reset sind bedienbar', async () => {
  // Ausgangszustand: App wurde mit paused=1 geladen → Button zeigt "fortsetzen"
  await page.getByRole('button', { name: 'Simulation fortsetzen' }).click()
  await expect(page.getByRole('button', { name: 'Simulation pausieren' })).toBeVisible()
  await page.getByRole('button', { name: 'Simulation pausieren' }).click()
  await expect(page.getByRole('button', { name: 'Simulation fortsetzen' })).toBeVisible()
  await page.getByRole('button', { name: 'Kamera zurücksetzen' }).click()
})
