import { expect, test, type Page } from '@playwright/test'
import type { Model } from 'cesium'
import { cityBySlug } from '../src/cities/definitions'

/**
 * The air traffic (src/map/AircraftLayer.ts): offline there is no feed,
 * so the tests put aircraft on the map themselves (__mg3d.setAircraft)
 * and check what the layer makes of them – a body per aircraft at its
 * altitude, the glTF loaded and swapped in, the callsign plate, the
 * selection through the URL hash, and the clock set into the past –
 * which offline, with no recording to switch to, keeps the list that is
 * up (the replay itself is unit-tested against a fake endpoint,
 * tests/aircraft-archive.test.ts). The look itself is not judged here: a
 * body at ten kilometres is pixels, and the CI runner's software
 * renderer is slow.
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
 * like the other specs: the traffic is rendered on the simulated clock as
 * far as the present, and an injected track around the real moment would
 * not cover a clock hours behind it – the aircraft would stand still.
 */
async function boot(url: string) {
  await page.goto(url)
  await page.waitForFunction(() => window.__mg3d?.ready === true, undefined, { timeout: 120_000 })
}

/** Two aircraft as the feed would report them a few seconds ago, level, moving east. */
const putAircraft = (airlinerAltitude = 10_800) =>
  page.evaluate(
    ({ AIRLINER, LIGHT, airlinerAltitude }) => {
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
      window.__mg3d!.setAircraft([one(AIRLINER, airlinerAltitude, 450, 'A388', 'A5'), one(LIGHT, 400, 90, 'C172', 'A1')])
    },
    { AIRLINER, LIGHT, airlinerAltitude },
  )

