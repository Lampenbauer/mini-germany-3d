import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

/**
 * E2E-/Visuelle Tests laufen komplett offline (?offline=1):
 * Cesium rendert dann einen Gitter-Globus statt Google 3D Tiles, sodass die
 * Tests deterministisch und ohne Netzwerkzugriff funktionieren.
 *
 * WebGL im Headless-Chromium wird über SwiftShader (Software-Rendering)
 * bereitgestellt.
 */

// In manchen Umgebungen (z.B. Claude-Code-Container) liegt ein passendes
// Chromium bereits unter /opt/pw-browsers – dann kein Download nötig.
const preinstalledChromium = '/opt/pw-browsers/chromium'

export default defineConfig({
  testDir: './e2e',
  // Seit Bussen/Fähren simuliert die Suite ~350 Fahrzeuge – unter SwiftShader
  // auf ausgelasteten CI-Runnern dauert ein einzelner Frame dadurch Sekunden.
  timeout: 180_000,
  fullyParallel: false,
  // Jede Spec mit Cesium bleibt in einem eigenen, sequenziellen SwiftShader-
  // Kontext. Mehrere Worker würden die ressourcenintensiven WebGL-Seiten
  // wieder parallel ausführen.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  expect: {
    // Sim-Uhr/Badges aktualisieren erst mit dem nächsten Loop-Tick – der kann
    // unter CI-Last mehrere Sekunden brauchen.
    timeout: 30_000,
    toHaveScreenshot: {
      // Software-Rendering + Font-Antialiasing variieren leicht zwischen
      // Umgebungen – kleine Abweichungen sind ok.
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
