import { expect, test } from '@playwright/test'

/**
 * Regression test for a frozen simulation when requestAnimationFrame stalls.
 *
 * rAF callbacks are handed out by the compositor. Under heavy software
 * rendering (SwiftShader on CI), on a weak GPU, or with an occluded window
 * they can stop arriving entirely while the page itself stays responsive.
 * The app's loop then never runs again: vehicles freeze at their last tick
 * while the wall-clock based SimClock keeps going, so they jump minutes
 * ahead the moment frames resume. The watchdog in App.tsx runs a frame from
 * a timer instead – timers are unaffected by the compositor.
 */
test('the simulation keeps running when requestAnimationFrame stalls', async ({ browser }) => {
  const page = await browser.newPage()

  // rAF wrapper with a kill switch: once armed, callbacks are re-queued
  // forever instead of being invoked – exactly what a starved compositor
  // looks like to the page.
  await page.addInitScript(() => {
    const real = window.requestAnimationFrame.bind(window)
    window.__stopRaf = false
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      real((time) => {
        if (window.__stopRaf) {
          window.requestAnimationFrame(cb)
          return
        }
        cb(time)
      })
  })

  // Nothing here is looked at on screen – only the loop's own counters
  await page.goto('/?offline=1&time=08:30&paused=1#routes=0&stops=0&labels=0')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 60_000 },
  )

  await page.evaluate(() => {
    window.__mrt!.setPaused(false)
    window.__mrt!.setSpeed(120)
  })

  // Cut off rAF and note where the simulation stands at that moment.
  await page.evaluate(() => {
    window.__stopRaf = true
  })
  const frozen = await page.evaluate(() => ({
    ticks: window.__mrt!.loopTicks(),
    vehicle: window.__mrt!.vehicles()[0],
  }))

  // The watchdog must keep ticking the simulation and moving the vehicles.
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.loopTicks()), {
      timeout: 15_000,
      intervals: [250, 500, 1000],
    })
    .toBeGreaterThan(frozen.ticks)

  await expect
    .poll(
      () =>
        page.evaluate(
          ({ id, lat, lon }) => {
            const vehicle = window.__mrt!.vehicles().find((v) => v.id === id)
            // Reaching the terminus and leaving the list also proves movement.
            return vehicle == null || vehicle.lat !== lat || vehicle.lon !== lon
          },
          { id: frozen.vehicle.id, lat: frozen.vehicle.lat, lon: frozen.vehicle.lon },
        ),
      { timeout: 15_000, intervals: [250, 500, 1000] },
    )
    .toBe(true)

  expect(await page.evaluate(() => window.__mrt!.lastLoopError())).toBeNull()
  await page.close()
})
