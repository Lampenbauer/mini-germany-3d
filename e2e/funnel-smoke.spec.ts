import { expect, test, type Page } from '@playwright/test'

/**
 * The exhaust over a ship's funnel (see src/map/FunnelSmoke.ts): a
 * stateless plume drawn by a hand-written shader whose errors surface
 * nowhere but as a RuntimeError out of the render loop – and only once a
 * plume is drawn, which needs a ship under way with a funnel. Offline
 * there is no AIS, so the test puts one on the map itself
 * (__mg3d.setAisVessels) and looks at it from a chase camera's distance:
 * the frame with her making twelve knots differs from the frame with her
 * stopped exactly where the plume is, and nowhere the hull is.
 *
 * On its own cheap page: routes, stops and labels off, the clock paused
 * so the ship stands where she is put.
 */

let page: Page

/** Rostock harbour, a 180 m box ship heading north-east from here. */
const SHIP = { lat: 54.1, lon: 12.13 }

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  // 220 m south-east of the ship, 60 m up, looking north-west across her
  await page.goto(
    '/?offline=1&welcome=0&time=12:00&paused=1#lat=54.0986&lon=12.1324&height=60&heading=315&pitch=-10&routes=0&stops=0&labels=0',
  )
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, { timeout: 120_000 })
})

test.afterAll(async () => {
  await page.close()
})

/**
 * Puts the box ship on the map reporting the given speed over the ground.
 * Her track holds one spot, so she stands where she is put whatever the
 * clock does between two frames – the plume follows the reported speed,
 * not the track, so the hull is the same in both pictures below.
 */
const putShip = (sogKn: number) =>
  page.evaluate(
    ({ lat, lon, sogKn }) => {
      const now = Date.now()
      const rendered = now - 240_000
      window.__mg3d!.setAisVessels([
        {
          mmsi: 211000001,
          name: 'TEST BOXSHIP',
          lat,
          lon,
          sogKn,
          cogDeg: 45,
          headingDeg: 45,
          navStatus: 0,
          typeCode: 70,
          lengthM: 180,
          widthM: 28,
          draughtM: 9,
          positionAt: now,
          track: [
            [rendered - 30_000, lat, lon, sogKn, 45, 45],
            [rendered + 30_000, lat, lon, sogKn, 45, 45],
          ],
        },
      ])
    },
    { ...SHIP, sogKn },
  )

/** The rendered frame's pixels, read off the canvas after a render of its own. */
const frame = () =>
  page.evaluate(() => {
    const viewer = window.__cesiumViewer!
    viewer.render()
    const source = viewer.canvas
    const copy = document.createElement('canvas')
    copy.width = source.width
    copy.height = source.height
    const ctx = copy.getContext('2d')!
    ctx.drawImage(source, 0, 0)
    const { data } = ctx.getImageData(0, 0, source.width, source.height)
    return { width: source.width, height: source.height, data: Array.from(data) }
  })

/** How many pixels of a frame differ visibly between two frames, inside a box in CSS-fraction coordinates. */
function differingPixels(
  a: { width: number; height: number; data: number[] },
  b: { width: number; height: number; data: number[] },
  box: { x0: number; y0: number; x1: number; y1: number },
): number {
  let count = 0
  for (let y = Math.floor(box.y0 * a.height); y < box.y1 * a.height; y++) {
    for (let x = Math.floor(box.x0 * a.width); x < box.x1 * a.width; x++) {
      const i = (y * a.width + x) * 4
      const la = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2]
      const lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2]
      if (Math.abs(la - lb) > 6) count++
    }
  }
  return count
}

test('a ship under way trails a plume from her funnel, a ship stopped shows none', async () => {
  test.setTimeout(300_000)
  const slowPoll = { timeout: 120_000, intervals: [1000, 2000, 4000] }
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.renderPacing()), { timeout: 60_000 })
    .toMatchObject({ interacting: false, tilesLoading: false })
  expect(await page.evaluate(() => window.__mg3d!.funnelSmoke())).toMatchObject({
    drawn: 0,
    supported: true,
  })

  // Stopped: the hull is up, the funnel cold
  await putShip(0)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aisVesselCount()), slowPoll).toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.funnelSmoke()!.drawn), slowPoll)
    .toBe(0)
  const cold = await frame()

  // Under way: one plume, and the shader drew it without a word from the loop
  await putShip(12)
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.funnelSmoke()!.drawn), slowPoll)
    .toBe(1)
  const smoking = await frame()
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()

  // The plume rises from the funnel aft of the bridge, at the left of the
  // frame from this camera, into the sky above the hull; the hull herself
  // – the right half of the frame – is the same in both pictures
  const plume = { x0: 0.22, y0: 0.05, x1: 0.42, y1: 0.4 }
  const hull = { x0: 0.5, y0: 0.25, x1: 0.9, y1: 0.6 }
  expect(differingPixels(cold, smoking, plume)).toBeGreaterThan(150)
  expect(differingPixels(cold, smoking, hull)).toBeLessThan(50)

  // Gone with the ship
  await page.evaluate(() => window.__mg3d!.setAisVessels(null))
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.funnelSmoke()!.drawn), slowPoll)
    .toBe(0)
  expect(pageErrors).toEqual([])
})
