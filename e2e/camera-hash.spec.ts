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

  // The clock was booted paused (?paused=1), so the pause state rides
  // along in the hash.
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 })
    .toMatch(/^#lat=[\d.]+&lon=[\d.]+&height=\d+&heading=\d+&pitch=-?\d+&paused=1$/)

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

test('a pose saved with the miniature look off survives a reload unmoved', async ({
  page,
}) => {
  test.setTimeout(240_000)

  // The pose in the hash was written through the plain lens (tilt=0). The
  // app opens it through that lens again – and must not walk the camera
  // for the lens swap, or every reload would land a step closer.
  await page.goto(
    '/?offline=1&time=08:30&paused=1#lat=54.0901&lon=12.1405&height=3000&heading=0&pitch=-45&tilt=0',
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  const cameraView = () =>
    page.evaluate(() => {
      const camera = window.__cesiumViewer!.camera.positionCartographic
      return {
        lat: (camera.latitude * 180) / Math.PI,
        lon: (camera.longitude * 180) / Math.PI,
        height: camera.height,
      }
    })
  const opened = await cameraView()
  expect(opened.lat).toBeCloseTo(54.0901, 3)
  expect(opened.height).toBeCloseTo(3000, 0)

  await page.reload()
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  const reloaded = await cameraView()
  expect(reloaded.lat).toBeCloseTo(opened.lat, 4)
  expect(reloaded.lon).toBeCloseTo(opened.lon, 4)
  expect(reloaded.height).toBeCloseTo(opened.height, 0)
})

test('a selected vehicle is shared and restored via the URL', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )

  // Select a vehicle – the URL must switch to the vehicle-only hash
  const vehicleId = await page.evaluate(() => {
    const id = window.__mrt!.vehicles()[0].id
    window.__mrt!.selectVehicle(id)
    return id
  })
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
    .toBe(`#vehicle=${encodeURIComponent(vehicleId)}&paused=1`)
  const sharedUrl = await page.evaluate(() => window.location.href)

  // Fresh app boot from the shared link (about:blank tears down the first
  // WebGL context, see above) – the same trip is selected again, the
  // vehicle card opens, and follow mode engages.
  await page.goto('about:blank')
  await page.goto(sharedUrl)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  const card = page.getByTestId('vehicle-card')
  await expect(card).toBeVisible({ timeout: 60_000 })
  // The trip id is no longer printed on the card, so ask the app which
  // vehicle it restored – that is what this test is actually about.
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.selectedVehicleId()), { timeout: 30_000 })
    .toBe(vehicleId)
  await expect(card.getByRole('button', { name: 'Stop following' })).toBeVisible({
    timeout: 30_000,
  })
})

test('layer toggles travel in the URL and are restored', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })

  await page.getByRole('switch', { name: 'Show routes' }).click()
  await page.getByRole('switch', { name: 'Show stops' }).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
    .toContain('routes=0&stops=0&paused=1')
  const sharedUrl = await page.evaluate(() => window.location.href)

  await page.goto('about:blank')
  await page.goto(sharedUrl)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  await expect(page.getByRole('switch', { name: 'Show routes' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(page.getByRole('switch', { name: 'Show stops' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  // The boot flag ?paused=1 was in the URL anyway – the button shows Resume
  await expect(page.getByRole('button', { name: 'Resume simulation' })).toBeVisible()
})

test('an edited hash applies without a reload', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(
    '/?offline=1&time=08:30&paused=1#lat=54.0901&lon=12.1405&height=6000&heading=0&pitch=-60',
  )
  await page.waitForFunction(() => window.__mrt?.ready === true)
  await expect(page.getByRole('switch', { name: 'Show stops' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  // Survives a same-document navigation, not a reload – the marker proves
  // the app kept running instead of booting again.
  await page.evaluate(() => {
    ;(window as unknown as { __stillTheSamePage?: boolean }).__stillTheSamePage = true
  })

  // What a user typing in the address bar does: only the hash changes.
  await page.evaluate(() => {
    window.location.hash = '#lat=54.0901&lon=12.1405&height=2000&heading=0&pitch=-60&stops=0'
  })

  await expect
    .poll(
      () => page.evaluate(() => window.__cesiumViewer!.camera.positionCartographic.height),
      { timeout: 20_000, intervals: [250, 500] },
    )
    .toBeLessThan(2600)

  // The layer state in the hash rides along, not just the camera
  await expect(page.getByRole('switch', { name: 'Show stops' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  expect(
    await page.evaluate(
      () => (window as unknown as { __stillTheSamePage?: boolean }).__stillTheSamePage,
    ),
  ).toBe(true)
})
