import { expect, test, type Page } from '@playwright/test'

/**
 * The ships' effects – the exhaust over a funnel (src/map/FunnelSmoke.ts)
 * and the wake (src/map/Wake.ts): hand-written shaders whose errors
 * surface nowhere but as a RuntimeError out of the render loop, and
 * only once a plume or a wake is drawn, which needs a ship under way.
 * Offline there is no AIS, so the tests put one on the map themselves
 * (__mg3d.setAisVessels) and read the effect off the canvas: the frame
 * with it differs from the frame without it where the effect is, and
 * nowhere else.
 *
 * On a cheap page each: routes, stops and labels off, the clock paused
 * so the ship stands where she is put. The frames stay in the page and
 * only the counts come out: a frame is four million numbers, and handing
 * one over the wire took the CI runner half a minute.
 */

let page: Page

/** Rostock harbour, a 180 m box ship put here. */
const SHIP = { lat: 54.1, lon: 12.13 }

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
})

test.afterAll(async () => {
  await page.close()
})

/**
 * Boots the map offline, paused at noon, at the pose given, and waits for
 * the globe's tiles: the pictures compared below must differ by the effect
 * alone. Both poses look steeply down on purpose – the offline globe's
 * grid tiles refine by the same screen-space error as any terrain, and a
 * view along the water from a low camera took 154 of them, which the CI
 * runner's software renderer did not get in within a minute;
 * from above, 20 to 30 do.
 */
async function boot(pose: string, time = '12:00') {
  // No seamarks: the Warnow has a dozen buoys within reach of these poses,
  // and a model landing between two frames would be the difference measured
  await page.goto(`/?offline=1&welcome=0&time=${time}&paused=1&seamarks=0#${pose}&routes=0&stops=0&labels=0`)
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, { timeout: 120_000 })
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.renderPacing()), { timeout: 120_000 })
    .toMatchObject({ interacting: false, tilesLoading: false })
}

/**
 * Puts the box ship on the map reporting the given speed over the ground
 * on the given course, and – with `runMeters` – a track that has her come
 * that far along it over the minute around the rendered instant. Without,
 * her track holds one spot, so she stands where she is put whatever the
 * clock does between two frames: the plume follows the reported speed,
 * not the track, so the hull is the same in both pictures.
 */
const putShip = (sogKn: number, courseDeg = 45, runMeters = 0, navStatus = 0) =>
  page.evaluate(
    ({ lat, lon, sogKn, courseDeg, runMeters, navStatus }) => {
      const now = Date.now()
      const rendered = now - 240_000
      const course = (courseDeg * Math.PI) / 180
      const dlat = ((Math.cos(course) * runMeters) / 2 / 111_132) * 1
      const dlon = (Math.sin(course) * runMeters) / 2 / (111_320 * Math.cos((lat * Math.PI) / 180))
      window.__mg3d!.setAisVessels([
        {
          mmsi: 211000001,
          name: 'TEST BOXSHIP',
          lat,
          lon,
          sogKn,
          cogDeg: courseDeg,
          headingDeg: courseDeg,
          lastCourseDeg: courseDeg,
          navStatus,
          typeCode: 70,
          lengthM: 180,
          widthM: 28,
          draughtM: 9,
          positionAt: now,
          track: [
            [rendered - 30_000, lat - dlat, lon - dlon, sogKn, courseDeg, courseDeg],
            [rendered + 30_000, lat + dlat, lon + dlon, sogKn, courseDeg, courseDeg],
          ],
        },
      ])
    },
    { ...SHIP, sogKn, courseDeg, runMeters, navStatus },
  )

/**
 * Whether the box ship wears her hull yet. The layer puts up a
 * placeholder box and swaps in the glTF hull once that is loaded – a
 * second locally, long enough on the CI runner that a frame taken right
 * after the ship was put showed water where the next one showed a hull.
 * A picture meant to hold the hull still waits for it.
 */
