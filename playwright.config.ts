import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

/**
 * E2E/visual tests run fully offline (?offline=1):
 * Cesium then renders a grid globe instead of Google 3D Tiles, so the tests
 * work deterministically and without network access.
 *
 * WebGL in headless Chromium is provided via SwiftShader (software
 * rendering).
 */

// In some environments (e.g. Claude Code containers) a suitable Chromium
// already exists under /opt/pw-browsers – then no download is needed.
const preinstalledChromium = '/opt/pw-browsers/chromium'

export default defineConfig({
  testDir: './e2e',
  // Since buses/ferries were added, the suite simulates ~350 vehicles –
  // under SwiftShader on busy CI runners a single frame therefore takes seconds.
  timeout: 180_000,
  fullyParallel: false,
  // Each spec using Cesium stays in its own, sequential SwiftShader
  // context. Multiple workers would run the resource-intensive WebGL pages
  // in parallel again.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  expect: {
    // Sim clock/badges only update with the next loop tick – which can
    // take several seconds under CI load.
    timeout: 30_000,
    toHaveScreenshot: {
      // Software rendering + font antialiasing vary slightly between
      // environments – small deviations are ok.
      maxDiffPixelRatio: 0.05,
    },
  },
  use: {
    baseURL: 'http://localhost:5199',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-gpu-sandbox'],
      ...(existsSync(preinstalledChromium) && !process.env.CI
        ? { executablePath: preinstalledChromium }
        : {}),
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
