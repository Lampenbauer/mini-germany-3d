/**
 * The page under the map: the plain HTML the build writes into every
 * index.html (see lib/site-pages.ts) – the city's facts, its lines, the
 * links to the other cities – for a reader who gets no map: a crawler,
 * a browser without WebGL, a script that failed to load. The app hides
 * it the moment it starts (main.tsx) and the error boundary shows it
 * again when the viewer cannot be built (components/ErrorBoundary.tsx),
 * so that whoever sees no map at least reads what it would have shown.
 */

/** The id of the static page's root element. */
export const STATIC_PAGE_ID = 'static-page'

/** Shows or hides the static page; nothing happens where the document has none. */
export function showStaticPage(shown: boolean): void {
  const page = document.getElementById(STATIC_PAGE_ID)
  if (page) page.hidden = !shown
}
