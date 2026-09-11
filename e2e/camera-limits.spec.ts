import { expect, test } from '@playwright/test'
import { cityBySlug } from '../src/cities/definitions'

/**
 * The camera leash (see src/map/camera-limits.ts): the view stays inside
 * the Rostock bounding box and does not zoom out past 25 km.
 *
 * Nothing here is read off the screen, so the scene is raised as cheaply
 * as it can be: routes, stops and labels off. Under SwiftShader those are
 * what a frame is spent on (see the note in tilt-shift.spec.ts), and this
 * spec drives the camera through a dozen gestures, each of them frames.
 *
 * One scene for all of it. The link from far away, the drag and the wheel
 * used to be separate boots, and raising the map cost more than the
 * gestures: the fence is the same fence whichever way the camera runs
 * into it, and it is moved between the parts by editing the URL hash –
 * the app applies an edited pose without a reload (see camera-hash.spec.ts).
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

test('a link from far away lands at the fence, and dragging and zooming out both stop there', async ({
  page,
}) => {
  test.setTimeout(300_000)

  // Munich, 2000 km up – outside the fence in every component, so the
  // camera has to end up in its south-western corner at the ceiling.
  await page.goto(
    `/?offline=1&welcome=0&time=08:30&paused=1#${CHEAP}&lat=48.137&lon=11.575&height=2000000&heading=0&pitch=-60`,
  )
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })
  const landed = await cameraView(page)
  expect(landed.lon).toBeCloseTo(FENCE.west, 2)
  expect(landed.lat).toBeCloseTo(FENCE.south, 2)
  expect(landed.height).toBeLessThanOrEqual(MAX_HEIGHT + 1)

  // Over to the eastern border, looking north so a horizontal drag moves
  // the camera along the east–west axis.
  await page.evaluate(
    (hash) => {
      window.location.hash = hash
    },
    `#${CHEAP}&lat=54.1&lon=${FENCE.east}&height=3000&heading=0&pitch=-60`,
  )
  await expect
    .poll(async () => (await cameraView(page)).height, { timeout: 30_000 })
    .toBeLessThan(3500)

  // Dragging the map to the left pushes the camera east – into the fence.
  // Two drags are plenty from the border; each one is seconds of
  // SwiftShader rendering on CI.
  for (let i = 0; i < 2; i++) {
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
  await page.evaluate(
    (hash) => {
      window.location.hash = hash
    },
    `#${CHEAP}&lat=54.09&lon=12.13&height=14000&heading=0&pitch=-90`,
  )
  await expect
    .poll(async () => (await cameraView(page)).height, { timeout: 30_000 })
    .toBeGreaterThan(10_000)
  const start = await cameraView(page)

  // Keep scrolling out well past the ceiling – the fence has to hold at
  // every step, not just at the end.
  await page.mouse.move(640, 400)
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 1800)
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
