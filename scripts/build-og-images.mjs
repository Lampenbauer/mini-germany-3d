#!/usr/bin/env node
/**
 * The link previews: a 1200×630 PNG per city – two where the city's name
 * differs between the languages (Cologne/Köln), one otherwise – and one
 * for the front door, into public/og/. The pages name them by the rule
 * in ogImagePath (src/lib/site-pages.ts), and tests/site-pages.test.ts
 * checks every page's picture is there – so a new city means running
 * this once more and committing what it draws.
 *
 * Committed rather than drawn in CI on purpose: the picture carries
 * text, and text rendering depends on the fonts of the machine that
 * draws it. The SVG asks for Inter, the app's own face, and takes the
 * system's sans-serif where it is not installed.
 *
 * Usage: node scripts/build-og-images.mjs
 */

import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { CITIES } from '../src/cities/definitions.ts'
import { localizeCityName, setLanguage } from '../src/lib/i18n.ts'

const OUT_DIR = fileURLToPath(new URL('../public/og/', import.meta.url))
const WIDTH = 1200
const HEIGHT = 630

// The app's greens and inks (index.css, NetworkIllustration.tsx), as hex –
// librsvg reads no oklch().
const BRAND = '#143b36'
const BRAND_LIGHT = '#5ee0c0'
const INK = '#f0f7f3'
const INK_MUTED = '#b5d9cf'
const GRID = '#dff5ed'
const AMBER = '#ecba73'
const BLUE = '#7caee8'
const PLATE = '#f3faf6'
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif"

/** The About dialog's small imaginary network, drawn large on the right. */
function illustration() {
  return (
    `<g transform="translate(560 40) scale(2.6)" opacity=".9">` +
    `<g stroke="${GRID}" stroke-width="1" opacity=".12">` +
    `<path d="M0 45H280M0 85H280M0 125H280M0 165H280M0 205H280M40 0V220M80 0V220M120 0V220M160 0V220M200 0V220M240 0V220" />` +
    `</g>` +
    `<g fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M-15 172H70Q88 172 101 159L183 77Q196 64 214 64H300" stroke="${BRAND_LIGHT}" />` +
    `<path d="M62 -15V55Q62 72 75 85L154 164Q167 177 186 177H296" stroke="${AMBER}" />` +
    `<path d="M-10 103H94Q111 103 124 116L183 175Q196 188 196 207V235" stroke="${BLUE}" />` +
    `</g>` +
    `<g fill="${BRAND}" stroke="${GRID}" stroke-width="3">` +
    `<circle cx="30" cy="172" r="5" /><circle cx="214" cy="64" r="5" />` +
    `<circle cx="62" cy="32" r="5" /><circle cx="235" cy="177" r="5" />` +
    `<circle cx="37" cy="103" r="5" /><circle cx="196" cy="214" r="5" />` +
    `<circle cx="119" cy="128" r="9" /><circle cx="165" cy="158" r="7" />` +
    `</g>` +
    `<g transform="translate(167 92) rotate(-45)">` +
    `<rect x="-17" y="-8" width="34" height="16" rx="6" fill="${PLATE}" stroke="${BRAND}" stroke-width="2" />` +
    `<path d="M-7 -4V4M0 -4V4M7 -4V4" stroke="${BRAND}" stroke-width="3" />` +
    `</g></g>`
  )
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The picture: the green, the network fading in from the right, an eyebrow and the title. */
function svg(eyebrow, title) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
    `<defs><linearGradient id="fade" x1="0" x2="1" y1="0" y2="0">` +
    `<stop offset="0" stop-color="${BRAND}" stop-opacity="1" />` +
    `<stop offset=".55" stop-color="${BRAND}" stop-opacity=".92" />` +
    `<stop offset="1" stop-color="${BRAND}" stop-opacity="0" />` +
    `</linearGradient></defs>` +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${BRAND}" />` +
    illustration() +
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#fade)" />` +
    `<circle cx="88" cy="266" r="7" fill="${BRAND_LIGHT}" />` +
    `<text x="108" y="274" font-family="${FONT}" font-size="24" font-weight="600" letter-spacing="4" fill="${INK_MUTED}">${escapeXml(eyebrow.toUpperCase())}</text>` +
    `<text x="80" y="366" font-family="${FONT}" font-size="76" font-weight="700" letter-spacing="-2" fill="${INK}">${escapeXml(title)}</text>` +
    `</svg>`
  )
}

async function draw(file, eyebrow, title) {
  await sharp(Buffer.from(svg(eyebrow, title)))
    .png({ compressionLevel: 9, palette: true })
    .toFile(OUT_DIR + file)
  console.log(`${file}: ${title}`)
}

mkdirSync(OUT_DIR, { recursive: true })
await draw('home.png', 'minigermany3d.com', 'Mini Germany 3D')
for (const city of CITIES) {
  const names = {}
  for (const lang of ['de', 'en']) {
    setLanguage(lang)
    names[lang] = localizeCityName(city.slug, city.name)
  }
  if (names.de === names.en) {
    await draw(`${city.slug}.png`, 'Mini Germany 3D', `Mini ${names.de} 3D`)
  } else {
    for (const lang of ['de', 'en']) {
      await draw(`${city.slug}.${lang}.png`, 'Mini Germany 3D', `Mini ${names[lang]} 3D`)
    }
  }
}
