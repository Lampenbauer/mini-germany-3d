import { expect, test } from '@playwright/test'

/**
 * The night-time street lighting (see src/map/StreetLampsLayer.ts): built
 * only once it would be visible, faded by the sun ramp, and off entirely
 * with ?lamps=0.
 */

test('street lamps light up at night and go dark by day', async ({ page }) => {
  test.setTimeout(240_000)

  // Daytime: nothing is built, and nothing is drawn
  await page.goto('/?offline=1&time=12:00&paused=1&rain=0#lat=54.0880&lon=12.1330&height=900&heading=0&pitch=-45')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.streetLamps().alpha), { timeout: 20_000 })
    .toBe(0)
  expect(await page.evaluate(() => window.__mrt!.streetLamps().drawn)).toBe(0)

  // Night: the pools are built and lit
  await page.evaluate(() => window.__mrt!.setTime('23:30'))
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.streetLamps().alpha), { timeout: 60_000 })
    .toBeGreaterThan(0)
  const lit = await page.evaluate(() => window.__mrt!.streetLamps())
  expect(lit.drawn).toBeGreaterThan(1000)

  // Back to day: the pools stay built but go dark again
  await page.evaluate(() => window.__mrt!.setTime('12:00'))
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.streetLamps().alpha), { timeout: 60_000 })
    .toBe(0)
})

test('?lamps=0 leaves the street lighting out entirely', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=23:30&paused=1&rain=0&lamps=0#lat=54.0880&lon=12.1330&height=900&heading=0&pitch=-45')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  await page.waitForTimeout(5000)
  const info = await page.evaluate(() => window.__mrt!.streetLamps())
  expect(info.drawn).toBe(0)
  expect(info.alpha).toBe(0)
})
