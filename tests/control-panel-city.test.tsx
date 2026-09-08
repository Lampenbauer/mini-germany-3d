import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel, type CityChoice, type ControlPanelProps } from '@/components/ControlPanel'
import { setLanguage } from '@/lib/i18n'

/**
 * The city picker: the panel's title, which opens the list of cities and
 * is named by the city it shows, the way a select is named by its value.
 * The app's own render never shows it under Vitest, where the registry
 * holds one city and the title stays plain text (see app.test.tsx) – so
 * the panel is rendered here with two.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

const ROSTOCK: CityChoice = { slug: 'rostock', name: 'Rostock', modes: ['tram', 'ferry'] }
const KIEL: CityChoice = { slug: 'kiel', name: 'Kiel', modes: ['bus', 'ferry'] }
const MUNICH: CityChoice = { slug: 'munich', name: 'Munich', modes: ['tram', 'subway', 'train', 'bus'] }
const COLOGNE: CityChoice = { slug: 'cologne', name: 'Cologne', modes: ['tram', 'train', 'bus'] }
const LUEBECK: CityChoice = { slug: 'lubeck', name: 'Lübeck', modes: ['bus'] }

function panel(overrides: Partial<ControlPanelProps> = {}) {
  const onSelectCity = vi.fn()
  const props: ControlPanelProps = {
    city: ROSTOCK,
    cities: [ROSTOCK, KIEL],
    cityLoading: false,
    onSelectCity,
    clockText: '12:00:00',
    speed: 1,
    paused: false,
    onSpeedChange: vi.fn(),
    onTogglePause: vi.fn(),
    onSetTime: vi.fn(),
    onResetTime: vi.fn(),
    onSetDate: vi.fn(),
    lines: [],
    onToggleLine: vi.fn(),
    onFocusLine: vi.fn(),
    onSetLinesVisible: vi.fn(),
    aisAvailable: false,
    showAisVessels: false,
    onToggleAisVessels: vi.fn(),
    activity: null,
    aisVesselCount: 0,
    onShowCityFacts: vi.fn(),
    ...overrides,
  }
  render(<ControlPanel {...props} />)
  return { onSelectCity }
}

describe('the city picker in the control panel', () => {
  it('makes the title itself the trigger, and says it opens a list', () => {
    panel()
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    const trigger = screen.getByRole('button', { name: 'Mini Rostock 3D' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    // The whole title is the button, not an icon beside it
    expect(screen.getByTestId('app-title').closest('button')).toBe(trigger)
  })

  it('lists every city, marks the current one, and switches on a click', () => {
    const { onSelectCity } = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(screen.getByRole('option', { name: 'Rostock' })).toHaveAttribute('aria-selected', 'true')
    const kiel = screen.getByRole('option', { name: 'Switch to Kiel' })
    expect(kiel).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(kiel)
    expect(onSelectCity).toHaveBeenCalledWith('kiel')
    // The list closes with the choice
    expect(screen.queryByRole('option', { name: 'Switch to Kiel' })).not.toBeInTheDocument()
  })

  it('does not switch to the city already shown', () => {
    const { onSelectCity } = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    fireEvent.click(screen.getByRole('option', { name: 'Rostock' }))
    expect(onSelectCity).not.toHaveBeenCalled()
  })

  it('waits while a city is loading', () => {
    panel({ cityLoading: true })
    expect(screen.getByRole('button', { name: 'Mini Rostock 3D' })).toBeDisabled()
  })

  it('leaves the title plain where there is nowhere else to go', () => {
    panel({ cities: [ROSTOCK] })
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    expect(screen.queryByRole('button', { name: 'Mini Rostock 3D' })).not.toBeInTheDocument()
  })

  it('speaks German too', () => {
    setLanguage('de')
    panel()
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    expect(screen.getByRole('option', { name: 'Nach Kiel wechseln' })).toBeInTheDocument()
  })

  it('lists the cities by name, in the language of the interface', () => {
    // The registry's own order is roughly north to south; the list is
    // alphabetical, and by the name shown – Köln belongs under K, Cologne
    // under C – with umlauts where a dictionary puts them.
    const cities = [ROSTOCK, MUNICH, KIEL, COLOGNE, LUEBECK]
    const names = () => screen.getAllByRole('option').map((o) => o.textContent)
    panel({ city: ROSTOCK, cities })
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    expect(names()).toEqual(['Cologne', 'Kiel', 'Lübeck', 'Munich', 'Rostock'])
    cleanup()
    setLanguage('de')
    panel({ city: ROSTOCK, cities })
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    expect(names()).toEqual(['Kiel', 'Köln', 'Lübeck', 'München', 'Rostock'])
  })

  it('names a city in the language of the interface', () => {
    // The definition spells the city in English (slug and folder are
    // English too); the German interface shows the German name.
    panel({ city: MUNICH, cities: [ROSTOCK, MUNICH] })
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Munich 3D')
    fireEvent.click(screen.getByRole('button', { name: 'Mini Munich 3D' }))
    expect(screen.getByRole('option', { name: 'Munich' })).toHaveAttribute('aria-selected', 'true')
    cleanup()
    setLanguage('de')
    panel({ city: ROSTOCK, cities: [ROSTOCK, MUNICH] })
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    const munich = screen.getByRole('option', { name: 'Nach München wechseln' })
    expect(munich).toHaveTextContent('München')
    fireEvent.click(munich)
  })
})
