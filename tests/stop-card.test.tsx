// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StopCard, type StopInfo } from '@/components/StopCard'
import type { StopDeparture } from '@/engine/simulation'
import type { InterchangeOption } from '@/lib/interchange'
import { offThePhone, onAPhone } from './phone'

afterEach(() => {
  cleanup()
  offThePhone()
})

/** 08:30 – the fixture departures sit a few minutes after it. */
const SIM_SECONDS = 8 * 3600 + 30 * 60

const stop: StopInfo = {
  id: 'doberaner-platz',
  name: 'Doberaner Platz',
  lon: 12.123,
  lat: 54.088,
  nhn: 12,
  lines: [
    { id: '3', color: '#F39200' },
    { id: '6', color: '#94368D' },
  ],
  inTunnel: false,
}

function departure(overrides: Partial<StopDeparture>): StopDeparture {
  return {
    tripId: '3-0-510',
    lineId: '3',
    color: '#F39200',
    mode: 'tram',
    direction: 0,
    destination: 'Dierkower Allee',
    departureSec: 8 * 3600 + 33 * 60,
    secondsUntil: 180,
    delaySeconds: 0,
    realtime: false,
    active: false,
    ...overrides,
  }
}

const interchange: InterchangeOption[] = [
  { id: '3', color: '#F39200' },
  { id: '6', color: '#94368D' },
  { id: '1', color: '#5D106A' }, // boards across the square
]

function renderCard(props: Partial<React.ComponentProps<typeof StopCard>> = {}) {
  return render(
    <StopCard
      stop={stop}
      departures={[departure({})]}
      simSeconds={SIM_SECONDS}
      interchange={interchange}
      onSelectVehicle={() => {}}
      onSelectLine={() => {}}
      onFlyTo={() => {}}
      onClose={() => {}}
      {...props}
    />,
  )
}

describe('StopCard', () => {
  it('names the stop and its serving lines', () => {
    renderCard()
    expect(screen.getByText('Doberaner Platz')).toBeInTheDocument()
    const badges = screen.getByTestId('stop-lines')
    expect(badges).toHaveTextContent('3')
    expect(badges).toHaveTextContent('6')
  })

  it('lists departures with time, line, destination, and countdown', () => {
    renderCard()
    const list = screen.getByTestId('stop-departures')
    expect(list).toHaveTextContent('08:33')
    expect(list).toHaveTextContent('Dierkower Allee')
    expect(list).toHaveTextContent('in 3 min')
  })

  it('shows "now" for a departure under a minute away', () => {
    renderCard({
      departures: [departure({ departureSec: SIM_SECONDS + 30, secondsUntil: 30 })],
    })
    expect(screen.getByTestId('stop-departures')).toHaveTextContent('now')
  })

  it('wraps an after-midnight departure back onto the clock face', () => {
    renderCard({
      simSeconds: 23 * 3600 + 55 * 60,
      departures: [departure({ departureSec: 24 * 3600 + 10 * 60, secondsUntil: 900 })],
    })
    expect(screen.getByTestId('stop-departures')).toHaveTextContent('00:10')
  })

  it('badges a delayed realtime departure', () => {
    renderCard({
      departures: [departure({ realtime: true, delaySeconds: 120 })],
    })
    expect(screen.getByTestId('stop-departures')).toHaveTextContent('+2 min')
  })

  it('links a departure to its vehicle only while it is on the map', () => {
    const onSelectVehicle = vi.fn()
    renderCard({
      departures: [
        departure({ tripId: 'active-trip', active: true }),
        departure({ tripId: 'waiting-trip', destination: 'Neuer Friedhof' }),
      ],
      onSelectVehicle,
    })
    const buttons = screen.getAllByTitle('Fly to this vehicle')
    expect(buttons).toHaveLength(1)
    // Visible at rest, not just on hover: only the row whose vehicle is
    // out there carries the mode icon.
    expect(screen.getAllByTestId('departure-on-map')).toHaveLength(1)
    expect(buttons[0]).toContainElement(screen.getByTestId('departure-on-map'))
    fireEvent.click(buttons[0])
    expect(onSelectVehicle).toHaveBeenCalledWith('active-trip')
  })

  it('says so when nothing departs within the hour', () => {
    renderCard({ departures: [] })
    expect(screen.getByTestId('stop-no-departures')).toBeInTheDocument()
    expect(screen.queryByTestId('stop-departures')).toBeNull()
  })

  it('shows nearby lines that do not call here, never its own', () => {
    renderCard()
    const nearby = screen.getByTestId('stop-nearby')
    expect(nearby).toHaveTextContent('1')
    expect(nearby.textContent).not.toContain('3')
    expect(nearby.textContent).not.toContain('6')
  })

  it('makes every line on the card a link to it – the ones calling here and the nearby ones', () => {
    const onSelectLine = vi.fn()
    renderCard({ onSelectLine })
    fireEvent.click(screen.getByRole('button', { name: 'Fly to 1' }))
    expect(onSelectLine).toHaveBeenLastCalledWith('1')
    fireEvent.click(screen.getByRole('button', { name: 'Fly to 3' }))
    expect(onSelectLine).toHaveBeenLastCalledWith('3')
  })

  it('marks an underground platform', () => {
    renderCard({ stop: { ...stop, inTunnel: true } })
    expect(screen.getByText('Underground platform')).toBeInTheDocument()
  })

  it('offers the camera flight to the stop', () => {
    const onFlyTo = vi.fn()
    renderCard({ onFlyTo })
    fireEvent.click(screen.getByRole('button', { name: 'Fly to stop' }))
    expect(onFlyTo).toHaveBeenCalledWith(stop)
  })

  it('folds to its head on a phone, the serving lines and the flight with it', () => {
    // The lines calling here are the head's own row and stay, and so
    // does the flight to the stop, an icon button in the head on a
    // phone; the departures go with the body
    onAPhone()
    const onFlyTo = vi.fn()
    renderCard({ onFlyTo })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse card' }))
    expect(screen.getByTestId('stop-lines')).toBeInTheDocument()
    expect(screen.queryByText('Departures')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fly to stop' }))
    expect(onFlyTo).toHaveBeenCalledWith(stop)
    fireEvent.click(screen.getByRole('button', { name: 'Expand card' }))
    expect(screen.getByText('Departures')).toBeInTheDocument()
  })
})
