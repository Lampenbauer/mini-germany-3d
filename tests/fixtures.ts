import type { NetworkJson } from '@/data/network-types'

/**
 * Synthetic mini network for unit tests:
 * straight north–south route with 3 stops spaced ~1000 m apart.
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

/**
 * Same straight north–south route as testNetworkJson, but the stretch
 * between 400 m and 700 m runs through a tunnel. Only direction 0 is
 * declared – direction 1 (including its tunnel range) is mirrored.
 */
export const testTunnelNetworkJson: NetworkJson = {
  meta: testNetworkJson.meta,
  stops: testNetworkJson.stops,
  lines: [
    {
      id: 'U',
      name: 'Tunnellinie',
      color: '#00aa88',
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
          tunnels: [[400, 700]],
        },
      ],
    },
  ],
}

/**
 * Multimodal mini network: a tram (without a mode field, like the old
 * network.json), a bus, and a ferry with its own vehicle dimensions.
 */
export const testMultiModalNetworkJson: NetworkJson = {
  meta: testNetworkJson.meta,
  stops: {
    ...testNetworkJson.stops,
    b1: { name: 'Busplatz', coord: [12.12, 54.0] },
    b2: { name: 'Busmarkt', coord: [12.12, 54.009] },
    f1: { name: 'Anleger West', coord: [12.14, 54.0] },
    f2: { name: 'Anleger Ost', coord: [12.149, 54.0] },
  },
  lines: [
    ...testNetworkJson.lines,
    {
      id: '22',
      name: 'Bus 22',
      color: '#1D4ED8',
      mode: 'bus',
      directions: [
        {
          from: 'Busplatz',
          to: 'Busmarkt',
          path: [
            [12.12, 54.0],
            [12.12, 54.009],
          ],
          stops: ['b1', 'b2'],
        },
      ],
    },
    {
      id: 'F1',
      name: 'Fähre West – Ost',
      color: '#0E7490',
      mode: 'ferry',
      vehicle: { length: 19.9, width: 6.6, height: 3.5 },
      directions: [
        {
          from: 'Anleger West',
          to: 'Anleger Ost',
          path: [
            [12.14, 54.0],
            [12.149, 54.0],
          ],
          stops: ['f1', 'f2'],
        },
      ],
    },
  ],
}
