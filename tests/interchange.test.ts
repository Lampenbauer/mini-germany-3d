import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { loadRostockNetwork } from './cities'
import { prepareNetwork } from '@/data/network'
import { buildInterchangeIndex } from '@/lib/interchange'
import type { NetworkJson } from '@/data/network-types'

/** Line ids reachable from a stop, own line included. */
function linesAt(index: ReturnType<typeof buildInterchangeIndex>, stopId: string): string[] {
  return (index.get(stopId) ?? []).map((option) => option.id).sort()
}

describe('buildInterchangeIndex', () => {
  /**
   * Two platforms 40 m apart plus one 300 m down the road, each served by
   * its own line. Coordinates are ~0.00036 ° of latitude per 40 m.
   */
  const network = prepareNetwork({
    meta: { source: 'approximated', attribution: 'Test' },
    stops: {
      north: { name: 'Markt Nord', coord: [12.1, 54.0] },
      south: { name: 'Markt Süd', coord: [12.1, 53.99964] },
      far: { name: 'Weit weg', coord: [12.1, 53.9973] },
      end: { name: 'Ende', coord: [12.1, 53.99] },
    },
    lines: [
      {
        id: 'A',
        name: 'A',
        color: '#ff0000',
        directions: [
          { from: 'Markt Nord', to: 'Ende', path: [[12.1, 54.0], [12.1, 53.99]], stops: ['north', 'end'] },
        ],
      },
      {
        id: 'B',
        name: 'B',
        color: '#00ff00',
        directions: [
          { from: 'Markt Süd', to: 'Ende', path: [[12.1, 53.99964], [12.1, 53.99]], stops: ['south', 'end'] },
        ],
      },
      {
        id: 'C',
        name: 'C',
        color: '#0000ff',
        directions: [
          { from: 'Weit weg', to: 'Ende', path: [[12.1, 53.9973], [12.1, 53.99]], stops: ['far', 'end'] },
        ],
      },
    ],
  } as NetworkJson)

  it('reaches the line on the platform across the square', () => {
    const index = buildInterchangeIndex(network, 100)
    expect(linesAt(index, 'north')).toEqual(['A', 'B'])
    expect(linesAt(index, 'south')).toEqual(['A', 'B'])
  })

  it('leaves out what is beyond the radius', () => {
    // C calls 300 m away – a stop, not an interchange
    expect(linesAt(buildInterchangeIndex(network, 100), 'north')).not.toContain('C')
    expect(linesAt(buildInterchangeIndex(network, 400), 'north')).toContain('C')
  })

  it('carries the line color for the badge', () => {
    const options = buildInterchangeIndex(network, 100).get('north') ?? []
    expect(options.find((o) => o.id === 'B')?.color).toBe('#00ff00')
  })

  it('orders by walking distance, so the stop\'s own lines lead', () => {
    // A calls here, B 40 m across the square, C 300 m down the road
    const options = buildInterchangeIndex(network, 400).get('north') ?? []
    expect(options.map((o) => o.id)).toEqual(['A', 'B', 'C'])
    // The walk is measured from the platform asked about, so the order
    // differs elsewhere: from 'far', B (260 m) comes before A (300 m).
    expect(buildInterchangeIndex(network, 400).get('far')?.map((o) => o.id)).toEqual([
      'C',
      'B',
      'A',
    ])
  })

  it('lists a line once even when it calls at several platforms nearby', () => {
    const options = buildInterchangeIndex(network, 400).get('end') ?? []
    expect(options.map((o) => o.id)).toEqual(['A', 'B', 'C'])
  })
})

describe('the real Rostock network', () => {
  const index = buildInterchangeIndex(loadRostockNetwork(), config.interchangeRadiusMeters)
  const network = loadRostockNetwork()

  /** The stop id of a platform by name and one of the lines calling there. */
  function platform(name: string, lineId: string): string {
    for (const line of network.lines) {
      if (line.id !== lineId) continue
      for (const dir of line.directions) {
        const stop = dir.stops.find((s) => s.name === name)
        if (stop) return stop.id
      }
    }
    throw new Error(`no platform "${name}" on line ${lineId}`)
  }

  it('connects the tram platforms across Doberaner Platz', () => {
    // Lines 3 and 6 stop there; 1, 2 and 5 board ~38 m away
    const lines = linesAt(index, platform('Doberaner Platz', '3'))
    expect(lines).toEqual(expect.arrayContaining(['1', '2', '5', '3', '6']))
  })

  it('connects the Hbf tram platform to the S-Bahn', () => {
    // "Hauptbahnhof (U)" and "Rostock Hauptbahnhof" are ~63 m apart
    const lines = linesAt(index, platform('Hauptbahnhof (U)', '2'))
    expect(lines).toEqual(expect.arrayContaining(['S1', 'S2', 'S3']))
  })

  it('stays modest – an interchange is not a whole neighborhood', () => {
    const sizes = [...index.values()].map((options) => options.length)
    const average = sizes.reduce((sum, n) => sum + n, 0) / sizes.length
    expect(average).toBeLessThan(5)
    expect(Math.max(...sizes)).toBeLessThan(16)
  })
})
