import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fullscreenElement,
  fullscreenSupported,
  onFullscreenChange,
  toggleFullscreen,
} from '@/lib/fullscreen'

/**
 * The browser-compat surface of the full-screen button. jsdom implements
 * none of the Fullscreen API, which makes it the right place to test this:
 * every property has to be planted, so each spelling can be exercised on
 * its own – including the one where nothing is there at all (iOS Safari).
 */

type Planted = Record<string, unknown>

const planted: { target: object; key: string; had: PropertyDescriptor | undefined }[] = []

function plant(target: object, key: string, value: unknown) {
  planted.push({ target, key, had: Object.getOwnPropertyDescriptor(target, key) })
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
}

afterEach(() => {
  for (const { target, key, had } of planted.reverse()) {
    if (had) Object.defineProperty(target, key, had)
    else delete (target as Planted)[key]
  }
  planted.length = 0
})

describe('fullscreenSupported', () => {
  it('is false where the browser offers nothing – no button is drawn there', () => {
    expect(fullscreenSupported()).toBe(false)
  })

  it('follows the standard flag', () => {
    plant(document, 'fullscreenEnabled', true)
    expect(fullscreenSupported()).toBe(true)
  })

  it('accepts the old WebKit spelling on its own', () => {
    plant(document, 'webkitFullscreenEnabled', true)
    expect(fullscreenSupported()).toBe(true)
  })

  it('stays false when the standard flag says no, whatever WebKit claims', () => {
    // ?? not ||: a browser that answers `false` has answered.
    plant(document, 'fullscreenEnabled', false)
    plant(document, 'webkitFullscreenEnabled', true)
    expect(fullscreenSupported()).toBe(false)
  })
})

describe('toggleFullscreen', () => {
  it('asks the element to fill the screen when nothing does yet', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const element = { requestFullscreen: request } as unknown as Element
    await toggleFullscreen(element)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('leaves full screen instead when something is already filling it', async () => {
    const exit = vi.fn().mockResolvedValue(undefined)
    plant(document, 'fullscreenElement', document.body)
    plant(document, 'exitFullscreen', exit)
    const request = vi.fn()
    await toggleFullscreen({ requestFullscreen: request } as unknown as Element)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('falls back to the WebKit spelling in both directions', async () => {
    const request = vi.fn()
    await toggleFullscreen({ webkitRequestFullscreen: request } as unknown as Element)
    expect(request).toHaveBeenCalledTimes(1)

    const exit = vi.fn()
    plant(document, 'webkitFullscreenElement', document.body)
    plant(document, 'webkitExitFullscreen', exit)
    await toggleFullscreen({} as Element)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('swallows a refusal instead of throwing at the click handler', async () => {
    // Requesting outside a user gesture rejects. The button has nothing to
    // do about it, and the change event is what tells the truth anyway.
    const element = {
      requestFullscreen: vi.fn().mockRejectedValue(new Error('not allowed')),
    } as unknown as Element
    await expect(toggleFullscreen(element)).resolves.toBeUndefined()
  })
})

describe('fullscreenElement', () => {
  it('is null while nothing fills the screen', () => {
    expect(fullscreenElement()).toBeNull()
  })

  it('reads either spelling', () => {
    plant(document, 'webkitFullscreenElement', document.body)
    expect(fullscreenElement()).toBe(document.body)
  })
})

describe('onFullscreenChange', () => {
  it('hears both event names and unsubscribes from both', () => {
    const handler = vi.fn()
    const off = onFullscreenChange(handler)
    document.dispatchEvent(new Event('fullscreenchange'))
    document.dispatchEvent(new Event('webkitfullscreenchange'))
    expect(handler).toHaveBeenCalledTimes(2)
    off()
    document.dispatchEvent(new Event('fullscreenchange'))
    document.dispatchEvent(new Event('webkitfullscreenchange'))
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
