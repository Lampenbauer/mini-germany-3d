import { expect, test, type Page } from '@playwright/test'

/**
 * Functional E2E tests against the real app (Cesium via SwiftShader).
 * The simulation starts frozen at 08:30 → deterministic state.
 *
 * All tests share one page (booting Cesium under software rendering is
 * expensive); the state is reset via the test API before each test.
 */

test.describe.configure({ mode: 'serial' })

let page: Page
let snapshotsAt0830 = ''

const tramSnapshotSignature = () =>
  page.evaluate(() =>
    JSON.stringify(
      window.__mg3d!.vehicles().map(({ id, lineId, nextStopName, lat, lon }) => [
        id,
        lineId,
        nextStopName,
        lat,
        lon,
      ]),
    ),
  )

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  // Routes off. Under SwiftShader the route polylines are what the
  // rasterizer chokes on – measured per frame on the offline scene: the
  // whole thing 489 ms, the routes alone 464 ms of it (see the note in
  // tilt-shift.spec.ts). Nothing here is measured off the screen, and the
  // one route assertion below reads the entities' colours, which a hidden
  // polyline carries just the same.
  await page.goto('/?offline=1&welcome=0&time=08:30&paused=1#routes=0')
  await page.waitForFunction(
    () => window.__mg3d?.ready === true && window.__mg3d.vehicleCount() > 0,
    undefined,
    { timeout: 60_000 },
  )
  snapshotsAt0830 = await tramSnapshotSignature()
})

test.afterAll(async () => {
  await page.close()
})

test.beforeEach(async () => {
  // Normalize the simulation state
  await page.evaluate(() => {
    window.__mg3d!.selectVehicle(null)
    window.__mg3d!.setPaused(true)
    window.__mg3d!.setSpeed(1)
    window.__mg3d!.setTime('08:30')
  })

  const timeInput = page.getByLabel('Set simulation time')
  await timeInput.fill('')
  await expect(timeInput).toHaveValue('')
  // Snapshots only catch up with the next loop tick – with ~350 vehicles
  // under SwiftShader that can take a long time on CI runners.
  await expect
    .poll(tramSnapshotSignature, { timeout: 60_000, intervals: [500, 1000, 2000] })
    .toBe(snapshotsAt0830)
  await expect(page.getByTestId('sim-clock')).toHaveText('08:30:00')
})

test('loads the app with map and control panel', async () => {
  await expect(page).toHaveTitle('Mini Rostock 3D')
  await expect(page.getByText('Mini Rostock 3D')).toBeVisible()
  await expect(page.locator('[data-testid=cesium-container] canvas')).toBeVisible()
  // The panel used to carry these as badges; the facts are still worth
  // asserting, so they are read from the debug API instead. Offline mode
  // in particular is what this whole spec file depends on.
  expect(await page.evaluate(() => window.__mg3d!.tilesetStatus())).toBe('offline')
  expect(await page.evaluate(() => window.__mg3d!.dataSource)).toMatch(/^(osm|approximated)$/)
})

test('the data attribution opens in the app\u2019s own dialog', async () => {
  // Cesium draws the link and would raise its own lightbox on it; the
  // credits belong in the dialog the rest of the interface uses. The list
  // inside is Cesium's own element, borrowed while the dialog is open.
  await page.locator('.cesium-credit-expand-link').click()
  const dialog = page.getByRole('dialog', { name: 'Data attribution' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('li').first()).toContainText('OpenStreetMap')
  await expect(page.locator('.cesium-credit-lightbox-overlay')).toBeHidden()
  // The interface steps back for as long as a dialog is up, so the credits
  // are read over the bare map. The panel clock stands in for all of it.
  await expect(page.getByTestId('sim-clock')).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('sim-clock')).toBeVisible()
  // …and handed back, so Cesium goes on writing to it
  await expect(page.locator('.cesium-credit-lightbox > ul')).toHaveCount(1)
})

