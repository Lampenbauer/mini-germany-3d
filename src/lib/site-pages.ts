/**
 * The pages under the map: one per city and language (see site-path.ts
 * for the addresses), each an index.html the build writes into its own
 * directory, with the same app in it and, under the app's root element,
 * the city as plain HTML – its title and description in the head, its
 * facts, its lines and the links to the other cities in the body. For
 * whoever gets no map: a crawler, which is what makes a city findable
 * and gives a shared link its preview, and a browser without WebGL,
 * which the error boundary sends here (components/ErrorBoundary.tsx).
 * The app hides the page the moment it starts (main.tsx).
 *
 * Two more pages are the legal notice and the privacy notice
 * (lib/legal.ts), in both languages, linked from every page's foot –
 * the law wants them reachable from wherever the site is read, and a
 * reader without the app reads it here. They ask the crawlers to keep
 * them out of the index (`noindex, follow`, by design) and stay
 * out of the sitemap for the same reason.
 *
 * Everything on the page is what the city card states and nothing more
 * (city-profile.ts – facts the sources state, no simulation results,
 * and the same two carefully named measures: stop positions, line
 * kilometres). The words are the interface's own, from both tables in
 * i18n.ts, so the page reads like the app that follows it.
 *
 * The page carries its own small stylesheet, the one exception to
 * "styling lives in the markup": it has to read with the app's bundle
 * missing, which is exactly the case it exists for.
 *
 * Rendered at build time by the prerender plugin in vite.config.ts
 * through Vite's module runner (this module speaks the app's aliases
 * and loads the cities the way the app does), and in dev for the page
 * being served. Pure over prepared data otherwise – tested in
 * tests/site-pages.test.ts.
 */

import { CITIES, isCitySlug, loadCityData } from '@/cities'
import type { PreparedLine } from '@/data/network-types'
import type { City } from '@/lib/city'
import {
  buildCityProfile,
  formatCount,
  formatKilometres,
  isRoundTheClock,
  tunnelPercent,
  type CityProfile,
} from '@/lib/city-profile'
import {
  getLanguage,
  localizeCityName,
  localizeLineName,
  MODE_KEY,
  setLanguage,
  sortCitiesByName,
  t,
  type Lang,
  type MessageKey,
} from '@/lib/i18n'
import { formatServiceTime } from '@/lib/line-profile'
import { legalText, type LegalText } from '@/lib/legal'
import { formatLegalPath, formatSitePath, parseSitePath, type LegalKind } from '@/lib/site-path'
import { APP_CLASS, STATIC_PAGE_ID } from '@/lib/static-page'
import { TRANSIT_MODES, type TransitMode } from '@/lib/transit-mode'

/** Where the site is served – the canonical URLs and the sitemap name it in full. */
export const SITE_ORIGIN = 'https://minigermany3d.com'

/** The two languages every page comes in; German first, it is the bare path's. */
export const PAGE_LANGS: readonly Lang[] = ['de', 'en']

/** The brand green (`--brand` in index.css), as the head's theme colour. */
const THEME_COLOR = '#143b36'

/** The pixel size the OG images are made in (scripts/build-og-images.mjs). */
const OG_IMAGE_SIZE = { width: 1200, height: 630 }

export interface StaticPage {
  /** Where the page is served: `/`, `/en/`, `/kiel/`, `/en/kiel/`. */
  path: string
  lang: Lang
  /** The city's slug; null for the front door. */
  city: string | null
  title: string
  description: string
  /** The same page in each language, by path. */
  alternates: Record<Lang, string>
  /** The preview picture a shared link shows, as a site path. */
  ogImage: string
  /** Whether the page asks the crawlers to leave it out of their index – the legal pages do. */
  noindex: boolean
  /** The static content: the root element with the id static-page.ts names, and everything in it. */
  body: string
}

/** The lines of a city as the page lists them – what the page needs of a PreparedLine. */
export type PageLine = Pick<PreparedLine, 'id' | 'name' | 'mode'>

/** Runs `fn` with the interface set to `lang`, and puts the language back. */
function withLanguage<T>(lang: Lang, fn: () => T): T {
  const before = getLanguage()
  setLanguage(lang)
  try {
    return fn()
  } finally {
    setLanguage(before)
  }
}

