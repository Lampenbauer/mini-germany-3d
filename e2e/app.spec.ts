import { expect, test, type Page } from '@playwright/test'

/**
 * Funktionale E2E-Tests gegen die echte App (Cesium via SwiftShader).
 * Die Simulation startet eingefroren um 08:30 → deterministische Zustände.
 *
 * Alle Tests teilen sich eine Page (Cesium-Start unter Software-Rendering ist
 * teuer); der Zustand wird vor jedem Test über die Test-API zurückgesetzt.
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
  // Simulationszustand normalisieren
  await page.evaluate(() => {
    window.__mrt!.selectTram(null)
    window.__mrt!.setPaused(true)
    window.__mrt!.setSpeed(1)
    window.__mrt!.setTime('08:30')
  })

  const timeInput = page.getByLabel('Simulationszeit setzen')
  await timeInput.fill('')
  await expect(timeInput).toHaveValue('')
  await expect.poll(tramSnapshotSignature).toBe(snapshotsAt0830)
  await expect(page.getByTestId('sim-clock')).toHaveText('08:30:00')
})

test('lädt die App mit Karte und Control-Panel', async () => {
  await expect(page).toHaveTitle('Mini Rostock 3D')
  await expect(page.getByText('Mini Rostock 3D')).toBeVisible()
  await expect(page.getByText('Straßenbahnnetz der RSAG – Fahrplansimulation')).toBeVisible()
  await expect(page.locator('[data-testid=cesium-container] canvas')).toBeVisible()
  await expect(page.getByTestId('tileset-status')).toHaveText('Offline-Modus')
  const source = await page.evaluate(() => window.__mrt!.dataSource)
  await expect(page.getByTestId('data-source')).toHaveText(
    source === 'osm' ? 'OSM-Geometrie' : 'Demo-Daten (approximiert)',
  )
})

test('zeigt die eingefrorene Simulationszeit 08:30', async () => {
  await expect(page.getByTestId('sim-clock')).toHaveText('08:30:00')
})

test('zeigt aktive Bahnen auf allen Linien des Netzes', async () => {
  const expected = await page.evaluate(() => window.__mrt!.lineIds())
  const activeLineIds = await page.evaluate(() => [
    ...new Set(window.__mrt!.trams().map((t) => t.lineId)),
  ])
  expect(activeLineIds.sort()).toEqual(expected.sort())

  await expect(page.getByTestId('tram-count')).toContainText(/\d+ Bahnen unterwegs/)
  const count = await page.evaluate(() => window.__mrt!.visibleTramCount())
  await expect(page.getByTestId('tram-count')).toContainText(`${count} Bahnen unterwegs`)
})

test('Linien-Switch blendet Bahnen der Linie aus', async () => {
  const before = await page.evaluate(() => window.__mrt!.visibleTramCount())
  await page.getByRole('switch', { name: 'Linie 1 anzeigen' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleTramCount()))
    .toBeLessThan(before)
  await page.getByRole('switch', { name: 'Linie 1 anzeigen' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.visibleTramCount()))
    .toBe(before)
})

test('Auswahl einer Bahn öffnet die Info-Karte', async () => {
  const tram = await page.evaluate(() => window.__mrt!.trams()[0])
  await page.evaluate((id) => window.__mrt!.selectTram(id), tram.id)

  const card = page.getByTestId('tram-card')
  await expect(card).toBeVisible()
  await expect(card.getByTestId('tram-next-stop')).toHaveText(tram.nextStopName)
  await expect(card.getByRole('button', { name: 'Bahn folgen' })).toBeVisible()

  await card.getByRole('button', { name: 'Auswahl schließen' }).click()
  await expect(card).not.toBeVisible()
})

test('nachts fahren keine Bahnen, morgens wieder', async () => {
  // 02:30: sicher vor der ersten Abfahrt (real wie synthetisch)
  await page.evaluate(() => window.__mrt!.setTime('02:30'))
  await expect.poll(() => page.evaluate(() => window.__mrt!.tramCount())).toBe(0)
  await expect(page.getByTestId('tram-count')).toContainText('0 Bahnen unterwegs')

  await page.evaluate(() => window.__mrt!.setTime('08:30'))
  await expect.poll(() => page.evaluate(() => window.__mrt!.tramCount())).toBeGreaterThan(0)
})

test('Wagenkästen folgen der Simulation (kein Einfrieren/Zurückbleiben)', async () => {
  // Regressionstest: Die Box-Primitives müssen den Label-Positionen exakt
  // folgen. (Ein Klon-Fehler der modelMatrix bzw. verhungernde
  // Geometrie-Neubauten ließen die Boxen früher an der Spawn-Position stehen.)
  // Keine festen Wartezeiten: Headless-Runner drosseln rAF teils unter 1 Hz,
  // eine 1,5-s-Schlafpause garantiert dort keinen einzigen Simulations-Tick.
  // Stattdessen auf beobachtete Bewegung pollen und danach den Box-Drift
  // messen – bei eingefrorenen Boxen wächst er bei Tempo 120 binnen
  // Sekunden auf hunderte Meter.
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
              // Bei ×120 kann die Fahrt binnen Sekunden am Endpunkt ankommen
              // und aus der Liste verschwinden – auch das belegt Bewegung.
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

test('Zeitraffer bewegt die Bahnen', async () => {
  const before = await page.evaluate(() =>
    JSON.stringify(window.__mrt!.trams().map((x) => x.id)),
  )
  await page.evaluate(() => {
    window.__mrt!.setPaused(false)
    window.__mrt!.setSpeed(300)
  })
  // Nach ein paar Sekunden ×300 müssen sich die aktiven Fahrten geändert haben
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

test('Uhrzeit lässt sich setzen und auf Echtzeit zurückstellen', async () => {
  // fill + einmaliges 15-s-Expect ist unter CI-Last zu knapp: Ein einzelner
  // Loop-Tick kann dort Sekunden dauern, und vereinzelt geht das Change-Event
  // des Zeit-Inputs verloren. Deshalb den (idempotenten) fill im Poll
  // wiederholen, bis die Uhr den Wert übernommen hat.
  const timeInput = page.getByLabel('Simulationszeit setzen')
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

  await page.getByRole('button', { name: 'Jetzt' }).click()
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

test('Pause-Button und Kamera-Reset sind bedienbar', async () => {
  // Ausgangszustand: App wurde mit paused=1 geladen → Button zeigt "fortsetzen"
  await page.getByRole('button', { name: 'Simulation fortsetzen' }).click()
  await expect(page.getByRole('button', { name: 'Simulation pausieren' })).toBeVisible()
  await page.getByRole('button', { name: 'Simulation pausieren' }).click()
  await expect(page.getByRole('button', { name: 'Simulation fortsetzen' })).toBeVisible()
  await page.getByRole('button', { name: 'Kamera zurücksetzen' }).click()
})
