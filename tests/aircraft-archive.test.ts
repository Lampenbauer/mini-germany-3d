import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AIRCRAFT_KEEPER_INTERVAL_MS,
  AircraftArchiveClient,
  AircraftArchiveWriter,
  AircraftReplay,
  adsbCoverQuery,
  aircraftArchiveSnapshot,
  aircraftReplayWanted,
  coverWithinLimit,
  parseAircraftArchiveChunk,
  type AircraftArchiveFix,
  type AircraftArchiveLine,
} from '@/lib/aircraft-archive'
import {
  ADSB_MAX_DIST_NM,
  AIRCRAFT_EXPIRE_MS,
  AIRCRAFT_PLAYBACK_DELAY_MS,
  adsbQuery,
  type AdsbRawAircraft,
  type AircraftState,
} from '@/lib/aircraft-extract'
import { ARCHIVE_HOUR_MS, ARCHIVE_TAIL_POLL_MS, REPLAY_EDGE_MS, type ArchiveStore } from '@/lib/archive-hours'
import { CITIES } from '@/cities/definitions'

/**
 * The aircraft archive: what the keeper writes per hour and city from
 * the answers it polls, and how the app replays it when the clock is
 * set into the past. The writer is exercised against an in-memory
 * store; the parity script holds the PHP twin to the same output on
 * disk. The hour files and the client are the harbour's (archive-hours.ts,
 * tests/ais-archive.test.ts) – here they are only shown to carry aircraft.
 */

afterEach(() => vi.restoreAllMocks())

/** 2027-01-15T08:00:00Z – exactly on the hour, so the hour keys read cleanly. */
const NOW = 1_800_000_000_000
const ROSTOCK = { slug: 'rostock', query: adsbQuery({ west: 11.9, south: 54.0, east: 12.4, north: 54.4 }) }
const KIEL = { slug: 'kiel', query: adsbQuery({ west: 10.0, south: 54.2, east: 10.4, north: 54.6 }) }

/** An airliner over Rostock as adsb.fi reports it, heard `seenPos` seconds before the poll. */
function airliner(overrides: Partial<AdsbRawAircraft> = {}, seenPos = 0.5): AdsbRawAircraft {
  return {
    hex: '3C65A2',
    type: 'adsb_icao',
    flight: 'DLH3Y  ',
    r: 'D-AIMB',
    t: 'A388',
    desc: 'AIRBUS A-380-800',
    category: 'A5',
    alt_baro: 34625,
    alt_geom: 35600,
    gs: 457.7,
    track: 291.8,
    true_heading: 297.7,
    baro_rate: 960,
    roll: -0.5,
    squawk: '0616',
    lat: 54.2,
    lon: 12.1,
    seen_pos: seenPos,
    ...overrides,
  }
}

const DLH3Y_STATIC = {
  hex: '3c65a2',
  callsign: 'DLH3Y',
  registration: 'D-AIMB',
  typeCode: 'A388',
  description: 'AIRBUS A-380-800',
  category: 'A5',
  squawk: '0616',
  source: 'adsb',
}

/** A store that keeps the files in memory, as "<slug>/<hour>" → text. */
function memoryStore() {
  const files = new Map<string, string>()
  const store: ArchiveStore = {
    has: (slug, hour) => files.has(`${slug}/${hour}`),
    append: (slug, hour, text) => files.set(`${slug}/${hour}`, (files.get(`${slug}/${hour}`) ?? '') + text),
    prune: (slug, oldestKept) => {
      for (const name of [...files.keys()]) {
        if (name.startsWith(`${slug}/`) && name.slice(slug.length + 1) < oldestKept) files.delete(name)
      }
    },
  }
  const lines = (slug: string, hour: string): AircraftArchiveLine[] =>
    (files.get(`${slug}/${hour}`) ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AircraftArchiveLine)
  return { files, store, lines }
}