const hullReady = () =>
  page.evaluate(() => {
    // The hulls live in the layer's own collection (VesselLayer.root)
    const primitives = window.__cesiumViewer!.scene.primitives
    for (let i = 0; i < primitives.length; i++) {
      const root = primitives.get(i) as { length?: number; get?(j: number): { id?: unknown; ready?: boolean } }
      if (typeof root.get !== 'function' || typeof root.length !== 'number') continue
      for (let j = 0; j < root.length; j++) {
        const primitive = root.get(j)
        if (primitive.id === 'vessel:211000001' && primitive.ready === true) return true
      }
    }
    return false
  })

/** Where the page keeps the frames the tests compare. */
type FramesWindow = Window & { __mg3dFrames?: Record<string, ImageData> }

/** Renders a frame of its own and keeps its pixels in the page under the name. */
const captureFrame = (name: string) =>
  page.evaluate((name) => {
    const viewer = window.__cesiumViewer!
    viewer.render()
    const source = viewer.canvas
    const copy = document.createElement('canvas')
    copy.width = source.width
    copy.height = source.height
    const ctx = copy.getContext('2d')!
    ctx.drawImage(source, 0, 0)
    const frames = ((window as FramesWindow).__mg3dFrames ??= {})
    frames[name] = ctx.getImageData(0, 0, source.width, source.height)
  }, name)

/** How many pixels differ visibly between two kept frames, inside a box in CSS-fraction coordinates. */
const differingPixels = (a: string, b: string, box: { x0: number; y0: number; x1: number; y1: number }) =>
  page.evaluate(
    ({ a, b, box }) => {
      const frames = (window as FramesWindow).__mg3dFrames!
      const fa = frames[a]
      const fb = frames[b]
      let count = 0
      for (let y = Math.floor(box.y0 * fa.height); y < box.y1 * fa.height; y++) {
        for (let x = Math.floor(box.x0 * fa.width); x < box.x1 * fa.width; x++) {
          const i = (y * fa.width + x) * 4
          const la = 0.2126 * fa.data[i] + 0.7152 * fa.data[i + 1] + 0.0722 * fa.data[i + 2]
          const lb = 0.2126 * fb.data[i] + 0.7152 * fb.data[i + 1] + 0.0722 * fb.data[i + 2]
          if (Math.abs(la - lb) > 6) count++
        }
      }
      return count
    },
    { a, b, box },
  )

const slowPoll = { timeout: 120_000, intervals: [1000, 2000, 4000] }

/**
 * Whether the picture in a box holds still: two frames, RENDERS_APART
 * frames rendered in between, compared by the rule above – the count of
 * pixels that still change. A Model's image-based lighting arrives some
 * frames after the Model itself: Cesium renders its environment map
 * (DynamicEnvironmentMapManager – a cube map of the sky, its
 * convolutions, the irradiance) as compute passes through a queue every
 * Model shares, a few passes a frame, and with the clock paused and
 * nothing moving the loop draws almost no frames. So the picture of the
 * ship stopped was taken before her sky lighting had arrived and the
 * picture under way – whose plume keeps frames coming – after it, and
 * her sides differed by nine thousand pixels. While every wagon of the
 * fleet was a Model, some 2 000 of their passes queued ahead of hers
 * and her lighting never arrived inside the test at all, which is why
 * this held before. Rendering the frames here, in the page, drives the
 * queue on without waiting on the clock.
 */
const RENDERS_APART = 30
const pictureStill = async (box: { x0: number; y0: number; x1: number; y1: number }) => {
  await captureFrame('still-a')
  await page.evaluate((frames) => {
    for (let i = 0; i < frames; i++) window.__cesiumViewer!.render()
  }, RENDERS_APART)
  await captureFrame('still-b')
  return differingPixels('still-a', 'still-b', box)
}

