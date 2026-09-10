import { expect, test, type Page } from '@playwright/test'

/**
 * The volumetric clouds (see src/map/CloudLayer.ts): a slab of ray-marched
 * cloud over the city, put up by the cloud cover the weather reports.
 * Its shaders are hand-written and their errors surface nowhere but as
 * a RuntimeError out of the render loop – and only once a cloud is
 * actually drawn, which no other test does. So this boots the real
 * renderer, puts a closed sky up and measures it off the canvas.
 *
 * On its own cheap page: routes and stops off. The home view looks down
 * on the city from above the cloud base, so a closed sky fills the frame
 * – at noon it is a bright layer over the dark offline globe, which is
 * what the luminance below picks up. Under SwiftShader every one of the
 * marched frames costs seconds; the polls are sized for that.
 */

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await page.goto('/?offline=1&welcome=0&time=12:00&paused=1#routes=0&stops=0&labels=0')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
})

test.afterAll(async () => {
  await page.close()
})

/** Mean luminance of the rendered frame, 0 … 255, read off the canvas. */
const frameLuminance = () =>
  page.evaluate(() => {
    const viewer = window.__cesiumViewer!
    // Same task as the render: the drawing buffer is not preserved
    viewer.render()
    const source = viewer.canvas
    const copy = document.createElement('canvas')
    copy.width = source.width
    copy.height = source.height
    const ctx = copy.getContext('2d')!
    ctx.drawImage(source, 0, 0)
    const { data } = ctx.getImageData(0, 0, source.width, source.height)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    return sum / (data.length / 4)
  })

test('a closed sky puts a cloud layer over the city and takes it away again', async () => {
  test.setTimeout(300_000)
  const slowPoll = { timeout: 120_000, intervals: [1000, 2000, 4000] }

  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // A picture that stands still, with the globe's tiles in: the baseline
  // is what a frame without clouds looks like, not one still loading
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.renderPacing()), { timeout: 60_000 })
    .toMatchObject({ interacting: false, tilesLoading: false })
  const clear = await frameLuminance()
  expect(await page.evaluate(() => window.__mrt!.cloudState())).toMatchObject({
    enabled: false,
    coverPercent: 0,
    drawn: false,
    supported: true,
  })

  // The clouds open switched off (config.weather.clouds3dDefault); the
  // switch in the weather popover turns them on, and on is the deviation,
  // so it rides along in the URL
  await page.getByRole('button', { name: 'Weather' }).click()
  const toggle = page.getByRole('switch', { name: 'Show the 3D clouds' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('clouds=1')
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.cloudState().enabled), slowPoll)
    .toBe(true)

  // The picked sky goes through the same per-tick path the live one does
  await page.evaluate(() => window.__mrt!.setCloudCover(100))
  // The cover eases in over six seconds; the layer reports when it is up
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.cloudState()), slowPoll)
    .toMatchObject({ coverPercent: 100, coverApplied: 100, drawn: true })
  // A closed noon sky seen from above is a lot brighter than the dark globe
  await expect.poll(frameLuminance, slowPoll).toBeGreaterThan(clear * 1.5)

  await page.evaluate(() => window.__mrt!.setCloudCover(0))
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.cloudState()), slowPoll)
    .toMatchObject({ coverPercent: 0, coverApplied: 0, drawn: false })
  await expect.poll(frameLuminance, slowPoll).toBeLessThan(clear * 1.1)
  expect(pageErrors).toEqual([])
})
