// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CreditsDialog } from '@/components/CreditsDialog'
import { setLanguage } from '@/lib/i18n'

/**
 * The credits dialog holds no credits of its own: Cesium rewrites its
 * list on every frame, so the dialog borrows that element while it is
 * open and hands it back when it closes. Anything else would show the
 * sources as they stood the moment somebody pressed the link.
 *
 * The stand-in here does what CesiumMap.borrowCreditList does – move the
 * element, keep no copy.
 */
afterEach(() => {
  cleanup()
  setLanguage('en')
})

function creditList() {
  const home = document.createElement('div')
  const list = document.createElement('ul')
  list.innerHTML = '<li>© OpenStreetMap contributors</li>'
  home.appendChild(list)
  document.body.appendChild(home)
  return { home, list, borrow: (host: HTMLElement | null) => (host ?? home).appendChild(list) }
}

describe('the credits dialog', () => {
  it('borrows Cesium’s list while it is open and hands it back', () => {
    const { home, list, borrow } = creditList()
    const props = { onOpenChange: () => {}, borrow }
    const { rerender } = render(<CreditsDialog open={false} {...props} />)
    expect(home.contains(list)).toBe(true)

    rerender(<CreditsDialog open {...props} />)
    const dialog = screen.getByRole('dialog', { name: 'Data attribution' })
    expect(dialog.contains(list)).toBe(true)
    expect(dialog).toHaveTextContent('OpenStreetMap')

    rerender(<CreditsDialog open={false} {...props} />)
    expect(home.contains(list)).toBe(true)
  })

  it('speaks the language of the interface', () => {
    setLanguage('de')
    const { borrow } = creditList()
    render(<CreditsDialog open onOpenChange={() => {}} borrow={borrow} />)
    expect(screen.getByRole('dialog', { name: 'Datenquellen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Datenquellen schließen' })).toBeInTheDocument()
  })
})