describe('the cover circle', () => {
  it('reaches the far edge of every city circle from a centre between the outermost ones', () => {
    const cover = adsbCoverQuery([ROSTOCK.query, KIEL.query])
    expect(cover.lat).toBeCloseTo((ROSTOCK.query.lat + KIEL.query.lat) / 2, 3)
    expect(cover.lon).toBeCloseTo((ROSTOCK.query.lon + KIEL.query.lon) / 2, 3)
    // Half the distance between the two centres (~129 km ≈ 69 nm) plus
    // the further circle's own radius (Rostock's, 21 nm), in whole miles
    expect(cover.distNm).toBe(56)
    expect(ROSTOCK.query.distNm).toBe(21)
    expect(adsbCoverQuery([])).toEqual({ lat: 0, lon: 0, distNm: 0 })
  })

  it('covers every city in the build within what adsb.fi answers for', () => {
    // The keeper polls one circle for all cities; a city that would fall
    // outside it would be recorded nowhere. Germany fits in 250 nm from
    // its middle with little to spare – a new city far out needs a look.
    const cover = adsbCoverQuery(CITIES.map((city) => adsbQuery(city.boundingBox)))
    expect(coverWithinLimit(cover)).toBe(true)
    expect(cover.distNm).toBeLessThanOrEqual(ADSB_MAX_DIST_NM)
    expect(coverWithinLimit({ lat: 51, lon: 10, distNm: ADSB_MAX_DIST_NM + 1 })).toBe(false)
  })

  it('polls often enough for a chord through a turn, and sends the clock to the recording at the shared edge', () => {
    expect(AIRCRAFT_KEEPER_INTERVAL_MS).toBeLessThanOrEqual(10_000)
    expect(aircraftReplayWanted(NOW - REPLAY_EDGE_MS - 1, NOW)).toBe(true)
    expect(aircraftReplayWanted(NOW - 30_000, NOW)).toBe(false)
    expect(aircraftReplayWanted(NOW + 3_600_000, NOW)).toBe(false)
  })
})

