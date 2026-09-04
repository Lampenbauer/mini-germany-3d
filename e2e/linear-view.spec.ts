import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { cityBySlug } from '../src/cities/definitions'

/**
 * The map/diagram switch (see src/map/LinearView.ts): every line pulled
 * straight into a row of its own, the vehicles carried over onto those
 * rows, and the map put away underneath while the diagram is up.
 *
 * Pressing it climbs the camera straight above the city first and only
 * then straightens the lines, so the morph carries lines the reader can
 * actually see (see CesiumMap.flyToCityPlan). Leaving it is the same
 * order backwards: the lines fold onto the map, then the camera goes
 * somewhere – home, or to whatever the press was aiming at.
 *
 * One boot for the whole thing – raising the scene is what costs here,
 * and the switch can be pressed twice on the same scene. The stops and
 * labels stay off: the diagram draws its own, and the map's are what a
 * SwiftShader frame is spent on (see tilt-shift.spec.ts).
 */

const CITY = cityBySlug('rostock')!

/**
 * What the plan view frames: the routes actually drawn, not the city
 * limits. Read off the committed network, the same geometry the map puts
 * up (RoutesLayer.linesExtent walks both directions of every line).
 */
function networkExtent() {
  const file = fileURLToPath(new URL('../src/cities/rostock/network.json', import.meta.url))
  const network = JSON.parse(readFileSync(file, 'utf8')) as {
    lines: { directions: { path: [number, number][] }[] }[]
  }
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const line of network.lines) {
    for (const dir of line.directions) {
      for (const [lon, lat] of dir.path) {
        west = Math.min(west, lon)
        east = Math.max(east, lon)
        south = Math.min(south, lat)
        north = Math.max(north, lat)
      }
    }
  }
  return { west, south, east, north }
}

const NETWORK = networkExtent()
const CENTER = {
  lon: (NETWORK.west + NETWORK.east) / 2,
  lat: (NETWORK.south + NETWORK.north) / 2,
}

/** Starts low and tilted, so the climb to the plan view is a real move. */
const VIEW = '#stops=0&labels=0&lat=54.0880&lon=12.1330&height=900&heading=0&pitch=-45'

function cameraPose(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const camera = window.__cesiumViewer!.camera
    return {
      lat: (camera.positionCartographic.latitude * 180) / Math.PI,
      lon: (camera.positionCartographic.longitude * 180) / Math.PI,
      height: camera.positionCartographic.height,
      pitch: (camera.pitch * 180) / Math.PI,
    }
  })
}

