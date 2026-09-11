/**
 * What a device can afford to draw. Every number the renderer was tuned
 * with – the shadow map, the multisampling, the tile budget, how far out
 * a vehicle body is drawn – was measured on a desktop GPU with gigabytes
 * of texture memory (see CLAUDE.md, "Rendering and performance"), and a
 * phone has neither the fill rate nor the memory for them: a 16384²
 * shadow texture alone is a gigabyte, more than a mid-range phone gives
 * a tab in total. So the map takes its numbers from a profile, and the
 * profile follows the device tier.
 *
 * Two tiers, deliberately no more: `desktop` is every number as it was,
 * `mobile` is a phone or a small tablet – a touch screen whose shorter
 * side is under MOBILE_MAX_SHORT_SIDE_PX, or any device that reports
 * little memory. A big touch tablet counts as a desktop: it has the
 * screen for the fine tiles and, as a rule, the GPU. `?tier=mobile` and
 * `?tier=desktop` override the reading, for measuring one profile on
 * the other's hardware.
 *
 * Pure – tested in tests/render-profile.test.ts; App.tsx reads the
 * browser once and hands the profile to CesiumMap.
 */

export type DeviceTier = 'desktop' | 'mobile'

/** What the tier is read from – a slice of navigator and screen. */
export interface DeviceReading {
  /** navigator.maxTouchPoints – 0 on a desktop without a touch screen. */
  maxTouchPoints: number
  /** screen.width / screen.height in CSS pixels, either order. */
  screenWidth: number
  screenHeight: number
  /** navigator.deviceMemory in GB (Chrome only, capped at 8); undefined elsewhere. */
  deviceMemoryGb: number | undefined
}

export interface RenderProfile {
  tier: DeviceTier
  /**
   * One shadow cascade's side in texels; the texture Cesium allocates is
   * twice this on each side (four cascades packed 2×2). 8192 is a
   * gigabyte, the desktop's deliberate choice for the edge; 2048 is 64 MB,
   * and a phone's screen is small enough that the coarser edge reads.
   */
  shadowMapSize: number
  /** Multisampling; 1 turns the multisample path off entirely. */
  msaaSamples: number
  /**
   * The device pixel ratio the drawing buffer follows, at most. Phones
   * report 3× and would draw nine times the pixels of a 1× screen for a
   * sharpness the fill rate cannot pay for; 1.5× keeps text readable.
   */
  maxPixelRatio: number
  /**
   * Tile LOD budget in CSS pixels (scaled by the pixel ratio in
   * CesiumMap). Coarser tiles on a phone: each step of the error is a
   * quarter of the tile data less, and the screen is too small to miss it.
   */
  tileSseCssPx: number
  /** Tile content cache and its overflow, in MB. */
  tileCacheMb: number
  tileOverflowMb: number
  /**
   * How many tiles the tree may hold before a fresh tileset replaces it
   * (see CesiumMap.replaceTileset). Scaled with the cache: a phone's
   * heap is a fraction of a desktop's.
   */
  tileTreeLimit: number
  /**
   * How far out a vehicle's body is drawn, in metres at the reference
   * lens (see VehicleLayer). The bodies are the frame's CPU cost – Berlin's
   * morning fleet at 13 ms of Model updates – and a phone has one core's
   * worth of that budget, so the range ends nearer.
   */
  vehicleBodyRangeM: number
  /** Cap on the rain drop pool; undefined leaves the overlay's own default. */
  maxRainDrops: number | undefined
  /**
   * Whether the ships under way trail exhaust (see map/FunnelSmoke.ts):
   * a translucent plume per ship, cheap on a desktop GPU, but fill rate
   * is the scarce thing on a phone and the plumes ask for frames.
   */
  funnelSmoke: boolean
}

/** Touch screens with a shorter side under this many CSS pixels are phones or small tablets. */
export const MOBILE_MAX_SHORT_SIDE_PX = 900

/** navigator.deviceMemory at or under this many GB is a mobile-tier device whatever its screen. */
export const MOBILE_MAX_MEMORY_GB = 2

/** The tier a device reads as; `forced` (from ?tier=) wins over the reading. */
export function detectDeviceTier(reading: DeviceReading, forced?: string | null): DeviceTier {
  if (forced === 'mobile' || forced === 'desktop') return forced
  if (reading.deviceMemoryGb !== undefined && reading.deviceMemoryGb <= MOBILE_MAX_MEMORY_GB)
    return 'mobile'
  const shortSide = Math.min(reading.screenWidth, reading.screenHeight)
  if (reading.maxTouchPoints > 0 && shortSide < MOBILE_MAX_SHORT_SIDE_PX) return 'mobile'
  return 'desktop'
}

/** The numbers a tier draws with; the desktop's are the ones the map was tuned with. */
export function renderProfileFor(tier: DeviceTier, deviceMemoryGb: number | undefined): RenderProfile {
  if (tier === 'mobile') {
    return {
      tier,
      shadowMapSize: 2048,
      msaaSamples: 1,
      maxPixelRatio: 1.5,
      tileSseCssPx: 8,
      tileCacheMb: 384,
      tileOverflowMb: 192,
      tileTreeLimit: 100_000,
      vehicleBodyRangeM: 2_000,
      maxRainDrops: 600,
      funnelSmoke: false,
    }
  }
  // navigator.deviceMemory is Chrome-only; elsewhere assume mid-range
  const memoryGb = deviceMemoryGb ?? 4
  return {
    tier,
    shadowMapSize: 8192,
    msaaSamples: 2,
    maxPixelRatio: 2,
    tileSseCssPx: 6,
    tileCacheMb: memoryGb >= 8 ? 2048 : 1024,
    tileOverflowMb: 1024,
    tileTreeLimit: 300_000,
    vehicleBodyRangeM: 3_500,
    maxRainDrops: undefined,
    funnelSmoke: true,
  }
}

/** The reading of the browser this code runs in. */
export function readDevice(): DeviceReading {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    screenWidth: window.screen?.width ?? window.innerWidth,
    screenHeight: window.screen?.height ?? window.innerHeight,
    deviceMemoryGb: nav.deviceMemory,
  }
}
