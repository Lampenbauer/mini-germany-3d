import { expect, test, type Page } from '@playwright/test'

/**
 * The URL hash as the app's memory: the camera pose, the layer switches,
 * the miniature look and the pause state ride in it, a selected vehicle
 * replaces the pose in it, and a link carrying any of them opens on them.
 *
 * Separate spec so that saving and restoring run one after the other on
 * the same page and two Cesium/SwiftShader instances never exist in
 * parallel. The first test walks one page through everything that is not
 * a selection – written, restored, reloaded, edited – because raising the
 * scene is what costs here: as four tests it booted seven times for what
 * three boots show.
 */

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

test('pose, layers and the miniature look are written, restored, kept through a reload and applied from an edited hash', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const hash = () => page.evaluate(() => window.location.hash)

  await page.goto('/?offline=1&welcome=0&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })

  // The clock was booted paused (?paused=1), so the pause state rides
  // along in the hash.
  await expect
    .poll(hash, { timeout: 5000 })
    // The sky rides in every hash; offline there is no live weather to
    // poll, so the sky is the clear one such a session opens on. The city
    // is the path's (lib/site-path.ts)
    .toMatch(/^#lat=[\d.]+&lon=[\d.]+&height=\d+&heading=\d+&pitch=-?\d+&weather=clear&paused=1$/)
  expect(await page.evaluate(() => window.location.pathname)).toBe('/en/rostock/')

  // The layer switches live in the popover on the map's control rail;
  // off is the deviation, so off is what gets written
  await page.getByRole('button', { name: 'Layers' }).click()
  await page.getByRole('switch', { name: 'Show routes' }).click()
  await page.getByRole('switch', { name: 'Show stops' }).click()
  await expect
    .poll(hash, { timeout: 10_000 })
    .toContain('routes=0&stops=0&weather=clear&paused=1')
  await page.keyboard.press('Escape')
  const written = await page.evaluate(() => window.location.href)

  // The link to open next: what the app wrote, with the pose swapped for
  // one of our own so the restore can be measured, and the miniature look
  // on – the deviation from the default lens, so it is in the hash too.
  const posed = written.replace(
    /#lat=[^&]+&lon=[^&]+&height=[^&]+&heading=[^&]+&pitch=[^&]+/,
    '#lat=54.0901&lon=12.1405&height=3000&heading=0&pitch=-45',
  )
  expect(posed).not.toBe(written)
  const sharedUrl = `${posed}&tiltshift=1`

  // Changing only the hash of the same URL would be a same-document
  // navigation. The stop-over destroys the first Cesium instance and forces
  // a fresh app boot afterwards, without holding two WebGL contexts at once.
  await page.goto('about:blank')
  await page.goto(sharedUrl)
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })
  const opened = await cameraView(page)
  expect(opened.lat).toBeCloseTo(54.0901, 3)
  expect(opened.lon).toBeCloseTo(12.1405, 3)
  expect(opened.height).toBeCloseTo(3000, 0)
  // The layers came back off ...
  await page.getByRole('button', { name: 'Layers' }).click()
  await expect(page.getByRole('switch', { name: 'Show routes' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(page.getByRole('switch', { name: 'Show stops' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await page.keyboard.press('Escape')
  // ... and the boot flag ?paused=1 was in the URL anyway – the button
  // shows Resume
  await expect(page.getByRole('button', { name: 'Resume simulation' })).toBeVisible()

  // The pose in the hash was written through the miniature lens
  // (tiltshift=1). The app opens it through that lens again – and must
  // not walk the camera for the lens it puts on, or every reload would
  // land a step closer.
  await page.reload()
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })
  const reloaded = await cameraView(page)
  expect(reloaded.lat).toBeCloseTo(opened.lat, 4)
  expect(reloaded.lon).toBeCloseTo(opened.lon, 4)
  expect(reloaded.height).toBeCloseTo(opened.height, 0)

  // What a user typing in the address bar does: only the hash changes.
  // Survives a same-document navigation, not a reload – the marker proves
  // the app kept running instead of booting again.
  await page.evaluate(() => {
    ;(window as unknown as { __stillTheSamePage?: boolean }).__stillTheSamePage = true
  })
  await page.evaluate(() => {
    window.location.hash = '#lat=54.0901&lon=12.1405&height=2000&heading=0&pitch=-60&tiltshift=1'
  })
  await expect
    .poll(
      () => page.evaluate(() => window.__cesiumViewer!.camera.positionCartographic.height),
      { timeout: 20_000, intervals: [250, 500] },
    )
    .toBeLessThan(2600)
  // The layer state in the hash rides along, not just the camera: the
  // edited hash names neither layer, so both are back at their default
  await page.getByRole('button', { name: 'Layers' }).click()
  await expect(page.getByRole('switch', { name: 'Show routes' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByRole('switch', { name: 'Show stops' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  expect(
    await page.evaluate(
      () => (window as unknown as { __stillTheSamePage?: boolean }).__stillTheSamePage,
    ),
  ).toBe(true)
})

test('a selected vehicle is shared and restored via the URL', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&welcome=0&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mg3d?.ready === true && window.__mg3d.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )

  // Select a vehicle – the URL must switch to the vehicle-only hash
  const vehicleId = await page.evaluate(() => {
    const id = window.__mg3d!.vehicles()[0].id
    window.__mg3d!.selectVehicle(id)
    return id
  })
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
    .toBe(`#vehicle=${encodeURIComponent(vehicleId)}&weather=clear&paused=1`)
  const sharedUrl = await page.evaluate(() => window.location.href)

  // Fresh app boot from the shared link (about:blank tears down the first
  // WebGL context, see above) – the same trip is selected again, the
  // vehicle card opens, and follow mode engages.
  await page.goto('about:blank')
  await page.goto(sharedUrl)
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, {
    timeout: 120_000,
  })
  const card = page.getByTestId('vehicle-card')
  await expect(card).toBeVisible({ timeout: 60_000 })
  // The trip id is no longer printed on the card, so ask the app which
  // vehicle it restored – that is what this test is actually about.
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.selectedVehicleId()), { timeout: 30_000 })
    .toBe(vehicleId)
  await expect(card.getByRole('button', { name: 'Stop following' })).toBeVisible({
    timeout: 30_000,
  })
})
