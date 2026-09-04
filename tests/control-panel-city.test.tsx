import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel, type CityChoice, type ControlPanelProps } from '@/components/ControlPanel'
import { setLanguage } from '@/lib/i18n'

/**
 * The city picker behind the caret beside the panel title. The app's own
 * render never shows it under Vitest, where the registry holds one city
 * and the caret stays out (see app.test.tsx) – so the panel is rendered
 * here with two.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

const ROSTOCK: CityChoice = { slug: 'rostock', name: 'Rostock', modes: ['tram', 'ferry'] }
const HAMBURG: CityChoice = { slug: 'hamburg', name: 'Hamburg', modes: ['subway', 'ferry'] }

function panel(overrides: Partial<ControlPanelProps> = {}) {
  const onSelectCity = vi.fn()
  const props: ControlPanelProps = {
    city: ROSTOCK,
    cities: [ROSTOCK, HAMBURG],
    cityLoading: false,
    onSelectCity,
    clockText: '12:00:00',
    speed: 1,
    paused: false,
    onSpeedChange: vi.fn(),
    onTogglePause: vi.fn(),
    onSetTime: vi.fn(),
    onResetTime: vi.fn(),
    lines: [],
    onToggleLine: vi.fn(),
    onFocusLine: vi.fn(),
    onSetLinesVisible: vi.fn(),
    showRoutes: true,
    onToggleRoutes: vi.fn(),
    showStops: true,
    onToggleStops: vi.fn(),
    showLabels: true,
    onToggleLabels: vi.fn(),
    aisAvailable: false,
    showAisVessels: false,
    onToggleAisVessels: vi.fn(),
    ...overrides,
  }
  render(<ControlPanel {...props} />)
  return { onSelectCity }
}

describe('the city picker in the control panel', () => {
  it('names the city in the title and offers the caret', () => {
    panel()
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    expect(screen.getByRole('button', { name: 'Choose a city' })).toBeInTheDocument()
  })

  it('lists every city, marks the current one, and switches on a click', () => {
    const { onSelectCity } = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a city' }))
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(screen.getByRole('option', { name: 'Rostock' })).toHaveAttribute('aria-selected', 'true')
    const hamburg = screen.getByRole('option', { name: 'Switch to Hamburg' })
    expect(hamburg).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(hamburg)
    expect(onSelectCity).toHaveBeenCalledWith('hamburg')
    // The list closes with the choice
    expect(screen.queryByRole('option', { name: 'Switch to Hamburg' })).not.toBeInTheDocument()
  })

  it('does not switch to the city already shown', () => {
    const { onSelectCity } = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a city' }))
    fireEvent.click(screen.getByRole('option', { name: 'Rostock' }))
    expect(onSelectCity).not.toHaveBeenCalled()
  })

  it('waits while a city is loading', () => {
    panel({ cityLoading: true })
    expect(screen.getByRole('button', { name: 'Choose a city' })).toBeDisabled()
  })

  it('speaks German too', () => {
    setLanguage('de')
    panel()
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    fireEvent.click(screen.getByRole('button', { name: 'Stadt wählen' }))
    expect(screen.getByRole('option', { name: 'Nach Hamburg wechseln' })).toBeInTheDocument()
  })
})