/** A city's name in a language. */
function cityNameIn(lang: Lang, city: City): string {
  return withLanguage(lang, () => localizeCityName(city.slug, city.name))
}

/** HTML-escapes text for an element's content or an attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The OG image of a page. One picture per city, unless its name differs
 * between the languages (Cologne/Köln) – then one per language, since
 * the picture carries the name. scripts/build-og-images.mjs follows the
 * same rule, and tests/site-pages.test.ts checks every page's picture
 * is there.
 */
export function ogImagePath(city: City | null, lang: Lang): string {
  if (!city) return '/og/home.png'
  const sameName = cityNameIn('de', city) === cityNameIn('en', city)
  return sameName ? `/og/${city.slug}.png` : `/og/${city.slug}.${lang}.png`
}

/**
 * "15 S-Bahn lines, 9 subway lines and 20 bus lines" – the modes in
 * display order with their line counts, joined the way the language
 * joins a list. The count is the network's, not the day's: a line that
 * stands still today is still a line of the city.
 */
export function citySummary(profile: CityProfile, lang: Lang): string {
  return withLanguage(lang, () => {
    const parts = profile.modes.map((entry) => {
      const key: MessageKey = entry.lines === 1 ? `page.line.${entry.mode}` : `page.lines.${entry.mode}`
      return `${formatCount(entry.lines)} ${t(key)}`
    })
    return new Intl.ListFormat(lang === 'de' ? 'de-DE' : 'en-GB', { type: 'conjunction' }).format(parts)
  })
}

/**
 * The words a city wears in a list, the panel's and the welcome
 * screen's icons written out: one per mode, and "ships" for ships in
 * general – a ferry line or the live harbour – last.
 */
function cityModeWords(city: City): string {
  const words = city.network.modes.filter((mode) => mode !== 'ferry').map((mode) => t(MODE_KEY[mode]))
  if (city.ais.enabled || city.network.modes.includes('ferry')) words.push(t('city.ships'))
  return words.join(', ')
}

/** The list of cities with their links – the front door's, and a city page's "more cities". */
function cityList(lang: Lang, except: string | null): string {
  const items = sortCitiesByName(CITIES.filter((city) => city.slug !== except))
    .map(
      ({ city, name }) =>
        `<li><a href="${formatSitePath(lang, city.slug)}">${escapeHtml(name)}</a> ` +
        `<span>${escapeHtml(cityModeWords(city))}</span></li>`,
    )
    .join('')
  return `<ul class="cities">${items}</ul>`
}

/** The lines of the city, grouped by mode in display order. */
function lineList(lines: readonly PageLine[]): string {
  return TRANSIT_MODES.map((mode: TransitMode) => {
    const own = lines.filter((line) => line.mode === mode)
    if (own.length === 0) return ''
    const items = own
      .map((line) => `<li><b>${escapeHtml(line.id)}</b> ${escapeHtml(localizeLineName(line.name))}</li>`)
      .join('')
    return `<h3>${escapeHtml(t(MODE_KEY[mode]))}</h3><ul class="lines">${items}</ul>`
  }).join('')
}

