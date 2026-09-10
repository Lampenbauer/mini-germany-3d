import { expect, test } from '@playwright/test'
import config from '../playwright.config'

/**
 * The page under the map (src/lib/site-pages.ts): what a reader gets
 * without the map – a crawler with no scripts, a browser with no WebGL.
 * This browser has no WebGL at all (--disable-3d-apis), so the viewer
 * cannot be built and the error boundary has to take over; the first
 * test does not even let the scripts load.
 */

const base = config.use?.launchOptions ?? {}
test.use({
  launchOptions: { ...base, args: [...(base.args ?? []), '--disable-3d-apis'] },
})

test('a city page reads without a single script', async ({ page }) => {
  // Every script, whatever its extension – the dev server serves .tsx
  await page.route('**/*', (route) =>
    route.request().resourceType() === 'script' ? route.abort() : route.continue(),
  )
  await page.goto('/kiel/?offline=1')
  await expect(page).toHaveTitle('Mini Kiel 3D')
  const staticPage = page.locator('#static-page')
  await expect(staticPage).toBeVisible()
  await expect(staticPage.locator('h1')).toHaveText('Mini Kiel 3D')
  // The card's facts, the lines, the way to the other cities – in German on the bare path
  await expect(staticPage).toContainText('Kiel in Zahlen')
  await expect(staticPage).toContainText('Haltepositionen')
  await expect(staticPage.locator('.lines li', { hasText: 'F1' }).first()).toBeVisible()
  await expect(staticPage.locator('a[href="/rostock/"]')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('de')

  // The same city under /en/ is the English page
  await page.goto('/en/kiel/?offline=1')
  await expect(staticPage).toContainText('Kiel in numbers')
  await expect(staticPage.locator('a[href="/en/rostock/"]')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
})

test('without WebGL the notice stands over the page instead of a white screen', async ({ page }) => {
  await page.goto('/en/kiel/?offline=1&welcome=0&time=08:30&paused=1')
  const notice = page.getByTestId('app-failed')
  await expect(notice).toBeVisible({ timeout: 60_000 })
  await expect(notice).toContainText('The map could not start.')
  await expect(notice.getByRole('button', { name: 'Try again' })).toBeVisible()
  // The app had hidden the page as it started; the boundary shows it again,
  // and the document scrolls past the map's fixed viewport to read it
  const staticPage = page.locator('#static-page')
  await expect(staticPage).toBeVisible()
  await expect(staticPage.locator('h1')).toHaveText('Mini Kiel 3D')
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
  ).toBe(true)
})