test('reads the About dialog over a bare map, and hands the focus back', async () => {
  // The interface steps back while a dialog is up. The button that opened
  // it steps back with it, which is the part worth checking in a real
  // browser: focus cannot return to an element that is still display:none,
  // so the wrapper has to be visible again by the time Radix restores it.
  const button = page.getByRole('button', { name: 'About this project' })
  await button.click()
  const dialog = page.getByRole('dialog', { name: 'Mini Germany 3D' })
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('sim-clock')).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('sim-clock')).toBeVisible()
  await expect(button).toBeFocused()
})

test('shows active vehicles on the network lines', async () => {
  const expected = await page.evaluate(() => window.__mg3d!.lineIds())
  const activeLineIds = await page.evaluate(() => [
    ...new Set(window.__mg3d!.vehicles().map((t) => t.lineId)),
  ])
  // Active lines must be known lines; individual bus lines may have genuine
  // GTFS service gaps at the probe time, night-only lines (F1–F4) rest during
  // the day, and suspended lines (line 2 during the 2026 Werftdreieck works)
  // do not run at all – but most of the network must be out.
  for (const id of activeLineIds) expect(expected).toContain(id)
  expect(activeLineIds.length).toBeGreaterThanOrEqual(
    Math.floor((expected.length * 2) / 3),
  )

  // Vehicles on visible lines are what the map actually draws
  const count = await page.evaluate(() => window.__mg3d!.visibleVehicleCount())
  expect(count).toBeGreaterThan(0)
})

test('renders OSM tunnel route sections at reduced opacity', async () => {
  const source = await page.evaluate(() => window.__mg3d!.dataSource)
  test.skip(source !== 'osm', 'The approximated fallback network has no OSM tunnel tags')

  const routeParts = await page.evaluate(() => {
    const viewer = window.__cesiumViewer!
    return viewer.entities.values.flatMap((entity) => {
      if (!entity.id.startsWith('route:')) return []
      const color = entity.polyline?.material?.color?.getValue(viewer.clock.currentTime)
      return color ? [{ id: entity.id, opacity: color.alpha }] : []
    })
  })
  // Line 2 crosses the tram tunnel at Rostock Hauptbahnhof: its route must
  // consist of normal pieces (0.85) plus tunnel pieces at 40 % of that.
  const line2Opacities = routeParts
    .filter(({ id }) => id.startsWith('route:2:'))
    .map(({ opacity }) => opacity)
  const tunnelOpacity = 0.85 * 0.2
  expect(line2Opacities.some((opacity) => Math.abs(opacity - tunnelOpacity) < 1e-6)).toBe(true)
  expect(line2Opacities.some((opacity) => Math.abs(opacity - 0.85) < 1e-6)).toBe(true)
})

test('offline routes lie on the ellipsoid as ordinary polylines, none clamped', async () => {
  // Clamping classifies against the depth buffer on every rendered frame
  // – the reason the grid globe used to cost twice the GPU of the photo
  // tiles. Offline the ground is 0 m, so nothing needs clamping.
  const routes = await page.evaluate(() => {
    const viewer = window.__cesiumViewer!
    const polylines = viewer.entities.values.filter((entity) => entity.id.startsWith('route:'))
    // The visualizers park (empty) collections of their own in
    // groundPrimitives, nested two deep – count the primitives at the
    // leaves, not the collections.
    type Collection = { length: number; get: (index: number) => Collection | object }
    const leaves = (node: Collection | object): number => {
      const collection = node as Collection
      if (typeof collection.length !== 'number') return 1
      // The innermost (ordered) collection has a length but no get()
      if (typeof collection.get !== 'function') return collection.length
      let n = 0
      for (let i = 0; i < collection.length; i++) n += leaves(collection.get(i))
      return n
    }
    const groundPrimitives = leaves(viewer.scene.groundPrimitives)
    return {
      count: polylines.length,
      clamped: polylines.filter(
        (entity) => entity.polyline?.clampToGround?.getValue(viewer.clock.currentTime) === true,
      ).length,
      groundPrimitives,
    }
  })
  expect(routes.count).toBeGreaterThan(0)
  expect(routes.clamped).toBe(0)
  expect(routes.groundPrimitives).toBe(0)
})