describe('AircraftArchiveWriter', () => {
  it('opens an hour with a snapshot and appends the fixes that moved on', () => {
    const { store, lines } = memoryStore()
    const writer = new AircraftArchiveWriter(store, [ROSTOCK, KIEL])
    const state: AircraftState = new Map()
    writer.record(state, { ac: [airliner()] }, NOW)
    writer.record(state, { ac: [airliner({ lat: 54.21, lon: 12.11, roll: 1.5 })] }, NOW + 10_000)
    // The same fix again, a poll later: nothing moved, nothing is written
    writer.record(state, { ac: [airliner({ lat: 54.21, lon: 12.11, roll: 1.5 }, 10.5)] }, NOW + 20_000)

    expect(lines('rostock', '2027-01-15T08')).toEqual([
      DLH3Y_STATIC,
      ['3c65a2', NOW - 500, 54.2, 12.1, 10850.9, 10553.7, 457.7, 291.8, 297.7, 4.9, -0.5, false],
      ['3c65a2', NOW + 9_500, 54.21, 12.11, 10850.9, 10553.7, 457.7, 291.8, 297.7, 4.9, 1.5, false],
    ])
    // Kiel's circle does not reach Rostock's sky – no file
    expect(store.has('kiel', '2027-01-15T08')).toBe(false)
  })

  it('writes the static data again only when it changes, and takes nothing from what the extraction drops', () => {
    const { store, lines: read } = memoryStore()
    const writer = new AircraftArchiveWriter(store, [ROSTOCK])
    const state: AircraftState = new Map()
    writer.record(state, { ac: [airliner({ flight: undefined })] }, NOW)
    // A callsign that appears between flights: one static line, no fix
    writer.record(state, { ac: [airliner({}, 10.5)] }, NOW + 10_000)
    // A follow-me car and an entry without a position leave no trace
    writer.record(
      state,
      { ac: [{ hex: 'aaaaaa', category: 'C2', lat: 54.2, lon: 12.1 }, { hex: 'bbbbbb', flight: 'GHOST' }] },
      NOW + 20_000,
    )
    expect(read('rostock', '2027-01-15T08')).toEqual([
      { ...DLH3Y_STATIC, callsign: '' },
      ['3c65a2', NOW - 500, 54.2, 12.1, 10850.9, 10553.7, 457.7, 291.8, 297.7, 4.9, -0.5, false],
      DLH3Y_STATIC,
    ])
  })

  it('files an aircraft under every city whose circle holds it, and the snapshot per city', () => {
    const { lines, store } = memoryStore()
    // Two circles that overlap: a second Rostock a few miles east
    const EAST = { slug: 'east', query: { ...ROSTOCK.query, lon: ROSTOCK.query.lon + 0.3 } }
    const writer = new AircraftArchiveWriter(store, [ROSTOCK, EAST])
    const state: AircraftState = new Map()
    writer.record(
      state,
      { ac: [airliner(), airliner({ hex: '3d2f0c', flight: 'DEQBK', lat: 54.2, lon: 11.6 })] },
      NOW,
    )
    // The westerly light aircraft is in Rostock's circle only
    expect(lines('rostock', '2027-01-15T08').map((line) => (Array.isArray(line) ? line[0] : `static ${line.hex}`))).toEqual([
      'static 3c65a2',
      '3c65a2',
      'static 3d2f0c',
      '3d2f0c',
    ])
    expect(lines('east', '2027-01-15T08').map((line) => (Array.isArray(line) ? line[0] : `static ${line.hex}`))).toEqual([
      'static 3c65a2',
      '3c65a2',
    ])
  })

  it('carries every aircraft alive into the next hour, and lets the retention go', () => {
    const { files, store, lines } = memoryStore()
    const writer = new AircraftArchiveWriter(store, [ROSTOCK])
    const state: AircraftState = new Map()
    writer.record(state, { ac: [airliner()] }, NOW)
    // A light aircraft last heard early in the hour has expired by its end
    writer.record(state, { ac: [airliner({ hex: '3d2f0c', flight: 'DEQBK', lat: 54.1, lon: 12.2 })] }, NOW + 60_000)
    const nextHour = NOW + ARCHIVE_HOUR_MS
    writer.record(state, { ac: [airliner({ lat: 54.3 })] }, nextHour + 5_000)
    expect(lines('rostock', '2027-01-15T09')).toEqual([
      // The snapshot: the airliner's static data and the fix that opened
      // the hour – nothing about the aircraft that left
      DLH3Y_STATIC,
      ['3c65a2', nextHour + 4_500, 54.3, 12.1, 10850.9, 10553.7, 457.7, 291.8, 297.7, 4.9, -0.5, false],
    ])
    // Three days later the first hour is pruned when a new one opens
    const later = NOW + 73 * ARCHIVE_HOUR_MS
    writer.record(state, { ac: [airliner()] }, later)
    expect([...files.keys()].sort()).toEqual(['rostock/2027-01-15T09', 'rostock/2027-01-18T09'])
  })

  it('snapshots only the fresh aircraft inside the circle, sorted by address', () => {
    const state: AircraftState = new Map()
    const writer = new AircraftArchiveWriter(memoryStore().store, [])
    writer.record(
      state,
      {
        ac: [
          airliner({ hex: 'ffffff', flight: 'LAST' }),
          airliner({ hex: '000001', flight: 'FIRST' }),
          airliner({ hex: 'aaaaaa', flight: 'FARAWAY', lat: 50.0, lon: 8.5 }),
        ],
      },
      NOW,
    )
    // One of them was heard two minutes ago – fresh enough to be kept in
    // the state, too old for the sky
    writer.record(state, { ac: [airliner({ hex: 'bbbbbb', flight: 'STALE' }, 120)] }, NOW)
    const snapshot = aircraftArchiveSnapshot(state, NOW, ROSTOCK.query)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AircraftArchiveLine)
    expect(snapshot.map((line) => (Array.isArray(line) ? line[0] : `static ${line.hex}`))).toEqual([
      'static 000001',
      '000001',
      'static ffffff',
      'ffffff',
    ])
  })
})

describe('parseAircraftArchiveChunk', () => {
  const fix = (hex: string, t: number): AircraftArchiveFix => [hex, t, 54.2, 12.1, 10000, 9800, 450, 90, 92, 0, null, false]

  it('reads the two line shapes and leaves a partial last line for the next chunk', () => {
    const text = `${JSON.stringify(DLH3Y_STATIC)}\n${JSON.stringify(fix('3c65a2', NOW))}\n["3c65a2",${NOW + 10}`
    const bytes = new TextEncoder().encode(text)
    const { lines, consumed } = parseAircraftArchiveChunk(bytes)
    expect(lines).toEqual([DLH3Y_STATIC, fix('3c65a2', NOW)])
    expect(consumed).toBe(text.lastIndexOf('\n') + 1)
  })

  it("skips a ship's line, a short one and junk, and keeps the rest", () => {
    const text = `[211676580,${NOW},54.1,12.1,8,90,92,0]\n["3c65a2",${NOW}]\n{"mmsi":1}\nnot json\n${JSON.stringify(fix('3c65a2', NOW))}\n`
    const { lines } = parseAircraftArchiveChunk(new TextEncoder().encode(text))
    expect(lines).toEqual([fix('3c65a2', NOW)])
  })
})

