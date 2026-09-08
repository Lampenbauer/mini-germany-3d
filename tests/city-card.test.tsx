// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CityCard, type CityCardProps } from '@/components/CityCard'
import type { CityActivity, CityProfile } from '@/lib/city-profile'
import { setLanguage } from '@/lib/i18n'

/**
 * The city card. Like the line card's, its rows are optional in the data –
 * a network can have no timetable, no heights and no tunnel – so the
 * cases worth pinning are the ones where a row disappears or a phrase is
 * left off rather than a zero shown.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

function profile(overrides: Partial<CityProfile> = {}): CityProfile {
  return {
    modes: [
      { mode: 'tram', lines: 6, running: 5 },
      { mode: 'train', lines: 3, running: 3 },
      { mode: 'bus', lines: 25, running: 25 },
      { mode: 'ferry', lines: 2, running: 2 },
    ],
    lines: { total: 36, running: 35 },
    stopPositions: 614,
    lineMeters: 424_000,
    tunnelMeters: 3_800,
    longest: { lineId: 'F2', mode: 'bus', meters: 28_900 },
    elevation: { min: 0.4, max: 53.2, highestStop: 'Südstadt' },
    trips: { total: 3595, shortWorkings: 1575 },
    service: { first: 3 * 3600 + 50 * 60, last: 4 * 3600 + 6 * 60 },
    ...overrides,
  }
}

function activity(overrides: Partial<CityActivity> = {}): CityActivity {
  return {
    total: 370,
    byMode: { tram: 38, train: 6, bus: 324, ferry: 2 },
    delay: { medianSeconds: 90, vehicles: 212 },
    ...overrides,
  }
}

function card(overrides: Partial<CityCardProps> = {}) {
  const onFocusLine = vi.fn()
  const onClose = vi.fn()
  render(
    <CityCard
      profile={profile()}
      activity={activity()}
      name="Rostock"
      longestLine={{ id: 'F2', name: 'Line F2', color: '#0aa' }}
      onFocusLine={onFocusLine}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onFocusLine, onClose }
}

describe('the city card', () => {
  it('states the network in numbers, with the idle lines counted against their mode', () => {
    card()
    expect(screen.getByTestId('city-card-name')).toHaveTextContent('Rostock')
    expect(screen.getByTestId('city-lines')).toHaveTextContent('36 lines · 35 running today')
    // Badges per mode: "5/6" where a tram line stands still, plain counts elsewhere
    expect(screen.getByLabelText('Tram 5/6')).toBeInTheDocument()
    expect(screen.getByLabelText('Bus 25')).toBeInTheDocument()
    expect(screen.getByTestId('city-stops')).toHaveTextContent('614 stop positions')
    expect(screen.getByTestId('city-route')).toHaveTextContent(
      '424 km of line · 3.8 km in tunnel (1 %)',
    )
    expect(screen.getByTestId('city-elevation')).toHaveTextContent(
      '0–53 m above sea level · highest: Südstadt',
    )
    expect(screen.getByTestId('city-trips')).toHaveTextContent('3,595 a day · 1,575 short workings')
    // The day begins at 03:50 and its night ends at 04:06 – a pause, so both ends are named
    expect(screen.getByTestId('city-service')).toHaveTextContent('03:50–04:06')
    expect(screen.getByTestId('city-running')).toHaveTextContent(
      '370 vehicles · 212 with live data · 2 min late on average',
    )
  })

  it('links the longest line to the map and closes on the cross', () => {
    const { onFocusLine, onClose } = card()
    fireEvent.click(
      screen.getByRole('button', { name: 'Fly to line Line F2, the longest at 28.9 km' }),
    )
    expect(onFocusLine).toHaveBeenCalledWith('F2')
    fireEvent.click(screen.getByRole('button', { name: 'Close the city card' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('leaves the phrases out that would say nothing', () => {
    card({
      profile: profile({
        lines: { total: 36, running: 36 },
        modes: [{ mode: 'bus', lines: 36, running: 36 }],
        tunnelMeters: 1_200,
        elevation: null,
        trips: { total: 476, shortWorkings: 0 },
        service: { first: 3 * 3600 + 900, last: 3 * 3600 },
      }),
      activity: activity({ delay: null }),
    })
    // Every line runs: no "36 running today"
    expect(screen.getByTestId('city-lines')).toHaveTextContent(/^36 lines/)
    expect(screen.getByTestId('city-lines')).not.toHaveTextContent('running today')
    // 1.2 km of 424 is below half a percent: no tunnel phrase
    expect(screen.getByTestId('city-route')).toHaveTextContent(/^424 km of line$/)
    expect(screen.queryByTestId('city-elevation')).not.toBeInTheDocument()
    expect(screen.getByTestId('city-trips')).toHaveTextContent(/^476 a day$/)
    // Berlin's trams: the night's longest pause is 03:00 to 03:15
    expect(screen.getByTestId('city-service')).toHaveTextContent('round the clock')
    expect(screen.getByTestId('city-running')).toHaveTextContent(/^370 vehicles$/)
  })

  it('says so without a timetable and before the first snapshot', () => {
    card({
      profile: profile({ lines: { total: 3, running: null }, trips: null, service: null }),
      activity: null,
    })
    expect(screen.getByTestId('city-trips')).toHaveTextContent('no timetable data')
    expect(screen.queryByTestId('city-service')).not.toBeInTheDocument()
    expect(screen.queryByTestId('city-running')).not.toBeInTheDocument()
  })

  it('speaks German with German digits', () => {
    setLanguage('de')
    card()
    expect(screen.getByTestId('city-lines')).toHaveTextContent('36 Linien · 35 fahren heute')
    expect(screen.getByTestId('city-trips')).toHaveTextContent('3.595 am Tag · 1.575 Kurzfahrten')
    expect(screen.getByTestId('city-route')).toHaveTextContent(
      '424 km Linienlänge · 3,8 km im Tunnel (1 %)',
    )
  })
})