/** One row of the facts list; an empty note is left out. */
function fact(label: string, value: string, note?: string): string {
  return (
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}` +
    (note ? ` <small>· ${escapeHtml(note)}</small>` : '') +
    `</dd></div>`
  )
}

/** The facts the city card carries, as a description list – same values, same words. */
function factList(profile: CityProfile, lines: readonly PageLine[]): string {
  const rows: string[] = []
  rows.push(
    fact(
      t('city.lines'),
      t('city.linesCount', { count: formatCount(profile.lines.total) }),
      profile.lines.running !== null && profile.lines.running < profile.lines.total
        ? t('city.linesRunning', { count: formatCount(profile.lines.running) })
        : undefined,
    ),
  )
  rows.push(fact(t('city.stops'), t('city.stopPositions', { count: formatCount(profile.stopPositions) })))
  rows.push(
    fact(
      t('city.route'),
      t('city.lineKm', { km: formatKilometres(profile.lineMeters) }),
      tunnelPercent(profile) > 0
        ? t('city.tunnelShare', {
            km: formatKilometres(profile.tunnelMeters),
            percent: tunnelPercent(profile),
          })
        : undefined,
    ),
  )
  rows.push(
    fact(
      t('city.trips'),
      profile.trips ? t('city.tripsPerDay', { count: formatCount(profile.trips.total) }) : t('city.noSchedule'),
      profile.trips && profile.trips.shortWorkings > 0
        ? t('city.shortWorkings', { count: formatCount(profile.trips.shortWorkings) })
        : undefined,
    ),
  )
  const longest = profile.longest && lines.find((line) => line.id === profile.longest?.lineId)
  if (profile.longest && longest) {
    rows.push(
      fact(
        t('city.longest'),
        `${longest.id} ${localizeLineName(longest.name)}`,
        formatKilometres(profile.longest.meters, 1),
      ),
    )
  }
  if (profile.elevation) {
    rows.push(
      fact(
        t('city.elevation'),
        t('city.elevationRange', {
          min: Math.round(profile.elevation.min),
          max: Math.round(profile.elevation.max),
        }),
        t('city.highestStop', { name: profile.elevation.highestStop }),
      ),
    )
  }
  if (profile.service) {
    rows.push(
      fact(
        t('city.service'),
        isRoundTheClock(profile.service)
          ? t('city.roundTheClock')
          : `${formatServiceTime(profile.service.first)}–${formatServiceTime(profile.service.last)}`,
      ),
    )
  }
  return `<dl>${rows.join('')}</dl>`
}

/**
 * The page's own stylesheet: dark like the app, legible without the
 * bundle – a document that shows the page takes the app's ground colour
 * itself, and gives up the app's fixed, unscrollable viewport
 * (index.css pins html, body and #root to the window for the map), or
 * the page would be cut off at the fold. Scoped to the page's id
 * throughout.
 */
const PAGE_STYLE =
  // Under the app (see lib/static-page.ts) the page is not there at all
  `html.${APP_CLASS} #${STATIC_PAGE_ID}{display:none}` +
  `html:not(.${APP_CLASS}):has(#${STATIC_PAGE_ID}:not([hidden])),` +
  `html:not(.${APP_CLASS}) body:has(#${STATIC_PAGE_ID}:not([hidden])),` +
  `html:not(.${APP_CLASS}) body:has(#${STATIC_PAGE_ID}:not([hidden])) #root{height:auto;overflow:visible}` +
  `html:not(.${APP_CLASS}) body:has(#${STATIC_PAGE_ID}:not([hidden])){background:#09090b;margin:0}` +
  `#${STATIC_PAGE_ID}{box-sizing:border-box;max-width:44rem;margin:0 auto;padding:2.5rem 1rem 4rem;` +
  `font:16px/1.55 Inter,system-ui,sans-serif;color:#e4e4e7}` +
  `#${STATIC_PAGE_ID}[hidden]{display:none}` +
  `#${STATIC_PAGE_ID} a{color:#5ee0c0}` +
  `#${STATIC_PAGE_ID} h1{font-size:2.25rem;line-height:1.1;letter-spacing:-.02em;margin:.25rem 0 1rem;color:#fafafa}` +
  `#${STATIC_PAGE_ID} h2{font-size:1.25rem;margin:2rem 0 .5rem;color:#fafafa}` +
  `#${STATIC_PAGE_ID} h3{font-size:1rem;margin:1rem 0 .25rem;color:#a1a1aa}` +
  `#${STATIC_PAGE_ID} p{margin:0 0 .75rem}` +
  `#${STATIC_PAGE_ID} .eyebrow{font-size:.75rem;letter-spacing:.12em;text-transform:uppercase;color:#5ee0c0;margin:0}` +
  `#${STATIC_PAGE_ID} .eyebrow a{text-decoration:none}` +
  `#${STATIC_PAGE_ID} .lead{font-size:1.125rem;color:#f4f4f5}` +
  `#${STATIC_PAGE_ID} .note{color:#a1a1aa}` +
  `#${STATIC_PAGE_ID} dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1.25rem;margin:0}` +
  `#${STATIC_PAGE_ID} dl div{display:contents}` +
  `#${STATIC_PAGE_ID} dt{color:#a1a1aa}` +
  `#${STATIC_PAGE_ID} dd{margin:0}` +
  `#${STATIC_PAGE_ID} small{color:#a1a1aa;font-size:inherit}` +
  `#${STATIC_PAGE_ID} ul{list-style:none;margin:0;padding:0}` +
  `#${STATIC_PAGE_ID} .lines li{display:inline-block;margin:0 1rem .35rem 0}` +
  `#${STATIC_PAGE_ID} .lines b{display:inline-block;min-width:2.25rem;padding:0 .4rem;border-radius:.35rem;` +
  `background:#27272a;text-align:center;margin-right:.35rem}` +
  `#${STATIC_PAGE_ID} .cities li{margin:.25rem 0}` +
  `#${STATIC_PAGE_ID} .cities span{color:#a1a1aa}` +
  `#${STATIC_PAGE_ID} footer{margin-top:2.5rem;border-top:1px solid #27272a;padding-top:1rem;color:#a1a1aa}`

/**
 * The other language's link, the way back to the front door from any
 * page but the front door, and the two legal pages – on every page,
 * the legal ones included (each links the other).
 */
function pageFooter(page: Pick<StaticPage, 'lang' | 'city' | 'alternates'> & { legal?: LegalKind }): string {
  const other: Lang = page.lang === 'de' ? 'en' : 'de'
  const links = [
    `<a href="${page.alternates[other]}" hreflang="${other}" lang="${other}">${escapeHtml(t('page.otherLanguage'))}</a>`,
  ]
  if (page.city || page.legal) links.push(`<a href="${formatSitePath(page.lang, null)}">${escapeHtml(t('page.allCities'))}</a>`)
  links.push(
    `<a href="${formatLegalPath(page.lang, 'imprint')}">${escapeHtml(t('legal.imprint'))}</a>`,
    `<a href="${formatLegalPath(page.lang, 'privacy')}">${escapeHtml(t('legal.privacy'))}</a>`,
  )
  return `<footer>${links.join(' · ')}</footer>`
}

/** A legal text's sections as HTML; an address block keeps its line breaks. */
function legalSections(text: LegalText): string {
  return text.sections
    .map(
      (section) =>
        `<section><h2>${escapeHtml(section.heading)}</h2>` +
        section.paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`).join('') +
        `</section>`,
    )
    .join('')
}

/** Wraps a page's sections in the root element the app hides, with the stylesheet first. */
function wrap(lang: Lang, sections: string): string {
  return `<div id="${STATIC_PAGE_ID}" lang="${lang}"><style>${PAGE_STYLE}</style>${sections}</div>`
}

/** The front door as a page: what the site is, and every city with a link. */
export function homePage(lang: Lang): StaticPage {
  return withLanguage(lang, () => {
    const alternates = { de: formatSitePath('de', null), en: formatSitePath('en', null) }
    const body = wrap(
      lang,
      `<header><p class="eyebrow">${escapeHtml(t('about.eyebrow'))}</p>` +
        `<h1>${escapeHtml(t('about.title'))}</h1>` +
        `<p class="lead">${escapeHtml(t('about.lead'))}</p>` +
        `<p>${escapeHtml(t('welcome.lead'))}</p>` +
        `<p>${escapeHtml(t('about.projectRealism'))}</p>` +
        `<p class="note">${escapeHtml(t('page.needsWebgl'))}</p></header>` +
        `<section><h2>${escapeHtml(t('welcome.cities'))}</h2>${cityList(lang, null)}</section>` +
        `<section><h2>${escapeHtml(t('about.notTitle'))}</h2>` +
        `<p>${escapeHtml(t('about.notLive'))}</p><p>${escapeHtml(t('about.notShips'))}</p>` +
        `<p>${escapeHtml(t('about.notComplete'))}</p></section>` +
        `<section><h2>${escapeHtml(t('about.builtTitle'))}</h2><p>${escapeHtml(t('about.built'))}</p></section>` +
        pageFooter({ lang, city: null, alternates }),
    )
    return {
      path: alternates[lang],
      lang,
      city: null,
      title: t('about.title'),
      description: t('page.description'),
      alternates,
      ogImage: ogImagePath(null, lang),
      noindex: false,
      body,
    }
  })
}

/** A legal page: the notice's text under the site's eyebrow, kept out of the index. */
export function legalPage(kind: LegalKind, lang: Lang): StaticPage {
  return withLanguage(lang, () => {
    const text = legalText(kind, lang)
    const alternates = { de: formatLegalPath('de', kind), en: formatLegalPath('en', kind) }
    const body = wrap(
      lang,
      `<header><p class="eyebrow"><a href="${formatSitePath(lang, null)}">${escapeHtml(t('welcome.eyebrow'))}</a></p>` +
        `<h1>${escapeHtml(text.title)}</h1>` +
        `<p class="lead">${escapeHtml(text.lead)}</p></header>` +
        legalSections(text) +
        pageFooter({ lang, city: null, legal: kind, alternates }),
    )
    return {
      path: alternates[lang],
      lang,
      city: null,
      title: `${text.title} – ${t('about.title')}`,
      description: text.lead,
      alternates,
      ogImage: ogImagePath(null, lang),
      noindex: true,
      body,
    }
  })
}

/** A city as a page: its facts and lines, the other cities, the sources. */
export function cityPage(
  city: City,
  lang: Lang,
  profile: CityProfile,
  lines: readonly PageLine[],
): StaticPage {
  return withLanguage(lang, () => {
    const name = localizeCityName(city.slug, city.name)
    const alternates = { de: formatSitePath('de', city.slug), en: formatSitePath('en', city.slug) }
    const summary = t('page.citySummary', { name, summary: citySummary(profile, lang) })
    const body = wrap(
      lang,
      `<header><p class="eyebrow"><a href="${formatSitePath(lang, null)}">${escapeHtml(t('welcome.eyebrow'))}</a></p>` +
        `<h1>${escapeHtml(t('city.title', { name }))}</h1>` +
        `<p class="lead">${escapeHtml(summary)}</p>` +
        `<p>${escapeHtml(t('about.project'))}</p>` +
        `<p>${escapeHtml(t('about.projectRealism'))}</p>` +
        `<p class="note">${escapeHtml(t('page.needsWebgl'))}</p></header>` +
        `<section><h2>${escapeHtml(t('city.facts', { name }))}</h2>${factList(profile, lines)}</section>` +
        `<section><h2>${escapeHtml(t('page.theLines'))}</h2>${lineList(lines)}</section>` +
        `<section><h2>${escapeHtml(t('page.otherCities'))}</h2>${cityList(lang, city.slug)}</section>` +
        `<section><h2>${escapeHtml(t('about.builtTitle'))}</h2><p>${escapeHtml(t('about.built'))}</p></section>` +
        pageFooter({ lang, city: city.slug, alternates }),
    )
    return {
      path: alternates[lang],
      lang,
      city: city.slug,
      title: t('city.title', { name }),
      description: t('page.cityDescription', { summary }),
      alternates,
      ogImage: ogImagePath(city, lang),
      noindex: false,
      body,
    }
  })
}

/** The head's tags for a page: title, description, canonical, the alternates, the previews. */
export function headTags(page: StaticPage): string {
  const url = SITE_ORIGIN + page.path
  const image = SITE_ORIGIN + page.ogImage
  const title = escapeHtml(page.title)
  const description = escapeHtml(page.description)
  const locale = page.lang === 'de' ? 'de_DE' : 'en_GB'
  const otherLocale = page.lang === 'de' ? 'en_GB' : 'de_DE'
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${url}" />`,
    ...PAGE_LANGS.map(
      (lang) => `<link rel="alternate" hreflang="${lang}" href="${SITE_ORIGIN}${page.alternates[lang]}" />`,
    ),
    `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${page.alternates.de}" />`,
    ...(page.noindex ? [`<meta name="robots" content="noindex, follow" />`] : []),
    `<meta name="theme-color" content="${THEME_COLOR}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Mini Germany 3D" />`,
    `<meta property="og:locale" content="${locale}" />`,
    `<meta property="og:locale:alternate" content="${otherLocale}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="${OG_IMAGE_SIZE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE_SIZE.height}" />`,
    `<meta property="og:image:alt" content="${title}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ].join('\n    ')
}

/** The markers in index.html between which a page's head tags and body go; they stay, so a page can be applied again. */
const HEAD_REGION = /(<!-- page:head -->)[\s\S]*?(<!-- \/page:head -->)/
const BODY_REGION = /(<!-- page:body -->)[\s\S]*?(<!-- \/page:body -->)/
const HTML_LANG = /<html lang="[a-z-]*"/

/**
 * index.html with a page in it: its language on the root element, its
 * tags in the head, its content under the app's root. The markers stay
 * in place, so the built index.html – which already carries the front
 * door – takes each city page in turn. Throws when index.html has lost
 * a marker: a build without the pages must not pass quietly.
 */
export function applyPage(html: string, page: StaticPage): string {
  if (!HEAD_REGION.test(html) || !BODY_REGION.test(html) || !HTML_LANG.test(html))
    throw new Error('index.html has lost the page markers (page:head, page:body) or its lang attribute')
  return html
    .replace(HTML_LANG, `<html lang="${page.lang}"`)
    .replace(HEAD_REGION, (_, open: string, close: string) => `${open}\n    ${headTags(page)}\n    ${close}`)
    .replace(BODY_REGION, (_, open: string, close: string) => `${open}\n    ${page.body}\n    ${close}`)
}

/** The sitemap: every page that wants indexing, each with its alternates. */
export function sitemap(pages: readonly StaticPage[]): string {
  const entries = pages
    .filter((page) => !page.noindex)
    .map(
      (page) =>
        `  <url>\n    <loc>${SITE_ORIGIN}${page.path}</loc>\n` +
        PAGE_LANGS.map(
          (lang) =>
            `    <xhtml:link rel="alternate" hreflang="${lang}" href="${SITE_ORIGIN}${page.alternates[lang]}" />\n`,
        ).join('') +
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${page.alternates.de}" />\n` +
        `  </url>`,
    )
    .join('\n')
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    `${entries}\n</urlset>\n`
  )
}