test('a vehicle body is ghosted in a tunnel, solid past the portal, and the underground view swaps the two', async () => {
  // Five polls of up to 30 s each, and every one of them waits for a
  // frame: with the clock paused and nothing moving, the render loop
  // idles at a 15 s heartbeat (see the pacing gate in App.tsx), so a
  // vehicle's new opacity can take two heartbeats to become readable.
  // The file's 3-minute default left no room for that and the underground
  // half of this once tipped over it on a green run, taking the whole
  // file with it through the serial retry.
  test.setTimeout(300_000)

  const source = await page.evaluate(() => window.__mg3d!.dataSource)
  test.skip(source !== 'osm', 'The approximated fallback network has no OSM tunnel tags')

  const transition = await page.evaluate(() => window.__mg3d!.tunnelTransition())
  expect(transition).not.toBeNull()

  const setSimulationTime = async (seconds: number) => {
    const hours = String(Math.floor(seconds / 3600)).padStart(2, '0')
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
    const secs = String(seconds % 60).padStart(2, '0')
    await page.evaluate((time) => window.__mg3d!.setTime(time), `${hours}:${minutes}:${secs}`)
  }
  const opacity = (inTunnel: boolean) => () =>
    page.evaluate(
      ({ id, inTunnel }) => {
        const snap = window.__mg3d!.vehicles().find((tram) => tram.id === id)
        return snap && snap.inTunnel === inTunnel ? window.__mg3d!.vehicleOpacity(id) : null
      },
      { id: transition!.id, inTunnel },
    )

  // Park the vehicle inside the tunnel: ghosted, at 40 % of the route's
  // own 0.85 – and check both views on it
  await setSimulationTime(transition!.tunnelTime)
  await expect.poll(opacity(true), { timeout: 30_000 }).toBeCloseTo(0.2)

  const underground = page.getByRole('radio', { name: 'Underground' })
  await underground.click()
  await expect(underground).toHaveAttribute('aria-checked', 'true')
  await expect.poll(opacity(true), { timeout: 30_000 }).toBeCloseTo(1)

  await page.getByRole('radio', { name: 'Surface' }).click()
  await expect(underground).toHaveAttribute('aria-checked', 'false')
  await expect.poll(opacity(true), { timeout: 30_000 }).toBeCloseTo(0.2)

  // Past the portal the body is solid again
  await setSimulationTime(transition!.surfaceTime)
  await expect.poll(opacity(false), { timeout: 30_000 }).toBeCloseTo(1)
})

test('line switch hides the vehicles of that line', async () => {
  const before = await page.evaluate(() => window.__mg3d!.visibleVehicleCount())
  await page.getByRole('switch', { name: 'Show Line 1' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.visibleVehicleCount()))
    .toBeLessThan(before)
  await page.getByRole('switch', { name: 'Show Line 1' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.visibleVehicleCount()))
    .toBe(before)
})

