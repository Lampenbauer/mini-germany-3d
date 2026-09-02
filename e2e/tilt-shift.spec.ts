import { expect, test, type Page } from '@playwright/test'

/**
 * The miniature look (see src/map/TiltShiftEffect.ts). Its three post-
 * process passes are the only hand-written screen-space shaders in the
 * app, and a GLSL error in them is invisible in unit tests – it surfaces
 * as a Cesium RuntimeError out of the render loop. So this boots the real
 * renderer, watches for that, and checks the frame actually changes when
 * the switch is flipped.
 */

let page: Page
const pageErrors: string[] = []

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 60_000 })
})

test.afterAll(async () => {
  await page.close()
})

/** The rendered canvas as a PNG buffer. */
const frame = async () => await page.locator('canvas').first().screenshot()

test('renders the effect and switches it off again', async () => {
  const toggle = page.getByRole('switch', { name: 'Show the miniature effect' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  const withEffect = await frame()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  // Off is a state worth sharing – it rides along in the URL
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('tilt=0')
  const withoutEffect = await frame()

  // The blur band and the grade touch nearly every pixel of the frame, so
  // the two states cannot come out byte-identical unless the stages never
  // ran at all.
  expect(withEffect.equals(withoutEffect)).toBe(false)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('tilt=0')

  // A shader that fails to compile takes the render loop down with it
  expect(pageErrors).toEqual([])
})
