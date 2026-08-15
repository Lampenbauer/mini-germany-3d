import { expect, test, type Page } from '@playwright/test'

/**
 * Visuelle Regressionstests: eingefrorene Simulation um 08:30 im
 * Offline-Modus → deterministisches Rendering (Gitter-Globus, Routen,
 * Haltestellen, Straßenbahnen, UI-Panel).
 *
 * Baselines aktualisieren:  npm run test:e2e:update
 */

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
  // Cesium ein paar Frames rendern lassen (Kacheln des Gitter-Globus, Labels)
  await page.waitForTimeout(3000)
})

test.afterAll(async () => {
  await page.close()
})

test('Gesamtansicht (Karte + Panel)', async () => {
  await expect(page).toHaveScreenshot('app-offline-0830.png')
})

test('Control-Panel im Detail', async () => {
  const panel = page.locator('[data-slot=card]').first()
  await expect(panel).toHaveScreenshot('control-panel.png')
})

test('Info-Karte einer ausgewählten Bahn', async () => {
  await page.evaluate(() => {
    const tram = window.__mrt!.trams().find((t) => t.lineId === '1')!
    window.__mrt!.selectTram(tram.id)
  })
  const card = page.getByTestId('tram-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveScreenshot('tram-card.png')
  await page.evaluate(() => window.__mrt!.selectTram(null))
})
