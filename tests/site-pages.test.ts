import { beforeAll, describe, expect, it } from 'vitest'
import { CITIES, cityBySlug } from '@/cities/definitions'
import { getLanguage } from '@/lib/i18n'
import {
  PAGE_LANGS,
  SITE_ORIGIN,
  applyPage,
  citySummary,
  escapeHtml,
  homePage,
  ogImagePath,
  pageFor,
  sitemap,
  type StaticPage,
} from '@/lib/site-pages'

/** The index.html the pages are applied to, reduced to what applyPage reads. */
const SHELL =
  '<!doctype html>\n<html lang="de" class="dark">\n  <head>\n    <!-- page:head -->\n    <title>x</title>\n' +
  '    <!-- /page:head -->\n  </head>\n  <body>\n    <div id="root"></div>\n    <!-- page:body -->\n' +
  '    <!-- /page:body -->\n  </body>\n</html>\n'

describe('the pages under the map', () => {
  let rostock: StaticPage
  let rostockEn: StaticPage

  beforeAll(async () => {
    rostock = (await pageFor('/rostock/'))!
    rostockEn = (await pageFor('/en/rostock/'))!
  })

  it('serves the front door in both languages, with every city linked', () => {
    const de = homePage('de')
    const en = homePage('en')
    expect(de.path).toBe('/')
    expect(en.path).toBe('/en/')
    expect(de.title).toBe('Mini Germany 3D')
    expect(de.alternates).toEqual({ de: '/', en: '/en/' })
    expect(de.body).toContain('id="static-page"')
    expect(de.body).toContain('lang="de"')
    expect(de.body).toContain('Große Städte, kleine Wege')
    expect(en.body).toContain('lang="en"')
    for (const city of CITIES) {
      expect(de.body).toContain(`href="/${city.slug}/"`)
      expect(en.body).toContain(`href="/en/${city.slug}/"`)
    }
    // Each names the other language's page
    expect(de.body).toContain('href="/en/" hreflang="en"')
    expect(en.body).toContain('href="/" hreflang="de"')
    // Köln sorts under K in German, Cologne under C in English
    expect(de.body).toContain('Köln')
    expect(en.body).toContain('Cologne')
    // Rendering a page leaves the interface's language where it was
    expect(getLanguage()).toBe('en')
  })

  it('gives a city its facts, its lines and the way to the others', () => {
    expect(rostock.path).toBe('/rostock/')
    expect(rostock.city).toBe('rostock')
    expect(rostock.title).toBe('Mini Rostock 3D')
    expect(rostock.alternates).toEqual({ de: '/rostock/', en: '/en/rostock/' })
    // The lead is the network in one sentence, the description carries it on
    expect(rostock.body).toContain('Das Netz in Rostock:')
    expect(rostock.description).toMatch(/^Das Netz in Rostock: .* Live auf einer fotorealistischen 3D-Karte/)
    expect(rostockEn.description).toMatch(/^The network in Rostock: .* Live on a photorealistic 3D map/)
    // The card's facts, in the card's words
    expect(rostock.body).toContain('<dt>Linien</dt>')
    expect(rostock.body).toContain('Haltepositionen')
    expect(rostock.body).toContain('Linienlänge')
    expect(rostock.body).toContain('<dt>Betrieb</dt>')
    expect(rostockEn.body).toContain('stop positions')
    expect(rostockEn.body).toContain('of line')
    // The lines by mode – Rostock's trams and its two ferries
    expect(rostock.body).toContain('<h3>Straßenbahn</h3>')
    expect(rostock.body).toContain('<b>FG</b>')
    expect(rostock.body).toContain('<b>FW</b>')
    expect(rostockEn.body).toContain('<h3>Tram</h3>')
    // The others are linked, the city itself is not among them
    expect(rostock.body).toContain('href="/kiel/"')
    expect(rostock.body).not.toContain('<a href="/rostock/">')
    expect(rostock.body).toContain('href="/en/rostock/" hreflang="en"')
    expect(rostock.body).not.toContain('<script')
  })

  it('names no page for a slug this build does not know', async () => {
    expect(await pageFor('/atlantis/')).toBeNull()
    expect((await pageFor('/'))?.lang).toBe('de')
    expect((await pageFor('/en/'))?.lang).toBe('en')
  })

  it('counts the lines per mode the way the language joins a list', () => {
    const profile = {
      modes: [
        { mode: 'tram' as const, lines: 6, running: 6 },
        { mode: 'train' as const, lines: 1, running: 1 },
        { mode: 'ferry' as const, lines: 2, running: 2 },
      ],
    }
    expect(citySummary(profile as never, 'en')).toBe('6 tram lines, 1 S-Bahn line and 2 ferry lines')
    expect(citySummary(profile as never, 'de')).toBe('6 Straßenbahnlinien, 1 S-Bahn-Linie und 2 Fährlinien')
  })

  it('puts a page into index.html and can put another over it', () => {
    const html = applyPage(SHELL, rostock)
    expect(html).toContain('<html lang="de"')
    expect(html).toContain('<title>Mini Rostock 3D</title>')
    expect(html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/rostock/" />`)
    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}/en/rostock/" />`)
    expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/rostock/" />`)
    expect(html).toContain(`<meta property="og:image" content="${SITE_ORIGIN}/og/rostock.png" />`)
    expect(html).toContain('<meta property="og:locale" content="de_DE" />')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('id="static-page"')
    // The markers stay, so the built index.html takes each city in turn
    const again = applyPage(html, rostockEn)
    expect(again).toContain('<html lang="en"')
    expect(again).toContain('<title>Mini Rostock 3D</title>')
    expect(again).not.toContain('Das Netz in Rostock')
    expect(again.match(/<title>/g)).toHaveLength(1)
    expect(again.match(/id="static-page"/g)).toHaveLength(1)
    // A shell without the markers fails loudly
    expect(() => applyPage('<html lang="de"><body></body></html>', rostock)).toThrow(/markers/)
  })

  it('escapes what goes into the markup', () => {
    expect(escapeHtml('Fischer & <Söhne> "AG"')).toBe('Fischer &amp; &lt;Söhne&gt; &quot;AG&quot;')
  })

  it('lists every page in the sitemap with its alternates', () => {
    const xml = sitemap([homePage('de'), homePage('en'), rostock, rostockEn])
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/</loc>`)
    expect(xml).toContain(`<loc>${SITE_ORIGIN}/en/rostock/</loc>`)
    expect(xml.match(/<url>/g)).toHaveLength(4)
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="de" href="${SITE_ORIGIN}/rostock/" />`)
  })

  it('has a preview picture for every page – one per city, two where the name differs', () => {
    // The pictures in public/og as the site serves them, by path
    const drawn = new Set(Object.keys(import.meta.glob('../public/og/*.png')).map((file) => file.slice('../public'.length)))
    expect(ogImagePath(null, 'de')).toBe('/og/home.png')
    expect(ogImagePath(cityBySlug('kiel')!, 'en')).toBe('/og/kiel.png')
    expect(ogImagePath(cityBySlug('cologne')!, 'de')).toBe('/og/cologne.de.png')
    expect(ogImagePath(cityBySlug('cologne')!, 'en')).toBe('/og/cologne.en.png')
    // Drawn by scripts/build-og-images.mjs and committed – a new city needs a run
    const pictures = new Set(PAGE_LANGS.map((lang) => ogImagePath(null, lang)))
    for (const city of CITIES) for (const lang of PAGE_LANGS) pictures.add(ogImagePath(city, lang))
    for (const picture of pictures) expect(drawn, picture).toContain(picture)
  })
})
