/**
 * The page under the map: the plain HTML the build writes into every
 * index.html (see lib/site-pages.ts) – the city's facts, its lines, the
 * links to the other cities – for a reader who gets no map: a crawler,
 * a browser without WebGL, a script that failed to load. The app hides
 * it the moment it starts (main.tsx) and the error boundary shows it
 * again when the viewer cannot be built (components/ErrorBoundary.tsx),
 * so that whoever sees no map at least reads what it would have shown.
 *
 * Hidden twice over, because the bundle is late: between the HTML being
 * parsed and main.tsx running, the page showed for a moment on every
 * load. So an inline script in index.html's head puts APP_CLASS on the
 * root element before the body is parsed, and the page's own stylesheet
 * hides it under that class (PAGE_STYLE in site-pages.ts). The same
 * script takes the class off again on `load` when the app has not
 * reported in by then (APP_STARTED_ATTRIBUTE) – a bundle that failed to
 * load must not leave a blank page. showStaticPage keeps the class, the
 * attribute and the `hidden` attribute in step; the inline script is
 * the one other place that knows these names.
 */

/** The id of the static page's root element. */
export const STATIC_PAGE_ID = 'static-page'

/** On the root element while the app is running (or about to): the page is hidden under it. */
export const APP_CLASS = 'has-app'

/** On the root element once main.tsx ran: the inline script's `load` fallback stands down. */
export const APP_STARTED_ATTRIBUTE = 'data-app-started'

/** Shows or hides the static page; nothing happens where the document has none. */
export function showStaticPage(shown: boolean): void {
  const root = document.documentElement
  if (!shown) root.setAttribute(APP_STARTED_ATTRIBUTE, '')
  root.classList.toggle(APP_CLASS, !shown)
  const page = document.getElementById(STATIC_PAGE_ID)
  if (page) page.hidden = !shown
}
