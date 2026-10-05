#!/usr/bin/env node
/**
 * The README's screenshots, taken from the live site in a headed Chromium –
 * on the real GPU, not SwiftShader: the night grade, the tilt-shift passes
 * and Google's fine tiles are what the pictures are for, and software
 * rendering answers the tile requests with 429s. Every view is loaded with
 * the simulation running, which is paused one second after the app is up
 * (the user's call: a second of playback, then the vehicles stay where
 * they are), waits for the tileset to settle and is shot with the
 * interface on – the panel and the cards are part of the picture. The
 * PNGs go to the output folder; they are downscaled to 2400 px and saved
 * as JPEG into docs/screenshots by hand
 * (`sips -s format jpeg -s formatOptions 82 --resampleWidth 2400 …`).
 *
 *   node scripts/build-readme-screenshots.mjs [out-dir] [name …] [name=url …]
 *
 * Without names every view in SHOTS is taken; a `name=url` argument adds a
 * view of its own – the way to follow an aircraft that is over the city
 * right now (`#aircraft=<hex>`, the hex from /api/aircraft?city=frankfurt),
 * since the one in a saved link has long landed.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const SITE = 'https://minigermany3d.com'

/** The views in the README, in its order. */
const SHOTS = [
  ['hamburg-harbour', `${SITE}/en/hamburg/?lang=en#lat=53.467681&lon=10.019491&height=6648&heading=339&pitch=-35&weather=live&clouds=1`],
  ['rostock-dawn-trams', `${SITE}/en/rostock/?lang=en#lat=54.086873&lon=12.120724&height=227&heading=44&pitch=-37&weather=live&clouds=1&tiltshift=1&blur=0.008&band=0.25&time=06:04`],
  ['rostock-dawn-sbahn', `${SITE}/en/rostock/?lang=en#lat=54.080148&lon=12.118532&height=182&heading=51&pitch=-29&weather=live&clouds=1&tiltshift=1&blur=0.008&band=0.25&time=06:04`],
  ['hamburg-ships', `${SITE}/en/hamburg/?lang=en#lat=53.533011&lon=9.889844&height=810&heading=98&pitch=-22&webcams=0&weather=live&clouds=1&tiltshift=1&blur=0.008&band=0.25&time=10:04`],
  ['kiel-ferry', `${SITE}/en/kiel/?lang=en#lat=54.364243&lon=10.128145&height=227&heading=75&pitch=-11&webcams=0&weather=live&clouds=1&tiltshift=1&blur=0.008&band=0.25&time=17:23`],
  ['rostock-night', `${SITE}/en/rostock/?lang=en#lat=54.167983&lon=12.112000&height=1039&heading=314&pitch=-27&webcams=0&weather=live&tiltshift=1&fov=31&blur=0.008&band=0.28&date=2026-10-04&time=19:55`],
  ['rostock-diagram', `${SITE}/en/rostock/?lang=en#lat=54.129500&lon=12.127400&height=28849&heading=0&pitch=-90&view=linear&weather=live&clouds=1`],
  ['cologne-flat', `${SITE}/en/cologne/?lang=en#lat=50.915323&lon=6.951634&height=3627&heading=1&pitch=-53&basemap=flat&weather=live&time=16:00`],
  // frankfurt-aircraft: pass `frankfurt-aircraft=${SITE}/en/frankfurt/?lang=en#aircraft=<hex>&webcams=0&weather=live&clouds=1&tiltshift=1&fov=38&blur=0.008&band=0.28`
]

const args = process.argv.slice(2)
const out = args[0] && !args[0].includes('=') && !SHOTS.some(([name]) => name === args[0]) ? args.shift() : 'docs/screenshots/raw'
const only = args.filter((a) => !a.includes('='))
for (const a of args.filter((a) => a.includes('='))) {
  const i = a.indexOf('=')
  SHOTS.push([a.slice(0, i), a.slice(i + 1)])
  only.push(a.slice(0, i))
}
mkdirSync(out, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `fn` in the page until it has been true `held` times in a row. */
async function waitFor(page, fn, { timeout = 150_000, every = 500, held = 1 } = {}) {
  const start = Date.now()
  let ok = 0
  while (Date.now() - start < timeout) {
    let value = false
    try {
      value = await page.evaluate(fn)
    } catch {
      value = false
    }
    ok = value ? ok + 1 : 0
    if (ok >= held) return true
    await sleep(every)
  }
  return false
}

const browser = await chromium.launch({ headless: false, args: ['--window-size=1500,1000', '--hide-scrollbars'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'en-US' })
const page = await context.newPage()
page.on('pageerror', (error) => console.log('  pageerror', error.message))

for (const [name, link] of SHOTS) {
  if (only.length && !only.includes(name)) continue
  const url = link
  console.log(`\n== ${name}`)
  const started = Date.now()
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`
  await page.goto('about:blank')
  await page.goto(url, { waitUntil: 'load' })
  // A second of playback, then the pause – and only then the long waits.
  await waitFor(page, () => !!window.__mg3d?.ready, { timeout: 60_000, every: 200 })
  await sleep(1000)
  await page.evaluate(() => window.__mg3d.setPaused(true))
  await waitFor(page, () => ['google-3d-tiles', 'flat'].includes(window.__mg3d.tilesetStatus()), { timeout: 60_000 })
  console.log('  tileset', await page.evaluate(() => window.__mg3d.tilesetStatus()), elapsed())
  // Google's tiles in and stable for ~3 s (the flat map: its imagery).
  const loaded = await waitFor(
    page,
    () => {
      const scene = window.__cesiumViewer.scene
      if (window.__mg3d.tilesetStatus() === 'flat') return scene.globe.tilesLoaded
      const primitives = scene.primitives
      for (let i = 0; i < primitives.length; i++) {
        const primitive = primitives.get(i)
        if (primitive && primitive.statistics && 'tilesLoaded' in primitive) {
          return (
            primitive.tilesLoaded &&
            primitive.statistics.numberOfTilesWithContentReady > 50 &&
            !window.__mg3d.renderPacing().tilesLoading
          )
        }
      }
      return false
    },
    { held: 6 },
  )
  console.log('  tiles loaded', loaded, elapsed())
  if (url.includes('view=linear')) await waitFor(page, () => window.__mg3d.linear(), { timeout: 60_000 })
  if (url.includes('#aircraft=')) {
    const found = await waitFor(page, () => location.hash.includes('aircraft='), { timeout: 40_000 })
    if (!found) console.log('  the aircraft is not over the city any more – pick another hex')
  }
  // The fleets' models and the ships' hulls come in after the tiles.
  await sleep(12_000)
  console.log(
    '  ',
    JSON.stringify(
      await page.evaluate(() => ({
        vehicles: window.__mg3d.vehicleCount(),
        ships: window.__mg3d.aisVesselCount(),
        aircraft: window.__mg3d.aircraftCount(),
        error: window.__mg3d.lastLoopError(),
        hash: location.hash,
      })),
    ),
  )
  // The rail fades after ten seconds without a pointer; a movement brings it back.
  await page.mouse.move(720, 450)
  await page.mouse.move(700, 440)
  await sleep(1500)
  await page.screenshot({ path: `${out}/${name}.png`, type: 'png' })
  console.log('  done', elapsed())
}
await browser.close()
