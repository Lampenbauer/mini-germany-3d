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

  // The panel: a sheet at the foot, as wide as the screen less its gutters, folded
  const panel = page.getByTestId('app-title').locator('xpath=ancestor::*[@data-slot="card"]')
  const panelBox = (await panel.boundingBox())!
  expect(panelBox.y).toBeGreaterThan(852 / 2)
  expect(panelBox.width).toBeGreaterThan(360)
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(852 - 30)
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
  expect(cardBox.y).toBeGreaterThan(852 * 0.35)
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(852 - 30)
  await expect(panel).toBeHidden()
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
})
