import { expect, test, type Page } from '@playwright/test'

/**
 * Funktionale E2E-Tests gegen die echte App (Cesium via SwiftShader).
 * Die Simulation startet eingefroren um 08:30 → deterministische Zustände.
 *
 * Alle Tests teilen sich eine Page (Cesium-Start unter Software-Rendering ist
 * teuer); der Zustand wird vor jedem Test über die Test-API zurückgesetzt.
 */

declare global {
  interface Window {
    __mrt?: {
      ready: boolean
      tramCount: () => number
      visibleTramCount: () => number
      trams: () => {
        id: string
        lineId: string
        nextStopName: string
        lat: number
        lon: number
      }[]
      setTime: (hhmm: string) => void
      setSpeed: (speed: number) => void
      setPaused: (paused: boolean) => void
      selectTram: (id: string | null) => void
      dataSource: string
      lineIds: () => string[]
      secondsOfDay: () => number
      loopTicks: () => number
      lastLoopError: () => string | null
      tramBoxDriftMeters: () => number
    }
    __cesiumViewer?: {
      camera: {
        positionCartographic: { longitude: number; latitude: number; height: number }
      }
    }
  }
}

test.describe.configure({ mode: 'serial' })

let page: Page

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await page.goto('/?offline=1&time=08:30&paused=1')
  await page.waitForFunction(
    () => window.__mrt?.ready === true && window.__mrt.tramCount() > 0,
    undefined,
    { timeout: 60_000 },
  )
})

test.afterAll(async () => {
  await page.close()
})

test.beforeEach(async () => {
  // Simulationszustand normalisieren
  await page.evaluate(() => {
    window.__mrt!.selectTram(null)
    window.__mrt!.setPaused(true)
    window.__mrt!.setTime('08:30')
    window.__mrt!.setSpeed(1)
  })
  await expect
    .poll(() => page.evaluate(() => window.__mrt!.tramCount()))
    .toBeGreaterThan(0)
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
  await page.evaluate(() => {
    window.__mrt!.setPaused(false)
    window.__mrt!.setSpeed(120)
  })
  await page.waitForTimeout(2000)
  const drift = await page.evaluate(() => window.__mrt!.tramBoxDriftMeters())
  expect(drift).toBeLessThan(5)

  // Und die Boxen bewegen sich tatsächlich (Matrix-Translation ändert sich)
  const posA = await page.evaluate(() => window.__mrt!.trams()[0])
  await page.waitForTimeout(1500)
  const driftAfter = await page.evaluate(() => window.__mrt!.tramBoxDriftMeters())
  const posB = await page.evaluate(() => window.__mrt!.trams()[0])
  expect(driftAfter).toBeLessThan(5)
  expect(posA.lat !== posB.lat || posA.lon !== posB.lon).toBe(true)
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
  await page.getByLabel('Simulationszeit setzen').fill('08:00')
  await expect(page.getByTestId('sim-clock')).toHaveText(/^08:00/)
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

test('„Bahn folgen“ führt die Kamera zur Bahn', async () => {
  // Render-Loop muss laufen (Diagnose: lastLoopError zeigt ggf. die Ursache)
  const ticksBefore = await page.evaluate(() => window.__mrt!.loopTicks())
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => ({
          ticks: window.__mrt!.loopTicks(),
          error: window.__mrt!.lastLoopError(),
        }))
        expect(state.error, `Render-Loop-Fehler: ${state.error}`).toBeNull()
        return state.ticks
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(ticksBefore)

  const tram = await page.evaluate(() => window.__mrt!.trams()[0])
  await page.evaluate((id) => window.__mrt!.selectTram(id), tram.id)
  // force: Playwrights Actionability-Retry kann unter SwiftShader-Last auf dem
  // Canvas landen und damit die Auswahl schließen (Klick auf leere Karte).
  await page.getByRole('button', { name: 'Bahn folgen' }).click({ force: true })
  await expect(page.getByRole('button', { name: 'Verfolgung beenden' })).toBeVisible()

  // Kamera muss sich in die Nähe der (pausierten) Bahn bewegen.
  // Großzügiges Timeout: Unter SwiftShader-Software-Rendering können einzelne
  // Frames sekundenlang dauern, bis die Follow-Kamera greift.
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => {
          const camera = window.__cesiumViewer!.camera.positionCartographic
          const tramNow = window.__mrt!.trams()[0]
          const camLat = (camera.latitude * 180) / Math.PI
          const camLon = (camera.longitude * 180) / Math.PI
          const dLat = (camLat - tramNow.lat) * 110540
          const dLon =
            (camLon - tramNow.lon) * 111320 * Math.cos((tramNow.lat * Math.PI) / 180)
          return {
            dist: Math.hypot(dLat, dLon),
            loopError: window.__mrt!.lastLoopError(),
          }
        })
        // Ein Loop-Fehler nach dem Klick würde das Folgen still verhindern –
        // dann soll der Test die Ursache nennen statt nur die Distanz.
        expect(state.loopError, `Render-Loop-Fehler: ${state.loopError}`).toBeNull()
        return state.dist
      },
      { timeout: 45_000, intervals: [500, 1000] },
    )
    .toBeLessThan(1500)

  await page.getByRole('button', { name: 'Verfolgung beenden' }).click({ force: true })
  await page.getByRole('button', { name: 'Auswahl schließen' }).click({ force: true })
  await expect(page.getByTestId('tram-card')).not.toBeVisible()
})

