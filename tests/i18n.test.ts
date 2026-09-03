import { afterEach, describe, expect, it } from 'vitest'
import { detectLanguage, getLanguage, localizeLineName, setLanguage, t } from '@/lib/i18n'

afterEach(() => {
  setLanguage('en')
})

describe('detectLanguage', () => {
  it('defaults to English', () => {
    expect(detectLanguage(null, [])).toBe('en')
    expect(detectLanguage(null, ['fr-FR', 'es'])).toBe('en')
  })

  it('uses German when the browser prefers it', () => {
    expect(detectLanguage(null, ['de-DE', 'de', 'en-US'])).toBe('de')
    expect(detectLanguage(null, ['de'])).toBe('de')
    expect(detectLanguage(null, ['DE-de'])).toBe('de')
  })

  it('respects the preference order among supported languages', () => {
    // English ranked above German stays English …
    expect(detectLanguage(null, ['en-US', 'de-DE'])).toBe('en')
    // … while unsupported languages ahead of German do not block it
    expect(detectLanguage(null, ['fr-FR', 'de-DE', 'en-US'])).toBe('de')
  })

  it('lets ?lang= override the browser preference', () => {
    expect(detectLanguage('de', ['en-US'])).toBe('de')
    expect(detectLanguage('en', ['de-DE'])).toBe('en')
    // Unsupported values fall back to detection
    expect(detectLanguage('fr', ['de-DE'])).toBe('de')
  })
})

describe('t', () => {
  it('returns English by default and interpolates parameters', () => {
    expect(getLanguage()).toBe('en')
    expect(t('traffic.title')).toBe('Traffic')
    expect(t('vehicle.late', { count: 3 })).toBe('3 min late')
  })

  it('switches every message to German', () => {
    setLanguage('de')
    expect(t('traffic.title')).toBe('Verkehr')
    expect(t('layers.stops')).toBe('Haltestellen')
    expect(t('vehicle.late', { count: 3 })).toBe('3 min Verspätung')
    expect(t('lines.flyTo', { name: 'Linie 1' })).toBe('Zu Linie 1 fliegen')
  })
})

describe('localizeLineName', () => {
  it('keeps the English names untouched by default', () => {
    expect(localizeLineName('Line 1')).toBe('Line 1')
    expect(localizeLineName('Ferry Kabutzenhof – Gehlsdorf')).toBe(
      'Ferry Kabutzenhof – Gehlsdorf',
    )
  })

  it('swaps the generic prefixes for German', () => {
    setLanguage('de')
    expect(localizeLineName('Line 1')).toBe('Linie 1')
    expect(localizeLineName('Ferry Kabutzenhof – Gehlsdorf')).toBe(
      'Fähre Kabutzenhof – Gehlsdorf',
    )
    // Already language-neutral names stay as they are
    expect(localizeLineName('Bus 22')).toBe('Bus 22')
    expect(localizeLineName('S-Bahn S1')).toBe('S-Bahn S1')
  })
})
