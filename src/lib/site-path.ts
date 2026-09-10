/**
 * The site's paths: where a page stands, not what it shows. A city has
 * an address of its own – `/berlin/` – and every page comes in two
 * languages, German bare and English under `/en/`:
 *
 *   /            the front door, German      /en/          in English
 *   /berlin/     Berlin, German               /en/berlin/   in English
 *
 * Real addresses rather than a `#city=` fragment (which they replaced on
 * 2026-09-10, with no links from before to keep alive) because a
 * fragment never reaches a server or a crawler: every city was one URL
 * to Google, and a shared link's preview was the site's. The build
 * writes an index.html into each of these directories
 * (see the prerender plugin in vite.config.ts), with the city's facts as
 * plain HTML for whoever cannot run the map – a crawler, a browser
 * without WebGL – and the app takes over from there. The camera pose, a
 * selection and the layer switches stay in the hash (lib/camera-hash.ts),
 * where an edit is a fragment navigation, not a page load.
 *
 * Alias-free on purpose: lib/i18n.ts reads the language off the path
 * before anything else loads, and vite.config.ts imports it.
 */

/** The languages the paths tell apart – the interface's own two. */
export type PathLang = 'de' | 'en'

export interface SitePath {
  /** `en` under /en/; null on a bare path, which says nothing about the language. */
  lang: PathLang | null
  /** The one segment after the language, if there is exactly one – whether it names a city is the caller's business. */
  city: string | null
}

/**
 * First path segments a city slug must never take: the site serves other
 * things there, and the parser below names no city for them. Pinned by
 * tests/cities.test.ts.
 */
export const RESERVED_PATH_SEGMENTS: readonly string[] = ['en', 'api', 'assets', 'cesium', 'models', 'og']

/**
 * A path's language and city. Tolerant of a trailing `index.html` and of
 * a missing trailing slash; a path with more than one segment (`/api/…`,
 * `/assets/…`) or a reserved one names no city.
 */
export function parseSitePath(pathname: string): SitePath {
  const segments = pathname.split('/').filter((segment) => segment !== '' && segment !== 'index.html')
  let lang: PathLang | null = null
  if (segments[0] === 'en') {
    lang = 'en'
    segments.shift()
  }
  const city =
    segments.length === 1 &&
    /^[a-z][a-z0-9-]{0,63}$/.test(segments[0]) &&
    !RESERVED_PATH_SEGMENTS.includes(segments[0])
      ? segments[0]
      : null
  return { lang, city }
}

/** The path of a page: `/`, `/en/`, `/kiel/`, `/en/kiel/`. */
export function formatSitePath(lang: PathLang, city: string | null): string {
  return `${lang === 'en' ? '/en' : ''}/${city ? `${city}/` : ''}`
}
