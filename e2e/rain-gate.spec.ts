import { expect, test, type Page } from '@playwright/test'

/**
 * Rain, on one deliberately cheap page – routes and stops off, a 40-drop
 * pool. Visible rain counts as an animation, so the app renders the whole
 * scene at full rate for as long as it falls, and the UI tick these tests
 * wait on rides along on that loop. Measured locally under SwiftShader:
 * the full scene at 1000 drops runs the loop at 2.6 ticks/s, this page at
 * 8.6 – and a loaded CI runner is a large factor slower again.
 *
 * Both tests on the same page: they used to boot the very same URL twice.
 * A pose under the cloud base: rain falls from the clouds, and a camera
 * above them – the home view is – sees none (see WeatherOverlay).
 */

test.describe.configure({ mode: 'serial' })

let page: Page
const slowPoll = { timeout: 60_000, intervals: [500, 1000, 2000] }
const drops = () => page.evaluate(() => window.__mg3d!.rainDropsVisible())

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await page.goto(
    '/?offline=1&welcome=0&time=08:30&paused=1&drops=40#lat=54.0847&lon=12.1162&height=400&heading=0&pitch=-35&routes=0&stops=0',
  )
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })
})

test.afterAll(async () => {
  await page.close()
})

/**
 * Below ground there is no weather: no drops falling around a camera that
 * sits under the city.
 */
test('the underground view stops the rain', async () => {
  test.setTimeout(240_000)

  await page.evaluate(() => window.__mg3d!.setRain(0.2))
  await expect.poll(drops, slowPoll).toBeGreaterThan(0)

  await page.getByRole('radio', { name: 'Underground' }).click()
  // No drops falling around a camera that is below ground
  await expect.poll(drops, slowPoll).toBe(0)

  // Dry before leaving again, so the second click lands on an idle scene
  await page.evaluate(() => window.__mg3d!.setRain(0))
  await page.getByRole('radio', { name: 'Surface' }).click()

  // The gate opens both ways: rain set on the surface shows up again
  await page.evaluate(() => window.__mg3d!.setRain(0.2))
  await expect.poll(drops, slowPoll).toBeGreaterThan(0)
  await page.evaluate(() => window.__mg3d!.setRain(0))
  await expect.poll(drops, slowPoll).toBe(0)
})

/**
 * The weather picker in the scene popover: a picked sky is set rather
 * than polled, so it works offline – and it has to reach the map through
 * the same per-tick path the live weather uses.
 */
test('a picked sky puts rain in the air and takes it out again', async () => {
  test.setTimeout(240_000)

  const button = page.getByRole('button', { name: 'Weather' })
  const buttonBox = (await button.boundingBox())!
  await button.click()
  // Offline there is nothing to poll, so live weather is not on offer
  await expect(page.getByRole('radio', { name: 'Live weather' })).toBeDisabled()

  // The panel hangs from the button's top edge and grows downward. Its
  // own default is the other way round – bottom edges together, growing
  // up – which is right for a control at the foot of the map and leaves
  // this one, at the head of it, flattened against the window's edge.
  const panelBox = (await page.getByRole('dialog').boundingBox())!
  expect(panelBox.y).toBeCloseTo(buttonBox.y, 0)
  expect(panelBox.x + panelBox.width).toBeLessThan(buttonBox.x)

  await page.getByRole('radio', { name: 'Rain' }).click()
  await expect(page.getByRole('radio', { name: 'Rain' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(drops, slowPoll).toBeGreaterThan(0)

  await page.getByRole('radio', { name: 'Sunny' }).click()
  await expect.poll(drops, slowPoll).toBe(0)
})
