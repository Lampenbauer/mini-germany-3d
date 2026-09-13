import { expect, test } from '@playwright/test'

/**
 * The night-time street lighting (see src/map/StreetLampsLayer.ts): built
 * only once it would be visible, faded by the sun ramp, put out by the
 * underground view, and off entirely with ?lamps=0. The airfield lighting
 * (src/map/AirfieldLightsLayer.ts – Rostock-Laage's few dozen lights are
 * in the city's box) rides the same ramp and the same switch, burns by
 * day in poor visibility too, and is checked on the same scene.
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
  const alpha = () => page.evaluate(() => window.__mg3d!.streetLamps().alpha)

  // Daytime: nothing is built, and nothing is drawn
  await page.goto(`/?offline=1&welcome=0&time=12:00&paused=1&rain=0&seamarks=0${VIEW}`)
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })
  await expect.poll(alpha, { timeout: 20_000 }).toBe(0)
  expect(await page.evaluate(() => window.__mg3d!.streetLamps().drawn)).toBe(0)

  expect(await page.evaluate(() => window.__mg3d!.airfieldLights().drawn)).toBe(0)

  // Night: the pools are built and lit, and so are the runway lights
  await page.evaluate(() => window.__mg3d!.setTime('23:30'))
  await expect.poll(alpha, slowPoll).toBeGreaterThan(0)
  const lit = await page.evaluate(() => window.__mg3d!.streetLamps())
  expect(lit.drawn).toBeGreaterThan(1000)
  const airfield = () => page.evaluate(() => window.__mg3d!.airfieldLights())
  await expect.poll(async () => (await airfield()).alpha, slowPoll).toBeGreaterThan(0)
  expect((await airfield()).drawn).toBeGreaterThan(10)
  // Laage's three floodlight masts light their apron as pools
  await expect.poll(async () => (await airfield()).floods, slowPoll).toBeGreaterThan(0)

  // Down there the surface is a dark relief the tunnels show through – a
  // lit street grid over it would only muddy them, and neither would a
  // lit runway.
  await page.getByRole('radio', { name: 'Underground' }).click()
  await expect.poll(alpha, slowPoll).toBe(0)
  await expect.poll(async () => (await airfield()).alpha, slowPoll).toBe(0)

  // ... and back on when the view returns to the surface
  await page.getByRole('radio', { name: 'Surface' }).click()
  await expect.poll(alpha, slowPoll).toBeGreaterThan(0)

  // Back to day: the pools stay built but go dark again
  await page.evaluate(() => window.__mg3d!.setTime('12:00'))
  await expect.poll(alpha, slowPoll).toBe(0)
  await expect.poll(async () => (await airfield()).alpha, slowPoll).toBe(0)

  // Fog by day lights the airfield as the tower would, and leaves the streets dark
  await page.evaluate(() => window.__mg3d!.setVisibility(800))
  await expect.poll(async () => (await airfield()).alpha, slowPoll).toBeGreaterThan(0)
  expect(await alpha()).toBe(0)
  await page.evaluate(() => window.__mg3d!.setVisibility(null))
  await expect.poll(async () => (await airfield()).alpha, slowPoll).toBe(0)
})

test('?lamps=0 leaves the street and the airfield lighting out entirely', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&welcome=0&time=23:30&paused=1&rain=0&lamps=0&seamarks=0${VIEW}`)
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })
  // Two loop ticks, not a fixed sleep: the lamps are built from the loop,
  // so a loop that has run twice and built nothing is the evidence.
  const ticks = await page.evaluate(() => window.__mg3d!.loopTicks())
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.loopTicks()), { timeout: 30_000 })
    .toBeGreaterThan(ticks + 1)
  const info = await page.evaluate(() => window.__mg3d!.streetLamps())
  expect(info.drawn).toBe(0)
  expect(info.alpha).toBe(0)
  expect(await page.evaluate(() => window.__mg3d!.airfieldLights())).toEqual({ drawn: 0, alpha: 0, floods: 0 })
})