test('a ship under way trails a plume from her funnel, a ship stopped shows none', async () => {
  test.setTimeout(300_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // 220 m south-east of the ship, 380 m up, looking steeply north-west
  // down across her: she lies broadside in the middle of the frame
  await boot('lat=54.0986&lon=12.13238&height=380&heading=315&pitch=-60')
  expect(await page.evaluate(() => window.__mg3d!.funnelSmoke())).toMatchObject({
    drawn: 0,
    supported: true,
  })

  // Stopped: the hull is up and lit by her sky, the funnel cold
  const plume = { x0: 0.2, y0: 0.28, x1: 0.38, y1: 0.4 }
  const hull = { x0: 0.45, y0: 0.36, x1: 0.7, y1: 0.48 }
  await putShip(0)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aisVesselCount()), slowPoll).toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.funnelSmoke()!.drawn), slowPoll)
    .toBe(0)
  await expect.poll(hullReady, slowPoll).toBe(true)
  await expect.poll(() => pictureStill(hull), slowPoll).toBe(0)
  await captureFrame('cold')

  // Under way: one plume, and the shader drew it without a word from the loop
  await putShip(12)
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.funnelSmoke()!.drawn), slowPoll)
    .toBe(1)
  await expect.poll(hullReady, slowPoll).toBe(true)
  await captureFrame('smoking')
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()

  // With no wind offline the plume trails dead aft: from the funnel aft
  // of the bridge, at the left of the hull from this camera, out over the
  // water beyond her stern; the forward two thirds of the hull herself
  // are the same in both pictures
  expect(await differingPixels('cold', 'smoking', plume)).toBeGreaterThan(150)
  expect(await differingPixels('cold', 'smoking', hull)).toBeLessThan(50)

  // Gone with the ship
  await page.evaluate(() => window.__mg3d!.setAisVessels(null))
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.funnelSmoke()!.drawn), slowPoll)
    .toBe(0)
  expect(pageErrors).toEqual([])
})

test('a ship under way leaves a wake behind her stern and nothing elsewhere', async () => {
  test.setTimeout(300_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // Straight above the ship, 700 m up, north at the top: she heads east
  // across the middle of the frame, her wake trails west of her stern
  await boot('lat=54.1&lon=12.129&height=700&heading=0&pitch=-89')
  expect(await page.evaluate(() => window.__mg3d!.wake())).toMatchObject({
    ships: 0,
    ferries: 0,
    supported: true,
  })
  await captureFrame('empty')

  // Six metres a second east for the minute around the rendered instant
  await putShip(12, 90, 360)
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.wake()!.ships), slowPoll)
    .toBeGreaterThan(20)
  await captureFrame('wake')
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()

  // The wash lies west of the stern – left of the hull in the frame – and
  // the water north-east of her, where no wake reaches, is untouched
  const wash = { x0: 0.3, y0: 0.47, x1: 0.45, y1: 0.55 }
  const quiet = { x0: 0.75, y0: 0.08, x1: 0.95, y1: 0.3 }
  expect(await differingPixels('empty', 'wake', wash)).toBeGreaterThan(300)
  expect(await differingPixels('empty', 'wake', quiet)).toBeLessThan(50)

  // Gone with the ship
  await page.evaluate(() => window.__mg3d!.setAisVessels(null))
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.wake()!.ships), slowPoll)
    .toBe(0)
  expect(pageErrors).toEqual([])
})

test('a ship under way at night shows her navigation lights, a moored one none, and by day nobody does', async () => {
  test.setTimeout(300_000)
  // At two in the morning, from her starboard quarter: the green
  // sidelight is screened off from here, the masthead and the stern
  // light are what a ship passing shows (see src/lib/nav-lights.ts)
  await boot('lat=54.0986&lon=12.13238&height=380&heading=315&pitch=-60', '02:00')
  await putShip(12)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aisVesselCount()), slowPoll).toBe(1)
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.navLights().ships), slowPoll)
    .toBeGreaterThan(0)
  // Moored (status 5): the lights go out
  await putShip(0, 45, 0, 5)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.navLights().ships), slowPoll).toBe(0)
  // At anchor (status 1): the one anchor light
  await putShip(0, 45, 0, 1)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.navLights().ships), slowPoll).toBe(1)
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()

  // By day the same ship under way shows nothing – the clock set to noon
  // on the same scene rather than a second boot, the street lamps going
  // out being the sign that the day has reached the map
  await putShip(12)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.navLights().ships), slowPoll).toBeGreaterThan(0)
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.streetLamps().alpha), slowPoll)
    .toBeGreaterThan(0)
  await page.evaluate(() => window.__mg3d!.setTime('12:00'))
  await expect.poll(() => page.evaluate(() => window.__mg3d!.streetLamps().alpha), slowPoll).toBe(0)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.navLights().ships), slowPoll).toBe(0)
})
