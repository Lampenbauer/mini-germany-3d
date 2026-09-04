import { expect, test, type Page } from '@playwright/test'
import { cityBySlug } from '../src/cities/definitions'

/**
 * Moving from one city to the next: the picker behind the caret beside
 * the panel title, and a link that names the city. Both must leave the
 * old city's lines behind, put the new city's up, name it in the title
 * and the URL, and land the camera inside the new city's leash.
 */

const HAMBURG = cityBySlug('hamburg')!.boundingBox
const ROSTOCK = cityBySlug('rostock')!.boundingBox

function cameraView(page: Page) {
  return page.evaluate(() => {
    const camera = window.__cesiumViewer!.camera.positionCartographic
    return {
      lat: (camera.latitude * 180) / Math.PI,
      lon: (camera.longitude * 180) / Math.PI,
      height: camera.height,
    }
  })
}

const inside = (view: { lat: number; lon: number }, box: typeof HAMBURG) =>
  view.lon >= box.west && view.lon <= box.east && view.lat >= box.south && view.lat <= box.north

test('the picker flies from Rostock to Hamburg', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Rostock 3D')
  expect(inside(await cameraView(page), ROSTOCK)).toBe(true)
  const rostockLines = await page.evaluate(() => window.__mrt!.lineIds())
  expect(rostockLines).toContain('FG')

  await page.getByRole('button', { name: 'Choose a city' }).click()
  await page.getByRole('option', { name: 'Switch to Hamburg' }).click()

  // The old city is torn down at once, the new one is up once its data
  // is in and its simulation runs.
  await page.waitForFunction(
    () =>
      window.__mrt?.ready === true &&
      window.__mrt.city() === 'hamburg' &&
      window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Hamburg 3D')
  await expect(page.getByTestId('app-title')).toHaveText('Mini Hamburg 3D')
  expect(page.url()).toContain('city=hamburg')
  const hamburgLines = await page.evaluate(() => window.__mrt!.lineIds())
  expect(hamburgLines).toContain('U1')
  expect(hamburgLines).not.toContain('FG')

  // The flight ends inside Hamburg's leash – under its ceiling, which the
  // arc of the flight climbs well above on the way – and the leash holds
  // there. Polled on both: the camera enters the box while still high up.
  await expect
    .poll(
      async () => {
        const view = await cameraView(page)
        return inside(view, HAMBURG) && view.height <= 25_000 + 1
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  expect(inside(await cameraView(page), ROSTOCK)).toBe(false)
})

test('a link naming the city opens it', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/?offline=1&time=08:30&paused=1#city=hamburg')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.city() === 'hamburg',
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Hamburg 3D')
  expect(inside(await cameraView(page), HAMBURG)).toBe(true)
  // The default city needs no name in the URL, every other city keeps its
  await page.getByRole('button', { name: 'Choose a city' }).click()
  await page.getByRole('option', { name: 'Switch to Rostock' }).click()
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.city() === 'rostock',
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Rostock 3D')
  expect(page.url()).not.toContain('city=')
})
