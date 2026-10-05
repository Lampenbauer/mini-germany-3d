// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VehicleCard, formatDelay, formatDelayLong } from '@/components/VehicleCard'
import { config } from '@/config'
import type { InterchangeOption } from '@/lib/interchange'
import type { TripProgress, VehicleSnapshot } from '@/engine/simulation'
import { offThePhone, onAPhone } from './phone'

afterEach(() => {
  cleanup()
  offThePhone()
})

const vehicle: VehicleSnapshot = {
  id: '1-0-510',
  lineId: '1',
  lineName: 'Line 1',
  color: '#e2001a',
  mode: 'tram',
  vehicle: config.vehicles.tram,
  direction: 0,
  distance: 0,
  lon: 12.13,
  lat: 54.08,
  bearing: 90,
  status: 'moving',
  inTunnel: false,
  gradient: 0,
  nextStopName: 'Doberaner Platz',
  destination: 'Hafenallee',
  origin: 'Mecklenburger Allee',
  delaySeconds: 0,
  realtime: false,
}

const noop = () => {}

/** 08:30 – the fixture arrivals sit a few minutes after it. */
const SIM_SECONDS = 8 * 3600 + 30 * 60

/**
 * Where a passenger can change (the card's own line is 1). Doberaner Platz
 * reaches line 6 across the square, Kröpeliner Tor has 4 and 5.
 */
const interchangeByStop = new Map<string, InterchangeOption[]>([
  [
    'doberaner-platz',
    [
      { id: '1', color: '#5D106A' },
      { id: '6', color: '#94368D' },
    ],
  ],
  [
    'kroepeliner-tor',
    [
      { id: '1', color: '#5D106A' },
      { id: '4', color: '#e2001a' },
      { id: '5', color: '#f39200' },
    ],
  ],
])

// Vehicle underway between Lange Straße (passed) and Doberaner Platz:
// position 0.5 = halfway along the first segment.
const progress: TripProgress = {
  stops: [
    {
      id: 'lange-strasse',
      name: 'Lange Straße',
      arrivalSec: 8 * 3600 + 29 * 60,
      lon: 12.135,
      lat: 54.089,
      passed: true,
    },
    {
      id: 'doberaner-platz',
      name: 'Doberaner Platz',
      arrivalSec: 8 * 3600 + 31 * 60,
      lon: 12.115,
      lat: 54.088,
      passed: false,
    },
    // Seconds are floored to the displayed minute
    {
      id: 'kroepeliner-tor',
      name: 'Kröpeliner Tor',
      arrivalSec: 8 * 3600 + 33 * 60 + 40,
      lon: 12.125,
      lat: 54.088,
      passed: false,
    },
  ],
  position: 0.5,
}

describe('formatDelayLong', () => {
  it('spells out a late vehicle', () => {
    expect(formatDelayLong(180)).toBe('3 min late')
  })

  it('spells out an early one – the feed does report those', () => {
    expect(formatDelayLong(-120)).toBe('2 min early')
    // The minute count must not carry the sign into the sentence
    expect(formatDelayLong(-60)).toBe('1 min early')
  })

  it('calls anything under a minute on time, either way', () => {
    expect(formatDelayLong(0)).toBe('on time')
    expect(formatDelayLong(59)).toBe('on time')
    expect(formatDelayLong(-59)).toBe('on time')
  })

  it('leaves the compact form for the stop card alone', () => {
    expect(formatDelay(180)).toBe('+3 min')
    expect(formatDelay(-120)).toBe('-2 min')
  })
})

