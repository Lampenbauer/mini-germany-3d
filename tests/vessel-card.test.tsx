import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VesselCard } from '@/components/VesselCard'
import type { AisVessel } from '@/lib/ais-extract'
import { formatFixAge, navStatusKey, vesselTypeKey } from '@/lib/vessel-info'

/**
 * The card for a clicked AIS ship. Everything it shows is optional in the
 * AIS itself – static reports arrive every six minutes and small craft
 * often send none – so the interesting cases are the missing ones.
 */

afterEach(cleanup)

const NOW = 1_800_000_000_000

function vessel(overrides: Partial<AisVessel> = {}): AisVessel {
  return {
    mmsi: 211222290,
    name: 'DENEB',
    lat: 54.0982,
    lon: 12.106,
    sogKn: 8.4,
    cogDeg: 90,
    headingDeg: 92,
    navStatus: 0,
    typeCode: 70,
    lengthM: 52,
    widthM: 12,
    draughtM: 3.5,
    positionAt: NOW - 30_000,
    track: [],
    ...overrides,
  }
}

function show(v: AisVessel, props: Partial<Parameters<typeof VesselCard>[0]> = {}) {
  const onToggleFollow = vi.fn()
  const onClose = vi.fn()
  render(
    <VesselCard
      vessel={v}
      nowMs={NOW}
      following={false}
      onToggleFollow={onToggleFollow}
      onClose={onClose}
      {...props}
    />,
  )
  return { onToggleFollow, onClose }
}

