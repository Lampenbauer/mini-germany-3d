import { expect, test } from '@playwright/test'
import { cityBySlug } from '../src/cities/definitions'

/**
 * The camera leash (see src/map/camera-limits.ts): the view stays inside
 * the Rostock bounding box and does not zoom out past 25 km.
 *
 * Nothing here is read off the screen, so the scene is raised as cheaply
 * as it can be: routes, stops and labels off. Under SwiftShader those are
 * what a frame is spent on (see the note in tilt-shift.spec.ts), and this
 * spec drives the camera through dozens of gestures, each of them frames.
 */

/** The fence in degrees: the city limits widened by 15 km. */
const FENCE = cityBySlug('rostock')!.boundingBox
const MAX_HEIGHT = 25_000
/** Slack for the assertions – the camera may sit right on the border. */
const SLACK = 0.01
/** Layers off – see the note above. */
const CHEAP = 'routes=0&stops=0&labels=0'

function cameraView(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const camera = window.__cesiumViewer!.camera.positionCartographic
    return {
      lat: (camera.latitude * 180) / Math.PI,
      lon: (camera.longitude * 180) / Math.PI,
      height: camera.height,
    }
  })
}

test('a shared link from far away lands at the fence', async ({ page }) => {
  test.setTimeout(240_000)

  // Munich, 2000 km up – outside the fence in every component, so the
  // camera has to end up in its south-western corner at the ceiling.
  await page.goto(
    `/?offline=1&time=08:30&paused=1#${CHEAP}&lat=48.137&lon=11.575&height=2000000&heading=0&pitch=-60`,
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })

  const view = await cameraView(page)
  expect(view.lon).toBeCloseTo(FENCE.west, 2)
  expect(view.lat).toBeCloseTo(FENCE.south, 2)
  expect(view.height).toBeLessThanOrEqual(MAX_HEIGHT + 1)
})

/**
 * Both gestures on one scene. They used to be two tests, and raising the
 * map twice for them cost more than the gestures themselves: the fence
 * is the same fence whether a drag or a wheel runs into it, and the
 * camera is moved between the two by editing the URL hash – the app
 * applies an edited pose without a reload (see camera-hash.spec.ts).
 */
test('dragging and zooming out both stop at the fence', async ({ page }) => {
  test.setTimeout(240_000)

  // Start on the eastern border, looking north so a horizontal drag moves
  // the camera along the east–west axis.
  await page.goto(
    `/?offline=1&time=08:30&paused=1#${CHEAP}&lat=54.1&lon=${FENCE.east}&height=3000&heading=0&pitch=-60`,
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })

  // Dragging the map to the left pushes the camera east – into the fence.
  // Three drags are plenty from the border; each one is seconds of
  // SwiftShader rendering on CI.
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(1000, 400)
    await page.mouse.down()
    await page.mouse.move(300, 400, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const view = await cameraView(page)
    expect(view.lon).toBeLessThan(FENCE.east + SLACK)
    expect(view.lat).toBeGreaterThan(FENCE.south - SLACK)
    expect(view.lat).toBeLessThan(FENCE.north + SLACK)
  }

  // Now the ceiling, from high up and straight down: climbing to it from
  // the home view takes dozens of wheel steps, and on a CI runner under
  // SwiftShader every one of them is seconds of rendering.
  await page.evaluate(() => {
    window.location.hash = '#routes=0&stops=0&labels=0&lat=54.09&lon=12.13&height=14000&heading=0&pitch=-90'
  })
  await expect
    .poll(async () => (await cameraView(page)).height, { timeout: 30_000 })
    .toBeGreaterThan(10_000)
  const start = await cameraView(page)

  // Keep scrolling out well past the ceiling – the fence has to hold at
  // every step, not just at the end.
  await page.mouse.move(640, 400)
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(150)
    const view = await cameraView(page)
    expect(view.height).toBeLessThanOrEqual(MAX_HEIGHT + 1)
    expect(view.lat).toBeGreaterThan(FENCE.south - SLACK)
    expect(view.lat).toBeLessThan(FENCE.north + SLACK)
    expect(view.lon).toBeGreaterThan(FENCE.west - SLACK)
    expect(view.lon).toBeLessThan(FENCE.east + SLACK)
  }

  // ... and the wheel really did run into the ceiling, otherwise the test
  // proves nothing. Straight down the ceiling is the height itself, so it
  // ends right below it (maximumZoomDistance measures the distance to the
  // point under the cursor, which a tilted view stretches).
  const end = await cameraView(page)
  expect(end.height).toBeGreaterThan(start.height)
  expect(end.height).toBeGreaterThan(MAX_HEIGHT * 0.9)
})