describe('AircraftReplay', () => {
  const fix = (hex: string, t: number, lat: number, alt: number | null = 10000): AircraftArchiveFix => [
    hex,
    t,
    lat,
    12.1,
    alt,
    alt === null ? null : alt - 300,
    450,
    0,
    2,
    5,
    -1,
    alt === null,
  ]

  it('answers with each aircraft as of the moment: the last fix, the statics, and the track around the sampled instant', () => {
    const replay = new AircraftReplay()
    // Fixes every ten seconds, the keeper's cadence
    replay.add([
      DLH3Y_STATIC as AircraftArchiveLine,
      ...[54.2, 54.21, 54.22, 54.23, 54.24].map((lat, i) => fix('3c65a2', NOW + i * 10_000, lat)),
    ])
    const atMs = NOW + 35_000
    const [aircraft] = replay.aircraftAt(atMs)
    expect(aircraft).toMatchObject({
      hex: '3c65a2',
      callsign: 'DLH3Y',
      registration: 'D-AIMB',
      typeCode: 'A388',
      description: 'AIRBUS A-380-800',
      category: 'A5',
      squawk: '0616',
      source: 'adsb',
      lat: 54.23,
      lon: 12.1,
      altGeomM: 10000,
      altBaroM: 9700,
      onGround: false,
      gsKn: 450,
      trackDeg: 0,
      headingDeg: 2,
      verticalRateMps: 5,
      rollDeg: -1,
      positionAt: NOW + 30_000,
    })
    // The layer samples twelve seconds behind: at NOW+23 s, between the
    // fixes at 20 and 30 s. The track runs from the fix at 20 s to the one
    // after the last fix before the moment (40 s), so the sampler always
    // finds the fix after its instant
    expect(aircraft.track.map((p) => p[0])).toEqual([NOW + 20_000, NOW + 30_000, NOW + 40_000])
    expect(aircraft.track[0]).toEqual([NOW + 20_000, 54.22, 12.1, 10000, 450, 0, 5])
    // A fix carrying no geometric altitude hands the sampler the pressure one
    replay.add([fix('3d2f0c', NOW + 30_000, 54.1, null), ['3d2f0c', NOW + 40_000, 54.1, 12.1, null, 200, 90, 0, null, null, null, false]])
    const light = replay.aircraftAt(NOW + 45_000).find((a) => a.hex === '3d2f0c')!
    expect(light.track.map((p) => p[3])).toEqual([null, 200])
    expect(light.onGround).toBe(false)
    expect(light.callsign).toBe('')
    expect(light.source).toBe('other')
  })

  it('has no aircraft before its first fix and none a minute after its last', () => {
    const replay = new AircraftReplay()
    replay.add([fix('3c65a2', NOW, 54.2)])
    expect(replay.aircraftAt(NOW - 1)).toEqual([])
    expect(replay.aircraftAt(NOW + AIRCRAFT_EXPIRE_MS)).toHaveLength(1)
    expect(replay.aircraftAt(NOW + AIRCRAFT_EXPIRE_MS + 1)).toEqual([])
    // Right after the first fix the track is that fix alone – the sampler
    // stands on it until the next one
    expect(replay.aircraftAt(NOW + 5_000)[0].track).toHaveLength(1)
  })

  it('drops the fix an hour snapshot repeats, sorts a late line in, and answers in address order', () => {
    const replay = new AircraftReplay()
    replay.add([fix('ffffff', NOW, 54.2), fix('ffffff', NOW + 10_000, 54.21)])
    // The next hour's snapshot repeats the last fix; a tail poll brings a
    // line the file already held in the middle
    replay.add([fix('ffffff', NOW + 10_000, 54.21), fix('ffffff', NOW + 5_000, 54.205), fix('000001', NOW + 8_000, 54.0)])
    // Sampled at NOW+8 s: the track starts at the fix before that instant
    const list = replay.aircraftAt(NOW + AIRCRAFT_PLAYBACK_DELAY_MS + 8_000)
    expect(list.map((a) => a.hex)).toEqual(['000001', 'ffffff'])
    expect(list[1].track.map((p) => p[0])).toEqual([NOW + 5_000, NOW + 10_000])
  })
})

