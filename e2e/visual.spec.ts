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

// Für Element-Screenshots nutzen wir toMatchSnapshot (Einzelaufnahme mit
// Toleranz) statt toHaveScreenshot: Letzteres wartet auf zwei identische
// aufeinanderfolgende Frames – durch das kontinuierliche Cesium-Rendering
// hinter den abgerundeten Panel-Ecken wird das nie ganz stabil.
test('Control-Panel im Detail', async () => {
  const panel = page.locator('[data-slot=card]').first()
  expect(await panel.screenshot({ animations: 'disabled' })).toMatchSnapshot(
    'control-panel.png',
    { maxDiffPixelRatio: 0.02 },
  )
})

test('Info-Karte einer ausgewählten Bahn', async () => {
  await page.evaluate(() => {
    const tram = window.__mrt!.trams().find((t) => t.lineId === '1')!
    window.__mrt!.selectTram(tram.id)
  })
  const card = page.getByTestId('tram-card')
  await expect(card).toBeVisible()
  expect(await card.screenshot({ animations: 'disabled' })).toMatchSnapshot('tram-card.png', {
    maxDiffPixelRatio: 0.02,
  })
  await page.evaluate(() => window.__mrt!.selectTram(null))
})
