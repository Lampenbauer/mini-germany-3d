#!/usr/bin/env node
/**
 * Kopiert die statischen CesiumJS-Assets (Workers, Widgets, Assets, ThirdParty)
 * nach public/cesium – von dort werden sie im Dev-Server und im Build unter
 * /cesium ausgeliefert (siehe CESIUM_BASE_URL in src/map/cesium-base.ts).
 *
 * Läuft automatisch als postinstall-Hook.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = resolve(__dirname, '../node_modules/cesium/Build/Cesium')
const target = resolve(__dirname, '../public/cesium')

if (!existsSync(source)) {
  console.error('❌ node_modules/cesium/Build/Cesium nicht gefunden – erst `npm install` ausführen.')
  process.exit(1)
}

mkdirSync(target, { recursive: true })
for (const dir of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) {
  cpSync(resolve(source, dir), resolve(target, dir), { recursive: true })
}
writeFileSync(
  resolve(target, '.gitkeep-note.txt'),
  'Dieses Verzeichnis wird von scripts/copy-cesium-assets.mjs erzeugt (postinstall) und ist nicht eingecheckt.\n',
)
console.log(`✅ Cesium-Assets nach ${target} kopiert`)
