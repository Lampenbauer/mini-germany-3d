// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WelcomeScreen, type WelcomeScreenProps } from '@/components/WelcomeScreen'
import type { CityChoice } from '@/components/ControlPanel'
import { setLanguage } from '@/lib/i18n'
import { WELCOME_STORAGE_KEY, setWelcomeHidden, welcomeHidden, welcomeWanted } from '@/lib/welcome'

/**
 * The front door (see lib/welcome.ts and components/WelcomeScreen):
 * when it opens, and what it offers once it has. The app's own boot
 * through it is covered in app.test.tsx.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

const ROSTOCK: CityChoice = { slug: 'rostock', name: 'Rostock', modes: ['tram', 'ferry'], ships: true }
const KIEL: CityChoice = { slug: 'kiel', name: 'Kiel', modes: ['bus', 'ferry'], ships: true }
const MUNICH: CityChoice = { slug: 'munich', name: 'Munich', modes: ['tram', 'subway', 'train', 'bus'], ships: false }
const COLOGNE: CityChoice = { slug: 'cologne', name: 'Cologne', modes: ['tram', 'train', 'bus'], ships: true }
const LUEBECK: CityChoice = { slug: 'lubeck', name: 'Lübeck', modes: ['bus'], ships: true }

/** A storage that remembers, the way localStorage does. */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

function door(overrides: Partial<WelcomeScreenProps> = {}) {
  const onPick = vi.fn()
  render(
    <WelcomeScreen
      open
      cities={[ROSTOCK, KIEL, MUNICH, COLOGNE, LUEBECK]}
      picked={null}
      hideNextTime={false}
      onPick={onPick}
      {...overrides}
    />,
  )
  return { onPick }
}

describe('when the welcome screen opens', () => {
  it('opens on a plain visit and stays away once the reader asked it to', () => {
    expect(welcomeWanted('', '', memoryStorage())).toBe(true)
    expect(welcomeWanted('', '', memoryStorage({ [WELCOME_STORAGE_KEY]: 'hidden' }))).toBe(false)
    // No storage to ask (private mode): the door opens every time
    expect(welcomeWanted('', '', null)).toBe(true)
  })

  it('stays away for a link that says where to go', () => {
    const storage = memoryStorage()
    expect(welcomeWanted('', '#city=kiel&weather=clear', storage)).toBe(false)
    expect(welcomeWanted('', '#lat=54.08&lon=12.13&height=3000&heading=0&pitch=-40', storage)).toBe(false)
    expect(welcomeWanted('', '#vehicle=1-0-510', storage)).toBe(false)
    expect(welcomeWanted('', '#vessel=211222520', storage)).toBe(false)
    expect(welcomeWanted('', '#stop=n123', storage)).toBe(false)
    // A preference alone names no place
    expect(welcomeWanted('', '#routes=0', storage)).toBe(true)
  })

  it('is forced either way from the URL', () => {
    expect(welcomeWanted('?welcome=0', '', memoryStorage())).toBe(false)
    expect(welcomeWanted('?offline=1&welcome=1', '#city=kiel', memoryStorage({ [WELCOME_STORAGE_KEY]: 'hidden' }))).toBe(true)
  })

  it('keeps the wish and drops it again', () => {
    const storage = memoryStorage()
    setWelcomeHidden(storage, true)
    expect(welcomeHidden(storage)).toBe(true)
    setWelcomeHidden(storage, false)
    expect(welcomeHidden(storage)).toBe(false)
    expect(storage.getItem(WELCOME_STORAGE_KEY)).toBeNull()
    // A storage that throws is no storage
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
    expect(welcomeHidden(broken)).toBe(false)
    expect(() => setWelcomeHidden(broken, true)).not.toThrow()
  })
})

describe('the welcome screen', () => {
  it('is a dialog with the question as its title, and no way past it but a city', () => {
    door()
    const dialog = screen.getByRole('dialog', { name: 'Which city would you like to see?' })
    expect(dialog).toHaveAttribute('data-testid', 'welcome-screen')
    expect(within(dialog).queryByRole('button', { name: /close/i })).not.toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
  })

  it('lists the cities by name in the language it speaks, with their modes said out loud', () => {
    door()
    const list = screen.getByRole('list', { name: 'Cities' })
    const names = within(list).getAllByRole('button').map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual(['Open Cologne', 'Open Kiel', 'Open Lübeck', 'Open Munich', 'Open Rostock'])
    // One ship for ships in general: Rostock's ferry line and Lübeck's
    // AIS harbour wear the same icon, Munich none
    expect(within(list).getByRole('button', { name: 'Open Rostock' })).toHaveTextContent('Tram, Ships')
    expect(within(list).getByRole('button', { name: 'Open Lübeck' })).toHaveTextContent('Bus, Ships')
    expect(within(list).getByRole('button', { name: 'Open Munich' })).not.toHaveTextContent('Ships')
  })

  it('sorts Köln under K in German', () => {
    setLanguage('de')
    door()
    const names = screen.getAllByRole('button', { name: /öffnen$/ }).map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual(['Kiel öffnen', 'Köln öffnen', 'Lübeck öffnen', 'München öffnen', 'Rostock öffnen'])
    expect(screen.getByRole('checkbox', { name: 'Diese Willkommensansicht bei deinem nächsten Besuch nicht mehr anzeigen' })).toBeInTheDocument()
  })

  it('hands over the city picked, with the checkbox as it stands', () => {
    const { onPick } = door()
    fireEvent.click(screen.getByRole('button', { name: 'Open Munich' }))
    expect(onPick).toHaveBeenLastCalledWith('munich', false)
    const box = screen.getByRole('checkbox', { name: 'Don’t show this welcome screen on your next visit' })
    expect(box).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(box)
    expect(box).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Open Kiel' }))
    expect(onPick).toHaveBeenLastCalledWith('kiel', true)
  })

  it('turns the picked card into a spinner and takes the other cards out of reach', () => {
    const { onPick } = door({ picked: 'kiel' })
    const kiel = screen.getByRole('button', { name: 'Loading Kiel …' })
    expect(kiel).toHaveAttribute('aria-busy', 'true')
    expect(kiel).toBeDisabled()
    expect(within(kiel).getByTestId('welcome-spinner')).toBeInTheDocument()
    expect(screen.queryByTestId('welcome-spinner')).toBe(within(kiel).getByTestId('welcome-spinner'))
    const rostock = screen.getByRole('button', { name: 'Open Rostock' })
    expect(rostock).toBeDisabled()
    fireEvent.click(rostock)
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    // The screen itself is still there, still a dialog
    expect(screen.getByRole('dialog', { name: 'Which city would you like to see?' })).toBeInTheDocument()
  })

  it('starts with the box ticked when the screen was forced open over a kept wish', () => {
    const { onPick } = door({ hideNextTime: true })
    const box = screen.getByRole('checkbox', { name: 'Don’t show this welcome screen on your next visit' })
    expect(box).toHaveAttribute('aria-checked', 'true')
    // Unticking it is how the wish is taken back
    fireEvent.click(box)
    fireEvent.click(screen.getByRole('button', { name: 'Open Rostock' }))
    expect(onPick).toHaveBeenLastCalledWith('rostock', false)
  })
})
