import { expect, test } from '@playwright/test'

/**
 * Separate spec so that no second Cesium/SwiftShader instance from the
 * long-lived app.spec.ts fixtures stays open during this test.
 */
test('GTFS-Realtime endpoint is fetched and shown in the panel', async ({ page }) => {
  // A single Cesium boot can still take much longer on busy CI runners
  // than it does locally.
  test.setTimeout(240_000)

  // Mock the filtered JSON endpoint – verifies the chain
  // fetch → validation → status badge in the panel.
  await page.route('**/api/realtime', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        timestamp: 1700000000,
        total: 42,
        delays: { 'some-trip': 120 },
      }),
    }),
  )

  await page.goto('/?offline=1&rt=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true)

  const badge = page.getByTestId('rt-status')
  await expect(badge).toBeVisible()
  await expect(badge).toContainText('GTFS-RT')
})
