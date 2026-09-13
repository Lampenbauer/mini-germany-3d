import { describe, expect, it } from 'vitest'
import { RESERVED_PATH_SEGMENTS, formatLegalPath, formatSitePath, parseSitePath } from '@/lib/site-path'

describe('the site paths', () => {
  it('reads the language and the city off a path', () => {
    expect(parseSitePath('/')).toEqual({ lang: null, city: null, legal: null })
    expect(parseSitePath('/en/')).toEqual({ lang: 'en', city: null, legal: null })
    expect(parseSitePath('/berlin/')).toEqual({ lang: null, city: 'berlin', legal: null })
    expect(parseSitePath('/en/berlin/')).toEqual({ lang: 'en', city: 'berlin', legal: null })
    // Apache serves the directory's index.html; a typed path may lack the slash
    expect(parseSitePath('/berlin/index.html')).toEqual({ lang: null, city: 'berlin', legal: null })
    expect(parseSitePath('/en/berlin')).toEqual({ lang: 'en', city: 'berlin', legal: null })
    expect(parseSitePath('/index.html')).toEqual({ lang: null, city: null, legal: null })
  })

  it('names the legal pages by either language’s word, and never as a city', () => {
    expect(parseSitePath('/impressum/')).toEqual({ lang: null, city: null, legal: 'imprint' })
    expect(parseSitePath('/en/imprint/')).toEqual({ lang: 'en', city: null, legal: 'imprint' })
    expect(parseSitePath('/datenschutz/')).toEqual({ lang: null, city: null, legal: 'privacy' })
    expect(parseSitePath('/en/privacy/')).toEqual({ lang: 'en', city: null, legal: 'privacy' })
    // The other language's word is read too; the prefix says the language
    expect(parseSitePath('/en/datenschutz/')).toEqual({ lang: 'en', city: null, legal: 'privacy' })
    expect(parseSitePath('/privacy/index.html').legal).toBe('privacy')
    for (const word of ['impressum', 'imprint', 'datenschutz', 'privacy']) expect(RESERVED_PATH_SEGMENTS).toContain(word)
    expect(formatLegalPath('de', 'imprint')).toBe('/impressum/')
    expect(formatLegalPath('en', 'imprint')).toBe('/en/imprint/')
    expect(formatLegalPath('de', 'privacy')).toBe('/datenschutz/')
    expect(formatLegalPath('en', 'privacy')).toBe('/en/privacy/')
  })

  it('names no city for what is not one segment of slug shape', () => {
    expect(parseSitePath('/api/cities/berlin/').city).toBeNull()
    expect(parseSitePath('/assets/index-abc.js').city).toBeNull()
    expect(parseSitePath('/Berlin/').city).toBeNull()
    expect(parseSitePath('/en/en/').city).toBeNull()
    // Whether the segment is a city this build knows is the caller's business
    expect(parseSitePath('/atlantis/').city).toBe('atlantis')
  })

  it('writes the German page bare and the English one under /en/', () => {
    expect(formatSitePath('de', null)).toBe('/')
    expect(formatSitePath('en', null)).toBe('/en/')
    expect(formatSitePath('de', 'kiel')).toBe('/kiel/')
    expect(formatSitePath('en', 'kiel')).toBe('/en/kiel/')
  })
})
