// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AboutDialog } from '@/components/AboutDialog'
import { LegalDialog } from '@/components/LegalDialog'
import { setLanguage } from '@/lib/i18n'
import { OPERATOR, legalText } from '@/lib/legal'

/**
 * The legal notice and the privacy notice (lib/legal.ts): the dialog
 * that shows them in the app, and the links at the About dialog's foot
 * that open it – not a tab of that dialog. The welcome screen's links
 * are in welcome-screen.test.tsx, the pages under the map in
 * site-pages.test.ts, the app's boot on one of their addresses in
 * app.test.tsx.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

describe('the legal texts', () => {
  it('carry the provider once, in both notices and both languages', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const kind of ['imprint', 'privacy'] as const) {
        const text = legalText(kind, lang)
        expect(text.title).not.toBe('')
        expect(text.lead).not.toBe('')
        expect(text.sections.length).toBeGreaterThan(2)
        const all = text.sections.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n')
        expect(all).toContain(OPERATOR.name)
        expect(all).toContain(OPERATOR.email)
        for (const section of text.sections) {
          expect(section.heading).not.toBe('')
          expect(section.paragraphs.length).toBeGreaterThan(0)
        }
      }
      // What the privacy notice says has to match what the app does
      const privacy = legalText('privacy', lang).sections.flatMap((s) => s.paragraphs).join('\n')
      expect(privacy).toContain('localStorage')
      expect(privacy).toContain('Open-Meteo')
      expect(privacy).toContain('Windy')
      expect(privacy).toContain('aisstream.io')
      expect(privacy).toContain('adsb.fi')
      expect(privacy).toContain('Cesium ion')
    }
    // The English one says which version binds
    expect(legalText('privacy', 'en').sections.at(-1)?.paragraphs[0]).toContain('German version is the binding one')
    expect(legalText('imprint', 'en').sections.at(-1)?.paragraphs[0]).toContain('German version is the binding one')
  })
})

describe('the legal dialog', () => {
  it('shows the notice asked for, with its sections, and none while closed', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<LegalDialog kind={null} onOpenChange={onOpenChange} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    rerender(<LegalDialog kind="privacy" onOpenChange={onOpenChange} />)
    const dialog = screen.getByRole('dialog', { name: 'Privacy' })
    expect(dialog).toHaveAttribute('data-testid', 'legal-dialog')
    for (const section of legalText('privacy', 'en').sections) {
      expect(within(dialog).getByRole('heading', { level: 3, name: section.heading })).toBeInTheDocument()
    }
    expect(dialog).toHaveTextContent(OPERATOR.email)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)

    rerender(<LegalDialog kind="imprint" onOpenChange={onOpenChange} />)
    expect(screen.getByRole('dialog', { name: 'Legal notice' })).toHaveTextContent(OPERATOR.street)
  })

  it('speaks German like the rest of the interface', () => {
    setLanguage('de')
    render(<LegalDialog kind="imprint" onOpenChange={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Impressum' })
    expect(dialog).toHaveTextContent('Angaben gemäß § 5 DDG')
    expect(within(dialog).getByRole('button', { name: 'Schließen' })).toBeInTheDocument()
  })
})

describe('the About dialog’s foot', () => {
  it('links both notices under every tab, without a tab of their own', () => {
    const onLegal = vi.fn()
    render(<AboutDialog open onOpenChange={() => {}} onLegal={onLegal} />)
    const dialog = screen.getByRole('dialog', { name: 'Mini Germany 3D' })
    // Three tabs, as before
    expect(within(dialog).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['The project', 'Good to know', 'Keyboard'])
    const legal = within(dialog).getByRole('navigation', { name: 'Legal' })
    expect(within(legal).getByRole('link', { name: 'Legal notice' })).toHaveAttribute('href', '/en/imprint/')
    expect(within(legal).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/en/privacy/')
    // Still there with another tab up
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Keyboard' }))
    fireEvent.click(within(legal).getByRole('link', { name: 'Legal notice' }))
    expect(onLegal).toHaveBeenLastCalledWith('imprint')
  })
})
