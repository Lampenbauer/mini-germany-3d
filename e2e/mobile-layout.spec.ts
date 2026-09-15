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
  // margin (the user found 13 px too close; CARD_SLOT in App.tsx)
  const creditTop = await page.evaluate(
    () => document.querySelector('.cesium-viewer-bottom')!.getBoundingClientRect().top,
  )
  const panel = page.getByTestId('app-title').locator('xpath=ancestor::*[@data-slot="card"]')
  const panelBox = (await panel.boundingBox())!
  expect(panelBox.y).toBeGreaterThan(852 / 2)
  expect(panelBox.width).toBeGreaterThan(360)
  expect(panelBox.y + panelBox.height).toBeCloseTo(852 - 48, 0)
  expect(creditTop - (panelBox.y + panelBox.height)).toBeGreaterThanOrEqual(24)
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
  await page.evaluate(() => window.__mg3d!.selectVehicle(null))
  await page.setViewportSize({ width: 393, height: 852 })
})
