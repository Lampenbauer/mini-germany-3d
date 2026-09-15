// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AircraftCard } from '@/components/AircraftCard'
import type { Aircraft } from '@/lib/aircraft-extract'
import { setLanguage } from '@/lib/i18n'
import { offThePhone, onAPhone } from './phone'

/**
 * The card for a clicked aircraft. Everything on it is what a
 * transponder chooses to send – a light aircraft has no callsign, an
 * older one no geometric altitude, a multilaterated position no speed –
 * so the interesting cases are the missing ones, as on the ship card.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
  offThePhone()
})

const NOW = 1_800_000_000_000

function aircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    hex: '3c65a2',
    callsign: 'DLH3Y',
    registration: 'D-AIMB',
    typeCode: 'A388',
    description: 'AIRBUS A-380-800',
    category: 'A5',
    lat: 50.2,
    lon: 8.1,
    altGeomM: 10850.9,
    altBaroM: 10553.7,
    onGround: false,
    gsKn: 457.7,
    trackDeg: 291.8,
    headingDeg: 297.7,
    verticalRateMps: 5,
    rollDeg: 0,
    squawk: '0616',
    source: 'adsb',
    positionAt: NOW - 8_000,
    track: [],
    ...overrides,
  }
}

function show(a: Aircraft, props: Partial<Parameters<typeof AircraftCard>[0]> = {}) {
  const onToggleFollow = vi.fn()
  const onClose = vi.fn()
  render(
    <AircraftCard
      aircraft={a}
      nowMs={NOW}
      following={false}
      onToggleFollow={onToggleFollow}
      onClose={onClose}
      {...props}
    />,
  )
  return { onToggleFollow, onClose }
}

describe('AircraftCard', () => {
  it('names the flight and states what the transponder sent', () => {
    show(aircraft())
    expect(screen.getByTestId('aircraft-name')).toHaveTextContent('DLH3Y')
    expect(screen.getByTestId('aircraft-type')).toHaveTextContent('AIRBUS A-380-800')
    expect(screen.getByTestId('aircraft-registration')).toHaveTextContent('D-AIMB')
    expect(screen.getByTestId('aircraft-hex')).toHaveTextContent('ICAO 3c65a2')
    // toHaveTextContent folds the thin space into a plain one
    expect(screen.getByTestId('aircraft-altitude')).toHaveTextContent(/10.851 m · FL346/)
    expect(screen.getByTestId('aircraft-speed')).toHaveTextContent('458 kn · 848 km/h')
    expect(screen.getByTestId('aircraft-climb')).toHaveTextContent('+5.0 m/s')
    expect(screen.getByText(/Live from ADS-B/)).toBeInTheDocument()
    expect(document.querySelector('.animate-pulse')).not.toBeNull()
    expect(screen.getByText(/last update 8 s ago/)).toBeInTheDocument()
    expect(screen.queryByTestId('aircraft-mlat')).not.toBeInTheDocument()
  })

  it('says recorded, without the pulse, for an aircraft replayed from the archive', () => {
    // As on the ship card: the pulse means "live", a replayed aircraft is
    // a fact of the past, and its fix age is measured on the clock that
    // replays it
    show(aircraft({ positionAt: NOW - 120_000 }), { recorded: true, nowMs: NOW })
    expect(screen.getByText(/Recorded from ADS-B/)).toBeInTheDocument()
    expect(screen.queryByText(/Live from ADS-B/)).not.toBeInTheDocument()
    expect(document.querySelector('.animate-pulse')).toBeNull()
    expect(screen.getByText(/last update 2 min ago/)).toBeInTheDocument()
  })

  it('falls back to the registration, and says what it does not know', () => {
    show(
      aircraft({
        callsign: '',
        registration: 'D-EQBK',
        typeCode: 'A210',
        description: '',
        altGeomM: null,
        altBaroM: 228.6,
        gsKn: null,
        verticalRateMps: null,
        source: 'mlat',
      }),
    )
    expect(screen.getByTestId('aircraft-name')).toHaveTextContent('D-EQBK')
    // The registration is the title already – not repeated in the lead
    expect(screen.queryByTestId('aircraft-registration')).not.toBeInTheDocument()
    expect(screen.getByTestId('aircraft-type')).toHaveTextContent('A210')
    // Below 1500 m no flight level is given – nobody flies one down there
    expect(screen.getByTestId('aircraft-altitude')).toHaveTextContent(/^229 m$/)
    expect(screen.getByTestId('aircraft-speed')).toHaveTextContent('not reported')
    expect(screen.getByTestId('aircraft-climb')).toHaveTextContent('not reported')
    expect(screen.getByTestId('aircraft-mlat')).toHaveTextContent('position by multilateration')
  })

  it('says "on the ground" for a taxiing aircraft, and "Type unknown" without a type', () => {
    show(aircraft({ onGround: true, altGeomM: null, altBaroM: null, verticalRateMps: null, typeCode: '', description: '' }))
    expect(screen.getByTestId('aircraft-altitude')).toHaveTextContent('on the ground')
    expect(screen.getByTestId('aircraft-climb')).toHaveTextContent('on the ground')
    expect(screen.getByTestId('aircraft-type')).toHaveTextContent('Type unknown')
  })

  it('offers to follow, and reports both buttons', () => {
    const { onToggleFollow, onClose } = show(aircraft())
    fireEvent.click(screen.getByRole('button', { name: 'Follow aircraft' }))
    expect(onToggleFollow).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close selection' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    cleanup()
    show(aircraft(), { following: true })
    expect(screen.getByRole('button', { name: 'Stop following' })).toBeInTheDocument()
  })

  it('folds to its head on a phone, like the ship card, the follow staying in the head', () => {
    onAPhone()
    show(aircraft())
    fireEvent.click(screen.getByRole('button', { name: 'Collapse card' }))
    expect(screen.getByTestId('aircraft-name')).toHaveTextContent('DLH3Y')
    expect(screen.queryByTestId('aircraft-altitude')).toBeNull()
    expect(screen.getByRole('button', { name: 'Follow aircraft' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand card' }))
    expect(screen.getByTestId('aircraft-altitude')).toBeInTheDocument()
  })

  it('speaks German', () => {
    setLanguage('de')
    show(aircraft())
    expect(screen.getByText(/Live per ADS-B/)).toBeInTheDocument()
    expect(screen.getByText('Höhe')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Flugzeug folgen' })).toBeInTheDocument()
  })
})
