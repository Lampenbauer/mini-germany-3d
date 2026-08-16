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
      window.__mrt!.trams().map(({ id, lineId, nextStopName, lat, lon }) => [
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
  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.tramCount() > 0,
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
    window.__mrt!.selectTram(null)
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
  await expect(
    page.getByText('RSAG network & Rostock ferries – schedule simulation'),
  ).toBeVisible()
  await expect(page.locator('[data-testid=cesium-container] canvas')).toBeVisible()
  await expect(page.getByTestId('tileset-status')).toHaveText('Offline mode')
  const source = await page.evaluate(() => window.__mrt!.dataSource)
  await expect(page.getByTestId('data-source')).toHaveText(
    source === 'osm' ? 'OSM geometry' : 'Demo data (approximated)',
  )
})

test('shows the frozen simulation time 08:30', async () => {
  await expect(page.getByTestId('sim-clock')).toHaveText('08:30:00')
})

test('shows active vehicles on the network lines', async () => {
  const expected = await page.evaluate(() => window.__mrt!.lineIds())
  const activeLineIds = await page.evaluate(() => [
    ...new Set(window.__mrt!.trams().map((t) => t.lineId)),
  ])
  // Active lines must be known lines; individual bus lines may have genuine
  // GTFS service gaps at the probe time, but most of the network must be out.
  for (const id of activeLineIds) expect(expected).toContain(id)
  expect(activeLineIds.length).toBeGreaterThanOrEqual(
    Math.floor(expected.length * 0.75),
  )

  // "trams" for a tram-only network, "vehicles" once buses/ferries join
  await expect(page.getByTestId('tram-count')).toContainText(
    /\d+ (trams|vehicles) in service/,
  )
  const count = await page.evaluate(() => window.__mrt!.visibleTramCount())
  await expect(page.getByTestId('tram-count')).toContainText(
    new RegExp(`${count} (trams|vehicles) in service`),
  )
})

test('line switch hides the vehicles of that line', async () => {
  const before = await page.evaluate(() => window.__mrt!.visibleTramCount())
  await page.getByRole('switch', { name: 'Show Line 1' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleTramCount()))
    .toBeLessThan(before)
  await page.getByRole('switch', { name: 'Show Line 1' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleTramCount()))
    .toBe(before)
})

test('selecting a vehicle opens the info card', async () => {
  const tram = await page.evaluate(() => window.__mrt!.trams()[0])
  await page.evaluate((id) => window.__mrt!.selectTram(id), tram.id)

  const card = page.getByTestId('tram-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('tram-next-stop')).toHaveText(tram.nextStopName)
  await expect(card.getByRole('button', { name: 'Follow tram' })).toBeVisible()

  await card.getByRole('button', { name: 'Close selection' }).click()
  await expect(card).not.toBeVisible()
})

test('no vehicles run at night, service resumes in the morning', async () => {
  // 02:30: safely before the first departure (real and synthetic alike)
  await page.evaluate(() => window.__mrt!.setTime('02:30'))
  await expect.poll(() => page.evaluate(() => window.__mrt!.tramCount())).toBe(0)
  await expect(page.getByTestId('tram-count')).toContainText(
    /0 (trams|vehicles) in service/,
  )

  await page.evaluate(() => window.__mrt!.setTime('08:30'))
  await expect.poll(() => page.evaluate(() => window.__mrt!.tramCount())).toBeGreaterThan(0)
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
    const before = await page.evaluate(() => window.__mrt!.trams()[0])
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ id, lat, lon }) => {
              const t = window.__mrt!.trams().find((x) => x.id === id)
              // At ×120 a trip can reach its terminus within seconds and
              // vanish from the list – that also proves movement.
              return t == null || t.lat !== lat || t.lon !== lon
            },
            { id: before.id, lat: before.lat, lon: before.lon },
          ),
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)
    expect(await page.evaluate(() => window.__mrt!.tramBoxDriftMeters())).toBeLessThan(5)
  }

  await movedOnceWithBoxesAttached()
  await movedOnceWithBoxesAttached()
})

test('time-lapse moves the vehicles', async () => {
  const before = await page.evaluate(() =>
    JSON.stringify(window.__mrt!.trams().map((x) => x.id)),
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
          (prev) => JSON.stringify(window.__mrt!.trams().map((x) => x.id)) !== prev,
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
  await expect.poll(() => page.evaluate(() => window.__mrt!.tramCount())).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Now' }).click()
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
