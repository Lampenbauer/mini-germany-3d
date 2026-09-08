import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel, type ControlPanelProps } from '@/components/ControlPanel'
import { setLanguage } from '@/lib/i18n'

/**
 * The AIS row at the end of the traffic section. The ships are not a line
 * and have no timetable, so they hang off the panel's own state rather than
 * off the network – which is exactly why they need a test of their own: the
 * app's own render never reaches this row under Vitest, where AIS counts as
 * unavailable (see aisAvailable in App.tsx).
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

function panel(overrides: Partial<ControlPanelProps> = {}) {
  const onToggleAisVessels = vi.fn()
  const props: ControlPanelProps = {
    city: { slug: 'rostock', name: 'Rostock', modes: ['ferry'] },
    cities: [{ slug: 'rostock', name: 'Rostock', modes: ['ferry'] }],
    cityLoading: false,
    onSelectCity: vi.fn(),
    clockText: '12:00:00',
    speed: 1,
    paused: false,
    onSpeedChange: vi.fn(),
    onTogglePause: vi.fn(),
    onSetTime: vi.fn(),
    onResetTime: vi.fn(),
    onSetDate: vi.fn(),
    lines: [
      {
        id: 'FG',
        name: 'Ferry Kabutzenhof – Gehlsdorf',
        color: '#0aa',
        mode: 'ferry',
        from: 'Kabutzenhof',
        to: 'Gehlsdorf',
        visible: true,
      },
    ],
    onToggleLine: vi.fn(),
    onFocusLine: vi.fn(),
    onSetLinesVisible: vi.fn(),
    aisAvailable: true,
    showAisVessels: true,
    onToggleAisVessels,
    activity: null,
    aisVesselCount: 0,
    onShowCityFacts: vi.fn(),
    ...overrides,
  }
  render(<ControlPanel {...props} />)
  return { onToggleAisVessels }
}

describe('the AIS ships in the control panel', () => {
  it('offers a switch of its own, after the lines it shares the water with', () => {
    panel()
    const list = screen.getByTestId('line-list')
    expect(within(list).getByText('AIS ships')).toBeInTheDocument()
    expect(within(list).getByRole('switch', { name: 'Show the AIS ships' })).toBeInTheDocument()
    // Last in the list: the ferry line above it is the one it follows
    const switches = within(list).getAllByRole('switch')
    expect(switches[switches.length - 1]).toHaveAttribute('aria-label', 'Show the AIS ships')
  })

  it('reports the switch instead of moving on its own', () => {
    const { onToggleAisVessels } = panel({ showAisVessels: true })
    const toggle = screen.getByRole('switch', { name: 'Show the AIS ships' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(onToggleAisVessels).toHaveBeenCalledWith(false)
  })

  it('shows the switch off when the fleet is off', () => {
    panel({ showAisVessels: false })
    expect(screen.getByRole('switch', { name: 'Show the AIS ships' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('leaves the row out where there is no live AIS to reach', () => {
    // Offline, in the tests and without an endpoint the switch could not
    // change anything – so it is not offered at all.
    panel({ aisAvailable: false })
    expect(screen.queryByText('AIS ships')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Show the AIS ships' })).not.toBeInTheDocument()
  })

  it('explains behind an info button that the clock leaves the ships alone', async () => {
    // Every other moving thing on the map runs on the panel's clock. The
    // ships do not, and that note is the reason the button is there.
    panel()
    const info = screen.getByRole('button', { name: 'What the clock does to the ships' })
    fireEvent.focus(info)
    const note = await screen.findAllByText(/sail in real time/i)
    expect(note.length).toBeGreaterThan(0)
    expect(note[0]).toHaveTextContent(/only pausing holds them/i)
  })

  it('leaves the info button out with the row it belongs to', () => {
    panel({ aisAvailable: false })
    expect(
      screen.queryByRole('button', { name: 'What the clock does to the ships' }),
    ).not.toBeInTheDocument()
  })

  it('heads the whole section as traffic rather than as lines', () => {
    // The section holds scheduled lines and unscheduled harbor traffic –
    // "Lines" stopped being true for it when the ships moved in.
    panel()
    expect(screen.getByText('Traffic')).toBeInTheDocument()
    expect(screen.queryByText('Lines')).not.toBeInTheDocument()
  })

  it('translates the row into German', () => {
    setLanguage('de')
    panel()
    expect(screen.getByText('Verkehr')).toBeInTheDocument()
    expect(screen.getByText('AIS-Schiffe')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'AIS-Schiffe anzeigen' })).toBeInTheDocument()
  })
})
