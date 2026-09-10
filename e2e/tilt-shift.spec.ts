import { expect, test, type Page } from '@playwright/test'

/**
 * The miniature look (see src/map/TiltShiftEffect.ts): a band across the
 * middle stays sharp, the rest of the frame blurs. Its three post-process
 * passes are the only hand-written screen-space shaders in the app, and a
 * GLSL error in them is invisible to the unit tests – it surfaces as a
 * Cesium RuntimeError out of the render loop. So this boots the real
 * renderer and measures the blur off the canvas.
 *
 * On its own page, and a deliberately cheap one: routes and labels off,
 * stops on. The measurement forces frames – one per readback, two per
 * switch click for Playwright's stability check, and a few more for the
 * lens ease the switch sets off (see CameraLens) – and under SwiftShader
 * every frame is paid for in full. Measured locally, per frame: the full
 * offline scene 489 ms, the routes alone 464 ms, the stops alone 137 ms
 * – the route polylines are what the software rasterizer chokes on, and
 * a CI runner is a large factor slower again. Inside app.spec, on the
 * full scene, this test ran 2.9 minutes on a green CI run – a hair under
 * its 3-minute limit – and the next commit tipped it over, twice through
 * the retry, which took the whole file's fourteen tests down with it.
 *
 * The stops are kept because they are what the blur is measured against.
 * The offline globe is a flat dark ground with nothing on it for the
 * metric to see; the stop discs are bright, sharp and spread over the
 * whole frame, and with them alone the two assertions below hold with
 * room to spare (measured: the top strip keeps 15 % of its detail
 * against the 50 % allowed, the band stands out 9× against the 3×
 * required).
 */

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  // A pose of the spec's own rather than the city's home view: the
  // reading below is a ratio of detail between two strips of the frame,
  // and it moved when the home view was raised from 5800 to 7400 m
  // (2026-09-10). This is the camera the home view stood at before.
  await page.goto(
    '/?offline=1&welcome=0&time=08:30&paused=1#lat=54.022550&lon=12.116191&height=5800&heading=0&pitch=-40&routes=0&labels=0',
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
})

test.afterAll(async () => {
  await page.close()
})

/**
 * High-frequency detail in two strips of the rendered frame: the top of
 * the picture, which the miniature effect blurs away, and the band across
 * the middle, which it keeps sharp.
 *
 * Read out of the canvas rather than through a Playwright screenshot on
 * purpose. An element screenshot waits for the element to be stable
 * across two animation frames, and a busy render loop under SwiftShader
 * starves that check for minutes – it is what made this test time out on
 * CI when it still took pictures.
 */
const frameDetail = () =>
  page.evaluate(() => {
    const viewer = window.__cesiumViewer!
    // The read has to happen in the same task as the render: the drawing
    // buffer is not preserved, so anything later comes back empty.
    viewer.render()
    const source = viewer.canvas
    const copy = document.createElement('canvas')
    copy.width = source.width
    copy.height = source.height
    const ctx = copy.getContext('2d')!
    ctx.drawImage(source, 0, 0)

    /** Mean |second derivative| along x – detail, blurred away or not. */
    const roughness = (fromY: number, toY: number) => {
      const top = Math.round(source.height * fromY)
      const height = Math.round(source.height * toY) - top
      const { data } = ctx.getImageData(0, top, source.width, height)
      const luma = (i: number) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      let sum = 0
      let samples = 0
      for (let y = 0; y < height; y++) {
        for (let x = 1; x < source.width - 1; x++) {
          const i = (y * source.width + x) << 2
          sum += Math.abs(2 * luma(i) - luma(i - 4) - luma(i + 4))
          samples++
        }
      }
      return sum / samples
    }
    return { top: roughness(0.02, 0.1), band: roughness(0.45, 0.55) }
  })

