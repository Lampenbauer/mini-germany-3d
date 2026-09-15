/**
 * jsdom has no `matchMedia`, so `narrowViewport()` (src/lib/viewport.ts)
 * reads every test as a desktop. `onAPhone()` answers its query as a
 * phone would, for what a card shows only there – the fold button and
 * the action in its head (CardShell in card-parts.tsx reads it once,
 * when made, so call it before rendering) – and `offThePhone()` takes
 * the answer away again, in an afterEach.
 */
export function onAPhone(): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia
}

export function offThePhone(): void {
  delete (window as { matchMedia?: unknown }).matchMedia
}
