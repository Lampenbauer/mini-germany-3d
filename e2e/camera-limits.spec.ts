import { expect, test } from '@playwright/test'

/**
 * The camera leash (see src/map/camera-limits.ts): the view stays within
 * ~100 km of the network and does not zoom out past 25 km.
 */

/**
 * The fence in degrees: the network's bounding box (12.030–12.225 °E /
 * 54.056–54.203 °N) padded by config.cameraLimits.paddingMeters.
 */
const FENCE = { west: 11.643, east: 12.611, south: 53.831, north: 54.428 }
const MAX_HEIGHT = 25_000
/** Slack for the assertions – the camera may sit right on the border. */
const SLACK = 0.01

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
    '/?offline=1&time=08:30&paused=1#lat=48.137&lon=11.575&height=2000000&heading=0&pitch=-60',
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })

  const view = await cameraView(page)
  expect(view.lon).toBeCloseTo(FENCE.west, 2)
  expect(view.lat).toBeCloseTo(FENCE.south, 2)
  expect(view.height).toBeLessThanOrEqual(MAX_HEIGHT + 1)
})

test('zooming out stops at the ceiling', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  const start = await cameraView(page)

  // Keep scrolling out well past the ceiling – the fence has to hold at
  // every step, not just at the end.
  await page.mouse.move(640, 400)
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(150)
    const view = await cameraView(page)
    expect(view.height).toBeLessThanOrEqual(MAX_HEIGHT + 1)
    expect(view.lat).toBeGreaterThan(FENCE.south - SLACK)
    expect(view.lat).toBeLessThan(FENCE.north + SLACK)
    expect(view.lon).toBeGreaterThan(FENCE.west - SLACK)
    expect(view.lon).toBeLessThan(FENCE.east + SLACK)
  }

  // ... and the wheel really did run into the ceiling, otherwise the test
  // proves nothing. It stops a little below it: maximumZoomDistance is the
  // distance to the point under the cursor, and the view is tilted.
  const end = await cameraView(page)
  expect(end.height).toBeGreaterThan(start.height * 1.5)
  expect(end.height).toBeGreaterThan(MAX_HEIGHT * 0.7)
})

test('panning stops at the fence', async ({ page }) => {
  test.setTimeout(240_000)

  // Start on the eastern border, looking north so a horizontal drag moves
  // the camera along the east–west axis.
  await page.goto(
    `/?offline=1&time=08:30&paused=1#lat=54.1&lon=${FENCE.east}&height=3000&heading=0&pitch=-60`,
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })

  // Dragging the map to the left pushes the camera east – into the fence.
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(1000, 400)
    await page.mouse.down()
    await page.mouse.move(300, 400, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const view = await cameraView(page)
    expect(view.lon).toBeLessThan(FENCE.east + SLACK)
    expect(view.lat).toBeGreaterThan(FENCE.south - SLACK)
    expect(view.lat).toBeLessThan(FENCE.north + SLACK)
  }
})
