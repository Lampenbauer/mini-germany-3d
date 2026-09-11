import { expect, test, type Page } from '@playwright/test'

/**
 * The air traffic (src/map/AircraftLayer.ts): offline there is no feed,
 * so the tests put aircraft on the map themselves (__mg3d.setAircraft)
 * and check what the layer makes of them – a body per aircraft at its
 * altitude, the glTF loaded and swapped in, the callsign plate, the
 * selection through the URL hash, and an empty sky when the clock is set
 * into the past. The look itself is not judged here: a body at ten
 * kilometres is pixels, and the CI runner's software renderer is slow.
 */

let page: Page

/**
 * Over Rostock harbour: one airliner high up, one light aircraft low – a
 * kilometre north of the camera, which looks north and down at 45° from
 * 1500 m, so the light aircraft at 400 m sits in the middle of the frame.
 */
const AIRLINER = { hex: '3c65a2', callsign: 'DLH3Y', lat: 54.1, lon: 12.13 }
const LIGHT = { hex: '3d2f0c', callsign: 'DEQBK', lat: 54.09, lon: 12.12 }

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
})

test.afterAll(async () => {
  await page.close()
})

/**
 * Boots the map offline on the real clock – not at a fixed time of day
 * like the other specs: a simulated clock behind the real one is a clock
 * in the past, and the sky is empty then by design.
 */
async function boot(url: string) {
  await page.goto(url)
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, { timeout: 120_000 })
}

/** Two aircraft as the feed would report them a few seconds ago, level, moving east. */
const putAircraft = () =>
  page.evaluate(
    ({ AIRLINER, LIGHT }) => {
      const now = Date.now()
      const rendered = now - 12_000
      const one = (
        a: { hex: string; callsign: string; lat: number; lon: number },
        altM: number,
        gsKn: number,
        typeCode: string,
        category: string,
      ) => ({
        hex: a.hex,
        callsign: a.callsign,
        registration: '',
        typeCode,
        description: '',
        category,
        lat: a.lat,
        lon: a.lon,
        altGeomM: altM,
        altBaroM: altM - 40,
        onGround: false,
        gsKn,
        trackDeg: 90,
        headingDeg: 90,
        verticalRateMps: 0,
        rollDeg: null,
        squawk: '1000',
        source: 'adsb' as const,
        positionAt: now,
        // Ten minutes of track around the rendered instant, so the playback
        // interpolates and the reckoning is never reached however slow the
        // runner – a slow crawl east (about 4 m/s) that stays in the frame
        track: [
          [rendered - 300_000, a.lat, a.lon - 0.02, altM, gsKn, 90, 0],
          [rendered + 300_000, a.lat, a.lon + 0.02, altM, gsKn, 90, 0],
        ] as [number, number, number, number | null, number | null, number | null, number | null][],
      })
      window.__mg3d!.setAircraft([one(AIRLINER, 10_800, 450, 'A388', 'A5'), one(LIGHT, 400, 90, 'C172', 'A1')])
    },
    { AIRLINER, LIGHT },
  )

/** Whether the aircraft's glTF body is in and ready to draw. */
const modelReady = (hex: string) =>
  page.evaluate((hex) => {
    const primitives = window.__cesiumViewer!.scene.primitives
    for (let i = 0; i < primitives.length; i++) {
      const primitive = primitives.get(i)
      if (primitive.id === `aircraft:${hex}` && primitive.ready === true) return true
    }
    return false
  }, hex)

const slowPoll = { timeout: 120_000, intervals: [1000, 2000, 4000] }

test('aircraft put on the map get a body each, their plates, and leave with the list', async () => {
  test.setTimeout(300_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await boot('/?offline=1&welcome=0#lat=54.08&lon=12.12&height=1500&heading=0&pitch=-45&routes=0&stops=0')
  expect(await page.evaluate(() => window.__mg3d!.aircraftCount())).toBe(0)

  await putAircraft()
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(2)
  // An aircraft moving in view paces the loop like a tram does
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.renderPacing().aircraftInView), slowPoll)
    .toBe(true)
  // The plates are entities of their own, carrying the callsign
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__cesiumViewer!.entities.values.filter((e) => e.id.startsWith('aircraft:')).length,
        ),
      slowPoll,
    )
    .toBe(2)
  // The glTF bodies come in behind the placeholder boxes
  await expect.poll(() => modelReady(AIRLINER.hex), slowPoll).toBe(true)
  await expect.poll(() => modelReady(LIGHT.hex), slowPoll).toBe(true)
  // Both wear their lights in the air – by day dimmer, never none
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.navLights().aircraft), slowPoll)
    .toBeGreaterThan(0)
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()

  // Gone with the list
  await page.evaluate(() => window.__mg3d!.setAircraft(null))
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(0)
  expect(pageErrors).toEqual([])
})

