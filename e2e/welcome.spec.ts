import { expect, test, type Page } from '@playwright/test'

/**
 * The welcome screen (see src/lib/welcome.ts): the front door on a plain
 * visit. Every other spec boots past it with ?welcome=0; this one opens
 * it on purpose with ?welcome=1 and walks through.
 */

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
})

test.afterAll(async () => {
  await page.close()
})

test('asks for a city, keeps the map bare behind the door and jumps there', async () => {
  await page.goto('/?offline=1&welcome=1&time=08:30&paused=1#routes=0')
  const door = page.getByTestId('welcome-screen')
  await expect(door).toBeVisible()
  await page.waitForFunction(() => window.__mg3d?.welcomeOpen() === true)
  // Cesium is up, nothing of a city is: no session, no vehicles, no hash
  expect(await page.evaluate(() => window.__mg3d!.ready)).toBe(false)
  expect(await page.evaluate(() => window.__mg3d!.vehicleCount())).toBe(0)
  expect(await page.evaluate(() => window.location.hash)).toBe('#routes=0')

  await page.getByRole('button', { name: 'Open Kiel' }).click()
  // The screen stands with a spinner while the city loads behind it … –
  // read in one look, because the city's arrival blocks the page for
  // seconds on the CI runner and the door (WELCOME_LINGER_MS, 2 s past
  // the pick) can be gone before a second assertion runs (seen
  // 2026-09-16, retried green). Where the door still stands, it stands
  // with its spinner and the session open behind it.
  const standing = await page.evaluate(() => ({
    door: document.querySelector('[data-testid="welcome-screen"]') !== null,
    spinner: document.querySelector('[data-testid="welcome-spinner"]') !== null,
    open: window.__mg3d!.welcomeOpen(),
  }))
  if (standing.door) {
    expect(standing.spinner).toBe(true)
    expect(standing.open).toBe(true)
  }
  // … and when it goes, the city is already there
  await expect(door).toBeHidden({ timeout: 60_000 })
  expect(await page.evaluate(() => window.__mg3d!.ready)).toBe(true)
  expect(await page.evaluate(() => window.__mg3d!.vehicleCount())).toBeGreaterThan(0)
  expect(await page.evaluate(() => window.__mg3d!.city())).toBe('kiel')
  expect(await page.evaluate(() => window.location.pathname)).toBe('/en/kiel/')
  expect(await page.evaluate(() => window.localStorage.getItem('mg3d.welcome'))).toBeNull()
})

test('stays away once asked to, and the next visit opens on the default city', async () => {
  // A different query than the test above left the page on: a URL that
  // differs only in its hash is a fragment navigation, not a load, and
  // the app would merely apply the hash to the city it already shows.
  await page.goto('/?offline=1&welcome=1&time=09:00&paused=1#routes=0')
  await expect(page.getByTestId('welcome-screen')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Don’t show this welcome screen on your next visit' }).click()
  await page.getByRole('button', { name: 'Open Kiel' }).click()
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, { timeout: 60_000 })
  expect(await page.evaluate(() => window.localStorage.getItem('mg3d.welcome'))).toBe('hidden')

  // A plain visit now – the last city was Kiel, the door is off, Rostock it is
  await page.goto('/?offline=1&time=09:00&paused=1#routes=0')
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, { timeout: 60_000 })
  await expect(page.getByTestId('welcome-screen')).toBeHidden()
  expect(await page.evaluate(() => window.__mg3d!.welcomeOpen())).toBe(false)
  expect(await page.evaluate(() => window.__mg3d!.city())).toBe('rostock')
})