test('selecting a vehicle opens the info card', async () => {
  const tram = await page.evaluate(() => window.__mg3d!.vehicles()[0])
  await page.evaluate((id) => window.__mg3d!.selectVehicle(id), tram.id)

  const card = page.getByTestId('vehicle-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('vehicle-next-stop')).toHaveText(tram.nextStopName)
  // The follow is the labelled button at the foot of the body here; the
  // fold button and the follow in the head are a phone's
  // (e2e/mobile-layout.spec.ts): beside the map there is nothing under
  // the card to uncover
  const follow = card.getByRole('button', { name: 'Follow tram' })
  await expect(follow).toBeVisible()
  await expect(follow).toHaveText('Follow tram')
  await expect(card.getByRole('button', { name: 'Collapse card' })).toBeHidden()

  // Every stop of the trip is a camera flight – the tooltip says so
  await expect(
    card.getByTestId('vehicle-trip-stops').getByRole('button').first(),
  ).toHaveAttribute('title', 'Fly to this stop')

  // The weather stays while the card is up, stepping left beside it
  // (WEATHER_BESIDE_CARD in App.tsx): the card opens at the button's
  // height, so the sky can be picked with a card open as well as without
  // one, and the two never overlap.
  const weather = page.getByRole('button', { name: 'Weather' })
  await expect(weather).toBeVisible()
  const cardBox = (await card.boundingBox())!
  await expect
    .poll(async () => {
      const box = (await weather.boundingBox())!
      return box.x + box.width <= cardBox.x && Math.abs(box.y - cardBox.y) < 1
    })
    .toBe(true)

  await card.getByRole('button', { name: 'Close selection' }).click()
  await expect(card).not.toBeVisible()
  await expect(weather).toBeVisible()
  // …and back into its corner once the card is gone
  await expect.poll(async () => (await weather.boundingBox())!.x + 36 + 16 > 1280 - 1).toBe(true)
})

test('night services keep running after midnight, daytime service resumes in the morning', async () => {
  // 02:30: the daytime lines are off, but the Fledermaus night buses (F1–F4)
  // and the around-the-clock Warnemünde ferry are still out. Their GTFS
  // departures are encoded as times past 24:00 and must wrap into the early
  // morning hours.
  await page.evaluate(() => window.__mg3d!.setTime('02:30'))
  // Wait until the daytime vehicles from the previous simulation time are
  // gone: night buses and ferries are the only lines with an F-prefixed id.
  await expect
    .poll(() =>
      page.evaluate(() => window.__mg3d!.vehicles().every((tram) => tram.lineId.startsWith('F'))),
    )
    .toBe(true)
  const nightCount = await page.evaluate(() => window.__mg3d!.vehicleCount())
  expect(nightCount).toBeGreaterThan(0)

  // 08:30: far more vehicles out than the handful of night services
  await page.evaluate(() => window.__mg3d!.setTime('08:30'))
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.vehicleCount()))
    .toBeGreaterThan(nightCount)
})

test('vehicle boxes follow the simulation (no freezing/lagging)', async () => {
  // Regression test: the box primitives must follow the label positions
  // exactly. (A modelMatrix clone bug and starved geometry rebuilds used to
  // leave the boxes stuck at their spawn position.)
  // No fixed sleeps: headless runners throttle rAF below 1 Hz at times, so a
  // 1.5 s sleep does not guarantee a single simulation tick there. Instead,
  // poll for observed movement and then measure the box drift – with frozen
  // boxes it grows to hundreds of meters within seconds at speed 120.
  await page.evaluate(() => {
    window.__mg3d!.setPaused(false)
    window.__mg3d!.setSpeed(120)
  })

  const movedOnceWithBoxesAttached = async () => {
    const before = await page.evaluate(() => window.__mg3d!.vehicles()[0])
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ id, lat, lon }) => {
              const t = window.__mg3d!.vehicles().find((x) => x.id === id)
              // At ×120 a trip can reach its terminus within seconds and
              // vanish from the list – that also proves movement.
              return t == null || t.lat !== lat || t.lon !== lon
            },
            { id: before.id, lat: before.lat, lon: before.lon },
          ),
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)
    expect(await page.evaluate(() => window.__mg3d!.vehicleBoxDriftMeters())).toBeLessThan(5)
  }

  await movedOnceWithBoxesAttached()
  await movedOnceWithBoxesAttached()
})

test('time-lapse moves the vehicles', async () => {
  const before = await page.evaluate(() =>
    JSON.stringify(window.__mg3d!.vehicles().map((x) => x.id)),
  )
  await page.evaluate(() => {
    window.__mg3d!.setPaused(false)
    window.__mg3d!.setSpeed(300)
  })
  // After a few seconds at ×300 the set of active trips must have changed
  await expect
    .poll(
      () =>
        page.evaluate(
          (prev) => JSON.stringify(window.__mg3d!.vehicles().map((x) => x.id)) !== prev,
          before,
        ),
      { timeout: 20_000 },
    )
    .toBe(true)
  // Under the time-lapse the whole picture is paced as if close up: the
  // fleets count as in view wherever their labels are drawn, and the ticks
  // come at the full rate
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.renderPacing()), { timeout: 10_000 })
    .toMatchObject({ paceWholeView: true, tickIntervalMs: 33 })
  await page.evaluate(() => window.__mg3d!.setSpeed(1))
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.renderPacing().paceWholeView), { timeout: 10_000 })
    .toBe(false)
})