test('a click-worthy aircraft is selectable and shared by its address', async () => {
  test.setTimeout(300_000)
  await boot('/?offline=1&welcome=0#lat=54.08&lon=12.12&height=1500&heading=0&pitch=-45&routes=0&stops=0')
  await putAircraft()
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(2)

  await page.evaluate((hex) => window.__mg3d!.selectAircraft(hex), AIRLINER.hex)
  await expect(page.getByTestId('aircraft-card')).toBeVisible()
  await expect(page.getByTestId('aircraft-name')).toHaveText(AIRLINER.callsign)
  await expect(page.getByTestId('aircraft-altitude')).toContainText('10 800 m')
  expect(await page.evaluate(() => window.location.hash)).toContain(`aircraft=${AIRLINER.hex}`)

  // The close button clears the selection and the hash
  await page.getByTestId('aircraft-card').getByRole('button', { name: 'Close selection' }).click()
  await expect(page.getByTestId('aircraft-card')).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('aircraft=')
  expect(await page.evaluate(() => window.__mg3d!.selectedAircraftHex())).toBeNull()

  // A link naming an aircraft restores it once the feed reports it
  await page.evaluate((hex) => {
    window.location.hash = `#aircraft=${hex}`
  }, LIGHT.hex)
  await expect(page.getByTestId('aircraft-card')).toBeVisible()
  await expect(page.getByTestId('aircraft-name')).toHaveText(LIGHT.callsign)
  expect(await page.evaluate(() => window.__mg3d!.selectedAircraftHex())).toBe(LIGHT.hex)
})

test('a clock set into the past empties the sky, and ?aircraft=0 opens with it off', async () => {
  test.setTimeout(300_000)
  await boot('/?offline=1&welcome=0#lat=54.08&lon=12.12&height=1500&heading=0&pitch=-45&routes=0&stops=0')
  await putAircraft()
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(2)

  // Two days back: there is no recording of the sky, so nothing is drawn
  await page.evaluate(() => {
    const today = window.__mg3d!.dateKey()
    const day = new Date(`${today}T12:00:00Z`)
    day.setUTCDate(day.getUTCDate() - 2)
    window.__mg3d!.setDate(day.toISOString().slice(0, 10))
  })
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(0)

  // ?aircraft=0: the switch is off and the list put on the map is not drawn
  await boot('/?offline=1&welcome=0&aircraft=0#lat=54.08&lon=12.12&height=1500&heading=0&pitch=-45&routes=0&stops=0')
  await putAircraft()
  await page.waitForTimeout(3000)
  expect(await page.evaluate(() => window.__mg3d!.aircraftCount())).toBe(0)
})

test('a followed aircraft leaving the box is watched from its edge, the camera stays inside', async () => {
  test.setTimeout(300_000)
  // Rostock's box ends at 12.5272° east. An aircraft 470 m inside it,
  // heading east at 15 m/s, crosses the edge half a minute into the test
  const EDGE_LON = 12.5272
  const AIRCRAFT = { hex: '4ca7b3', callsign: 'RYR7T', lat: 54.1, lon: 12.52 }
  await boot('/?offline=1&welcome=0#lat=54.09&lon=12.5&height=1500&heading=90&pitch=-30&routes=0&stops=0')
  await page.evaluate(
    ({ hex, callsign, lat, lon }) => {
      const now = Date.now()
      const rendered = now - 12_000
      const dlon = (15 * 300) / (111_320 * Math.cos((lat * Math.PI) / 180))
      window.__mg3d!.setAircraft([
        {
          hex,
          callsign,
          registration: '',
          typeCode: 'B738',
          description: '',
          category: 'A3',
          lat,
          lon,
          altGeomM: 2000,
          altBaroM: 1960,
          onGround: false,
          gsKn: 30,
          trackDeg: 90,
          headingDeg: 90,
          verticalRateMps: 0,
          rollDeg: null,
          squawk: '1000',
          source: 'adsb',
          positionAt: now,
          track: [
            [rendered - 300_000, lat, lon - dlon, 2000, 30, 90, 0],
            [rendered + 300_000, lat, lon + dlon, 2000, 30, 90, 0],
          ],
        },
      ])
    },
    AIRCRAFT,
  )
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(1)
  await page.evaluate((hex) => window.__mg3d!.selectAircraft(hex), AIRCRAFT.hex)
  await page.getByRole('button', { name: 'Follow aircraft' }).click()
  await expect(page.getByRole('button', { name: 'Stop following' })).toBeVisible()

  // The chase engages: the camera comes to the aircraft, inside the box
  const cameraLon = () =>
    page.evaluate(() => (window.__cesiumViewer!.camera.positionCartographic.longitude * 180) / Math.PI)
  await expect.poll(cameraLon, slowPoll).toBeGreaterThan(12.51)

  // The aircraft flies out over the edge; the camera follows it to the
  // edge and stops there, still following – the card stays up – while
  // the aircraft flies on another few hundred metres
  await expect
    .poll(cameraLon, { timeout: 150_000, intervals: [2000, 4000] })
    .toBeGreaterThan(EDGE_LON - 0.002)
  await page.waitForTimeout(15_000)
  expect(await cameraLon()).toBeLessThanOrEqual(EDGE_LON + 0.0005)
  expect(await cameraLon()).toBeGreaterThan(EDGE_LON - 0.002)
  await expect(page.getByRole('button', { name: 'Stop following' })).toBeVisible()
  // Looking east after the aircraft, not down at the edge
  const heading = await page.evaluate(() => (window.__cesiumViewer!.camera.heading * 180) / Math.PI)
  expect(Math.abs(heading - 90)).toBeLessThan(25)
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()
})
