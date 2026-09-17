#!/usr/bin/env node
/**
 * Generates the procedural transport models into public/models/*.glb.
 *
 *   npm run models:build
 *
 * The GLBs are committed (like the generated network data), so a normal
 * checkout needs neither this script nor a build step – it exists to
 * regenerate the fleet after editing scripts/lib/vehicle-fleet.mjs,
 * bus-model.mjs, vessel-fleet.mjs, aircraft-fleet.mjs or buoy-fleet.mjs.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLEET } from './lib/vehicle-fleet.mjs'
import { VESSELS } from './lib/vessel-fleet.mjs'
import { AIRCRAFT } from './lib/aircraft-fleet.mjs'
import { BUOYS } from './lib/buoy-fleet.mjs'
import { toGlb, triangleCount } from './lib/vehicle-mesh.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '../public/models')

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, build] of Object.entries({ ...FLEET, ...VESSELS, ...AIRCRAFT, ...BUOYS })) {
  const mesh = build()
  const glb = toGlb(mesh, { name })
  const path = resolve(OUT_DIR, `${name}.glb`)
  writeFileSync(path, glb)
  console.log(
    `✅ ${name}.glb: ${triangleCount(mesh)} triangles, ${(glb.byteLength / 1024).toFixed(1)} kB`,
  )
}
