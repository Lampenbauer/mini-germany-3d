import { expect, test } from '@playwright/test'

/**
 * The stop card: click (or select) a stop → lines, next departures, and a
 * shareable #stop= link. Selection travels through the same test API the
 * vehicle tests use – a real scene.pick per click is an offscreen render,
 * ruinous under SwiftShader.
 */

/** All stop ids in the scene's billboards (they carry "stop:<id>" ids). */
async function stopIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const v = window.__cesiumViewer as unknown as {
      scene: { primitives: { length: number; get(i: number): unknown } }
    }
    const ids = new Set<string>()
    for (let i = 0; i < v.scene.primitives.length; i++) {
      const p = v.scene.primitives.get(i) as { length?: number; get?(j: number): { id?: unknown } }
      if (typeof p.length !== 'number' || !p.get) continue
      for (let j = 0; j < p.length; j++) {
        const id = p.get(j)?.id
        if (typeof id === 'string' && id.startsWith('stop:')) ids.add(id.slice(5))
      }
    }
    return [...ids]
  })
}

test('selecting a stop opens its departure board', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )
  const stopId = (await stopIds(page))[0]
  expect(stopId).toBeTruthy()

  await page.evaluate((id) => window.__mrt!.selectStop(id), stopId)
  const card = page.getByTestId('stop-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('stop-lines')).toBeVisible()
  // Rush hour on a served stop: the board must not be empty
  await expect(card.getByTestId('stop-departures')).toBeVisible({ timeout: 30_000 })

  // The URL now carries the stop instead of a camera pose
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
    .toContain(`stop=${encodeURIComponent(stopId!)}`)

  // Close → back to the camera-pose hash
  await card.getByRole('button', { name: 'Close selection' }).click()
  await expect(card).not.toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
    .toMatch(/^#lat=/)
})

test('a real click on a stop disc opens the card', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  // The one test that exercises the actual pick path (scene.pick on a
  // billboard) instead of the test API. The home view has hundreds of
  // stops in frame – find one comfortably inside the viewport, clear of
  // the control panel on the left and the buttons on the right, and
  // standing on its own: a hub puts its platforms' discs within a few
  // pixels of each other at this height, and a click into that pile
  // selects whichever disc is drawn on top, which is a fact about the
  // pile rather than about the pick path. The first stop inside the box
  // used to be enough; with the narrower lens (config.camera.fovDeg) it
  // came out at the edge of the box and in a pile of four.
  const ids = await stopIds(page)
  expect(ids.length).toBeGreaterThan(0)
  const positions: { id: string; x: number; y: number }[] = []
  for (const id of ids) {
    const pos = await page.evaluate((sid) => window.__mrt!.stopScreenPosition(sid), id)
    if (pos) positions.push({ id, ...pos })
  }
  const clickable =
    positions.find(
      (stop) =>
        stop.x > 420 &&
        stop.x < 1160 &&
        stop.y > 80 &&
        stop.y < 720 &&
        positions.every(
          (other) => other.id === stop.id || Math.hypot(other.x - stop.x, other.y - stop.y) >= 24,
        ),
    ) ?? null
  expect(clickable).not.toBeNull()

  await page.mouse.click(clickable!.x, clickable!.y)
  await expect(page.getByTestId('stop-card')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.selectedStopId()))
    .toBe(clickable!.id)
})

test('a shared stop link restores the card and flies to the stop', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  const stopId = (await stopIds(page))[0]
  expect(stopId).toBeTruthy()

  // Fresh boot from the shared link (about:blank tears down the first
  // WebGL context, same pattern as the vehicle-hash spec)
  await page.goto('about:blank')
  await page.goto(`/?offline=1&time=08:30&paused=1#stop=${encodeURIComponent(stopId!)}`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, {
    timeout: 120_000,
  })
  await expect(page.getByTestId('stop-card')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.selectedStopId()))
    .toBe(stopId)
})

test('a departure click follows its vehicle', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )

  // A stop whose board lists a departure that is already on the map –
  // only those are clickable links to their vehicle.
  const card = page.getByTestId('stop-card')
  const link = card.getByTitle('Fly to this vehicle').first()
  let found = false
  for (const id of (await stopIds(page)).slice(0, 25)) {
    await page.evaluate((sid) => window.__mrt!.selectStop(sid), id)
    await expect(card).toBeVisible()
    if ((await link.count()) > 0) {
      found = true
      break
    }
  }
  expect(found, 'no stop with a departure already on the map').toBe(true)
  // The mode icon marks it as clickable without hovering
  await expect(link.getByTestId('departure-on-map')).toBeVisible()

  // force: Playwright's actionability retry can land on the canvas under
  // SwiftShader load and thereby close the selection (click on empty map).
  await link.click({ force: true })

  // The board is replaced by the vehicle card – one selection at a time –
  // and the camera rides along right away.
  await expect(page.getByTestId('vehicle-card')).toBeVisible()
  await expect(card).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop following' })).toBeVisible()
  const tripId = await page.evaluate(() => window.__mrt!.selectedVehicleId())
  expect(tripId).toBeTruthy()

  // The camera closes in on the vehicle (paused, so it stays put).
  await expect
    .poll(
      () =>
        page.evaluate((vehicleId) => {
          const c = window.__cesiumViewer!.camera.positionCartographic
          const v = window.__mrt!.vehicles().find(({ id }) => id === vehicleId)
          if (!v) return Number.POSITIVE_INFINITY
          const camLat = (c.latitude * 180) / Math.PI
          const camLon = (c.longitude * 180) / Math.PI
          const dLat = (camLat - v.lat) * 110540
          const dLon = (camLon - v.lon) * 111320 * Math.cos((v.lat * Math.PI) / 180)
          return Math.hypot(dLat, dLon)
        }, tripId),
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBeLessThan(1500)
})
