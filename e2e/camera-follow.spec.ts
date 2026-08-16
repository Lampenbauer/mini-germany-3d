import { expect, test } from '@playwright/test'

/**
 * Eigene Spec für den renderintensiven Follow-Test: Er startet mit einer
 * frischen Kamera und sein Retry wiederholt nicht die schnellen App-Tests.
 */
test('„Bahn folgen“ führt die Kamera zur Bahn', async ({ page }) => {
  // Ein langsamer SwiftShader-Boot plus die beiden Render-Loop-Polls brauchen
  // auf ausgelasteten CI-Runnern mehr Spielraum als das globale 90-s-Limit.
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.tramCount() > 0,
    undefined,
    { timeout: 120_000 },
  )

  // Render-Loop muss laufen (Diagnose: lastLoopError zeigt ggf. die Ursache).
  const ticksBefore = await page.evaluate(() => window.__mrt!.loopTicks())
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => ({
          ticks: window.__mrt!.loopTicks(),
          error: window.__mrt!.lastLoopError(),
        }))
        expect(state.error, `Render-Loop-Fehler: ${state.error}`).toBeNull()
        return state.ticks
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(ticksBefore)

  const tram = await page.evaluate(() => window.__mrt!.trams()[0])
  await page.evaluate((id) => window.__mrt!.selectTram(id), tram.id)
  // force: Playwrights Actionability-Retry kann unter SwiftShader-Last auf dem
  // Canvas landen und damit die Auswahl schließen (Klick auf leere Karte).
  await page.getByRole('button', { name: 'Bahn folgen' }).click({ force: true })
  await expect(page.getByRole('button', { name: 'Verfolgung beenden' })).toBeVisible()

  // Kamera muss sich in die Nähe der (pausierten) Bahn bewegen.
  // Großzügiges Timeout: Unter SwiftShader-Software-Rendering können einzelne
  // Frames sekundenlang dauern, bis die Follow-Kamera greift.
  await expect
    .poll(
      async () => {
        const state = await page.evaluate((tramId) => {
          const camera = window.__cesiumViewer!.camera.positionCartographic
          const tramNow = window.__mrt!.trams().find(({ id }) => id === tramId)
          if (!tramNow) {
            return {
              dist: Number.POSITIVE_INFINITY,
              loopError: `Ausgewählte Bahn ${tramId} ist nicht mehr aktiv`,
            }
          }
          const camLat = (camera.latitude * 180) / Math.PI
          const camLon = (camera.longitude * 180) / Math.PI
          const dLat = (camLat - tramNow.lat) * 110540
          const dLon =
            (camLon - tramNow.lon) * 111320 * Math.cos((tramNow.lat * Math.PI) / 180)
          return {
            dist: Math.hypot(dLat, dLon),
            loopError: window.__mrt!.lastLoopError(),
          }
        }, tram.id)
        // Ein Loop-Fehler nach dem Klick würde das Folgen still verhindern –
        // dann soll der Test die Ursache nennen statt nur die Distanz.
        expect(state.loopError, `Render-Loop-Fehler: ${state.loopError}`).toBeNull()
        return state.dist
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBeLessThan(1500)

  await page.getByRole('button', { name: 'Verfolgung beenden' }).click({ force: true })
  await page.getByRole('button', { name: 'Auswahl schließen' }).click({ force: true })
  await expect(page.getByTestId('tram-card')).not.toBeVisible()
})
