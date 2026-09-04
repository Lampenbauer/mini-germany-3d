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
      window.__mrt!.vehicles().map(({ id, lineId, nextStopName, lat, lon }) => [
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
  await page.goto('/?offline=1&time=08:30&paused=1#routes=0')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.vehicleCount() > 0,
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
    window.__mrt!.selectVehicle(null)
    window.__mrt!.setPaused(true)
    window.__mrt!.setSpeed(1)
    window.__mrt!.setTime('08:30')
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
  expect(await page.evaluate(() => window.__mrt!.tilesetStatus())).toBe('offline')
  expect(await page.evaluate(() => window.__mrt!.dataSource)).toMatch(/^(osm|approximated)$/)
})

test('shows the frozen simulation time 08:30', async () => {
  await expect(page.getByTestId('sim-clock')).toHaveText('08:30:00')
})

test('shows active vehicles on the network lines', async () => {
  const expected = await page.evaluate(() => window.__mrt!.lineIds())
  const activeLineIds = await page.evaluate(() => [
    ...new Set(window.__mrt!.vehicles().map((t) => t.lineId)),
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
  const count = await page.evaluate(() => window.__mrt!.visibleVehicleCount())
  expect(count).toBeGreaterThan(0)
})

test('renders OSM tunnel route sections at reduced opacity', async () => {
  const source = await page.evaluate(() => window.__mrt!.dataSource)
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

test('changes a rendered vehicle body between 40% and 100% at a tunnel portal', async () => {
  const source = await page.evaluate(() => window.__mrt!.dataSource)
  test.skip(source !== 'osm', 'The approximated fallback network has no OSM tunnel tags')

  const transition = await page.evaluate(() => window.__mrt!.tunnelTransition())
  expect(transition).not.toBeNull()

  const setSimulationTime = async (seconds: number) => {
    const hours = String(Math.floor(seconds / 3600)).padStart(2, '0')
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
    const secs = String(seconds % 60).padStart(2, '0')
    await page.evaluate((time) => window.__mrt!.setTime(time), `${hours}:${minutes}:${secs}`)
  }

  await setSimulationTime(transition!.tunnelTime)
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const snap = window.__mrt!.vehicles().find((tram) => tram.id === id)
          return snap?.inTunnel ? window.__mrt!.vehicleOpacity(id) : null
        }, transition!.id),
      { timeout: 30_000 },
    )
    .toBeCloseTo(0.2)

  await setSimulationTime(transition!.surfaceTime)
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const snap = window.__mrt!.vehicles().find((tram) => tram.id === id)
          return snap && !snap.inTunnel ? window.__mrt!.vehicleOpacity(id) : null
        }, transition!.id),
      { timeout: 30_000 },
    )
    .toBeCloseTo(1)
})