test('GTFS-Realtime-Endpunkt wird abgeholt und im Panel angezeigt', async ({ browser }) => {
  // Den gefilterten JSON-Endpunkt mocken – verifiziert die Kette
  // fetch → Validierung → Status-Badge im Panel. Die Zweitseite ist eine
  // volle Cesium-Instanz; ohne finally bliebe sie bei einem Fehlschlag bis
  // zum Retry offen und zwei parallele SwiftShader-Kontexte können den
  // Browser auf CI-Runnern zum Absturz bringen.
  const rtPage = await browser.newPage()
  try {
    await rtPage.route('**/api/realtime', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          timestamp: 1700000000,
          total: 42,
          delays: { 'irgendein-trip': 120 },
        }),
      }),
    )
    await rtPage.goto('/?offline=1&rt=1&time=08:30&paused=1')
    await rtPage.waitForFunction(() => window.__mrt?.ready === true)

    const badge = rtPage.getByTestId('rt-status')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('GTFS-RT')
  } finally {
    await rtPage.close()
  }
})

test('Kameraausrichtung wird im URL-Hash gespeichert und wiederhergestellt', async ({
  browser,
}) => {
  // Hash wird spätestens alle 1500 ms aktualisiert
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 5000 })
    .toMatch(/^#lat=[\d.]+&lon=[\d.]+&height=\d+&heading=\d+&pitch=-?\d+$/)

  // Ansicht aus einem Hash wiederherstellen (frische Seite); finally wie im
  // Realtime-Test, damit bei einem Fehlschlag keine zweite Cesium-Seite
  // bis zum Retry offen bleibt.
  const other = await browser.newPage()
  try {
    await other.goto('/?offline=1&time=08:30&paused=1#lat=54.0901&lon=12.1405&height=800&heading=90&pitch=-45')
    await other.waitForFunction(() => window.__mrt?.ready === true)
    const view = await other.evaluate(() => {
      const camera = window.__cesiumViewer!.camera.positionCartographic
      return {
        lat: (camera.latitude * 180) / Math.PI,
        lon: (camera.longitude * 180) / Math.PI,
        height: camera.height,
      }
    })
    expect(view.lat).toBeCloseTo(54.0901, 3)
    expect(view.lon).toBeCloseTo(12.1405, 3)
    expect(view.height).toBeGreaterThan(700)
    expect(view.height).toBeLessThan(900)
  } finally {
    await other.close()
  }
})

test('Pause-Button und Kamera-Reset sind bedienbar', async () => {
  // Ausgangszustand: App wurde mit paused=1 geladen → Button zeigt "fortsetzen"
  await page.getByRole('button', { name: 'Simulation fortsetzen' }).click()
  await expect(page.getByRole('button', { name: 'Simulation pausieren' })).toBeVisible()
  await page.getByRole('button', { name: 'Simulation pausieren' }).click()
  await expect(page.getByRole('button', { name: 'Simulation fortsetzen' })).toBeVisible()
  await page.getByRole('button', { name: 'Kamera zurücksetzen' }).click()
})