describe('VesselCard', () => {
  it('shows what the ship reports about herself', () => {
    show(vessel())
    expect(screen.getByTestId('vessel-name')).toHaveTextContent('DENEB')
    expect(screen.getByTestId('vessel-status')).toHaveTextContent('Under way using engine')
    expect(screen.getByTestId('vessel-speed')).toHaveTextContent('8.4 kn')
    expect(screen.getByTestId('vessel-type')).toHaveTextContent('Cargo ship')
    expect(screen.getByTestId('vessel-dimensions')).toHaveTextContent('52 × 12 m')
    expect(screen.getByTestId('vessel-draught')).toHaveTextContent('3.5 m')
    expect(screen.getByTestId('vessel-mmsi')).toHaveTextContent('211222290')
  })

  it('falls back to the MMSI while no static report has named her', () => {
    show(vessel({ name: '' }))
    expect(screen.getByTestId('vessel-name')).toHaveTextContent('211222290')
  })

  it('survives a field the server never sent at all', () => {
    // Not hypothetical: the state file outlives deploys, so records
    // written before a field existed reach the browser without the key.
    // `undefined` slips past a `=== null` guard and throws on .toFixed,
    // which took the whole view down in production. The client normalizes
    // now (see ais.ts), but the card must not be the thing that decides it.
    const partial = vessel()
    delete (partial as Partial<AisVessel>).draughtM
    delete (partial as Partial<AisVessel>).sogKn
    expect(() => show(partial)).not.toThrow()
    expect(screen.getByTestId('vessel-draught')).toHaveTextContent('not reported')
    expect(screen.getByTestId('vessel-speed')).toHaveTextContent('not reported')
  })

  it('says a field is unreported instead of inventing a zero', () => {
    show(vessel({ typeCode: 0, lengthM: null, widthM: null, draughtM: null, sogKn: null, navStatus: null }))
    expect(screen.getByTestId('vessel-type')).toHaveTextContent('unknown')
    expect(screen.getByTestId('vessel-dimensions')).toHaveTextContent('not reported')
    expect(screen.getByTestId('vessel-draught')).toHaveTextContent('not reported')
    expect(screen.getByTestId('vessel-speed')).toHaveTextContent('not reported')
    expect(screen.getByTestId('vessel-status')).toHaveTextContent('unknown')
  })

  it('reads a lying ship as stopped, not as drifting at 0.1 kn', () => {
    show(vessel({ sogKn: 0.1, navStatus: 5 }))
    expect(screen.getByTestId('vessel-speed')).toHaveTextContent('0 kn')
    expect(screen.getByTestId('vessel-status')).toHaveTextContent('Moored')
  })

  it('offers the follow button and reports the click', () => {
    const { onToggleFollow } = show(vessel())
    fireEvent.click(screen.getByRole('button', { name: 'Follow vessel' }))
    expect(onToggleFollow).toHaveBeenCalledOnce()
  })

  it('offers to stop following while the camera is chasing', () => {
    show(vessel(), { following: true })
    expect(screen.getByRole('button', { name: 'Stop following' })).toBeInTheDocument()
  })

  it('closes on the close button', () => {
    const { onClose } = show(vessel())
    fireEvent.click(screen.getByRole('button', { name: 'Close selection' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('vessel-info', () => {
  it('names the AIS type groups and their special craft', () => {
    expect(vesselTypeKey(70)).toBe('vesselType.cargo')
    expect(vesselTypeKey(60)).toBe('vesselType.passenger')
    expect(vesselTypeKey(80)).toBe('vesselType.tanker')
    expect(vesselTypeKey(52)).toBe('vesselType.tug')
    // The 5x group is a grab bag – the harbor's own craft are named
    expect(vesselTypeKey(50)).toBe('vesselType.pilot')
    expect(vesselTypeKey(51)).toBe('vesselType.searchRescue')
    // 3x is not a group at all but a list of individual craft
    expect(vesselTypeKey(30)).toBe('vesselType.fishing')
    expect(vesselTypeKey(36)).toBe('vesselType.sailing')
    expect(vesselTypeKey(37)).toBe('vesselType.pleasure')
    // The codes ITU-R M.1371-6 (2026) spells out
    expect(vesselTypeKey(76)).toBe('vesselType.containerShip')
    expect(vesselTypeKey(75)).toBe('vesselType.bulkCarrier')
    expect(vesselTypeKey(77)).toBe('vesselType.roro')
    expect(vesselTypeKey(78)).toBe('vesselType.landingCraft')
    expect(vesselTypeKey(67)).toBe('vesselType.excursion')
    expect(vesselTypeKey(66)).toBe('vesselType.ferry')
    expect(vesselTypeKey(65)).toBe('vesselType.cruise')
    expect(vesselTypeKey(38)).toBe('vesselType.trawler')
    expect(vesselTypeKey(39)).toBe('vesselType.patrol')
    expect(vesselTypeKey(86)).toBe('vesselType.tugAndBarge')
    expect(vesselTypeKey(4)).toBe('vesselType.specialPurpose') // ice breaker
    expect(vesselTypeKey(14)).toBe('vesselType.support')
    // The coarse codes still keep their group labels
    expect(vesselTypeKey(71)).toBe('vesselType.cargo')
    expect(vesselTypeKey(79)).toBe('vesselType.cargo')
    expect(vesselTypeKey(69)).toBe('vesselType.passenger')
    // 0 is "not available", not a type
    expect(vesselTypeKey(0)).toBeNull()
  })

  it('maps only the navigational statuses the standard defines', () => {
    expect(navStatusKey(0)).toBe('navStatus.0')
    expect(navStatusKey(5)).toBe('navStatus.5')
    expect(navStatusKey(null)).toBeNull()
    // 9, 10 and 13 are reserved – an unknown code must not read as a guess
    expect(navStatusKey(9)).toBeNull()
    expect(navStatusKey(13)).toBeNull()
  })

  it('gives the fix age in the unit that reads well', () => {
    expect(formatFixAge(NOW - 20_000, NOW)).toBe('last fix 20 s ago')
    expect(formatFixAge(NOW - 240_000, NOW)).toBe('last fix 4 min ago')
    // A clock that runs backwards must not produce a negative age
    expect(formatFixAge(NOW + 5_000, NOW)).toBe('last fix 0 s ago')
  })
})