/** A city's pages in both languages, from its data loaded once; kept for the process (the data does not change under a build). */
const cityPagesBySlug = new Map<string, Promise<Record<Lang, StaticPage>>>()

function cityPages(city: City): Promise<Record<Lang, StaticPage>> {
  let pages = cityPagesBySlug.get(city.slug)
  if (!pages) {
    pages = loadCityData(city.slug).then((data) => {
      const profile = buildCityProfile(data.network, data.schedule ?? undefined)
      const lines: PageLine[] = data.network.lines.map(({ id, name, mode }) => ({ id, name, mode }))
      return {
        de: cityPage(city, 'de', profile, lines),
        en: cityPage(city, 'en', profile, lines),
      }
    })
    cityPagesBySlug.set(city.slug, pages)
  }
  return pages
}

/** Every page of the site: the front door, the two legal pages and each city, in both languages. */
export async function allPages(): Promise<StaticPage[]> {
  const pages: StaticPage[] = PAGE_LANGS.flatMap((lang) => [
    homePage(lang),
    legalPage('imprint', lang),
    legalPage('privacy', lang),
  ])
  // One city at a time: a city's data is a few megabytes parsed, and
  // thirteen of them in flight at once would be that many times over.
  for (const city of CITIES) {
    const own = await cityPages(city)
    for (const lang of PAGE_LANGS) pages.push(own[lang])
  }
  return pages
}

/**
 * The page a path is served with: a city's, a legal page, the front
 * door's, or none for a path that is none of these (a wrong slug – the
 * app opens the default city there, the dev server serves the bare
 * index.html).
 */
export async function pageFor(pathname: string): Promise<StaticPage | null> {
  const { lang, city, legal } = parseSitePath(pathname)
  const pageLang: Lang = lang ?? 'de'
  if (legal !== null) return legalPage(legal, pageLang)
  if (city === null) return homePage(pageLang)
  if (!isCitySlug(city)) return null
  const own = await cityPages(CITIES.find((c) => c.slug === city)!)
  return own[pageLang]
}
