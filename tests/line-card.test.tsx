import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LineCard } from '@/components/LineCard'
import type { LineActivity, LineProfile } from '@/lib/line-profile'

/**
 * The line card. Every row is optional in the data – a line can have no
 * timetable, no gradient and no tunnel – so the cases worth pinning are
 * the ones where a row has to disappear rather than show a zero.
 */

afterEach(cleanup)

function profile(overrides: Partial<LineProfile> = {}): LineProfile {
  return {
    lineId: '1',
    mode: 'tram',
    from: 'Mecklenburger Allee',
    to: 'Hafenallee',
    lengthMeters: [18_700, 18_650],
    stopCount: [39, 39],
    meanStopSpacing: 490,
    tunnelShare: 0,
    heightRange: { min: 1, max: 20 },
    service: { first: 3 * 3600 + 1440, last: 24 * 3600 + 2460 },
    headway: { median: 600, peak: 600 },
    trips: { total: 217, shortWorkings: 139 },
    ...overrides,
  }
}

function activity(overrides: Partial<LineActivity> = {}): LineActivity {
  return {
    running: 6,
    nextDeparture: [8 * 3600 + 1800, 8 * 3600 + 2100],
    delay: null,
    ...overrides,
  }
}

function show(p: LineProfile, a: LineActivity | null = null) {
  const onFlyTo = vi.fn()
  const onClose = vi.fn()
  render(
    <LineCard
      profile={p}
      activity={a}
      name="Line 1"
      color="#5D106A"
      onFlyTo={onFlyTo}
      onClose={onClose}
    />,
  )
  return { onFlyTo, onClose }
}

describe('LineCard', () => {
  it('states the service day, the route and the trips', () => {
    show(profile())
    expect(screen.getByTestId('line-name')).toHaveTextContent('Line 1')
    expect(screen.getByTestId('line-service')).toHaveTextContent('03:24–00:41')
    expect(screen.getByTestId('line-service')).toHaveTextContent('every 10 min')
    expect(screen.getByTestId('line-route')).toHaveTextContent('18.7 km')
    expect(screen.getByTestId('line-route')).toHaveTextContent('39 stops')
    expect(screen.getByTestId('line-route')).toHaveTextContent('490 m apart')
    expect(screen.getByTestId('line-trips')).toHaveTextContent('217 a day')
    expect(screen.getByTestId('line-trips')).toHaveTextContent('139 short workings')
    expect(screen.getByTestId('line-terrain')).toHaveTextContent('1–20 m NHN')
  })

  it('names the peak only when it is actually denser', () => {
    // Line 1: 10 minutes all day, peak included – saying "10 min at peak"
    // next to "every 10 min" would be noise
    show(profile())
    expect(screen.getByTestId('line-service')).not.toHaveTextContent('at peak')
    cleanup()

    show(profile({ headway: { median: 600, peak: 480 } }))
    expect(screen.getByTestId('line-service')).toHaveTextContent('8 min at peak')
  })

  it('drops the rows a line has no data for', () => {
    // The Warnow ferry: no gradient, no tunnel, and every trip runs the
    // full route – three rows that must not appear as zeros
    show(profile({ heightRange: null, tunnelShare: 0, trips: { total: 70, shortWorkings: 0 } }))
    expect(screen.queryByTestId('line-terrain')).not.toBeInTheDocument()
    expect(screen.getByTestId('line-trips')).not.toHaveTextContent('short workings')
  })

  it('says so when a line has no timetable at all', () => {
    show(profile({ service: null, headway: null, trips: null }))
    expect(screen.getByTestId('line-service')).toHaveTextContent('no timetable data')
    expect(screen.queryByTestId('line-trips')).not.toBeInTheDocument()
    // The route is geometry and stands without a schedule
    expect(screen.getByTestId('line-route')).toHaveTextContent('18.7 km')
  })

  it('shows both directions where they differ', () => {
    show(profile({ lengthMeters: [8800, 6100], stopCount: [16, 12] }))
    expect(screen.getByTestId('line-route')).toHaveTextContent('8.8 / 6.1 km')
    expect(screen.getByTestId('line-route')).toHaveTextContent('16 / 12 stops')
  })

  it('reports the underground share of a line that has one', () => {
    show(profile({ tunnelShare: 0.12 }))
    expect(screen.getByTestId('line-terrain')).toHaveTextContent('12 % underground')
  })

  it('flies to the line and closes', () => {
    const { onFlyTo, onClose } = show(profile())
    fireEvent.click(screen.getByRole('button', { name: 'Fly to the line' }))
    expect(onFlyTo).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Close line' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('LineCard live rows', () => {
  it('says how much of the line is out and when it next leaves', () => {
    show(profile(), activity())
    expect(screen.getByTestId('line-running')).toHaveTextContent('6 in service')
    // Both directions, soonest first, each naming where it heads – which
    // is what makes a single entry unambiguous when one direction is done
    expect(screen.getByTestId('line-next')).toHaveTextContent('08:30 → Hafenallee')
    expect(screen.getByTestId('line-next')).toHaveTextContent('08:35 → Mecklenburger Allee')
  })

  it('names the destination of the one direction still running', () => {
    show(profile(), activity({ nextDeparture: [null, 8 * 3600 + 2100] }))
    expect(screen.getByTestId('line-next')).toHaveTextContent('08:35 → Mecklenburger Allee')
    expect(screen.getByTestId('line-next')).not.toHaveTextContent('Hafenallee')
  })

  it('does not pretend a line is out when it is not', () => {
    show(profile(), activity({ running: 0, nextDeparture: [null, null] }))
    expect(screen.getByTestId('line-running')).toHaveTextContent('none in service')
    expect(screen.getByTestId('line-next')).toHaveTextContent('nothing more today')
  })

  it('reports the delay only where the feed covers the line', () => {
    show(profile(), activity({ delay: null }))
    expect(screen.getByTestId('line-running')).not.toHaveTextContent('late')
    cleanup()

    show(profile(), activity({ delay: { medianSeconds: 180, vehicles: 4 } }))
    expect(screen.getByTestId('line-running')).toHaveTextContent('3 min late on average')
    cleanup()

    // Early happens – the DELFI feed reports it for a few percent of trips
    show(profile(), activity({ delay: { medianSeconds: -120, vehicles: 2 } }))
    expect(screen.getByTestId('line-running')).toHaveTextContent('2 min early on average')
    cleanup()

    // Under a minute either way is "to time", not "0 min late"
    show(profile(), activity({ delay: { medianSeconds: 20, vehicles: 3 } }))
    expect(screen.getByTestId('line-running')).toHaveTextContent('running to time')
  })

  it('leaves the live rows out entirely before the first snapshot', () => {
    show(profile(), null)
    expect(screen.queryByTestId('line-running')).not.toBeInTheDocument()
    expect(screen.queryByTestId('line-next')).not.toBeInTheDocument()
    // The profile stands on its own
    expect(screen.getByTestId('line-route')).toBeInTheDocument()
  })
})
