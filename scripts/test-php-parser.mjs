#!/usr/bin/env node
/**
 * Parity test: the PHP mini protobuf parser (server/api/realtime.php) must
 * extract exactly the same delays as the Node implementation
 * (src/lib/rt-extract.ts). Runs locally and in CI (requires php in PATH).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime

const feedObject = {
  header: { gtfsRealtimeVersion: '2.0', timestamp: 1765432100 },
  entity: [
    { id: '1', tripUpdate: { trip: { tripId: 'rostock-a', routeId: 'R1', startDate: '20260817' }, delay: 180 } },
    {
      id: '2',
      tripUpdate: {
        trip: { tripId: 'rostock-b' },
        stopTimeUpdate: [
          { stopSequence: 2, arrival: { delay: 45, time: 1765432000 } },
          { stopSequence: 3, departure: { delay: 999 } },
        ],
      },
    },
    { id: '3', tripUpdate: { trip: { tripId: 'rostock-c' }, delay: -90 } },
    { id: '4', tripUpdate: { trip: { tripId: 'woanders-x' }, delay: 300 } },
    { id: '5', tripUpdate: { trip: { tripId: 'rostock-d' } } },
    { id: '6', vehicle: { position: { latitude: 54.0, longitude: 12.1 } } },
    {
      id: '7',
      tripUpdate: {
        trip: { tripId: 'rostock-e' },
        stopTimeUpdate: [{ stopSequence: 1, departure: { delay: 60 }, arrival: { delay: 30 } }],
        delay: 120,
      },
    },
  ],
}

const expected = {
  timestamp: 1765432100,
  total: 7,
  delays: { 'rostock-a': 180, 'rostock-b': 45, 'rostock-c': -90, 'rostock-e': 120 },
}

const dir = mkdtempSync(join(tmpdir(), 'mg3d-php-test-'))
try {
  const feedPath = join(dir, 'feed.pb')
  const schedulePath = join(dir, 'schedule.json')
  writeFileSync(feedPath, FeedMessage.encode(FeedMessage.fromObject(feedObject)).finish())
  writeFileSync(
    schedulePath,
    JSON.stringify({
      lines: {
        '1': {
          '0': {
            departures: [100, 200, 300, 400, 500],
            tripIds: ['rostock-a', 'rostock-b', 'rostock-c', 'rostock-d', 'rostock-e'],
          },
        },
      },
    }),
  )

  const output = execFileSync(
    'php',
    ['server/api/realtime.php', '--selftest', feedPath, schedulePath],
    { encoding: 'utf8' },
  )
  const actual = JSON.parse(output)

  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) {
    console.error('❌ PHP parser deviates from the Node reference!')
    console.error('Expected:', JSON.stringify(expected))
    console.error('Actual:', JSON.stringify(actual))
    process.exit(1)
  }
  console.log('✅ PHP parser returns exactly the reference result:', output.trim())
} finally {
  rmSync(dir, { recursive: true, force: true })
}
