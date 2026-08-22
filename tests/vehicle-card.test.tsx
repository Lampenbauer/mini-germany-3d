import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VehicleCard } from '@/components/VehicleCard'
import { config } from '@/config'
import type { TripProgress, VehicleSnapshot } from '@/engine/simulation'

afterEach(cleanup)

const vehicle: VehicleSnapshot = {
  id: '1-0-510',
  lineId: '1',
  lineName: 'Line 1',
  color: '#e2001a',
  mode: 'tram',
  vehicle: config.vehicles.tram,
  direction: 0,
  lon: 12.13,
  lat: 54.08,
  bearing: 90,
  status: 'moving',
  inTunnel: false,
  nextStopName: 'Doberaner Platz',
  destination: 'Hafenallee',
  origin: 'Mecklenburger Allee',
  delaySeconds: 0,
  realtime: false,
}

const noop = () => {}

// Vehicle underway between Lange Straße (passed) and Doberaner Platz:
// position 0.5 = halfway along the first segment.
const progress: TripProgress = {
  stops: [
    {
      name: 'Lange Straße',
      arrivalSec: 8 * 3600 + 29 * 60,
      lon: 12.135,
      lat: 54.089,
      passed: true,
    },
    {
      name: 'Doberaner Platz',
      arrivalSec: 8 * 3600 + 31 * 60,
      lon: 12.115,
      lat: 54.088,
      passed: false,
    },
    // Seconds are floored to the displayed minute
    {
      name: 'Kröpeliner Tor',
      arrivalSec: 8 * 3600 + 33 * 60 + 40,
      lon: 12.125,
      lat: 54.088,
      passed: false,
    },
  ],
  position: 0.5,
}

describe('VehicleCard trip stops', () => {
  it('lists every stop with its arrival time, dimming the served ones', () => {
    render(
      <VehicleCard
        vehicle={vehicle}
        tripProgress={progress}
        onFlyToStop={noop}
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
        onFlyToStop={noop}
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
        onFlyToStop={noop}
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
        onFlyToStop={onFlyToStop}
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
        onFlyToStop={noop}
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
