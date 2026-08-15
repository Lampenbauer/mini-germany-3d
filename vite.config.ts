/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// CesiumJS benötigt seine statischen Assets (Workers, Widgets, Assets, ThirdParty)
// unter einer bekannten Basis-URL. scripts/copy-cesium-assets.mjs (postinstall)
// kopiert sie nach public/cesium; CESIUM_BASE_URL zeigt darauf
// (siehe src/map/cesium-base.ts).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 6000,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
})
