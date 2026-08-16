import { expect, test } from '@playwright/test'

/**
 * Separate spec so that saving and restoring run one after the other on the
 * same page and two Cesium/SwiftShader instances never exist in parallel.
 */
test('camera pose is saved to and restored from the URL hash', async ({
  page,
}) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true)

  // The hash is updated at most every 1500 ms.
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 })
    .toMatch(/^#lat=[\d.]+&lon=[\d.]+&height=\d+&heading=\d+&pitch=-?\d+$/)

  // Changing only the hash of the same URL would be a same-document
  // navigation. The stop-over destroys the first Cesium instance and forces
  // a fresh app boot afterwards, without holding two WebGL contexts at once.
  await page.goto('about:blank')
  await page.goto(
    '/?offline=1&time=08:30&paused=1#lat=54.0901&lon=12.1405&height=800&heading=90&pitch=-45',
  )
  await page.waitForFunction(() => window.__mrt?.ready === true)

  const view = await page.evaluate(() => {
    const camera = window.__cesiumViewer!.camera.positionCartographic
    return {
      lat: (camera.latitude * 180) / Math.PI,
      lon: (camera.longitude * 180) / Math.PI,
      height: camera.height,
    }
  })
  expect(view.lat).toBeCloseTo(54.0901, 3)
  expect(view.lon).toBeCloseTo(12.1405, 3)
  expect(view.height).toBeGreaterThan(700)
  expect(view.height).toBeLessThan(900)
})