test('the miniature effect blurs the frame outside its sharp band', async () => {
  // Generous: a lean page, but a loaded runner still hands out frames in
  // seconds, and this waits on a dozen of them.
  test.setTimeout(240_000)

  // A GLSL error in the three post-process passes surfaces nowhere else
  // than as a RuntimeError out of the render loop. Toggling the effect
  // below releases and rebuilds the stages, so the shaders are compiled
  // again while this listener is attached.
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // Only measure a picture that stands still. The switch turns the lens
  // as well as the effect (see CameraLens): the angle eases over a few
  // frames and the camera walks along, and a frame from the middle of
  // that would measure the motion rather than the blur.
  const settled = () =>
    expect
      .poll(() => page.evaluate(() => window.__mrt!.renderPacing().interacting), {
        timeout: 60_000,
      })
      .toBe(false)

  /**
   * A reading of a picture that has stopped changing. The camera settling
   * is not the whole of it: Cesium compiles a post-process stage's shader
   * asynchronously and skips the stage until it is done, and under
   * SwiftShader that takes frames – so the first frame after the switch
   * can still be the unblurred one. Two readings that agree are the
   * evidence that the frame is the finished one, and the assertions below
   * then judge the effect rather than the moment they were made in.
   */
  const steadyFrameDetail = async () => {
    let previous = await frameDetail()
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await frameDetail()
      const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * 0.02
      if (close(previous.top, current.top) && close(previous.band, current.band)) return current
      previous = current
    }
    return previous
  }

  await settled()

  // The look starts off (config.camera.miniatureDefault) and is switched
  // on from the photo popover in the camera block at the lower right; on
  // is the deviation, so it rides along in the URL. It is a lens on the
  // map rather than a command to it, which is why it sits with the
  // camera and not with the sky (see the weather popover). The popover
  // is DOM over the canvas, not part of the frame, so it can stay open
  // while the canvas is read.
  await page.getByRole('button', { name: 'Photo mode' }).click()
  const toggle = page.getByRole('switch', { name: 'Show the miniature effect' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const withoutEffect = await steadyFrameDetail()

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('tiltshift=1')
  // The three passes are compiled and running, and the camera pose is one
  // that carries the effect at all – without both, the frame below would
  // be the unblurred one and the failure would point at the shader.
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.tiltShiftState()), { timeout: 60_000 })
    .toEqual({ enabled: true, strength: 1, ready: true })
  await settled()
  const withEffect = await steadyFrameDetail()

  // The blur takes the top of the picture down to a fraction of its detail
  expect(withEffect.top).toBeLessThan(withoutEffect.top * 0.5)
  // …and only with the effect on does the middle of one frame stand out
  // against its top. Measured as a ratio within each frame, so it says
  // something about the band rather than about what happens to be in the
  // two strips – the untouched frame's own ratio is the baseline.
  const standsOut = (frame: { top: number; band: number }) => frame.band / frame.top
  expect(standsOut(withEffect)).toBeGreaterThan(standsOut(withoutEffect) * 3)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('tiltshift=')
  expect(pageErrors).toEqual([])
})

/**
 * Mean luminance of the rendered frame, 0 … 255 – read out of the canvas
 * the same way frameDetail is, and for the same reasons.
 */
const frameLuminance = () =>
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
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    return sum / (data.length / 4)
  })

test('the photo grade brightens the frame at a raised exposure', async () => {
  test.setTimeout(240_000)

  // The grade is a fourth hand-written pass (see src/map/PhotoGradeEffect.ts),
  // and it is compiled only once a knob leaves neutral – the test above
  // never turns one, so a GLSL error in it would surface nowhere but here.
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // Whatever the test above left open, start from a closed popover
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Photo mode' }).click()
  const exposure = page.getByRole('slider', { name: 'Exposure' })
  await expect(exposure).toHaveAttribute('aria-valuenow', '0')
  const plain = await frameLuminance()

  // Two stops up is four times the light – on the mostly dark offline
  // globe that lifts the mean well clear of any noise in the readback
  await exposure.focus()
  await page.keyboard.press('End')
  await expect(exposure).toHaveAttribute('aria-valuenow', '2')
  // Polled: the pass is compiled asynchronously and skipped until it is
  await expect.poll(frameLuminance, { timeout: 60_000 }).toBeGreaterThan(plain * 1.5)

  // The reset button puts the knob – and the picture – back
  await page.getByRole('button', { name: 'Reset to defaults' }).click()
  await expect(exposure).toHaveAttribute('aria-valuenow', '0')
  await expect.poll(frameLuminance, { timeout: 60_000 }).toBeLessThan(plain * 1.1)
  expect(pageErrors).toEqual([])
})
