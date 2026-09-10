import { describe, expect, it } from 'vitest'
import { formatSitePath, parseSitePath } from '@/lib/site-path'

describe('the site paths', () => {
  it('reads the language and the city off a path', () => {
    expect(parseSitePath('/')).toEqual({ lang: null, city: null })
    expect(parseSitePath('/en/')).toEqual({ lang: 'en', city: null })
    expect(parseSitePath('/berlin/')).toEqual({ lang: null, city: 'berlin' })
    expect(parseSitePath('/en/berlin/')).toEqual({ lang: 'en', city: 'berlin' })
    // Apache serves the directory's index.html; a typed path may lack the slash
    expect(parseSitePath('/berlin/index.html')).toEqual({ lang: null, city: 'berlin' })
    expect(parseSitePath('/en/berlin')).toEqual({ lang: 'en', city: 'berlin' })
    expect(parseSitePath('/index.html')).toEqual({ lang: null, city: null })
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
