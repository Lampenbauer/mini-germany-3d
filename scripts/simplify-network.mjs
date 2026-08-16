#!/usr/bin/env node
/**
 * Post-processes src/data/network.json in place: simplifies all direction
 * paths (Douglas–Peucker, default 0.3 m tolerance) and rounds coordinates
 * to 6 decimal places (~11 cm). Visually lossless, but shrinks the data
 * chunk and speeds up network preparation at startup.
 *
 *   npm run data:simplify
 *
 * Environment variables:
 *   NETWORK_OUT           – alternative network.json path
 *   SIMPLIFY_TOLERANCE_M  – tolerance in meters (default 0.3)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compactPath, DEFAULT_TOLERANCE_M } from './lib/simplify.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.NETWORK_OUT
  ? resolve(process.env.NETWORK_OUT)
  : resolve(__dirname, '../src/data/network.json')
const TOLERANCE = Number(process.env.SIMPLIFY_TOLERANCE_M) || DEFAULT_TOLERANCE_M

const network = JSON.parse(readFileSync(FILE, 'utf8'))

let before = 0
let after = 0
for (const line of network.lines) {
  for (const dir of line.directions) {
    before += dir.path.length
    dir.path = compactPath(dir.path, TOLERANCE)
    after += dir.path.length
  }
}
for (const stop of Object.values(network.stops)) {
  stop.coord = [Number(stop.coord[0].toFixed(6)), Number(stop.coord[1].toFixed(6))]
}

writeFileSync(FILE, JSON.stringify(network, null, 2) + '\n', 'utf8')
console.log(
  `✅ ${FILE}: path points ${before} → ${after} ` +
    `(-${(100 - (after / before) * 100).toFixed(1)} %, tolerance ${TOLERANCE} m)`,
)
console.log('Tip: npm test validates the simplified dataset.')
