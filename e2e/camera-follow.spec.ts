import { expect, test } from '@playwright/test'

/**
 * Separate spec for the render-heavy follow test: it starts with a fresh
 * camera, and its retry does not re-run the fast app tests.
 */
test('"Follow" moves the camera to the vehicle', async ({ page }) => {
  // A slow SwiftShader boot plus the two render-loop polls need more
  // headroom on busy CI runners than the global limit provides.
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )

  // The render loop must be running (diagnosis: lastLoopError names the cause).
  const ticksBefore = await page.evaluate(() => window.__mrt!.loopTicks())
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => ({
          ticks: window.__mrt!.loopTicks(),
          error: window.__mrt!.lastLoopError(),
        }))
        expect(state.error, `Render loop error: ${state.error}`).toBeNull()
        return state.ticks
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(ticksBefore)

  const tram = await page.evaluate(() => window.__mrt!.vehicles()[0])
  await page.evaluate((id) => window.__mrt!.selectVehicle(id), tram.id)
  // force: Playwright's actionability retry can land on the canvas under
  // SwiftShader load and thereby close the selection (click on empty map).
  await page.getByRole('button', { name: 'Follow tram' }).click({ force: true })
  await expect(page.getByRole('button', { name: 'Stop following' })).toBeVisible()

  // The camera must move close to the (paused) vehicle.
  // Generous timeout: under SwiftShader software rendering individual frames
  // can take seconds until the follow camera takes hold.
  await expect
    .poll(
      async () => {
        const state = await page.evaluate((vehicleId) => {
          const camera = window.__cesiumViewer!.camera.positionCartographic
          const tramNow = window.__mrt!.vehicles().find(({ id }) => id === vehicleId)
          if (!tramNow) {
            return {
              dist: Number.POSITIVE_INFINITY,
              loopError: `Selected vehicle ${vehicleId} is no longer active`,
            }
          }
          const camLat = (camera.latitude * 180) / Math.PI
          const camLon = (camera.longitude * 180) / Math.PI
          const dLat = (camLat - tramNow.lat) * 110540
          const dLon =
            (camLon - tramNow.lon) * 111320 * Math.cos((tramNow.lat * Math.PI) / 180)
          return {
            dist: Math.hypot(dLat, dLon),
            loopError: window.__mrt!.lastLoopError(),
          }
        }, tram.id)
        // A loop error after the click would silently prevent following –
        // then the test should name the cause instead of just the distance.
        expect(state.loopError, `Render loop error: ${state.loopError}`).toBeNull()
        return state.dist
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBeLessThan(1500)

  // Hover cursor: with the camera right behind the vehicle it is large on
  // screen, which makes this the cheap place to check the pointer without
  // booting another Cesium instance. The position comes from the app – a
  // scene.pick() search would be an offscreen render per probed pixel and
  // is far too slow under software rendering.
  const cursor = () =>
    page.evaluate(
      () => (document.querySelector('canvas') as HTMLCanvasElement).style.cursor || '',
    )
  // The chase camera keeps easing, so ask for the position and hover it in
  // one poll instead of once up front.
  await expect
    .poll(
      async () => {
        const spot = await page.evaluate(
          (id) => window.__mrt!.vehicleScreenPosition(id),
          tram.id,
        )
        if (!spot) return 'vehicle off screen'
        await page.mouse.move(Math.round(spot.x), Math.round(spot.y))
        await page.waitForTimeout(250)
        return cursor()
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBe('pointer')

  // Off the vehicle it goes back to the default cursor
  await page.mouse.move(640, 60)
  await expect.poll(cursor, { timeout: 15_000 }).toBe('')

  await page.getByRole('button', { name: 'Stop following' }).click({ force: true })
  await page.getByRole('button', { name: 'Close selection' }).click({ force: true })
  await expect(page.getByTestId('vehicle-card')).not.toBeVisible()
})
