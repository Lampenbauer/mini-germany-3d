/**
 * Must run before the first Cesium import (see main.tsx): tells CesiumJS
 * where its static assets live (Workers/Assets/Widgets/ThirdParty – see
 * vite.config.ts).
 */
;(globalThis as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/cesium'

export {}