/** Whether the aircraft's glTF body is in and ready to draw. */
const modelReady = (hex: string) =>
  page.evaluate((hex) => {
    // The bodies live in the layer's own collection (AircraftLayer.root)
    const primitives = window.__cesiumViewer!.scene.primitives
    for (let i = 0; i < primitives.length; i++) {
      const root = primitives.get(i) as { length?: number; get?(j: number): { id?: unknown; ready?: boolean } }
      if (typeof root.get !== 'function' || typeof root.length !== 'number') continue
      for (let j = 0; j < root.length; j++) {
        const primitive = root.get(j)
        if (primitive.id === `aircraft:${hex}` && primitive.ready === true) return true
      }
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

  // The regenerated GLB must still expose the actual gear node to Cesium:
  // hidden at cruise, shown on approach, hidden again after climbing.
  const gearShown = () => page.evaluate((hex) => {
    const primitives = window.__cesiumViewer!.scene.primitives
    for (let i = 0; i < primitives.length; i++) {
      const root = primitives.get(i) as { length?: number; get?(j: number): Model }
      if (typeof root.get !== 'function' || typeof root.length !== 'number') continue
      for (let j = 0; j < root.length; j++) {
        const model = root.get(j)
        if (model.id === `aircraft:${hex}` && model.ready) return model.getNode('gear')?.show
      }
    }
    return null
  }, AIRLINER.hex)
  await expect.poll(gearShown, slowPoll).toBe(false)
  await putAircraft(400)
  await expect.poll(gearShown, slowPoll).toBe(true)
  await putAircraft()
  await expect.poll(gearShown, slowPoll).toBe(false)

  // Gone with the list
  await page.evaluate(() => window.__mg3d!.setAircraft(null))
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(0)

  // A clock set two days back asks for the recording – which offline
  // there is none of, so the list that is up stays up rather than the
  // sky blinking empty; proved by a couple of ticks going by on the same
  // scene, a boot being the dear thing here
  await putAircraft()
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(2)
  await page.evaluate(() => {
    const today = window.__mg3d!.dateKey()
    const day = new Date(`${today}T12:00:00Z`)
    day.setUTCDate(day.getUTCDate() - 2)
    window.__mg3d!.setDate(day.toISOString().slice(0, 10))
  })
  const ticks = await page.evaluate(() => window.__mg3d!.loopTicks())
  await expect.poll(() => page.evaluate(() => window.__mg3d!.loopTicks()), slowPoll).toBeGreaterThan(ticks + 2)
  expect(await page.evaluate(() => window.__mg3d!.aircraftCount())).toBe(2)
  expect(await page.evaluate(() => window.__mg3d!.aircraftReplay())).toEqual({ active: false, hours: [], fleet: 0 })
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()
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

test('?aircraft=0 opens with the traffic switched off', async () => {
  test.setTimeout(300_000)
  // A boot of its own: the switch is read from the URL once. The list
  // put on the map is not drawn – proved by a simulated second going by
  // (a couple of ticks, on which the layer would have been synced)
  // rather than by a fixed wait
  await boot('/?offline=1&welcome=0&aircraft=0#lat=54.08&lon=12.12&height=1500&heading=0&pitch=-45&routes=0&stops=0')
  await putAircraft()
  const since = await page.evaluate(() => window.__mg3d!.secondsOfDay())
  await expect
    .poll(() => page.evaluate(() => window.__mg3d!.secondsOfDay()), slowPoll)
    .toBeGreaterThan(since + 1)
  expect(await page.evaluate(() => window.__mg3d!.aircraftCount())).toBe(0)
})

test('a followed aircraft leaving the box is watched from its edge, the camera stays inside', async () => {
  test.setTimeout(300_000)
  // Rostock's box ends where its definition says (12.6048° east). An
  // aircraft 180 m inside it, heading east at 30 m/s, crosses the edge
  // six seconds into the test – near enough that the CI runner is not
  // kept waiting, far enough for the chase to engage first. Its track is
  // a straight line on the wall clock, so the test knows where it is at
  // any moment without asking the map (flightLon below).
  const EDGE_LON = cityBySlug('rostock')!.boundingBox.east
  const SPEED_MPS = 30
  const AIRCRAFT = { hex: '4ca7b3', callsign: 'RYR7T', lat: 54.1, lon: EDGE_LON - 0.0028 }
  type FlightWindow = Window & { __mg3dFlight?: { rendered: number; lon0: number; dlon: number } }
  // The camera starts 1.8 km inside the edge, looking east
  const startLon = (EDGE_LON - 0.0272).toFixed(4)
  await boot(`/?offline=1&welcome=0#lat=54.09&lon=${startLon}&height=1500&heading=90&pitch=-30&routes=0&stops=0`)
  await page.evaluate(
    ({ hex, callsign, lat, lon, speed }) => {
      const now = Date.now()
      const rendered = now - 12_000
      const dlon = (speed * 300) / (111_320 * Math.cos((lat * Math.PI) / 180))
      ;(window as FlightWindow).__mg3dFlight = { rendered, lon0: lon - dlon, dlon }
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
          gsKn: speed / 0.514444,
          trackDeg: 90,
          headingDeg: 90,
          verticalRateMps: 0,
          rollDeg: null,
          squawk: '1000',
          source: 'adsb',
          positionAt: now,
          track: [
            [rendered - 300_000, lat, lon - dlon, 2000, speed / 0.514444, 90, 0],
            [rendered + 300_000, lat, lon + dlon, 2000, speed / 0.514444, 90, 0],
          ],
        },
      ])
    },
    { ...AIRCRAFT, speed: SPEED_MPS },
  )
  await expect.poll(() => page.evaluate(() => window.__mg3d!.aircraftCount()), slowPoll).toBe(1)
  await page.evaluate((hex) => window.__mg3d!.selectAircraft(hex), AIRCRAFT.hex)
  await page.getByRole('button', { name: 'Follow aircraft' }).click()
  await expect(page.getByRole('button', { name: 'Stop following' })).toBeVisible()

  // The chase engages: the camera comes to the aircraft, inside the box
  const cameraLon = () =>
    page.evaluate(() => (window.__cesiumViewer!.camera.positionCartographic.longitude * 180) / Math.PI)
  await expect.poll(cameraLon, slowPoll).toBeGreaterThan(EDGE_LON - 0.0172)

  // The aircraft flies out over the edge; the camera follows it to the
  // edge and stops there, still following – the card stays up. Judged
  // once the aircraft is 200 m beyond the edge: a camera still chasing
  // would be 60 m outside by then, well past the slack allowed
  const flightLon = () =>
    page.evaluate(() => {
      const f = (window as FlightWindow).__mg3dFlight!
      return f.lon0 + 2 * f.dlon * ((Date.now() - 12_000 - (f.rendered - 300_000)) / 600_000)
    })
  await expect
    .poll(flightLon, { timeout: 120_000, intervals: [500, 1000] })
    .toBeGreaterThan(EDGE_LON + 0.0031)
  expect(await cameraLon()).toBeLessThanOrEqual(EDGE_LON + 0.0005)
  expect(await cameraLon()).toBeGreaterThan(EDGE_LON - 0.002)
  await expect(page.getByRole('button', { name: 'Stop following' })).toBeVisible()
  // Looking east after the aircraft, not down at the edge
  const heading = await page.evaluate(() => (window.__cesiumViewer!.camera.heading * 180) / Math.PI)
  expect(Math.abs(heading - 90)).toBeLessThan(25)
  expect(await page.evaluate(() => window.__mg3d!.lastLoopError())).toBeNull()
})
