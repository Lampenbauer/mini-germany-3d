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

  await page.getByRole('tab', { name: 'Line diagram' }).click()

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

  // The camera controls went with the map – the diagram has no camera to
  // aim – but the tabs stay: a view you cannot leave by is not a tab.
  await expect(page.getByRole('button', { name: 'Reset camera' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Line diagram' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: 'Underground' })).toBeVisible()

  // The URL carries the view, so the diagram can be shared
  expect(await page.evaluate(() => window.location.hash)).toContain('view=linear')

  // Back to the map: the globe returns, the diagram gets out of the way,
  // and the camera flies home – the plan view is a working position, not
  // a place to be put down in.
  await page.getByRole('tab', { name: 'Surface' }).click()
  await expect.poll(() => page.evaluate(() => window.__mrt!.linear()), { timeout: 10_000 }).toBe(false)
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'visible')
  await expect(diagram).toBeHidden({ timeout: 10_000 })
  expect(await page.evaluate(() => window.location.hash)).not.toContain('view=linear')
  await expect(page.getByRole('button', { name: 'Reset camera' })).toBeVisible()

  // The home view, read once the flight has actually landed rather than
  // while it is still easing: the pitch is the last component to arrive,
  // so it is the one worth waiting on.
  await expect
    .poll(async () => (await cameraPose(page)).pitch, { timeout: 30_000 })
    .toBeGreaterThan(CITY.home.pitch - 0.5)
  const home = await cameraPose(page)
  expect(home.pitch).toBeCloseTo(CITY.home.pitch, 0)
  expect(home.height).toBeLessThan(CITY.home.height * 1.2)
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

  /**
   * The probe's record, once it has actually seen the transition land.
   * A CSS assertion resolves the instant the DOM says so, which under
   * SwiftShader can be a frame or two before the probe next runs – and a
   * record read that early is missing the very frames the claim is about.
   */
  const recordShowing = async (landed: (frame: LinearProbeFrame) => boolean) => {
    await expect.poll(async () => (await samples()).some(landed), { timeout: 60_000 }).toBe(true)
    return samples()
  }

  // Into the diagram
  await watch()
  await page.getByRole('tab', { name: 'Line diagram' }).click()
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'hidden', {
    timeout: 30_000,
  })
  const goingIn = await recordShowing((f) => f.diagramShown && f.drawnByMap === 0)

  // Never both at once: no frame has the map drawing routes while the
  // diagram is on screen. That is the whole claim.
  expect(goingIn.some((f) => f.drawnByMap > 0)).toBe(true)
  expect(goingIn.filter((f) => f.diagramShown && f.drawnByMap > 0)).toEqual([])

  // ... and never neither: the network is on screen throughout, because
  // the diagram's lines are at full strength from its first frame.
  expect(goingIn.filter((f) => !f.diagramShown && f.drawnByMap === 0)).toEqual([])

  // Back to the map, same claim in reverse
  await watch()
  await page.getByRole('tab', { name: 'Surface' }).click()
  await expect(page.getByTestId('linear-view')).toBeHidden({ timeout: 30_000 })
  const goingOut = await recordShowing((f) => !f.diagramShown && f.drawnByMap > 0)
  expect(goingOut.some((f) => f.diagramShown)).toBe(true)
  expect(goingOut.filter((f) => f.diagramShown && f.drawnByMap > 0)).toEqual([])
  expect(goingOut.filter((f) => !f.diagramShown && f.drawnByMap === 0)).toEqual([])
})

/**
 * All three readings travel in the URL, and the map is the one that
 * needs no word for it: `view=` is absent on the surface, `view=linear`
 * for the diagram, `view=underground` for the tunnels.
 */
test('the URL carries whichever reading is on screen', async ({ page }) => {
  test.setTimeout(240_000)

  const hash = () => page.evaluate(() => window.location.hash)

  // A pose in the link and a camera left to settle. Both matter: without
  // them the boot flight is still writing the hash for its own reasons,
  // and a press that writes nothing looks like a press that works.
  await page.goto(
    `/?offline=1&time=08:30#stops=0&labels=0&lat=54.0880&lon=12.1330&height=2500&heading=0&pitch=-45`,
  )
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.renderPacing().interacting), { timeout: 60_000 })
    .toBe(false)
  expect(await hash()).not.toContain('view=')

  // The underground view moves no camera of its own, so nothing but the
  // press itself can put it in the URL.
  await page.getByRole('tab', { name: 'Underground' }).click()
  await expect.poll(hash, { timeout: 10_000 }).toContain('view=underground')

  // The diagram writes its own, and the surface writes nothing at all
  await page.getByRole('tab', { name: 'Line diagram' }).click()
  await expect.poll(hash, { timeout: 30_000 }).toContain('view=linear')
  await page.getByRole('tab', { name: 'Surface' }).click()
  await expect.poll(hash, { timeout: 30_000 }).not.toContain('view=')

  // An edited hash applies without a reload, like every other switch
  await page.evaluate(() => {
    window.location.hash = '#stops=0&labels=0&view=underground'
  })
  await expect(page.getByRole('tab', { name: 'Underground' })).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 30_000 },
  )
})

/**
 * A link naming a reading opens into it, once there is a city to show it
 * in – the diagram waits for its network, the tunnels for the map.
 */
test('a shared link opens on the reading it names', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&time=08:30#stops=0&labels=0&view=underground`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })
  await expect(page.getByRole('tab', { name: 'Underground' })).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 30_000 },
  )
})

/**
 * The three readings are tabs, so every one of them is reachable from
 * every other. Picking the tunnels while the diagram is up is the one
 * that has to do two things in order: bring the lines back down onto the
 * map, and only then take the camera under the city.
 */
test('the underground tab is reachable from the diagram', async ({ page }) => {
  test.setTimeout(240_000)

  await page.goto(`/?offline=1&time=08:30${VIEW}`)
  await page.waitForFunction(() => window.__mrt?.ready === true, undefined, { timeout: 120_000 })

  await page.getByRole('tab', { name: 'Line diagram' }).click()
  await expect(page.getByTestId('cesium-container')).toHaveCSS('visibility', 'hidden', {
    timeout: 30_000,
  })

  await page.getByRole('tab', { name: 'Underground' }).click()

  // The diagram is down, the map is back, and the map is the underground one
  await expect.poll(() => page.evaluate(() => window.__mrt!.linear()), { timeout: 20_000 }).toBe(false)
  await expect(page.getByTestId('linear-view')).toBeHidden({ timeout: 20_000 })
  await expect(page.getByRole('tab', { name: 'Underground' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(await page.evaluate(() => window.location.hash)).toContain('view=underground')

  // ... and the camera came home for it. Leaving the diagram lands at the
  // city's home view whichever reading was picked: the plan it was left
  // on is 25 km straight down, where the tunnels are nothing to see.
  await expect
    .poll(async () => (await cameraPose(page)).pitch, { timeout: 30_000 })
    .toBeGreaterThan(CITY.home.pitch - 0.5)
  const landed = await cameraPose(page)
  expect(landed.height).toBeLessThan(CITY.home.height * 1.2)
  expect(landed.lon).toBeCloseTo(CITY.home.longitude, 1)

  // ... and back up the other way, without passing through the diagram
  await page.getByRole('tab', { name: 'Surface' }).click()
  await expect(page.getByRole('tab', { name: 'Surface' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
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

  await page.getByRole('tab', { name: 'Line diagram' }).click()
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
