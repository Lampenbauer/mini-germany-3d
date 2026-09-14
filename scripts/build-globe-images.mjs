#!/usr/bin/env node
/**
 * The pictures on the globe of the map's control rail
 * (src/components/GlobeIllustration.tsx): every city from above, three
 * times, from Mapbox's Static Images API – the satellite picture, and
 * the light and the dark street map – into public/globe/. The globe
 * shows the city on the map in the look of the ground a click on it
 * brings: the street map while Google's tiles are up (light by day,
 * dark at night), the satellite picture on the flat map (see MapRail in
 * App.tsx); a city switch crossfades to the next city's pictures.
 *
 * One request per picture, by hand: a 400 × 400 frame at @2x, centred
 * on the city limits and zoomed so that they fill the disc the
 * component clips it to, with Mapbox's logo and attribution overlay
 * left off – the credit stands in the map's credit list instead
 * (CesiumMap.addGlobeCredit), where an 84 px disc could not carry it.
 * Downscaled to GLOBE_IMAGE_PX and written as WebP, a few tens of
 * kilobytes each, and committed: the pictures do not change, and a rail
 * button must not wait for a network. Mapbox counts the requests
 * against the account's Static Images allowance; a rerun is byte-stable
 * as long as the styles are. A new city needs a run of this, and
 * tests/globe-illustration.test.tsx fails until it has one.
 *
 * Needs the unrestricted Mapbox token (VITE_MAPBOX_TOKEN in .env – the
 * deploy's is locked to the site's domain and refuses a script).
 *
 * Usage: node scripts/build-globe-images.mjs [slug …]   (all cities without arguments)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { CITIES } from '../src/cities/definitions.ts'

const OUT_DIR = fileURLToPath(new URL('../public/globe/', import.meta.url))
const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url))

/** The frame asked for (rendered at @2x), and the size the pictures are kept at. */
const FRAME_PX = 400
export const GLOBE_IMAGE_PX = 256
/**
 * Zoom levels below the one that fits the city limits into the frame
 * edge to edge: a margin of the surroundings, and the disc's edge
 * clear of the limits.
 */
const ZOOM_MARGIN = 0.25

/** The three pictures: which Mapbox style each is drawn from. */
export const GLOBE_IMAGES = {
  satellite: 'mapbox/satellite-v9',
  light: 'mapbox/light-v11',
  dark: 'mapbox/dark-v11',
}

/**
 * The centre and zoom that put a city's limits into the frame: the
 * Static Images API tiles the world in 512 px at zoom 0, so a frame of
 * FRAME_PX spans 360° × FRAME_PX / 512 of longitude at zoom 0 and half
 * that with every level; the latitude span is stretched by the
 * Mercator factor at the city.
 */
export function frameFor(city) {
  const b = city.cityBounds
  const latitude = (b.south + b.north) / 2
  const longitude = (b.west + b.east) / 2
  const spanLon = b.east - b.west
  const spanLat = (b.north - b.south) / Math.cos((latitude * Math.PI) / 180)
  const zoom = Math.log2((360 * FRAME_PX) / (512 * Math.max(spanLon, spanLat))) - ZOOM_MARGIN
  return { longitude: Math.round(longitude * 1e4) / 1e4, latitude: Math.round(latitude * 1e4) / 1e4, zoom: Math.round(zoom * 100) / 100 }
}

function token() {
  const fromEnv = process.env.VITE_MAPBOX_TOKEN
  if (fromEnv) return fromEnv
  try {
    const match = /^VITE_MAPBOX_TOKEN=(.+)$/m.exec(readFileSync(ENV_FILE, 'utf8'))
    if (match) return match[1].trim()
  } catch {
    // no .env
  }
  throw new Error('VITE_MAPBOX_TOKEN is not set (env or .env)')
}

const accessToken = token()
mkdirSync(OUT_DIR, { recursive: true })
const wanted = process.argv.slice(2)
const cities = wanted.length > 0 ? CITIES.filter((c) => wanted.includes(c.slug)) : CITIES

for (const city of cities) {
  const { longitude, latitude, zoom } = frameFor(city)
  for (const [name, style] of Object.entries(GLOBE_IMAGES)) {
    const url =
      `https://api.mapbox.com/styles/v1/${style}/static/` +
      `${longitude},${latitude},${zoom},0,0/${FRAME_PX}x${FRAME_PX}@2x` +
      `?logo=false&attribution=false&access_token=${accessToken}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${city.slug} ${name}: ${response.status} ${await response.text()}`)
    const picture = Buffer.from(await response.arrayBuffer())
    const webp = await sharp(picture)
      .resize(GLOBE_IMAGE_PX, GLOBE_IMAGE_PX, { kernel: 'lanczos3' })
      .webp({ quality: 88, effort: 6 })
      .toBuffer()
    const file = `${OUT_DIR}${city.slug}-${name}.webp`
    writeFileSync(file, webp)
    console.log(`${city.slug} ${name} (zoom ${zoom}): ${webp.length} bytes`)
  }
}
