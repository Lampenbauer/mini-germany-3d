import { expect, test, type Page } from '@playwright/test'
import { PNG } from 'pngjs'

/**
 * Visuelle Tests: eingefrorene Simulation um 08:30 im Offline-Modus
 * (Gitter-Globus, Routen, Haltestellen, Straßenbahnen, UI-Panel).
 *
 * Zwei Ebenen:
 * 1. Karten-Rendering: Pixel-Analyse des Seiten-Screenshots (sind farbige
 *    Routen/Bahnen sichtbar?). Bewusst KEIN Baseline-Vergleich – WebGL-Ausgaben
 *    unterscheiden sich zwischen GPU-/SwiftShader-Versionen (z.B. lokal vs. CI)
 *    großflächig im Antialiasing. Der Screenshot wird dem Report angehängt.
 * 2. UI-Elemente (Panel, Info-Karte): pixelgenauer Baseline-Vergleich per
 *    toMatchSnapshot – die Panels sind im Offline-Modus opak und nutzen die
 *    gebündelte Inter-Schrift, dadurch umgebungsunabhängig.
 *
 * Baselines aktualisieren (nach UI- oder Datenänderungen):
 *   npm run test:e2e:update
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

test('Karte rendert Routen und Bahnen (Pixel-Analyse)', async ({}, testInfo) => {
  const shot = await page.screenshot()
  await testInfo.attach('app-offline-0830', { body: shot, contentType: 'image/png' })

  const png = PNG.sync.read(shot)
  const total = png.width * png.height
  let colorful = 0
  let dark = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]
    const g = png.data[i + 1]
    const b = png.data[i + 2]
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colorful++
    if (r + g + b < 90) dark++
  }

  // Farbige Pixel = Routen-Polylinien, Straßenbahnen, Linien-Badges.
  // Ein schwarzer/leerer Canvas fällt hier durch (nur Panel-Chips ≈ 0,2 %).
  // Gemessener Normalwert: ~1,7 %.
  expect(colorful / total).toBeGreaterThan(0.005)
  // Dunkler Kartenhintergrund muss dominieren (Seite ist nicht weiß/leer);
  // gemessener Normalwert: ~95 %.
  expect(dark / total).toBeGreaterThan(0.3)
  expect(dark / total).toBeLessThan(0.99)
})

// Für Element-Screenshots nutzen wir toMatchSnapshot (Einzelaufnahme mit
// Toleranz) statt toHaveScreenshot: Letzteres wartet auf zwei identische
// aufeinanderfolgende Frames – durch das kontinuierliche Cesium-Rendering
// hinter den abgerundeten Panel-Ecken wird das nie ganz stabil. Aus dem
// gleichen Grund fotografieren wir per page.screenshot({ clip }) statt
// locator.screenshot(): Letzteres enthält eine eigene Stabilitäts-Warteschleife
// (scrollIntoView), die auf ausgelasteten CI-Runnern in den Timeout läuft.
async function elementShot(locator: ReturnType<Page['locator']>) {
  const box = (await locator.boundingBox())!
  return page.screenshot({ clip: box, animations: 'disabled' })
}

test('Control-Panel im Detail', async () => {
  // page.screenshot rendert die Seite samt Cesium-Canvas – mit ~350
  // Fahrzeugen unter SwiftShader dauert das auf CI-Runnern zusätzlich lange.
  test.setTimeout(240_000)
  const panel = page.locator('[data-slot=card]').first()
  expect(await elementShot(panel)).toMatchSnapshot('control-panel.png', {
    maxDiffPixelRatio: 0.03,
  })
})

test('Info-Karte einer ausgewählten Bahn', async () => {
  test.setTimeout(240_000)
  await page.evaluate(() => {
    const tram = window.__mrt!.trams().find((t) => t.lineId === '1')!
    window.__mrt!.selectTram(tram.id)
  })
  const card = page.getByTestId('tram-card')
  await expect(card).toBeVisible()
  expect(await elementShot(card)).toMatchSnapshot('tram-card.png', {
    maxDiffPixelRatio: 0.03,
  })
  await page.evaluate(() => window.__mrt!.selectTram(null))
})
