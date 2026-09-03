import { expect, test } from '@playwright/test'

/**
 * Below ground there is no weather: no drops falling around a camera that
 * sits under the city.
 *
 * On its own page, and a deliberately cheap one – routes and stops off, a
 * 40-drop pool. Visible rain counts as an animation, so the app renders
 * the whole scene at full rate for as long as it falls, and the UI tick
 * this test waits on rides along on that loop. Measured locally under
 * SwiftShader: the full scene at 1000 drops runs the loop at 2.6 ticks/s,
 * this page at 8.6 – and a loaded CI runner is a large factor slower
 * again. Sharing app.spec's page also meant a flake here retried all
 * fourteen of its tests.
 */
test('the underground view stops the rain', async ({ page }) => {
  test.setTimeout(240_000)
  const slowPoll = { timeout: 60_000, intervals: [500, 1000, 2000] }
  const drops = () => page.evaluate(() => window.__mrt!.rainDropsVisible())

  await page.goto('/?offline=1&time=08:30&paused=1&drops=40#routes=0&stops=0')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })

  await page.evaluate(() => window.__mrt!.setRain(0.2))
  await expect.poll(drops, slowPoll).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Show underground view' }).click()
  // No drops falling around a camera that is below ground
  await expect.poll(drops, slowPoll).toBe(0)

  // Dry before leaving again, so the second click lands on an idle scene
  await page.evaluate(() => window.__mrt!.setRain(0))
  await page.getByRole('button', { name: 'Back to the surface view' }).click()

  // The gate opens both ways: rain set on the surface shows up again
  await page.evaluate(() => window.__mrt!.setRain(0.2))
  await expect.poll(drops, slowPoll).toBeGreaterThan(0)
  await page.evaluate(() => window.__mrt!.setRain(0))
})

/**
 * The weather picker in the scene popover, on the same cheap page: a
 * picked sky is set rather than polled, so it works offline – and it has
 * to reach the map through the same per-tick path the live weather uses.
 */
test('a picked sky puts rain in the air and takes it out again', async ({ page }) => {
  test.setTimeout(240_000)
  const slowPoll = { timeout: 60_000, intervals: [500, 1000, 2000] }
  const drops = () => page.evaluate(() => window.__mrt!.rainDropsVisible())

  await page.goto('/?offline=1&time=08:30&paused=1&drops=40#routes=0&stops=0')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })

  await page.getByRole('button', { name: 'Scene' }).click()
  // Offline there is nothing to poll, so live weather is not on offer
  await expect(page.getByRole('radio', { name: 'Live weather' })).toBeDisabled()

  await page.getByRole('radio', { name: 'Rain' }).click()
  await expect(page.getByRole('radio', { name: 'Rain' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(drops, slowPoll).toBeGreaterThan(0)

  await page.getByRole('radio', { name: 'Sunny' }).click()
  await expect.poll(drops, slowPoll).toBe(0)
})
