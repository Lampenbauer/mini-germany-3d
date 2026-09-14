// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel, type ControlPanelProps } from '@/components/ControlPanel'
import { setLanguage } from '@/lib/i18n'

/**
 * The aircraft row at the very end of the traffic section, after the AIS
 * ships: like them not a line and without a timetable, hung off the
 * panel's own state – and, like them, never reached by the app's own
 * render under Vitest, where the traffic counts as unavailable.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

function panel(overrides: Partial<ControlPanelProps> = {}) {
  const onToggleAircraft = vi.fn()
  const props: ControlPanelProps = {
    city: { slug: 'frankfurt', name: 'Frankfurt', modes: ['tram'], ships: true },
    cities: [{ slug: 'frankfurt', name: 'Frankfurt', modes: ['tram'], ships: true }],
    cityLoading: false,
    onSelectCity: vi.fn(),
    clockText: '12:00:00',
    speed: 1,
    paused: false,
    onSpeedChange: vi.fn(),
    onTogglePause: vi.fn(),
    pickedDate: null,
    enteredTime: null,
    onSetTime: vi.fn(),
    onResetTime: vi.fn(),
    onSetDate: vi.fn(),
    lines: [
      { id: '11', name: 'Line 11', color: '#a00', mode: 'tram', from: 'Höchst', to: 'Fechenheim', visible: true },
    ],
    onToggleLine: vi.fn(),
    onFocusLine: vi.fn(),
    onSetLinesVisible: vi.fn(),
    aisAvailable: true,
    showAisVessels: true,
    onToggleAisVessels: vi.fn(),
    activity: null,
    aisVesselCount: 3,
    aircraftAvailable: true,
    showAircraft: true,
    onToggleAircraft,
    aircraftCount: 0,
    onShowCityFacts: vi.fn(),
    ...overrides,
  }
  render(<ControlPanel {...props} />)
  return { onToggleAircraft }
}

describe('the aircraft in the control panel', () => {
  it('offers a switch of its own, last in the list after the ships', () => {
    panel()
    const list = screen.getByTestId('line-list')
    expect(within(list).getByText('Aircraft')).toBeInTheDocument()
    const switches = within(list).getAllByRole('switch')
    expect(switches[switches.length - 1]).toHaveAttribute('aria-label', 'Show the aircraft')
    expect(switches[switches.length - 2]).toHaveAttribute('aria-label', 'Show the AIS ships')
  })

  it('reports the switch instead of moving on its own', () => {
    const { onToggleAircraft } = panel({ showAircraft: true })
    const toggle = screen.getByRole('switch', { name: 'Show the aircraft' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(onToggleAircraft).toHaveBeenCalledWith(false)
  })

  it('counts the aircraft while the switch is on, and not while it is off', () => {
    panel({ aircraftCount: 27 })
    expect(screen.getByTestId('aircraft-count')).toHaveTextContent('(27)')
    cleanup()
    panel({ aircraftCount: 27, showAircraft: false })
    expect(screen.queryByTestId('aircraft-count')).not.toBeInTheDocument()
  })

  it('leaves the row out where there is no live traffic to reach', () => {
    panel({ aircraftAvailable: false })
    expect(screen.queryByText('Aircraft')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Show the aircraft' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'What the clock does to the aircraft' }),
    ).not.toBeInTheDocument()
  })

  it('explains behind an info button that a clock set back replays the recording', async () => {
    panel()
    const info = screen.getByRole('button', { name: 'What the clock does to the aircraft' })
    fireEvent.focus(info)
    const note = await screen.findAllByText(/fly in real time/i)
    expect(note.length).toBeGreaterThan(0)
    expect(note[0]).toHaveTextContent(/set back – up to four days – replays the traffic recorded then/i)
    expect(note[0]).toHaveTextContent(/only pausing holds them/i)
  })

  it('translates the row into German', () => {
    setLanguage('de')
    panel()
    expect(screen.getByText('Flugzeuge')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Flugzeuge anzeigen' })).toBeInTheDocument()
  })
})
