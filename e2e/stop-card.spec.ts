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
  // the control panel on the left and the buttons on the right.
  const ids = await stopIds(page)
  expect(ids.length).toBeGreaterThan(0)
  let clickable: { id: string; x: number; y: number } | null = null
  for (const id of ids) {
    const pos = await page.evaluate((sid) => window.__mrt!.stopScreenPosition(sid), id)
    if (pos && pos.x > 400 && pos.x < 1180 && pos.y > 60 && pos.y < 740) {
      clickable = { id, ...pos }
      break
    }
  }
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
