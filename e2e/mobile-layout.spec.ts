import { expect, test } from '@playwright/test'

/**
 * The interface on a phone (see src/lib/viewport.ts and the max-sm
 * variants in App.tsx): the panel is a sheet at the foot of the screen
 * and opens folded, a card takes the sheet's place and the panel leaves
 * while it is up, the rail and the readings stand at the top, and what
 * has no place on a phone – the diagram, the photo mode, full screen –
 * is not offered. The map itself draws from the mobile profile.
 */

const CHEAP = 'routes=0&stops=0&labels=0'

test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true })

test('the interface makes room for the map on a phone', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto(`/rostock/?offline=1&welcome=0&time=08:30&paused=1#${CHEAP}`)
  await page.waitForFunction(
    () => window.__mg3d?.ready === true && window.__mg3d.vehicleCount() > 0,
    undefined,
    { timeout: 120_000 },
  )
  // A phone-shaped touch screen reads as the mobile tier without being told
  expect(await page.evaluate(() => window.__mg3d!.renderProfile().tier)).toBe('mobile')
  expect(await page.evaluate(() => window.__mg3d!.shadowMap().size)).toBe(2048)
  // Nothing pushes the page wider than the screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // The panel: a sheet at the foot, as wide as the screen less its gutters,
  // folded – and clear of the Cesium credit line under it by a good
  // margin (13 px was too close; CARD_SLOT in App.tsx)
  const creditTop = await page.evaluate(
    () => document.querySelector('.cesium-viewer-bottom')!.getBoundingClientRect().top,
  )
  const panel = page.getByTestId('app-title').locator('xpath=ancestor::*[@data-slot="card"]')
  const panelBox = (await panel.boundingBox())!
  expect(panelBox.y).toBeGreaterThan(852 / 2)
  expect(panelBox.width).toBeGreaterThan(360)
  expect(panelBox.y + panelBox.height).toBeCloseTo(852 - 48, 0)
  // 24 px measured (the bar's top is the Cesium ion logo's, 4 px over the
  // edge since index.css pads it); a good margin is what is asked
  expect(creditTop - (panelBox.y + panelBox.height)).toBeGreaterThanOrEqual(20)
  // The bar itself stands 4 px over the bottom edge, 1 more than Cesium's own 3
  const creditBottom = await page.evaluate(() => {
    const bar = document.querySelector('.cesium-viewer-bottom')!
    const rect = bar.getBoundingClientRect()
    return rect.bottom - parseFloat(getComputedStyle(bar).paddingBottom)
  })
  expect(852 - creditBottom).toBeCloseTo(4, 0)
  await expect(page.getByRole('button', { name: 'Expand panel' })).toBeVisible()
  await expect(page.getByText('Traffic')).toBeHidden()
  // Unfolded it stops at a good half of the screen and scrolls inside
  await page.getByRole('button', { name: 'Expand panel' }).click()
  await expect(page.getByText('Traffic')).toBeVisible()
  const open = (await panel.boundingBox())!
  expect(open.height).toBeLessThanOrEqual(852 * 0.55 + 1)
  await page.getByRole('button', { name: 'Collapse panel' }).click()

  // The rail and the readings stand at the top; the desktop-only controls are gone
  const rail = page.getByRole('group', { name: 'View controls' })
  const railBox = (await rail.boundingBox())!
  expect(railBox.y).toBeLessThan(100)
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(393)
  const tabs = page.getByRole('radiogroup', { name: 'View' })
  expect((await tabs.boundingBox())!.y).toBeLessThan(100)
  // The weather, the readings and the rail share one top edge, the phone's
  // 12 px inset – the weather's round button level with the rail's first
  const weatherBox = (await page.getByRole('button', { name: /^Weather/ }).boundingBox())!
  const railButtonBox = (await page.getByTestId('map-rail').getByRole('button').first().boundingBox())!
  expect(weatherBox.y).toBeCloseTo(12, 0)
  expect((await tabs.boundingBox())!.y).toBeCloseTo(weatherBox.y, 0)
  expect(railButtonBox.y).toBeCloseTo(weatherBox.y, 0)
  expect(railButtonBox.height).toBeCloseTo(weatherBox.height, 0)
  // …and so do the popovers that open from the row: the weather's beside
  // its button, the layers' beside the rail's column (hung from its top,
  // LayersPopover's railRef), both on the phone's own edge padding
  // (PHONE_POPOVER_EDGE_PADDING) rather than 4 px under it
  const popover = page.locator('[data-slot="popover-content"]')
  await page.getByRole('button', { name: /^Weather/ }).click()
  await expect(popover).toBeVisible()
  expect((await popover.boundingBox())!.y).toBeCloseTo(weatherBox.y, 0)
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()
  await page.getByRole('button', { name: 'Layers' }).click()
  await expect(popover).toBeVisible()
  const layersBox = (await popover.boundingBox())!
  expect(layersBox.y).toBeCloseTo(weatherBox.y, 0)
  expect(layersBox.x + layersBox.width).toBeLessThanOrEqual(railButtonBox.x)
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()
  await expect(page.getByRole('radio', { name: 'Line diagram' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Photo mode' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeHidden()
  await expect(page.getByRole('button', { name: /^Face (north|east|south|west)$/ })).toBeVisible()

  // A card takes the sheet's place, and the panel leaves while it is up
  await page.evaluate(() => window.__mg3d!.selectVehicle(window.__mg3d!.vehicles()[0].id))
  const card = page.getByTestId('vehicle-card')
  await expect(card).toBeVisible()
  const cardBox = (await card.boundingBox())!
  expect(cardBox.width).toBeGreaterThan(360)
  // At most a good half of the screen high (CARD_SHELL), the map above it
  expect(cardBox.height).toBeLessThanOrEqual(852 * 0.6 + 1)
  // The same foot as the panel's: the two are one sheet
  expect(cardBox.y + cardBox.height).toBeCloseTo(panelBox.y + panelBox.height, 0)
  await expect(panel).toBeHidden()

  // The card's action – the follow – is an icon button in the head on a
  // phone, first in the corner's row before the fold and close buttons
  // (CardShell's action in card-parts.tsx), not the labelled button at
  // the foot of the body it is on a desktop
  const follow = card.getByRole('button', { name: 'Follow tram' })
  const fold = card.getByRole('button', { name: 'Collapse card' })
  const close = card.getByRole('button', { name: 'Close selection' })
  const [followBox, foldBox, closeBox] = await Promise.all(
    [follow, fold, close].map(async (button) => (await button.boundingBox())!),
  )
  expect(followBox.x + followBox.width).toBeLessThanOrEqual(foldBox.x + 1)
  expect(foldBox.x + foldBox.width).toBeLessThanOrEqual(closeBox.x + 1)
  expect(Math.abs(followBox.y - closeBox.y)).toBeLessThan(1)
  expect(followBox.height).toBeLessThanOrEqual(40)

  // The card folds to its head with the panel's fold button (CardHead):
  // the stops go, the head with the line, its termini and the follow
  // stays at the foot, and the map above it grows by what the body took
  const stops = card.getByTestId('vehicle-trip-stops')
  await expect(stops).toBeVisible()
  await fold.click()
  await expect(stops).toBeHidden()
  await expect(follow).toBeVisible()
  await expect(card.getByTestId('vehicle-status')).toBeVisible()
  const folded = (await card.boundingBox())!
  expect(folded.height).toBeLessThan(cardBox.height / 2)
  expect(folded.y + folded.height).toBeCloseTo(cardBox.y + cardBox.height, 0)
  await card.getByRole('button', { name: 'Expand card' }).click()
  await expect(stops).toBeVisible()
  await page.evaluate(() => window.__mg3d!.selectVehicle(null))
  await expect(card).toBeHidden()
  await expect(panel).toBeVisible()

  // The weather keeps its corner while a card is up
  await page.evaluate(() => window.__mg3d!.selectVehicle(window.__mg3d!.vehicles()[0].id))
  await expect(page.getByRole('button', { name: /^Weather/ })).toBeVisible()
  await page.evaluate(() => window.__mg3d!.selectVehicle(null))

  // The About dialog is the whole screen, without the keyboard tab
  await page.getByRole('button', { name: 'About this project' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const dialogBox = (await dialog.boundingBox())!
  expect(dialogBox.x).toBe(0)
  expect(dialogBox.y).toBe(0)
  expect(dialogBox.width).toBe(393)
  expect(dialogBox.height).toBe(852)
  await expect(dialog.getByRole('tab', { name: 'Keyboard' })).toBeHidden()
  await expect(dialog.getByRole('tab', { name: 'The project' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // A link asking for the diagram gets the map
  await page.evaluate(() => window.__mg3d!.setLinear(true))
  expect(await page.evaluate(() => window.__mg3d!.linear())).toBe(false)

  // The credit line fills the width. Cesium writes a credit, its
  // delimiter and the next credit with no whitespace between them, one
  // unbreakable run, and on a phone the line broke inside a credit 60 px
  // short of the edge (index.css makes each delimiter a break
  // opportunity). Three on-screen credits like the live scene's – Windy's
  // two and Google's – put a second line under the Cesium ion logo; each
  // line's leftover has to be narrower than the piece that starts the
  // next line, or that piece would have fitted.
  await page.evaluate(() => {
    const viewer = window.__cesiumViewer as unknown as {
      creditDisplay: {
        constructor: { cesiumCredit: { constructor: new (html: string, showOnScreen: boolean) => unknown } }
        addStaticCredit(credit: unknown): void
      }
      scene: { requestRender(): void }
    }
    const Credit = viewer.creditDisplay.constructor.cesiumCredit.constructor
    for (const html of [
      '<a href="https://www.windy.com/">Webcams: Windy.com</a>',
      '<a href="https://api.windy.com/">Upgrade for commercial use.</a>',
      '<span>Google Maps</span>',
    ]) {
      viewer.creditDisplay.addStaticCredit(new Credit(html, true))
    }
    viewer.scene.requestRender()
  })
  await expect(page.locator('.cesium-viewer-bottom')).toContainText('Google Maps')
  const creditLines = await page.evaluate(() => {
    const bar = document.querySelector('.cesium-viewer-bottom')!.getBoundingClientRect()
    const pieces = document.querySelectorAll(
      '.cesium-viewer-bottom .cesium-credit-wrapper, .cesium-viewer-bottom .cesium-credit-delimiter, .cesium-viewer-bottom .cesium-credit-expand-link',
    )
    const rects = [...pieces].flatMap((el) =>
      [...el.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top })),
    )
    const lines: { top: number; right: number; firstWidth: number }[] = []
    for (const r of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const line = lines.find((l) => Math.abs(l.top - r.top) < 6)
      if (line) line.right = Math.max(line.right, r.right)
      else lines.push({ top: r.top, right: r.right, firstWidth: r.right - r.left })
    }
    // 7 px of padding on the right (index.css), the line's own edge
    return { barRight: bar.right - 7, firstLeft: Math.min(...rects.map((r) => r.left)), lines }
  })
  expect(creditLines.lines.length).toBeGreaterThanOrEqual(2)
  // …and starts 7 px in, 2 more than Cesium's own 5 (index.css)
  expect(creditLines.firstLeft).toBeCloseTo(7, 0)
  for (let i = 1; i < creditLines.lines.length; i++) {
    const leftover = creditLines.barRight - creditLines.lines[i - 1].right
    expect(leftover).toBeLessThan(creditLines.lines[i].firstWidth)
  }

  // A card taller than its cap scrolls in its body under a head that
  // stands (CardBody in card-parts.tsx): the close button and the
  // follow stay in reach however long the stop list. A short screen
  // makes any vehicle card overflow its 60dvh; the card once scrolled
  // as a whole and took its head off the top of the screen.
  await page.setViewportSize({ width: 393, height: 600 })
  await page.evaluate(() => window.__mg3d!.selectVehicle(window.__mg3d!.vehicles()[0].id))
  await expect(card).toBeVisible()
  const body = card.locator('[data-slot="scroll-area-viewport"]').first()
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const head = card.locator('[data-slot="card-header"]')
  const headBefore = (await head.boundingBox())!
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const headAfter = (await head.boundingBox())!
  expect(headAfter.y).toBeCloseTo(headBefore.y, 0)
  expect(headAfter.height).toBeCloseTo(headBefore.height, 0)
  await expect(card.getByRole('button', { name: 'Close selection' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Follow tram' })).toBeVisible()
  expect((await card.boundingBox())!.height).toBeLessThanOrEqual(600 * 0.6 + 1)

  // Where the sheet reaches into the rail's column, the card lies over
  // the controls, not under them (CARD_SLOT's z-20): the point where the
  // two overlap belongs to the card
  const shortCard = (await card.boundingBox())!
  // The whole column – the globe and the About button stand outside the
  // "View controls" group, at its foot, and are the ones the sheet meets
  const shortRail = (await page.getByTestId('map-rail').boundingBox())!
  const overlapTop = Math.max(shortCard.y, shortRail.y)
  const overlapBottom = Math.min(shortCard.y + shortCard.height, shortRail.y + shortRail.height)
  expect(overlapBottom - overlapTop).toBeGreaterThan(20)
  const probe = { x: shortRail.x + shortRail.width / 2, y: (overlapTop + overlapBottom) / 2 }
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="vehicle-card"]') !== null,
      probe,
    ),
  ).toBe(true)
  await page.evaluate(() => window.__mg3d!.selectVehicle(null))
  await page.setViewportSize({ width: 393, height: 852 })
})
