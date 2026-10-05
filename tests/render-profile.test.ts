import { describe, expect, it } from 'vitest'
import {
  MOBILE_MAX_MEMORY_GB,
  MOBILE_MAX_SHORT_SIDE_PX,
  detectDeviceTier,
  renderProfileFor,
  type DeviceReading,
} from '@/lib/render-profile'

const desktop: DeviceReading = {
  maxTouchPoints: 0,
  screenWidth: 2560,
  screenHeight: 1440,
  deviceMemoryGb: 8,
}
const phone: DeviceReading = {
  maxTouchPoints: 5,
  screenWidth: 393,
  screenHeight: 852,
  deviceMemoryGb: undefined,
}

describe('the device tier', () => {
  it('reads a touch screen with a short side under the limit as mobile, whichever way it is held', () => {
    expect(detectDeviceTier(phone)).toBe('mobile')
    expect(detectDeviceTier({ ...phone, screenWidth: 852, screenHeight: 393 })).toBe('mobile')
    expect(
      detectDeviceTier({ ...phone, screenWidth: MOBILE_MAX_SHORT_SIDE_PX, screenHeight: 1200 }),
    ).toBe('desktop')
  })

  it('keeps a desktop and a big tablet on the desktop tier', () => {
    expect(detectDeviceTier(desktop)).toBe('desktop')
    // A small desktop window is not a phone: no touch points
    expect(detectDeviceTier({ ...desktop, screenWidth: 800, screenHeight: 600 })).toBe('desktop')
    // An iPad-sized touch screen has the pixels for the fine tiles
    expect(
      detectDeviceTier({ maxTouchPoints: 5, screenWidth: 1024, screenHeight: 1366, deviceMemoryGb: undefined }),
    ).toBe('desktop')
  })

  it('reads little memory as mobile whatever the screen, and lets ?tier= override everything', () => {
    expect(detectDeviceTier({ ...desktop, deviceMemoryGb: MOBILE_MAX_MEMORY_GB })).toBe('mobile')
    expect(detectDeviceTier(desktop, 'mobile')).toBe('mobile')
    expect(detectDeviceTier(phone, 'desktop')).toBe('desktop')
    expect(detectDeviceTier(phone, 'tablet')).toBe('mobile')
    expect(detectDeviceTier(phone, null)).toBe('mobile')
  })
})

describe('the render profile', () => {
  it('gives the desktop the numbers the map was tuned with, the cache by memory', () => {
    const big = renderProfileFor('desktop', 8)
    expect(big).toMatchObject({ shadowMapSize: 8192, msaaSamples: 1, maxPixelRatio: 2, tileSseCssPx: 6 })
    expect(big.tileCacheMb).toBe(2048)
    expect(renderProfileFor('desktop', 4).tileCacheMb).toBe(1024)
    // No reading (Safari, Firefox): mid-range assumed
    expect(renderProfileFor('desktop', undefined).tileCacheMb).toBe(1024)
    expect(big.maxRainDrops).toBeUndefined()
    expect(big.shipEffects).toBe(true)
  })

  it('gives a phone less of everything, and the memory reading changes nothing there', () => {
    const small = renderProfileFor('mobile', 8)
    const big = renderProfileFor('desktop', 8)
    expect(small.shadowMapSize).toBeLessThan(big.shadowMapSize)
    // No multisampling on either tier
    expect(small.msaaSamples).toBe(1)
    expect(big.msaaSamples).toBe(1)
    // The pixel-ratio cap is the one number both tiers share (2× on both)
    expect(small.maxPixelRatio).toBe(big.maxPixelRatio)
    expect(small.tileSseCssPx).toBeGreaterThan(big.tileSseCssPx)
    expect(small.tileCacheMb + small.tileOverflowMb).toBeLessThan(1024)
    expect(small.tileTreeLimit).toBeLessThan(big.tileTreeLimit)
    expect(small.vehicleBodyRangeM).toBeLessThan(big.vehicleBodyRangeM)
    expect(small.maxRainDrops).toBeDefined()
    // No exhaust plumes and no wakes: fill rate, and the frames they ask for
    expect(small.shipEffects).toBe(false)
    expect(renderProfileFor('mobile', undefined)).toEqual(small)
  })
})
