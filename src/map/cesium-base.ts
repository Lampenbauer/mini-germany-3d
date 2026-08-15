/**
 * Muss vor dem ersten Cesium-Import ausgeführt werden (siehe main.tsx):
 * teilt CesiumJS mit, wo seine statischen Assets liegen
 * (Workers/Assets/Widgets/ThirdParty – siehe vite.config.ts).
 */
;(globalThis as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/cesium'

export {}
