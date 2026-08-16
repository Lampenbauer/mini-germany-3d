import { expect, test } from '@playwright/test'

/**
 * Eigene Spec, damit Speichern und Wiederherstellen nacheinander auf derselben
 * Seite laufen und nie zwei Cesium-/SwiftShader-Instanzen parallel existieren.
 */
test('Kameraausrichtung wird im URL-Hash gespeichert und wiederhergestellt', async ({
  page,
}) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true)

  // Hash wird spätestens alle 1500 ms aktualisiert.
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 })
    .toMatch(/^#lat=[\d.]+&lon=[\d.]+&height=\d+&heading=\d+&pitch=-?\d+$/)

  // Nur den Hash derselben URL zu ändern wäre eine Same-Document-Navigation.
  // Der Zwischenstopp zerstört die erste Cesium-Instanz und erzwingt danach
  // einen frischen App-Boot, ohne zwei WebGL-Kontexte parallel zu halten.
  await page.goto('about:blank')
  await page.goto(
    '/?offline=1&time=08:30&paused=1#lat=54.0901&lon=12.1405&height=800&heading=90&pitch=-45',
  )
  await page.waitForFunction(() => window.__mrt?.ready === true)

  const view = await page.evaluate(() => {
    const camera = window.__cesiumViewer!.camera.positionCartographic
    return {
      lat: (camera.latitude * 180) / Math.PI,
      lon: (camera.longitude * 180) / Math.PI,
      height: camera.height,
    }
  })
  expect(view.lat).toBeCloseTo(54.0901, 3)
  expect(view.lon).toBeCloseTo(12.1405, 3)
  expect(view.height).toBeGreaterThan(700)
  expect(view.height).toBeLessThan(900)
})