test('the clock can be set and restored to real time', async () => {
  // fill + a single 15 s expect is too tight under CI load: a single loop
  // tick can take seconds there, and occasionally the time input's change
  // event gets lost. Hence repeat the (idempotent) fill in a poll until the
  // clock has picked up the value.
  const timeInput = page.getByLabel('Set simulation time')
  await expect
    .poll(
      async () => {
        await timeInput.fill('08:00')
        return page.getByTestId('sim-clock').textContent()
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toMatch(/^08:00/)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.vehicleCount())).toBeGreaterThan(0)
  // The time typed is in the hash as typed (the ?time= of the boot stays
  // in the search string), and stays 08:00 there while the clock runs on
  // from it – the address bar does not tick with the simulation
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('&time=08:00')
  await page.evaluate(() => window.__mg3d!.setTime('08:45'))
  await page.getByRole('button', { name: 'Resume simulation' }).click()
  await page.getByRole('button', { name: 'Pause simulation' }).click()
  expect(await page.evaluate(() => window.location.hash)).toContain('&time=08:00')

  await page.getByRole('button', { name: 'Now' }).click()
  // The field must not keep advertising a time the simulation left behind,
  // and neither may the link
  await expect(timeInput).toHaveValue('')
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('time=')
  const diff = await page.evaluate(() => {
    const fmt = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    let h = 0
    let m = 0
    let s = 0
    for (const part of fmt.formatToParts(Date.now())) {
      if (part.type === 'hour') h = parseInt(part.value, 10) % 24
      else if (part.type === 'minute') m = parseInt(part.value, 10)
      else if (part.type === 'second') s = parseInt(part.value, 10)
    }
    const now = h * 3600 + m * 60 + s
    const d = Math.abs(window.__mg3d!.secondsOfDay() - now)
    return Math.min(d, 86400 - d)
  })
  expect(diff).toBeLessThan(120)
})

test('pause button and camera reset are usable', async () => {
  // Initial state: the app was loaded with paused=1 → the button shows "Resume"
  await page.getByRole('button', { name: 'Resume simulation' }).click()
  await expect(page.getByRole('button', { name: 'Pause simulation' })).toBeVisible()
  await page.getByRole('button', { name: 'Pause simulation' }).click()
  await expect(page.getByRole('button', { name: 'Resume simulation' })).toBeVisible()
  // The compass test next sets a pose of its own, which a flight still
  // under way would carry off – so wait for this one to land. "Follow"
  // was pressed on the card above for one commit, which left the camera
  // at a vehicle and made this a real flight; the compass test failed on
  // CI right after it, with the wait already in place, and had never
  // failed before. The camera is left alone in this file since.
  await page.getByRole('button', { name: 'Reset camera' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.renderPacing().interacting), {
      timeout: 60_000,
    })
    .toBe(false)
})

