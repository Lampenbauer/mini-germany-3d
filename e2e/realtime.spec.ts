import { expect, test } from '@playwright/test'

/**
 * Eigene Spec, damit während dieses Tests keine zweite Cesium-/SwiftShader-
 * Instanz aus den langlebigen app.spec.ts-Fixtures geöffnet bleibt.
 */
test('GTFS-Realtime-Endpunkt wird abgeholt und im Panel angezeigt', async ({ page }) => {
  // Ein einzelner Cesium-Boot kann auf ausgelasteten CI-Runnern weiterhin
  // deutlich länger als lokal dauern.
  test.setTimeout(240_000)

  // Den gefilterten JSON-Endpunkt mocken – verifiziert die Kette
  // fetch → Validierung → Status-Badge im Panel.
  await page.route('**/api/realtime', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        timestamp: 1700000000,
        total: 42,
        delays: { 'irgendein-trip': 120 },
      }),
    }),
  )

  await page.goto('/?offline=1&rt=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true)

  const badge = page.getByTestId('rt-status')
  await expect(badge).toBeVisible()
  await expect(badge).toContainText('GTFS-RT')
})
