import { expect, test, type Page } from '@playwright/test'
import { cityBySlug } from '../src/cities/definitions'

/**
 * Moving from one city to the next: the picker the panel title opens,
 * and a link that names the city. Both must leave the
 * old city's lines behind, put the new city's up, name it in the title
 * and the URL, and land the camera inside the new city's leash.
 *
 * Both boots keep the routes, stops and labels off. What is asserted here
 * is which lines the app holds and where the camera stands, and under
 * SwiftShader those layers are what a frame is spent on (see the note in
 * tilt-shift.spec.ts).
 */

/** Layers off – see the note above. */
const CHEAP = 'routes=0&stops=0&labels=0'

const KIEL = cityBySlug('kiel')!.boundingBox
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

const inside = (view: { lat: number; lon: number }, box: typeof KIEL) =>
  view.lon >= box.west && view.lon <= box.east && view.lat >= box.south && view.lat <= box.north

test('the picker flies from Rostock to Kiel', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto(`/?offline=1&welcome=0&time=08:30&paused=1#${CHEAP}`)
  await page.waitForFunction(
    () => window.__mg3d?.ready === true && window.__mg3d.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Rostock 3D')
  expect(inside(await cameraView(page), ROSTOCK)).toBe(true)
  const rostockLines = await page.evaluate(() => window.__mg3d!.lineIds())
  expect(rostockLines).toContain('FG')

  await page.getByRole('button', { name: 'Mini Rostock 3D' }).click()
  await page.getByRole('option', { name: 'Switch to Kiel' }).click()

  // The old city stays on the map for the length of the flight and hands
  // over on arrival, so this waits out the flight as well as the data.
  await page.waitForFunction(
    () =>
      window.__mg3d?.ready === true &&
      window.__mg3d.city() === 'kiel' &&
      window.__mg3d.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Kiel 3D')
  await expect(page.getByTestId('app-title')).toHaveText('Mini Kiel 3D')
  // The city is in the path (lib/site-path.ts), under the language the interface speaks
  expect(new URL(page.url()).pathname).toBe('/en/kiel/')
  const kielLines = await page.evaluate(() => window.__mg3d!.lineIds())
  expect(kielLines).toContain('F1')
  expect(kielLines).not.toContain('FG')

  // The flight ends inside Kiel's leash – under its ceiling, which the
  // arc of the flight climbs well above on the way – and the leash holds
  // there. Polled on both: the camera enters the box while still high up.
  await expect
    .poll(
      async () => {
        const view = await cameraView(page)
        return inside(view, KIEL) && view.height <= 30_000 + 1
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  expect(inside(await cameraView(page), ROSTOCK)).toBe(false)
})

test('a link naming the city opens it', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto(`/kiel/?offline=1&welcome=0&time=08:30&paused=1#${CHEAP}`)
  await page.waitForFunction(
    () => window.__mg3d?.ready === true && window.__mg3d.city() === 'kiel',
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Kiel 3D')
  expect(inside(await cameraView(page), KIEL)).toBe(true)
  // Every city keeps its name in the URL, the default one included
  await page.getByRole('button', { name: 'Mini Kiel 3D' }).click()
  await page.getByRole('option', { name: 'Switch to Rostock' }).click()
  await page.waitForFunction(
    () => window.__mg3d?.ready === true && window.__mg3d.city() === 'rostock',
    undefined,
    { timeout: 120_000 },
  )
  await expect(page).toHaveTitle('Mini Rostock 3D')
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe('/en/rostock/')
  // The boot options stay in the search string through the move
  expect(new URL(page.url()).searchParams.get('offline')).toBe('1')
})