test('the compass follows the view and walks it round the quarters', async () => {
  // The needle turns with the camera, and the button says which quarter it
  // will bring the view onto – so pressing it is never a guess.
  //
  // Everything here addresses the compass by its place in the column, not
  // by its label. The label is state: it names the quarter the next press
  // aims at, and it is refreshed on the UI tick a moment after the camera
  // has moved. A locator keyed on it races that tick – on a runner where
  // a frame takes seconds, the button is still called what it was called
  // before the flight, and waiting for the new name times out.
  test.setTimeout(240_000)
  const compass = page.getByRole('group', { name: 'View controls' }).getByRole('button').first()
  const heading = () =>
    page.evaluate(() => (window.__cesiumViewer!.camera.heading * 180) / Math.PI)
  const needleDeg = async () => {
    const style = await compass.locator('svg').getAttribute('style')
    const match = /rotate\((-?[\d.]+)deg\)/.exec(style ?? '')
    expect(match, `no rotation on the needle: ${style}`).not.toBeNull()
    return Number(match![1])
  }
  /** How far apart two angles are, whichever way round the dial. */
  const apart = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)
  const facing = (deg: number) =>
    expect.poll(async () => apart(await heading(), deg), { timeout: 60_000 }).toBeLessThan(1)
  const offering = (label: string) =>
    expect(compass).toHaveAttribute('aria-label', label, { timeout: 60_000 })

  // Looking south-south-east: the needle follows within a UI tick, and the
  // button offers the quarter the view is nearest to
  await page.evaluate(() => {
    window.location.hash = '#lat=54.09&lon=12.13&height=3000&heading=190&pitch=-45'
  })
  await offering('Face south')
  // The needle carries the icon's own angle; what matters is that it stands
  // at the heading, and keeps standing there as the view turns.
  const offset = (await needleDeg()) - 190
  const needleFacing = (deg: number) =>
    expect
      .poll(async () => apart((await needleDeg()) - offset, deg), { timeout: 60_000 })
      .toBeLessThan(1)

  await compass.click()
  await facing(180)
  await needleFacing(180)

  // Standing on a quarter, the button offers the next one and keeps going
  await offering('Face west')
  await compass.click()
  await facing(270)

  // …and past west it comes round to north instead of stopping there
  await offering('Face north')
  await compass.click()
  await facing(0)
  await needleFacing(0)
  await offering('Face east')
})

