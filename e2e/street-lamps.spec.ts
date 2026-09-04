import { expect, test } from '@playwright/test'

/**
 * The night-time street lighting (see src/map/StreetLampsLayer.ts): built
 * only once it would be visible, faded by the sun ramp, put out by the
 * underground view, and off entirely with ?lamps=0.
 *
 * Two boots, not three. Building seven thousand light pools and getting
 * them onto a SwiftShader frame is the expensive part here, and the
 * night ramp and the underground view can be checked on the same lit
 * scene instead of raising it twice. The routes are off throughout: this
 * measures the lamps' own alpha, and the route polylines are what the
 * software rasterizer spends its frame on (see tilt-shift.spec.ts).
 */

/** Where the camera stands for both boots: over the city, looking down. */
const VIEW = '#routes=0&lat=54.0880&lon=12.1330&height=900&heading=0&pitch=-45'

test('street lamps follow the sun and the underground view', async ({ page }) => {
  test.setTimeout(240_000)
  const slowPoll = { timeout: 60_000, intervals: [500, 1000, 2000] }
  const alpha = () => page.evaluate(() => window.__mrt!.streetLamps().alpha)

  // Daytime: nothing is built, and nothing is drawn
  await page.goto(`/?offline=1&time=12:00&paused=1&rain=0${VIEW}`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  await expect.poll(alpha, { timeout: 20_000 }).toBe(0)
  expect(await page.evaluate(() => window.__mrt!.streetLamps().drawn)).toBe(0)

  // Night: the pools are built and lit
  await page.evaluate(() => window.__mrt!.setTime('23:30'))
  await expect.poll(alpha, slowPoll).toBeGreaterThan(0)
  const lit = await page.evaluate(() => window.__mrt!.streetLamps())
  expect(lit.drawn).toBeGreaterThan(1000)

  // Down there the surface is a dark relief the tunnels show through – a
  // lit street grid over it would only muddy them.
  await page.getByRole('tab', { name: 'Underground' }).click()
  await expect.poll(alpha, slowPoll).toBe(0)

  // ... and back on when the view returns to the surface
  await page.getByRole('tab', { name: 'Surface' }).click()
  await expect.poll(alpha, slowPoll).toBeGreaterThan(0)

  // Back to day: the pools stay built but go dark again
  await page.evaluate(() => window.__mrt!.setTime('12:00'))
  await expect.poll(alpha, slowPoll).toBe(0)
})

test('?lamps=0 leaves the street lighting out entirely', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&time=23:30&paused=1&rain=0&lamps=0${VIEW}`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  await page.waitForTimeout(5000)
  const info = await page.evaluate(() => window.__mrt!.streetLamps())
  expect(info.drawn).toBe(0)
  expect(info.alpha).toBe(0)
})