describe('VehicleCard trip stops', () => {
  it('lists every stop with its arrival time, dimming the served ones', () => {
    render(
      <VehicleCard
        vehicle={vehicle}
        tripProgress={progress}
        simSeconds={SIM_SECONDS}
        interchangeByStop={interchangeByStop}
        onFlyToStop={noop}
        onSelectLine={noop}
        following={false}
        onToggleFollow={noop}
        onClose={noop}
      />,
    )
    expect(screen.getByText('Stops')).toBeInTheDocument()
    const list = screen.getByTestId('vehicle-trip-stops')
    const rows = list.querySelectorAll('li')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('08:29')
    expect(rows[1]).toHaveTextContent('08:31')
    expect(rows[2]).toHaveTextContent('08:33')
    // Served stops are dimmed
    expect(rows[0].querySelector('.opacity-50')).not.toBeNull()
    expect(rows[1].querySelector('.opacity-50')).toBeNull()
    // The next-stop row keeps the vehicle-next-stop testid (E2E contract)
    expect(screen.getByTestId('vehicle-next-stop')).toHaveTextContent('Doberaner Platz')
  })

  it('places the vehicle marker on the current segment', () => {
    render(
      <VehicleCard
        vehicle={vehicle}
        tripProgress={progress}
        simSeconds={SIM_SECONDS}
        interchangeByStop={interchangeByStop}
        onFlyToStop={noop}
        onSelectLine={noop}
        following={false}
        onToggleFollow={noop}
        onClose={noop}
      />,
    )
    const marker = screen.getByTestId('vehicle-position')
    // position 0.5 → marker in the first row, halfway down its segment
    const rows = screen.getByTestId('vehicle-trip-stops').querySelectorAll('li')
    expect(rows[0].contains(marker)).toBe(true)
    expect(marker.style.top).toBe('calc(50% + 0.625rem)')
    expect(marker.style.backgroundColor).toBe('rgb(226, 0, 26)')
  })

  it('rings the stop dot while dwelling there (integer position)', () => {
    render(
      <VehicleCard
        vehicle={vehicle}
        tripProgress={{ ...progress, position: 1 }}
        simSeconds={SIM_SECONDS}
        interchangeByStop={interchangeByStop}
        onFlyToStop={noop}
        onSelectLine={noop}
        following={false}
        onToggleFollow={noop}
        onClose={noop}
      />,
    )
    const marker = screen.getByTestId('vehicle-position')
    const rows = screen.getByTestId('vehicle-trip-stops').querySelectorAll('li')
    expect(rows[1].contains(marker)).toBe(true)
    // Fraction 0 → the marker sits exactly on the row's own dot
    expect(marker.style.top).toBe('calc(0% + 0.625rem)')
    // While dwelling at stop 1, the next stop is stop 2
    expect(screen.getByTestId('vehicle-next-stop')).toHaveTextContent('Kröpeliner Tor')
  })

  it('clicking a stop reports it for the camera flight', () => {
    const onFlyToStop = vi.fn()
    render(
      <VehicleCard
        vehicle={vehicle}
        tripProgress={progress}
        simSeconds={SIM_SECONDS}
        interchangeByStop={interchangeByStop}
        onFlyToStop={onFlyToStop}
        onSelectLine={noop}
        following={false}
        onToggleFollow={noop}
        onClose={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fly to Lange Straße' }))
    expect(onFlyToStop).toHaveBeenCalledWith(progress.stops[0])
  })

  it('falls back to the snapshot next stop when no timetable window exists', () => {
    render(
      <VehicleCard
        vehicle={vehicle}
        tripProgress={null}
        simSeconds={SIM_SECONDS}
        interchangeByStop={interchangeByStop}
        onFlyToStop={noop}
        onSelectLine={noop}
        following={false}
        onToggleFollow={noop}
        onClose={noop}
      />,
    )
    expect(screen.queryByTestId('vehicle-trip-stops')).not.toBeInTheDocument()
    expect(screen.getByText('Next stop')).toBeInTheDocument()
    expect(screen.getByTestId('vehicle-next-stop')).toHaveTextContent('Doberaner Platz')
  })
})

describe('VehicleCard summary', () => {
  const renderCard = (props: Partial<React.ComponentProps<typeof VehicleCard>> = {}) =>
    render(
      <VehicleCard
        vehicle={vehicle}
        tripProgress={progress}
        simSeconds={SIM_SECONDS}
        interchangeByStop={interchangeByStop}
        onFlyToStop={noop}
        onSelectLine={noop}
        following={false}
        onToggleFollow={noop}
        onClose={noop}
        {...props}
      />,
    )

  it('lifts the destination arrival out of the stop list', () => {
    renderCard()
    // Last stop arrives 08:33:40 → 08:33, three minutes after 08:30
    const arrival = screen.getByTestId('vehicle-arrival')
    expect(arrival).toHaveTextContent('08:33')
    expect(arrival).toHaveTextContent('in 3 min')
    // Two stops still ahead of the vehicle (position 0.5)
    expect(arrival).toHaveTextContent('2 stops to go')
  })

  it('says "arriving" instead of "in 0 min" right before the destination', () => {
    renderCard({ simSeconds: 8 * 3600 + 33 * 60 + 30 })
    expect(screen.getByTestId('vehicle-arrival')).toHaveTextContent('arriving')
  })

  it('marks the destination itself as the final stop', () => {
    renderCard({ tripProgress: { ...progress, position: 2 } })
    expect(screen.getByTestId('vehicle-arrival')).toHaveTextContent('final stop')
  })

  it('names the vehicle type and its length', () => {
    renderCard()
    const type = screen.getByTestId('vehicle-type')
    expect(type).toHaveTextContent('Tram')
    expect(type).toHaveTextContent('32 m')
  })

  it('shows the stop it stands at while dwelling, never its own line', () => {
    // position 1 = standing at Doberaner Platz. Those are the connections
    // a passenger can take right now – not the ones two minutes ahead.
    renderCard({ tripProgress: { ...progress, position: 1 } })
    expect(screen.getByText('Change at Doberaner Platz')).toBeInTheDocument()
    const badges = screen.getByTestId('vehicle-interchange')
    expect(badges).toHaveTextContent('6')
    expect(badges).not.toHaveTextContent('1')
  })

  it('makes each interchange badge a way to that line', () => {
    // Same thing clicking the line in the control panel does – the badge
    // names a line a passenger can change to, so it should lead there.
    const onSelectLine = vi.fn()
    renderCard({ onSelectLine })
    fireEvent.click(screen.getByRole('button', { name: 'Fly to 6' }))
    expect(onSelectLine).toHaveBeenCalledWith('6')
  })

  it('moves on to the stop ahead once the vehicle pulls away', () => {
    renderCard({ tripProgress: { ...progress, position: 1.1 } })
    expect(screen.getByText('Change at Kröpeliner Tor')).toBeInTheDocument()
    const badges = screen.getByTestId('vehicle-interchange')
    expect(badges).toHaveTextContent('4')
    expect(badges).toHaveTextContent('5')
    expect(badges).not.toHaveTextContent('6')
  })

  it('hides the interchange block where no other line is reachable', () => {
    // position 0 = standing at Lange Straße, which no other line reaches
    renderCard({ tripProgress: { ...progress, position: 0 } })
    expect(screen.queryByTestId('vehicle-interchange')).toBeNull()
  })

  it('folds to its head on a phone and opens again, the follow in the head throughout', () => {
    // The panel's fold button beside the close button (CardHead): on a
    // phone the card is a sheet over the map, and folded it keeps the
    // head – line, origin and destination, the follow as an icon button
    // in the corner – and nothing under it.
    onAPhone()
    renderCard()
    const follow = screen.getByRole('button', { name: 'Follow tram' })
    expect(follow.closest('[data-slot="card-header"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse card' }))
    expect(screen.getByText(/Hafenallee/)).toBeInTheDocument()
    expect(screen.queryByTestId('vehicle-trip-stops')).toBeNull()
    expect(screen.queryByTestId('vehicle-arrival')).toBeNull()
    expect(screen.getByRole('button', { name: 'Follow tram' })).toBe(follow)
    fireEvent.click(screen.getByRole('button', { name: 'Expand card' }))
    expect(screen.getByTestId('vehicle-trip-stops')).toBeInTheDocument()
  })

  it('keeps the follow in the body on a desktop', () => {
    renderCard()
    const follow = screen.getByRole('button', { name: 'Follow tram' })
    expect(follow.closest('[data-slot="card-content"]')).not.toBeNull()
    expect(follow).toHaveTextContent('Follow tram')
  })
})
