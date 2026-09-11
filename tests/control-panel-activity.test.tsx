// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ControlPanel,
  type ControlPanelProps,
  type LineToggleInfo,
} from '@/components/ControlPanel'
import { setLanguage } from '@/lib/i18n'

/**
 * The live counts in the control panel – how much of the fleet is out,
 * per mode and in all – and the info button in its head that opens the
 * city card. The counts are the simulation's, so they belong in the panel
 * (see the working notes); what they must not do is show a zero before
 * the simulation has said anything.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

const line = (id: string, mode: LineToggleInfo['mode']): LineToggleInfo => ({
  id,
  name: `Line ${id}`,
  color: '#0aa',
  mode,
  from: 'A',
  to: 'B',
  visible: true,
})

function panel(overrides: Partial<ControlPanelProps> = {}) {
  const onShowCityFacts = vi.fn()
  const props: ControlPanelProps = {
    city: { slug: 'rostock', name: 'Rostock', modes: ['tram', 'bus', 'ferry'], ships: true },
    cities: [{ slug: 'rostock', name: 'Rostock', modes: ['tram', 'bus', 'ferry'], ships: true }],
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
    lines: [line('1', 'tram'), line('22', 'bus'), line('FG', 'ferry')],
    onToggleLine: vi.fn(),
    onFocusLine: vi.fn(),
    onSetLinesVisible: vi.fn(),
    aisAvailable: true,
    showAisVessels: true,
    onToggleAisVessels: vi.fn(),
    activity: { total: 41, byMode: { tram: 38, bus: 3 }, delay: null },
    aisVesselCount: 14,
    aircraftAvailable: false,
    showAircraft: false,
    onToggleAircraft: vi.fn(),
    aircraftCount: 0,
    onShowCityFacts,
    ...overrides,
  }
  render(<ControlPanel {...props} />)
  return { onShowCityFacts }
}

describe('the live counts in the control panel', () => {
  it('writes the fleet beside the traffic heading and per mode beside the group headers', () => {
    panel()
    expect(screen.getByTestId('running-total')).toHaveTextContent('41 out now')
    // The groups carry the bare number; the heading has said "out now" once
    expect(screen.getByTestId('running-tram')).toHaveTextContent(/^\(38\)$/)
    expect(screen.getByTestId('running-tram')).toHaveAttribute('title', '38 out now')
    // A mode with nothing out reads zero, not nothing – the ferries are
    // simply not running, which is a fact about the moment
    expect(screen.getByTestId('running-ferry')).toHaveTextContent(/^\(0\)$/)
    expect(screen.getByTestId('ais-count')).toHaveTextContent(/^\(14\)$/)
    expect(screen.getByTestId('ais-count')).toHaveAttribute('title', '14 ships')
  })

  it('shows no counts before the first snapshot', () => {
    panel({ activity: null, aisVesselCount: 0 })
    expect(screen.queryByTestId('running-total')).not.toBeInTheDocument()
    expect(screen.queryByTestId('running-tram')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ais-count')).not.toBeInTheDocument()
  })

  it('drops the ship count with the AIS switch off', () => {
    panel({ showAisVessels: false })
    expect(screen.queryByTestId('ais-count')).not.toBeInTheDocument()
  })

  it('speaks German', () => {
    setLanguage('de')
    panel()
    expect(screen.getByTestId('running-total')).toHaveTextContent('41 unterwegs')
    expect(screen.getByTestId('ais-count')).toHaveAttribute('title', '14 Schiffe')
  })
})

describe('the info button in the panel head', () => {
  it('is named for the city and opens the city card', () => {
    const { onShowCityFacts } = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Rostock in numbers' }))
    expect(onShowCityFacts).toHaveBeenCalledTimes(1)
  })

  it('waits while the city loads', () => {
    panel({ cityLoading: true })
    expect(screen.getByRole('button', { name: 'Rostock in numbers' })).toBeDisabled()
  })
})
