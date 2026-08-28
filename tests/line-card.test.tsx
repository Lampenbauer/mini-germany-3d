import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LineCard } from '@/components/LineCard'
import type { LineProfile } from '@/lib/line-profile'

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

function show(p: LineProfile) {
  const onFlyTo = vi.fn()
  const onClose = vi.fn()
  render(<LineCard profile={p} name="Line 1" color="#5D106A" onFlyTo={onFlyTo} onClose={onClose} />)
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
