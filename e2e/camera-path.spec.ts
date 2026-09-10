import { expect, test, type Page } from '@playwright/test'

/**
 * The camera path (src/lib/camera-path.ts): two keyframes and a duration,
 * flown on the wall clock from the photo popover or from a link. The
 * pose is read back from the hash the app writes once the camera
 * settles – the same numbers the keyframes are made of.
 */

const CHEAP = 'routes=0&stops=0&labels=0'
const START = { longitude: 12.1, latitude: 54.06, height: 3000, heading: 350, pitch: -40 }
const END = { longitude: 12.14, latitude: 54.1, height: 1500, heading: 20, pitch: -30 }

/**
 * The camera pose the URL carries once the camera has settled: the hash
 * has moved on from `before` – the app writes a pose shortly after the
 * camera comes to rest, and mid-flight at most every so often – and then
 * stood still for a moment, so it is the pose of a camera at rest.
 */
async function settledPose(page: Page, before: string) {
  const read = () => page.evaluate(() => window.location.hash)
  const deadline = Date.now() + 20_000
  for (;;) {
    const first = await read()
    await page.waitForTimeout(700)
    const second = await read()
    if (first === second && first !== before && first.includes('lat=')) {
      const params = new URLSearchParams(first.slice(1))
      return Object.fromEntries(
        ['lat', 'lon', 'height', 'heading', 'pitch'].map((k) => [k, Number(params.get(k))]),
      )
    }
    if (Date.now() > deadline) throw new Error(`the camera never settled past ${before}: ${second}`)
  }
}

test('flies from the start to the end on the wall clock, whatever the simulation does', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto(`/rostock/?offline=1&welcome=0&time=08:30&paused=1#${CHEAP}`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
  const secondsBefore = await page.evaluate(() => window.__mrt!.secondsOfDay())

  await page.evaluate(
    ([start, end]) => window.__mrt!.setCameraPath({ keyframes: [start, end], durationS: 3, ease: 'linear' }),
    [START, END],
  )
  // The path rides in the hash, so a link carries it
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain('path=54.060000,12.100000,3000,350,-40;54.100000,12.140000,1500,20,-30&dur=3&ease=linear')

  // The popover lists the keyframes and can put the camera on either
  await page.getByRole('button', { name: 'Photo mode' }).click()
  // Two lines in the popover; toHaveText folds the break into a space
  await expect(page.getByTestId('path-start')).toHaveText('54.0600° N 12.1000° E 3.0 km · 350° · −40°')
  await expect(page.getByTestId('path-end')).toHaveText('54.1000° N 12.1400° E 1.5 km · 20° · −30°')
  const beforeStart = await page.evaluate(() => window.location.hash)
  await page.getByRole('button', { name: 'Camera to the start' }).click()
  const atStart = await settledPose(page, beforeStart)
  expect(atStart.height).toBeCloseTo(3000, -1)
  expect(atStart.heading).toBe(350)

  // Play: the flight ends on the end keyframe and reports itself over
  const beforeFlight = await page.evaluate(() => window.location.hash)
  await page.getByRole('button', { name: 'Play the camera path' }).click()
  expect(await page.evaluate(() => window.__mrt!.cameraPath().playing)).toBe(true)
  await expect(page.getByRole('button', { name: 'Stop the camera path' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.cameraPath()), { timeout: 30_000 })
    .toMatchObject({ playing: false, progress: 1 })
  const atEnd = await settledPose(page, beforeFlight)
  expect(atEnd.lat).toBeCloseTo(54.1, 3)
  expect(atEnd.lon).toBeCloseTo(12.14, 3)
  expect(atEnd.height).toBeCloseTo(1500, -1)
  expect(atEnd.heading).toBe(20)
  expect(atEnd.pitch).toBe(-30)
  // The simulation was paused and is paused still: the flight is the wall clock's
  expect(await page.evaluate(() => window.__mrt!.secondsOfDay())).toBe(secondsBefore)

  // A hand on the camera takes the flight off
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__mrt!.playCameraPath())
  expect(await page.evaluate(() => window.__mrt!.cameraPath().playing)).toBe(true)
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, -300)
  await expect.poll(() => page.evaluate(() => window.__mrt!.cameraPath().playing)).toBe(false)
})

test('a link with ?play=1 flies its path once the city is up', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto(
    `/rostock/?offline=1&welcome=0&time=08:30&paused=1&play=1` +
      `#${CHEAP}&path=54.060000,12.100000,3000,350,-40;54.100000,12.140000,1500,20,-30&dur=2`,
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
  // No pace named: the gentle one is the default
  expect(await page.evaluate(() => window.__mrt!.cameraPath().path?.ease)).toBe('smooth')
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.cameraPath()), { timeout: 30_000 })
    .toMatchObject({ playing: false, progress: 1 })
  const atEnd = await settledPose(page, '')
  expect(atEnd.height).toBeCloseTo(1500, -1)
  expect(atEnd.pitch).toBe(-30)
})