test('the underground view swaps ghosted and solid vehicles', async () => {
  // Three polls of up to 30 s each, and every one of them waits for a
  // frame: with the clock paused and nothing moving, the render loop
  // idles at a 15 s heartbeat (see the pacing gate in App.tsx), so a
  // vehicle's new opacity can take two heartbeats to become readable.
  // The file's 3-minute default left no room for that and this test
  // tipped over it on a green run, taking all fourteen with it through
  // the serial retry.
  test.setTimeout(240_000)

  const source = await page.evaluate(() => window.__mrt!.dataSource)
  test.skip(source !== 'osm', 'The approximated fallback network has no OSM tunnel tags')

  const transition = await page.evaluate(() => window.__mrt!.tunnelTransition())
  expect(transition).not.toBeNull()

  // Park a vehicle inside a tunnel and check both views on it
  const hours = String(Math.floor(transition!.tunnelTime / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((transition!.tunnelTime % 3600) / 60)).padStart(2, '0')
  const secs = String(transition!.tunnelTime % 60).padStart(2, '0')
  await page.evaluate((time) => window.__mrt!.setTime(time), `${hours}:${minutes}:${secs}`)

  const opacity = () =>
    page.evaluate((id) => {
      const snap = window.__mrt!.vehicles().find((tram) => tram.id === id)
      return snap?.inTunnel ? window.__mrt!.vehicleOpacity(id) : null
    }, transition!.id)

  await expect.poll(opacity, { timeout: 30_000 }).toBeCloseTo(0.2)

  const underground = page.getByRole('tab', { name: 'Underground' })
  await underground.click()
  await expect(underground).toHaveAttribute('aria-selected', 'true')
  await expect.poll(opacity, { timeout: 30_000 }).toBeCloseTo(1)

  await page.getByRole('tab', { name: 'Surface' }).click()
  await expect(underground).toHaveAttribute('aria-selected', 'false')
  await expect.poll(opacity, { timeout: 30_000 }).toBeCloseTo(0.2)
})

test('line switch hides the vehicles of that line', async () => {
  const before = await page.evaluate(() => window.__mrt!.visibleVehicleCount())
  await page.getByRole('switch', { name: 'Show Line 1' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleVehicleCount()))
    .toBeLessThan(before)
  await page.getByRole('switch', { name: 'Show Line 1' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleVehicleCount()))
    .toBe(before)
})

test('selecting a vehicle opens the info card', async () => {
  const tram = await page.evaluate(() => window.__mrt!.vehicles()[0])
  await page.evaluate((id) => window.__mrt!.selectVehicle(id), tram.id)

  const card = page.getByTestId('vehicle-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('vehicle-next-stop')).toHaveText(tram.nextStopName)
  await expect(card.getByRole('button', { name: 'Follow tram' })).toBeVisible()

  // Every stop of the trip is a camera flight – the tooltip says so
  await expect(
    card.getByTestId('vehicle-trip-stops').getByRole('button').first(),
  ).toHaveAttribute('title', 'Fly to this stop')

  await card.getByRole('button', { name: 'Close selection' }).click()
  await expect(card).not.toBeVisible()
})

test('night services keep running after midnight, daytime service resumes in the morning', async () => {
  // 02:30: the daytime lines are off, but the Fledermaus night buses (F1–F4)
  // and the around-the-clock Warnemünde ferry are still out. Their GTFS
  // departures are encoded as times past 24:00 and must wrap into the early
  // morning hours.
  await page.evaluate(() => window.__mrt!.setTime('02:30'))
  // Wait until the daytime vehicles from the previous simulation time are
  // gone: night buses and ferries are the only lines with an F-prefixed id.
  await expect
    .poll(() =>
      page.evaluate(() => window.__mrt!.vehicles().every((tram) => tram.lineId.startsWith('F'))),
    )
    .toBe(true)
  const nightCount = await page.evaluate(() => window.__mrt!.vehicleCount())
  expect(nightCount).toBeGreaterThan(0)

  // 08:30: far more vehicles out than the handful of night services
  await page.evaluate(() => window.__mrt!.setTime('08:30'))
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.vehicleCount()))
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
    window.__mrt!.setPaused(false)
    window.__mrt!.setSpeed(120)
  })

  const movedOnceWithBoxesAttached = async () => {
    const before = await page.evaluate(() => window.__mrt!.vehicles()[0])
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ id, lat, lon }) => {
              const t = window.__mrt!.vehicles().find((x) => x.id === id)
              // At ×120 a trip can reach its terminus within seconds and
              // vanish from the list – that also proves movement.
              return t == null || t.lat !== lat || t.lon !== lon
            },
            { id: before.id, lat: before.lat, lon: before.lon },
          ),
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)
    expect(await page.evaluate(() => window.__mrt!.vehicleBoxDriftMeters())).toBeLessThan(5)
  }

  await movedOnceWithBoxesAttached()
  await movedOnceWithBoxesAttached()
})

test('time-lapse moves the vehicles', async () => {
  const before = await page.evaluate(() =>
    JSON.stringify(window.__mrt!.vehicles().map((x) => x.id)),
  )
  await page.evaluate(() => {
    window.__mrt!.setPaused(false)
    window.__mrt!.setSpeed(300)
  })
  // After a few seconds at ×300 the set of active trips must have changed
  await expect
    .poll(
      () =>
        page.evaluate(
          (prev) => JSON.stringify(window.__mrt!.vehicles().map((x) => x.id)) !== prev,
          before,
        ),
      { timeout: 20_000 },
    )
    .toBe(true)
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
  await expect.poll(() => page.evaluate(() => window.__mrt!.vehicleCount())).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Now' }).click()
  // The field must not keep advertising a time the simulation left behind
  await expect(timeInput).toHaveValue('')
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
    const d = Math.abs(window.__mrt!.secondsOfDay() - now)
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
  await page.getByRole('button', { name: 'Reset camera' }).click()
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