describe('AircraftArchiveClient', () => {
  const hourLine = (hex: string, t: number) => `["${hex}",${t},54.2,12.1,10000,9700,450,0,2,5,-1,false]\n`

  /** A fake endpoint: hour name → file text, fetched through the client's own option. */
  function endpoint(files: Record<string, string>) {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      const params = new URL(url, 'http://localhost').searchParams
      const text = files[params.get('hour') ?? '']
      if (text === undefined) return new Response(JSON.stringify({ error: 'none' }), { status: 404 })
      const from = Number(params.get('from') ?? 0)
      const bytes = new TextEncoder().encode(text)
      if (from > bytes.length) return new Response(null, { status: 416 })
      return new Response(bytes.slice(from), { status: 200 })
    }) as unknown as typeof fetch
    return { calls, fetchImpl, files }
  }

  /** Waits until no fetch of the client is in flight – by its own status, not by a timer. */
  const settle = async (client: AircraftArchiveClient) => {
    for (let i = 0; i < 100 && client.status().some((h) => h.status === 'loading'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  it('loads the hour of the moment from the aircraft endpoint, reaching back only the playback delay', async () => {
    const api = endpoint({
      '2027-01-15T07': hourLine('3c65a2', NOW - 20_000),
      '2027-01-15T08': hourLine('3c65a2', NOW + 5_000),
    })
    const client = new AircraftArchiveClient('/api/aircraft?city=rostock', { fetch: api.fetchImpl })
    const realNow = NOW + 3 * ARCHIVE_HOUR_MS
    // Five seconds into the hour the sampled instant (12 s behind) is in
    // the hour before – both are wanted
    client.follow(NOW + 5_000, realNow)
    await settle(client)
    expect(client.status().map((h) => `${h.key}:${h.status}`)).toEqual(['2027-01-15T07:loaded', '2027-01-15T08:loaded'])
    expect(api.calls).toEqual([
      '/api/aircraft?city=rostock&hour=2027-01-15T07',
      '/api/aircraft?city=rostock&hour=2027-01-15T08',
    ])
    // A minute in, the hour before is no longer needed
    client.follow(NOW + 60_000, realNow + 55_000)
    await settle(client)
    expect(client.status().map((h) => h.key)).toEqual(['2027-01-15T08'])
    expect(client.ready(NOW + 60_000)).toBe(true)
    // The traffic as of a moment comes from what is loaded, with the
    // recorded fix as the aircraft's position
    expect(client.aircraftAt(NOW + 20_000).map((a) => [a.hex, a.positionAt])).toEqual([['3c65a2', NOW + 5_000]])
    expect(client.aircraftAt(NOW + 70_000)).toEqual([])
  })

  it('polls the tail of the hour still being written and stops answering on stop', async () => {
    const files = { '2027-01-15T08': hourLine('3c65a2', NOW + 10_000) }
    const api = endpoint(files)
    const client = new AircraftArchiveClient('/api/aircraft?city=rostock', { fetch: api.fetchImpl })
    const simNow = NOW + 10 * 60_000
    const realNow = NOW + 12 * 60_000
    client.follow(simNow, realNow)
    await settle(client)
    expect(client.aircraftAt(NOW + 30_000)).toHaveLength(1)
    files['2027-01-15T08'] += hourLine('3d2f0c', NOW + 9 * 60_000)
    client.follow(simNow + ARCHIVE_TAIL_POLL_MS, realNow + ARCHIVE_TAIL_POLL_MS)
    await settle(client)
    const firstLength = new TextEncoder().encode(hourLine('3c65a2', NOW + 10_000)).length
    expect(api.calls[1]).toBe(`/api/aircraft?city=rostock&hour=2027-01-15T08&from=${firstLength}`)
    expect(client.aircraftAt(simNow).map((a) => a.hex)).toEqual(['3d2f0c'])
    client.stop()
    expect(client.status()).toEqual([])
    expect(client.aircraftAt(simNow)).toEqual([])
  })
})
