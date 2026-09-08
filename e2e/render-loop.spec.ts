import { expect, test } from '@playwright/test'

/**
 * Two things about the app's loop that need the real page and nothing on
 * the screen: the GTFS-Realtime feed reaching the simulation, and the
 * watchdog that keeps the simulation ticking when requestAnimationFrame
 * stalls. One boot for both – each used to raise the same page on its
 * own, and under SwiftShader the boot is what a test here costs.
 *
 * The page is the cheapest the app has: routes, stops and labels off.
 */
test('the realtime feed reaches the simulation, which keeps running when requestAnimationFrame stalls', async ({
  page,
}) => {
  // A single Cesium boot can still take much longer on busy CI runners
  // than it does locally.
  test.setTimeout(240_000)

  // rAF wrapper with a kill switch: once armed, callbacks are re-queued
  // forever instead of being invoked – exactly what a starved compositor
  // looks like to the page. rAF callbacks are handed out by the
  // compositor; under heavy software rendering, on a weak GPU, or with an
  // occluded window they can stop arriving entirely while the page itself
  // stays responsive. The app's loop then never runs again: vehicles
  // freeze at their last tick while the wall-clock based SimClock keeps
  // going, so they jump minutes ahead the moment frames resume. The
  // watchdog in App.tsx runs a frame from a timer instead – timers are
  // unaffected by the compositor.
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

  // Mock the filtered JSON endpoint – verifies the chain
  // fetch → validation → status in the app.
  //
  // Matched on the path rather than by a glob over the whole URL: the app
  // asks per city (/api/realtime?city=rostock), and a glob written for the
  // bare path stops matching the moment a query string appears. A mock
  // that misses does not fail – the request goes to the real endpoint
  // instead, and the test quietly turns into one about whether the
  // upstream feed happens to be up. Hence the count below.
  let served = 0
  await page.route(
    (url) => url.pathname === '/api/realtime',
    (route) => {
      served++
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          timestamp: 1700000000,
          total: 42,
          delays: { 'some-trip': 120 },
        }),
      })
    },
  )

  await page.goto('/?offline=1&rt=1&time=08:30&paused=1#routes=0&stops=0&labels=0')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )

  // The feed reaching the app and matching trips is the part worth
  // asserting, so it is read from the debug API.
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.realtimeStatus()?.state))
    .toBe('live')
  // ... and it really was our JSON that got there, not the internet's
  expect(served).toBeGreaterThan(0)

  // Now the watchdog. Cut off rAF and note where the simulation stands at
  // that moment.
  await page.evaluate(() => {
    window.__mrt!.setPaused(false)
    window.__mrt!.setSpeed(120)
  })
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
})
