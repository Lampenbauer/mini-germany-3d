import type { NetworkJson } from '@/data/network-types'

/**
 * Synthetisches Mini-Netz für Unit-Tests:
 * Gerade Nord-Süd-Strecke mit 3 Haltestellen im Abstand von je ~1000 m.
 */
export const testNetworkJson: NetworkJson = {
  meta: {
    source: 'approximated',
    generated: '2026-01-01',
    attribution: 'Testdaten',
  },
  stops: {
    a: { name: 'Alpha', coord: [12.1, 54.0] },
    b: { name: 'Beta', coord: [12.1, 54.009] },
    c: { name: 'Gamma', coord: [12.1, 54.018] },
  },
  lines: [
    {
      id: 'T',
      name: 'Testlinie',
      color: '#ff0000',
      directions: [
        {
          from: 'Alpha',
          to: 'Gamma',
          path: [
            [12.1, 54.0],
            [12.1, 54.009],
            [12.1, 54.018],
          ],
          stops: ['a', 'b', 'c'],
        },
      ],
    },
  ],
}
