import '@testing-library/jest-dom/vitest'

// jsdom kennt keinen ResizeObserver (wird vom Radix-Slider benötigt)
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver
}