test('the buoys come up on the water as the camera comes down, and their lanterns with the night', async () => {
  const buoys = () => page.evaluate(() => window.__mg3d!.buoys())
  const slowPoll = { timeout: 60_000, intervals: [500, 1000, 2000] }
  // The Warnow's marks are registered with the city; from high over
  // the centre every cell is out of range and nothing is drawn
  expect((await buoys()).buoys).toBeGreaterThan(150)
  await page.evaluate(() => {
    window.location.hash = '#lat=54.09&lon=12.13&height=8000&heading=0&pitch=-60&routes=0'
  })
  await expect.poll(async () => (await buoys()).shown, slowPoll).toBe(0)
  // Down to the fairway in the Breitling: the cells within reach load
  // their models (offline from the local GLBs, like the ships' hulls)
  await page.evaluate(() => {
    window.location.hash = '#lat=54.12&lon=12.09&height=400&heading=0&pitch=-45&routes=0'
  })
  await expect.poll(async () => (await buoys()).shown, slowPoll).toBeGreaterThan(10)
  // Offline there are no tiles to clamp to: the fallback surface, no pick
  expect((await buoys()).clamped).toBe(0)
  // Night: the lanterns burn, and the lighthouses with them – from over
  // the Breitling the Petersdorf leading lights show their red; noon:
  // all of them are out
  const lighthouses = () => page.evaluate(() => window.__mg3d!.lighthouses())
  expect((await lighthouses()).lights).toBeGreaterThan(5)
  await page.evaluate(() => window.__mg3d!.setTime('23:00'))
  await expect.poll(async () => (await buoys()).lightAlpha, slowPoll).toBe(1)
  await expect.poll(async () => (await lighthouses()).alpha, slowPoll).toBe(1)
  expect((await lighthouses()).shown).toBeGreaterThan(0)
  // The night's grade on the whole frame (PhotoGradeEffect): its pass runs
  // from dusk – compiled here, which proves its shader – and not by day
  const nightGrade = () =>
    page.evaluate(() => {
      const stage = window.__cesiumViewer!.scene.postProcessStages.getStageByName('mg3d_photo_grade')
      return { enabled: stage.enabled, ready: stage.ready }
    })
  await expect.poll(nightGrade, slowPoll).toEqual({ enabled: true, ready: true })
  // The turning optics (lib/lighthouse-beam.ts): Rostock has two – Warnemünde,
  // seven kilometres north of here and within the beams' reach, and Bastorf,
  // out of it. The Warnemünde lens at the clock's zero points north, out to
  // sea, and its shaft is drawn – its shader compiled offline, which is what
  // this proves; the light on the tiles is the tileset's shader and needs the
  // tiles. Paused, the optic stands and is no motion to the loop
  expect((await lighthouses()).rotating).toBe(2)
  await expect.poll(async () => (await lighthouses()).beams, slowPoll).toBeGreaterThanOrEqual(1)
  expect(await page.evaluate(() => window.__mg3d!.renderPacing().beamInView)).toBe(false)
  // Running, with the tower in the frame – from the Alter Strom looking
  // north at it – it turns on the simulated clock and the loop paces for
  // it: ticks at the beams' capped rate, frames with them
  await page.evaluate(() => {
    window.location.hash = '#lat=54.172&lon=12.09&height=250&heading=0&pitch=-15&routes=0'
  })
  const opticTime = async () => (await lighthouses()).opticTime
  const standing = await opticTime()
  await page.evaluate(() => window.__mg3d!.setPaused(false))
  await expect.poll(opticTime, slowPoll).toBeGreaterThan(standing + 0.5)
  await expect.poll(() => page.evaluate(() => window.__mg3d!.renderPacing().beamInView), slowPoll).toBe(true)
  // Paced, not the 500 ms of an idle map (the beam's own cap is the unit
  // test's). Polled, and read in one go with the flag: the flight the
  // hash change starts swings the frustum, and on the CI runner one tick
  // had the tower out of it between the two reads (2026-09-16, retried)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const pacing = window.__mg3d!.renderPacing()
          return pacing.beamInView ? pacing.tickIntervalMs : Number.POSITIVE_INFINITY
        }),
      slowPoll,
    )
    .toBeLessThan(500)
  await page.evaluate(() => window.__mg3d!.setPaused(true))
  await page.evaluate(() => {
    window.location.hash = '#lat=54.12&lon=12.09&height=400&heading=0&pitch=-45&routes=0'
  })
  await page.evaluate(() => window.__mg3d!.setTime('12:00'))
  await expect.poll(async () => (await buoys()).lightAlpha, slowPoll).toBe(0)
  await expect.poll(async () => (await lighthouses()).alpha, slowPoll).toBe(0)
  expect((await lighthouses()).beams).toBe(0)
  expect((await nightGrade()).enabled).toBe(false)
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()

  // The flat map, over the same water: offline it has no pictures (no
  // Mapbox request without a token, and none in the tests), but the
  // ground is switched all the same – the globe takes the depth test,
  // the marks are set on the flat water again, the hash names it – and
  // the tiles come back the same way. The loop runs on through both.
  const ticks = () => page.evaluate(() => window.__mg3d!.loopTicks())
  let tick = await ticks()
  await page.evaluate(() => window.__mg3d!.setBasemap('flat'))
  expect(await page.evaluate(() => window.__mg3d!.basemap())).toBe('flat')
  expect(await page.evaluate(() => window.__mg3d!.tilesetStatus())).toBe('offline')
  expect(await page.evaluate(() => window.__mg3d!.flatMap().shown)).toBe(false)
  expect(await page.evaluate(() => window.__cesiumViewer!.scene.globe.depthTestAgainstTerrain)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('basemap=flat')
  await expect.poll(ticks, slowPoll).toBeGreaterThan(tick + 2)
  expect((await buoys()).shown).toBeGreaterThan(10)
  tick = await ticks()
  await page.evaluate(() => window.__mg3d!.setBasemap('3d'))
  expect(await page.evaluate(() => window.__cesiumViewer!.scene.globe.depthTestAgainstTerrain)).toBe(false)
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('basemap=')
  await expect.poll(ticks, slowPoll).toBeGreaterThan(tick + 2)
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()
})
