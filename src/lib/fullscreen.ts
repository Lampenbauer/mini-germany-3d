/**
 * Fullscreen, across the two spellings of the API that are still in the
 * field. Safari only got the unprefixed Element.requestFullscreen in 16.4;
 * before that it is webkitRequestFullscreen, and the change event carries
 * its own name too. iOS Safari has neither for a plain element – only for
 * a <video> – so `fullscreenSupported` comes back false there and the
 * caller leaves its button out rather than offering one that does nothing.
 *
 * Kept out of the component: this is the whole of the browser-compat
 * surface, and it is testable without rendering anything.
 */

/** The prefixed halves of the API, as the older WebKit spells them. */
interface WebkitDocument {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => void
}
interface WebkitElement {
  webkitRequestFullscreen?: () => void
}

function doc(): Document & WebkitDocument {
  return document as Document & WebkitDocument
}

/** Whether this browser can put an element full screen at all. */
export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false
  const d = doc()
  return Boolean(d.fullscreenEnabled ?? d.webkitFullscreenEnabled)
}

/** The element currently filling the screen, or null. */
export function fullscreenElement(): Element | null {
  const d = doc()
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null
}

/**
 * Enter full screen with `target`, or leave it if anything is full screen
 * already. Rejections are swallowed on purpose: a request outside a user
 * gesture, or one the browser simply refuses, is not worth an error in the
 * console – the button stays where it is and nothing changes.
 */
export async function toggleFullscreen(target: Element): Promise<void> {
  const d = doc()
  try {
    if (fullscreenElement() !== null) {
      if (d.exitFullscreen) await d.exitFullscreen()
      else d.webkitExitFullscreen?.()
      return
    }
    const element = target as Element & WebkitElement
    if (element.requestFullscreen) await element.requestFullscreen()
    else element.webkitRequestFullscreen?.()
  } catch {
    /* refused – the caller reads the truth back from the change event */
  }
}

/**
 * Subscribe to entering and leaving full screen, however it happened –
 * the button, F11, or Escape. Returns the unsubscribe.
 */
export function onFullscreenChange(handler: () => void): () => void {
  document.addEventListener('fullscreenchange', handler)
  document.addEventListener('webkitfullscreenchange', handler)
  return () => {
    document.removeEventListener('fullscreenchange', handler)
    document.removeEventListener('webkitfullscreenchange', handler)
  }
}