test('the lines pull straight and the map comes back', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&time=08:30${VIEW}`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
  // Vehicles have to be running, otherwise the dots prove nothing
  await expect.poll(() => page.evaluate(() => window.__mrt!.vehicleCount()), {
    timeout: 30_000,
  }).toBeGreaterThan(0)

  const diagram = page.getByTestId('linear-view')
  await expect(diagram).toBeHidden()

  await page.getByRole('button', { name: 'Pull the lines straight' }).click()

  // The camera climbs straight above the middle of the drawn network
  await expect
    .poll(async () => (await cameraPose(page)).pitch, { timeout: 20_000 })
    .toBeLessThan(-89)
  const plan = await cameraPose(page)
  expect(plan.lon).toBeCloseTo(CENTER.lon, 2)
  expect(plan.lat).toBeCloseTo(CENTER.lat, 2)
  // ... far enough up that every route is on screen, which is the whole
  // point of the climb: the morph carries each line from where it is.
  const framed = await page.evaluate(() => {
    const rectangle = window.__cesiumViewer!.camera.computeViewRectangle()!
    const deg = (radians: number) => (radians * 180) / Math.PI
    return {
      west: deg(rectangle.west),
      south: deg(rectangle.south),
      east: deg(rectangle.east),
      north: deg(rectangle.north),
    }
  })
  expect(framed.west).toBeLessThan(NETWORK.west)
  expect(framed.east).toBeGreaterThan(NETWORK.east)
  expect(framed.south).toBeLessThan(NETWORK.south)
  expect(framed.north).toBeGreaterThan(NETWORK.north)

  // One row per line the panel shows, and a dot per vehicle on them
  await expect.poll(() => page.evaluate(() => window.__mrt!.linear()), { timeout: 10_000 }).toBe(true)
  await expect(diagram).toBeVisible({ timeout: 10_000 })
  // The globe is not drawn while nothing of it is visible – also the
  // signal that the morph has run its course.
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'hidden', {
    timeout: 10_000,
  })
  const rows = await diagram.locator('svg > g:first-child > path').count()
  expect(rows).toBeGreaterThan(3)
  await expect.poll(() => diagram.locator('circle[data-vehicle]').count(), {
    timeout: 20_000,
  }).toBeGreaterThan(0)

  // A dot on a row is the same vehicle the map would have opened
  await diagram.locator('circle[data-vehicle]').first().click()
  await expect(page.getByTestId('vehicle-card')).toBeVisible()

  // ... and the camera controls went with it
  await expect(page.getByRole('button', { name: 'Show underground view' })).toHaveCount(0)

  // The URL carries the view, so the diagram can be shared
  expect(await page.evaluate(() => window.location.hash)).toContain('view=linear')

  // Back to the map: the globe returns, the diagram gets out of the way,
  // and the camera flies home – the plan view is a working position, not
  // a place to be put down in.
  await page.getByRole('button', { name: 'Back to the map' }).click()
  await expect.poll(() => page.evaluate(() => window.__mrt!.linear()), { timeout: 10_000 }).toBe(false)
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'visible')
  await expect(diagram).toBeHidden({ timeout: 10_000 })
  expect(await page.evaluate(() => window.location.hash)).not.toContain('view=linear')
  await expect(page.getByRole('button', { name: 'Show underground view' })).toBeVisible()

  // The home view: its height and pitch, aimed at the city's home point.
  await expect
    .poll(async () => (await cameraPose(page)).height, { timeout: 30_000 })
    .toBeLessThan(CITY.home.height * 1.2)
  const home = await cameraPose(page)
  expect(home.pitch).toBeCloseTo(CITY.home.pitch, 0)
  expect(home.height).toBeGreaterThan(CITY.home.height * 0.8)
  expect(home.lon).toBeCloseTo(CITY.home.longitude, 1)
})

/**
 * The handover. Two networks on screen at once – the map's own, standing
 * still, and the diagram's copy straightening away from it – is what a
 * cross-fade would show, and it reads as a smear rather than as lines
 * being pulled. So the map lets go of its routes, stops, vehicles and
 * names the frame the morph starts, and takes them back the frame it
 * ends: at rest the two lie exactly on top of each other, so neither
 * handover has anything to show.
 *
 * Watched from inside the page at frame rate – a screenshot cannot be
 * timed finely enough to catch a 900 ms transition under SwiftShader.
 */
test('the map lets go of the network for exactly as long as the diagram holds it', async ({
  page,
}) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&time=08:30#lat=54.0880&lon=12.1330&height=6000&heading=0&pitch=-50`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.vehicleCount()), { timeout: 30_000 })
    .toBeGreaterThan(0)

  /** Samples the two networks every frame until told to stop. */
  const watch = () =>
    page.evaluate(() => {
      window.__linearProbe = []
      const tick = () => {
        const viewer = window.__cesiumViewer!
        const routes = viewer.entities.values.filter((entity) => entity.polyline)
        const backdrop = document.querySelector('[data-testid="linear-view"] > div')
        window.__linearProbe!.push({
          drawnByMap: routes.filter((entity) => entity.show).length,
          drawnByDiagram: backdrop ? Number(getComputedStyle(backdrop).opacity) : -1,
          diagramShown:
            getComputedStyle(document.querySelector('[data-testid="linear-view"]')!).display !==
            'none',
        })
        if (window.__linearProbe!.length < 600) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  const samples = () => page.evaluate(() => window.__linearProbe!)

  // Into the diagram
  await watch()
  await page.getByRole('button', { name: 'Pull the lines straight' }).click()
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'hidden', {
    timeout: 30_000,
  })
  const goingIn = await samples()

  // Never both at once: no frame has the map drawing routes while the
  // diagram is on screen. That is the whole claim.
  expect(goingIn.some((f) => f.drawnByMap > 0)).toBe(true)
  expect(goingIn.some((f) => f.diagramShown)).toBe(true)
  expect(goingIn.filter((f) => f.diagramShown && f.drawnByMap > 0)).toEqual([])

  // ... and never neither: the network is on screen throughout, because
  // the diagram's lines are at full strength from its first frame.
  expect(goingIn.filter((f) => !f.diagramShown && f.drawnByMap === 0)).toEqual([])

  // Back to the map, same claim in reverse
  await watch()
  await page.getByRole('button', { name: 'Back to the map' }).click()
  await expect(page.getByTestId('linear-view')).toBeHidden({ timeout: 30_000 })
  const goingOut = await samples()
  expect(goingOut.some((f) => f.drawnByMap > 0)).toBe(true)
  expect(goingOut.filter((f) => f.diagramShown && f.drawnByMap > 0)).toEqual([])
  expect(goingOut.filter((f) => !f.diagramShown && f.drawnByMap === 0)).toEqual([])
})

/**
 * Aiming at something on the diagram is aiming at something on the map:
 * the lines fold back and the flight starts once they are down.
 */
test('following a vehicle from the diagram brings the map back', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&time=08:30${VIEW}`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.vehicleCount()), { timeout: 30_000 })
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Pull the lines straight' }).click()
  const diagram = page.getByTestId('linear-view')
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'hidden', {
    timeout: 30_000,
  })

  // A dot on a row, then "Follow" on the card it opens
  await expect
    .poll(() => diagram.locator('circle[data-vehicle]').count(), { timeout: 20_000 })
    .toBeGreaterThan(0)
  await diagram.locator('circle[data-vehicle]').first().click()
  await expect(page.getByTestId('vehicle-card')).toBeVisible()
  await page.getByRole('button', { name: 'Follow' }).click()

  // The map is back, the URL says so, and the camera is down at the vehicle
  await expect.poll(() => page.evaluate(() => window.__mrt!.linear()), { timeout: 10_000 }).toBe(false)
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'visible')
  expect(await page.evaluate(() => window.location.hash)).not.toContain('view=linear')
  await expect
    .poll(async () => (await cameraPose(page)).height, { timeout: 30_000 })
    .toBeLessThan(500)
})

test('a shared link opens straight into the diagram', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&time=08:30#stops=0&labels=0&view=linear`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })

  await expect.poll(() => page.evaluate(() => window.__mrt!.linear()), { timeout: 30_000 }).toBe(true)
  const diagram = page.getByTestId('linear-view')
  await expect(diagram).toBeVisible()
  // The map underneath is the plan view too, so coming back lands where
  // pressing the switch would have – no flight, nobody was watching.
  const plan = await cameraPose(page)
  expect(plan.pitch).toBeLessThan(-89)
  expect(plan.lon).toBeCloseTo(CENTER.lon, 2)
  expect(plan.lat).toBeCloseTo(CENTER.lat, 2)
  expect(await diagram.locator('svg > g:first-child > path').count()).toBeGreaterThan(3)
})
