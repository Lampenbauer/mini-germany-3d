/**
 * The site's paths: where a page stands, not what it shows. A city has
 * an address of its own – `/berlin/` – and every page comes in two
 * languages, German bare and English under `/en/`:
 *
 *   /            the front door, German      /en/          in English
 *   /berlin/     Berlin, German               /en/berlin/   in English
 *   /impressum/  the legal notice             /en/imprint/  in English
 *   /datenschutz/ the privacy notice          /en/privacy/  in English
 *
 * Real addresses rather than a `#city=` fragment (which they replaced,
 * with no links from before to keep alive) because a
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

/** The two pages the law asks for (lib/legal.ts has their text). */
export type LegalKind = 'imprint' | 'privacy'

/**
 * Where each legal page stands, per language – the German words on the
 * bare path, the English ones under /en/. Either word is read in either
 * place (`/en/impressum/` is the legal notice too); the language is the
 * prefix's business.
 */
export const LEGAL_PATH_SEGMENTS: Readonly<Record<LegalKind, Readonly<Record<PathLang, string>>>> = {
  imprint: { de: 'impressum', en: 'imprint' },
  privacy: { de: 'datenschutz', en: 'privacy' },
}

const LEGAL_KINDS = Object.keys(LEGAL_PATH_SEGMENTS) as LegalKind[]

/** The legal page a path segment names, if any. */
function legalKindOf(segment: string): LegalKind | null {
  return LEGAL_KINDS.find((kind) => Object.values(LEGAL_PATH_SEGMENTS[kind]).includes(segment)) ?? null
}

export interface SitePath {
  /** `en` under /en/; null on a bare path, which says nothing about the language. */
  lang: PathLang | null
  /** The one segment after the language, if there is exactly one – whether it names a city is the caller's business. */
  city: string | null
  /** The legal page the path names, if it is one of those instead of a city. */
  legal: LegalKind | null
}

/**
 * First path segments a city slug must never take: the site serves other
 * things there, and the parser below names no city for them. Pinned by
 * tests/cities.test.ts.
 */
export const RESERVED_PATH_SEGMENTS: readonly string[] = [
  'en',
  'api',
  'assets',
  'cesium',
  'models',
  'og',
  ...LEGAL_KINDS.flatMap((kind) => Object.values(LEGAL_PATH_SEGMENTS[kind])),
]

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
  const legal = segments.length === 1 ? legalKindOf(segments[0]) : null
  const city =
    segments.length === 1 &&
    /^[a-z][a-z0-9-]{0,63}$/.test(segments[0]) &&
    !RESERVED_PATH_SEGMENTS.includes(segments[0])
      ? segments[0]
      : null
  return { lang, city, legal }
}

/** The path of a page: `/`, `/en/`, `/kiel/`, `/en/kiel/`. */
export function formatSitePath(lang: PathLang, city: string | null): string {
  return `${lang === 'en' ? '/en' : ''}/${city ? `${city}/` : ''}`
}

/** The path of a legal page in a language: `/impressum/`, `/en/privacy/`. */
export function formatLegalPath(lang: PathLang, kind: LegalKind): string {
  return formatSitePath(lang, LEGAL_PATH_SEGMENTS[kind][lang])
}
