import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AIS_ARCHIVE_HOUR_MS,
  AIS_ARCHIVE_TAIL_POLL_MS,
  AIS_REPLAY_EDGE_MS,
  AIS_REPLAY_TRACK_LOOKBACK_MS,
  AisArchiveClient,
  AisArchiveWriter,
  AisReplay,
  aisReplayWanted,
  archiveHourIsOpen,
  archiveHourKey,
  archiveHourStart,
  archiveSnapshot,
  parseArchiveChunk,
  type AisArchiveFix,
  type AisArchiveLine,
  type AisArchiveStore,
} from '@/lib/ais-archive'
import { AIS_PLAYBACK_DELAY_MS, type AisRawMessage, type AisState } from '@/lib/ais-extract'

/**
 * The AIS archive: what the keeper writes per hour and city, and how the
 * app replays it when the clock is set into the past. The writer is
 * exercised against an in-memory store; the parity script holds the PHP
 * twin to the same output on disk.
 */

afterEach(() => vi.restoreAllMocks())

/** 2027-01-15T08:00:00Z – exactly on the hour, so the hour keys read cleanly. */
const NOW = 1_800_000_000_000
const ROSTOCK = { slug: 'rostock', box: { west: 11.9, south: 54.0, east: 12.4, north: 54.4 } }
const KIEL = { slug: 'kiel', box: { west: 10.0, south: 54.2, east: 10.4, north: 54.6 } }

function positionReport(
  mmsi: number,
  lat: number,
  lon: number,
  sog = 8,
  name?: string,
  kinematics: { cog?: number; hdg?: number; nav?: number } = {},
): AisRawMessage {
  const { cog = 90, hdg = 92, nav = 0 } = kinematics
  return {
    MessageType: 'PositionReport',
    MetaData: { MMSI: mmsi, ShipName: name ?? '', latitude: lat, longitude: lon },
    Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: sog, Cog: cog, TrueHeading: hdg, NavigationalStatus: nav } },
  }
}

function staticReport(mmsi: number, lat: number, lon: number, name: string, length = 52): AisRawMessage {
  return {
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: mmsi, ShipName: name, latitude: lat, longitude: lon },
    Message: { ShipStaticData: { Name: name, Type: 70, Dimension: { A: 40, B: length - 40, C: 6, D: 6 }, MaximumStaticDraught: 3.5 } },
  }
}

/** A store that keeps the files in memory, as "<slug>/<hour>" → text. */
function memoryStore() {
  const files = new Map<string, string>()
  const store: AisArchiveStore = {
    has: (slug, hour) => files.has(`${slug}/${hour}`),
    append: (slug, hour, text) => files.set(`${slug}/${hour}`, (files.get(`${slug}/${hour}`) ?? '') + text),
    prune: (slug, oldestKept) => {
      for (const name of [...files.keys()]) {
        if (name.startsWith(`${slug}/`) && name.slice(slug.length + 1) < oldestKept) files.delete(name)
      }
    },
  }
  const lines = (slug: string, hour: string): AisArchiveLine[] =>
    (files.get(`${slug}/${hour}`) ?? '')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AisArchiveLine)
  return { files, store, lines }
}

describe('the hour files', () => {
  it('are named by UTC hour and parse back to their start', () => {
    expect(archiveHourKey(NOW)).toBe('2027-01-15T08')
    expect(archiveHourKey(NOW + 59 * 60_000)).toBe('2027-01-15T08')
    expect(archiveHourKey(NOW + AIS_ARCHIVE_HOUR_MS)).toBe('2027-01-15T09')
    expect(archiveHourStart('2027-01-15T08')).toBe(NOW)
    expect(archiveHourStart('2027-01-15')).toBeNull()
    expect(archiveHourStart('../../etc/passwd')).toBeNull()
  })

  it('stay open for a minute after their end, then count as closed', () => {
    const end = NOW + AIS_ARCHIVE_HOUR_MS
    expect(archiveHourIsOpen('2027-01-15T08', NOW + 30 * 60_000)).toBe(true)
    expect(archiveHourIsOpen('2027-01-15T08', end + 30_000)).toBe(true)
    expect(archiveHourIsOpen('2027-01-15T08', end + 61_000)).toBe(false)
  })

  it('replay a simulated moment a minute or more behind the real one, and nothing later', () => {
    expect(aisReplayWanted(NOW - AIS_REPLAY_EDGE_MS - 1, NOW)).toBe(true)
    expect(aisReplayWanted(NOW - 30_000, NOW)).toBe(false)
    expect(aisReplayWanted(NOW, NOW)).toBe(false)
    expect(aisReplayWanted(NOW + 3_600_000, NOW)).toBe(false)
  })
})

describe('AisArchiveWriter', () => {
  it('opens an hour with a snapshot and appends the fixes that follow', () => {
    const { store, lines } = memoryStore()
    const writer = new AisArchiveWriter(store, [ROSTOCK, KIEL])
    const state: AisState = new Map()
    writer.record(state, staticReport(1, 54.1, 12.1, 'DENEB'), NOW)
    writer.record(state, positionReport(1, 54.11, 12.11), NOW + 60_000)
    writer.record(state, positionReport(2, 54.2, 12.2, 0, 'SKIFF'), NOW + 90_000)

    const hour = lines('rostock', '2027-01-15T08')
    // The first message opened the file: its snapshot already holds the
    // ship and that first fix, nothing is written twice
    expect(hour).toEqual([
      { mmsi: 1, name: 'DENEB', typeCode: 70, lengthM: 52, widthM: 12, draughtM: 3.5, lastCourseDeg: null },
      [1, NOW, 54.1, 12.1, null, null, null, null],
      // The course she moves on is in the fix, not in a static line of its own
      [1, NOW + 60_000, 54.11, 12.11, 8, 90, 92, 0],
      // A ship first seen gets her static line even with nothing learnt
      { mmsi: 2, name: 'SKIFF', typeCode: 0, lengthM: null, widthM: null, draughtM: null, lastCourseDeg: null },
      [2, NOW + 90_000, 54.2, 12.2, 0, 90, 92, 0],
    ])
    // Kiel heard nothing – no file
    expect(store.has('kiel', '2027-01-15T08')).toBe(false)
  })

  it('writes the static data again only when it changes', () => {
    const { store, lines } = memoryStore()
    const writer = new AisArchiveWriter(store, [ROSTOCK])
    const state: AisState = new Map()
    writer.record(state, positionReport(1, 54.1, 12.1), NOW)
    writer.record(state, positionReport(1, 54.1, 12.1), NOW + 1_000)
    writer.record(state, staticReport(1, 54.1, 12.1, 'DENEB'), NOW + 2_000)
    writer.record(state, staticReport(1, 54.1, 12.1, 'DENEB'), NOW + 3_000)
    const statics = lines('rostock', '2027-01-15T08').filter((line) => !Array.isArray(line))
    expect(statics.map((line) => (line as { name: string }).name)).toEqual(['', 'DENEB'])
  })

  it('carries the course a ship came in on in the snapshot, and writes no line for it under way', () => {
    const { store, lines } = memoryStore()
    const writer = new AisArchiveWriter(store, [ROSTOCK])
    const state: AisState = new Map()
    // A barge without a gyro: three fixes under way on changing courses,
    // then moored with the course her receiver makes of its drift. One
    // static line at first sight (the snapshot's, taken after the merge,
    // so it already holds that first course) – the courses ride in the fixes
    const barge = (lat: number, sog: number, cog: number, atMs: number) =>
      writer.record(state, positionReport(1, lat, 12.1, sog, '', { cog, hdg: 511 }), atMs)
    barge(54.1, 8, 200, NOW)
    barge(54.11, 8, 220, NOW + 60_000)
    barge(54.12, 8, 245, NOW + 120_000)
    barge(54.12, 0, 17, NOW + 180_000)
    expect(lines('rostock', '2027-01-15T08').filter((line) => !Array.isArray(line))).toEqual([
      { mmsi: 1, name: '', typeCode: 0, lengthM: null, widthM: null, draughtM: null, lastCourseDeg: 200 },
    ])
    // The next hour's snapshot says which way she lies; her fix at rest cannot
    barge(54.12, 0, 17, NOW + AIS_ARCHIVE_HOUR_MS)
    expect(lines('rostock', '2027-01-15T09')).toEqual([
      { mmsi: 1, name: '', typeCode: 0, lengthM: null, widthM: null, draughtM: null, lastCourseDeg: 245 },
      [1, NOW + AIS_ARCHIVE_HOUR_MS, 54.12, 12.1, 0, 17, null, 0],
    ])
  })

  it('files a ship under every city whose box she is in, and none other', () => {
    const { store } = memoryStore()
    const writer = new AisArchiveWriter(store, [ROSTOCK, KIEL])
    const state: AisState = new Map()
    writer.record(state, positionReport(1, 54.3, 10.2), NOW)
    expect(store.has('kiel', '2027-01-15T08')).toBe(true)
    expect(store.has('rostock', '2027-01-15T08')).toBe(false)
  })

  it('carries every ship alive into the next hour, and lets the retention go', () => {
    const { files, store, lines } = memoryStore()
    const writer = new AisArchiveWriter(store, [ROSTOCK])
    const state: AisState = new Map()
    writer.record(state, staticReport(1, 54.1, 12.1, 'DENEB'), NOW)
    writer.record(state, positionReport(2, 54.2, 12.2, 0, 'SKIFF'), NOW + 40 * 60_000)
    // The next hour opens on a fix of ship 2; ship 1 went quiet 61 minutes
    // ago and is not carried – the live list would not have her either
    writer.record(state, positionReport(2, 54.21, 12.21, 0), NOW + AIS_ARCHIVE_HOUR_MS + 60_000)
    expect(lines('rostock', '2027-01-15T09')).toEqual([
      { mmsi: 2, name: 'SKIFF', typeCode: 0, lengthM: null, widthM: null, draughtM: null, lastCourseDeg: null },
      [2, NOW + AIS_ARCHIVE_HOUR_MS + 60_000, 54.21, 12.21, 0, 90, 92, 0],
    ])
    // A ship still fresh is carried with her LAST fix, at its own time
    writer.record(state, positionReport(3, 54.3, 12.3), NOW + AIS_ARCHIVE_HOUR_MS + 50 * 60_000)
    writer.record(state, positionReport(2, 54.22, 12.22, 0), NOW + 2 * AIS_ARCHIVE_HOUR_MS + 1_000)
    const carried = lines('rostock', '2027-01-15T10').filter(Array.isArray) as AisArchiveFix[]
    expect(carried.map((fix) => [fix[0], fix[1]])).toEqual([
      [2, NOW + 2 * AIS_ARCHIVE_HOUR_MS + 1_000],
      [3, NOW + AIS_ARCHIVE_HOUR_MS + 50 * 60_000],
    ])
    // Five days on, the first hours are gone with the next file opened
    writer.record(state, positionReport(4, 54.1, 12.1), NOW + 122 * AIS_ARCHIVE_HOUR_MS)
    expect([...files.keys()].sort()).toEqual(['rostock/2027-01-15T10', 'rostock/2027-01-20T10'])
  })

  it('snapshots only the ships inside the box, sorted by MMSI', () => {
    const state: AisState = new Map()
    const writer = new AisArchiveWriter(memoryStore().store, [])
    writer.record(state, positionReport(9, 54.1, 12.1), NOW)
    writer.record(state, positionReport(5, 54.3, 10.2), NOW)
    writer.record(state, positionReport(7, 54.2, 12.2), NOW)
    const snapshot = archiveSnapshot(state, NOW, ROSTOCK.box)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as AisArchiveLine)
    expect(snapshot.filter(Array.isArray).map((fix) => (fix as AisArchiveFix)[0])).toEqual([7, 9])
  })
})

describe('parseArchiveChunk', () => {
  const encode = (text: string) => new TextEncoder().encode(text)

  it('reads whole lines and leaves a partial last line for the next chunk', () => {
    const text = '{"mmsi":1,"name":"A","typeCode":0,"lengthM":null,"widthM":null,"draughtM":null}\n[1,5,54.1,12.1,null,null,null,null]\n[1,6,54'
    const { lines, consumed } = parseArchiveChunk(encode(text))
    expect(lines).toHaveLength(2)
    expect(consumed).toBe(text.lastIndexOf('\n') + 1)
  })

  it('skips a line that does not parse and everything that is not a line of the archive', () => {
    const { lines } = parseArchiveChunk(encode('[1,5,54.1,12.1,null,null,null,null]\nnot json\n"a string"\n[1]\n{"noMmsi":true}\n'))
    expect(lines).toHaveLength(1)
  })

  it('counts bytes, not characters', () => {
    const text = '{"mmsi":1,"name":"MÖWE","typeCode":0,"lengthM":null,"widthM":null,"draughtM":null}\n'
    const bytes = encode(text)
    expect(bytes.length).toBe(text.length + 1)
    expect(parseArchiveChunk(bytes).consumed).toBe(bytes.length)
  })
})

describe('AisReplay', () => {
  const fix = (mmsi: number, t: number, lat = 54.1, lon = 12.1, nav: number | null = 0): AisArchiveFix => [
    mmsi,
    t,
    lat,
    lon,
    8,
    90,
    92,
    nav,
  ]
  const statics = (mmsi: number, name: string) => ({ mmsi, name, typeCode: 70, lengthM: 52, widthM: 12, draughtM: 3.5 })

  it('answers with each ship as of the moment: her last fix, her track from the sampled one', () => {
    const replay = new AisReplay()
    const t0 = NOW
    replay.add([
      statics(1, 'DENEB'),
      fix(1, t0 - 400_000, 54.08, 12.08),
      fix(1, t0 - 200_000, 54.09, 12.09),
      fix(1, t0, 54.1, 12.1),
      fix(1, t0 + 60_000, 54.11, 12.11),
      fix(1, t0 + 120_000, 54.12, 12.12),
      fix(1, t0 + 400_000, 54.13, 12.13, 5),
    ])
    const at = t0 + 310_000
    const [vessel] = replay.vesselsAt(at)
    expect(vessel.name).toBe('DENEB')
    expect(vessel.lengthM).toBe(52)
    // The last fix at or before the moment is where she is and how fresh she is
    expect(vessel.positionAt).toBe(t0 + 120_000)
    expect(vessel.lat).toBe(54.12)
    expect(vessel.navStatus).toBe(0)
    // The track starts at the fix at or before AIS_REPLAY_TRACK_LOOKBACK_MS
    // behind the instant the layer samples (AIS_PLAYBACK_DELAY_MS back) –
    // the wake reads it there – and ends at the last fix; the fix before
    // that one is not carried
    const sampled = at - AIS_PLAYBACK_DELAY_MS
    expect(sampled - AIS_REPLAY_TRACK_LOOKBACK_MS).toBeGreaterThan(t0 - 200_000)
    expect(sampled - AIS_REPLAY_TRACK_LOOKBACK_MS).toBeLessThan(t0)
    expect(vessel.track.map((p) => p[0])).toEqual([t0 - 200_000, t0, t0 + 60_000, t0 + 120_000])
    // Later, the moored fix is the last one and its status the current one
    const [later] = replay.vesselsAt(t0 + 500_000)
    expect(later.positionAt).toBe(t0 + 400_000)
    expect(later.navStatus).toBe(5)
  })

  it('has no ship before her first fix and none half an hour after her last', () => {
    const replay = new AisReplay()
    replay.add([fix(1, NOW), fix(1, NOW + 60_000)])
    expect(replay.vesselsAt(NOW - 1)).toEqual([])
    expect(replay.vesselsAt(NOW)).toHaveLength(1)
    expect(replay.vesselsAt(NOW + 60_000 + 30 * 60_000)).toHaveLength(1)
    expect(replay.vesselsAt(NOW + 60_000 + 30 * 60_000 + 1)).toEqual([])
  })

  it('reads the course a ship came in on off her fixes, and off the snapshot where they are all at rest', () => {
    const replay = new AisReplay()
    const at = (t: number, sog: number, cog: number | null): AisArchiveFix => [1, t, 54.1, 12.1, sog, cog, null, 0]
    replay.add([
      { ...statics(1, 'BARGE'), lastCourseDeg: 245 },
      at(NOW, 0, 17),
      at(NOW + 60_000, 0, null),
      at(NOW + 120_000, 6, 300),
      at(NOW + 180_000, 0.3, 12),
    ])
    // Every loaded fix at rest: the snapshot's course, not the drift of the fix
    expect(replay.vesselsAt(NOW + 60_000)[0].lastCourseDeg).toBe(245)
    // A fix under way since: its course, and it survives the fixes at rest after
    expect(replay.vesselsAt(NOW + 120_000)[0].lastCourseDeg).toBe(300)
    expect(replay.vesselsAt(NOW + 180_000)[0].lastCourseDeg).toBe(300)
    // A snapshot written before the field existed, and nothing under way: none
    const older = new AisReplay()
    older.add([statics(1, 'BARGE'), at(NOW, 0, 17)])
    expect(older.vesselsAt(NOW)[0].lastCourseDeg).toBeNull()
  })

  it('clamps the track to the first fix while the sampled moment lies before it', () => {
    const replay = new AisReplay()
    replay.add([fix(1, NOW), fix(1, NOW + 60_000)])
    const [vessel] = replay.vesselsAt(NOW + 60_000)
    expect(vessel.track.map((p) => p[0])).toEqual([NOW, NOW + 60_000])
  })

  it('drops the fix an hour snapshot repeats and sorts a late line in', () => {
    const replay = new AisReplay()
    replay.add([fix(1, NOW + 10_000), fix(1, NOW + 70_000)])
    // The next hour's snapshot carries the last fix again
    replay.add([statics(1, 'DENEB'), fix(1, NOW + 70_000), fix(1, NOW + 130_000)])
    // …and an earlier hour loaded afterwards lands in order
    replay.add([fix(1, NOW - 50_000)])
    // Sampled before her first fix, the track is all of them, once each
    const [vessel] = replay.vesselsAt(NOW + 130_000)
    expect(vessel.track.map((p) => p[0])).toEqual([NOW - 50_000, NOW + 10_000, NOW + 70_000, NOW + 130_000])
    expect(vessel.name).toBe('DENEB')
  })

  it('takes a nameless ship as the live list does, and leaves the excluded twins out', () => {
    const replay = new AisReplay()
    replay.add([fix(1, NOW), fix(2, NOW)])
    const fleet = replay.vesselsAt(NOW, new Set([2]))
    expect(fleet.map((v) => v.mmsi)).toEqual([1])
    expect(fleet[0].name).toBe('')
    expect(fleet[0].typeCode).toBe(0)
    expect(fleet[0].lengthM).toBeNull()
  })

  it('answers in MMSI order whatever order the hours came in', () => {
    const replay = new AisReplay()
    replay.add([fix(9, NOW), fix(3, NOW), fix(5, NOW)])
    expect(replay.vesselsAt(NOW).map((v) => v.mmsi)).toEqual([3, 5, 9])
  })
})

describe('AisArchiveClient', () => {
  const hourLine = (mmsi: number, t: number) => `[${mmsi},${t},54.1,12.1,8,90,92,0]\n`

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

  /**
   * Waits until no fetch of the client is in flight – by its own status,
   * not by a timer, so a slow event loop cannot make the wait too short.
   * The stubbed endpoint answers in microtasks; the cap is only there so
   * a broken client fails the test instead of hanging it.
   */
  const settle = async (client: AisArchiveClient) => {
    for (let i = 0; i < 100 && client.status().some((h) => h.status === 'loading'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  it('loads the hour of the moment, the hour the sampling reaches back into, and the next one ahead', async () => {
    const api = endpoint({
      '2027-01-15T07': hourLine(1, NOW - 120_000),
      '2027-01-15T08': hourLine(1, NOW + 60_000),
      '2027-01-15T09': hourLine(1, NOW + AIS_ARCHIVE_HOUR_MS + 60_000),
    })
    const client = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    // Two minutes into the hour: the sampled moment (4 min behind) is in
    // the hour before, and the next hour is not due yet
    const realNow = NOW + 3 * AIS_ARCHIVE_HOUR_MS
    client.follow(NOW + 120_000, realNow)
    await settle(client)
    expect(client.status().map((h) => `${h.key}:${h.status}`)).toEqual([
      '2027-01-15T07:loaded',
      '2027-01-15T08:loaded',
    ])
    // Fifty-five minutes in, at real pace: the next hour is prefetched, the
    // one before dropped
    client.follow(NOW + 55 * 60_000, realNow + 53 * 60_000)
    await settle(client)
    expect(client.status().map((h) => `${h.key}:${h.status}`)).toEqual([
      '2027-01-15T08:loaded',
      '2027-01-15T09:loaded',
    ])
    // Closed hours are asked for once, whole, and never again
    expect(api.calls.filter((url) => url.includes('hour=2027-01-15T08'))).toEqual([
      '/api/ais?city=rostock&hour=2027-01-15T08',
    ])
    // The fleet as of a moment comes from what is loaded – the hour's only
    // fix places the ship for the half hour after it, then she expires
    expect(client.vesselsAt(NOW + 20 * 60_000).map((v) => v.positionAt)).toEqual([NOW + 60_000])
    expect(client.vesselsAt(NOW + 55 * 60_000)).toEqual([])
  })

  it('prefetches further ahead the faster the clock runs', async () => {
    const api = endpoint({})
    const at = NOW + 2 * AIS_ARCHIVE_HOUR_MS + 45 * 60_000
    // At real pace, a quarter of an hour before the boundary, the next
    // hour is not wanted yet – the lead is ten minutes
    const slow = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    slow.follow(at - 60_000, NOW)
    slow.follow(at, NOW + 60_000)
    await settle(slow)
    expect(slow.status().map((h) => h.key)).toEqual(['2027-01-15T10'])
    // Under a ×165 time-lapse the same moment is reached within a minute of
    // real time, and ten real seconds at that pace reach into the next hour
    const fast = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    fast.follow(NOW, NOW)
    fast.follow(at, NOW + 60_000)
    await settle(fast)
    expect(fast.status().map((h) => h.key)).toEqual(['2027-01-15T10', '2027-01-15T11'])
  })

  it('polls the tail of the hour still being written, from where it stopped', async () => {
    const files = { '2027-01-15T08': hourLine(1, NOW + 10_000) }
    const api = endpoint(files)
    const client = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    const simNow = NOW + 10 * 60_000
    const realNow = NOW + 12 * 60_000
    client.follow(simNow, realNow)
    await settle(client)
    expect(client.vesselsAt(simNow)).toHaveLength(1)
    // The file grows; the next follow within the poll interval asks nothing
    files['2027-01-15T08'] += hourLine(2, NOW + 70_000)
    client.follow(simNow + 1_000, realNow + 1_000)
    await settle(client)
    expect(api.calls).toHaveLength(1)
    // Past the interval, only the new bytes are asked for
    client.follow(simNow + AIS_ARCHIVE_TAIL_POLL_MS, realNow + AIS_ARCHIVE_TAIL_POLL_MS)
    await settle(client)
    const firstLength = new TextEncoder().encode(hourLine(1, NOW + 10_000)).length
    expect(api.calls[1]).toBe(`/api/ais?city=rostock&hour=2027-01-15T08&from=${firstLength}`)
    expect(client.vesselsAt(simNow).map((v) => v.mmsi)).toEqual([1, 2])
    expect(client.status()[0].lines).toBe(2)
  })

  it('is ready for a moment once its hour has been answered for, a tail refresh included', async () => {
    const files = { '2027-01-15T08': hourLine(1, NOW + 10_000) }
    const api = endpoint(files)
    const client = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    const simNow = NOW + 10 * 60_000
    const realNow = NOW + 12 * 60_000
    expect(client.ready(simNow)).toBe(false)
    client.follow(simNow, realNow)
    // Asked, not answered: whoever draws keeps the picture that is up
    expect(client.ready(simNow)).toBe(false)
    await settle(client)
    expect(client.ready(simNow)).toBe(true)
    // The tail refresh puts the hour back to loading, but it is still there
    client.follow(simNow + AIS_ARCHIVE_TAIL_POLL_MS, realNow + AIS_ARCHIVE_TAIL_POLL_MS)
    expect(client.status()[0].status).toBe('loading')
    expect(client.ready(simNow)).toBe(true)
    await settle(client)
    // An hour nobody recorded is answered for too – with an empty harbour
    const absent = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    absent.follow(NOW + 3 * AIS_ARCHIVE_HOUR_MS, NOW + 4 * AIS_ARCHIVE_HOUR_MS)
    await settle(absent)
    expect(absent.ready(NOW + 3 * AIS_ARCHIVE_HOUR_MS)).toBe(true)
    expect(absent.vesselsAt(NOW + 3 * AIS_ARCHIVE_HOUR_MS)).toEqual([])
  })

  it('keeps asking for an open hour nobody has recorded yet, and gives up on a closed one', async () => {
    const api = endpoint({})
    const client = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    const realNow = NOW + 30 * 60_000
    client.follow(NOW + 10 * 60_000, realNow)
    await settle(client)
    expect(client.status().map((h) => h.status)).toEqual(['absent'])
    expect(client.vesselsAt(NOW + 10 * 60_000)).toEqual([])
    client.follow(NOW + 10 * 60_000, realNow + AIS_ARCHIVE_TAIL_POLL_MS)
    await settle(client)
    expect(api.calls).toHaveLength(2)
    // A day later that hour is closed for good – one 404 is the answer
    const client2 = new AisArchiveClient('/api/ais?city=rostock', { fetch: api.fetchImpl })
    const dayLater = realNow + 24 * AIS_ARCHIVE_HOUR_MS
    client2.follow(NOW + 10 * 60_000, dayLater)
    await settle(client2)
    client2.follow(NOW + 10 * 60_000, dayLater + AIS_ARCHIVE_TAIL_POLL_MS)
    await settle(client2)
    expect(api.calls).toHaveLength(3)
  })

  it('drops a late answer for an hour it no longer holds, and everything on stop', async () => {
    let release: (() => void) | null = null
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(new TextEncoder().encode(hourLine(1, NOW)), { status: 200 }))
        }),
    ) as unknown as typeof fetch
    const client = new AisArchiveClient('/api/ais?city=rostock', { fetch: fetchImpl })
    client.follow(NOW, NOW)
    client.stop()
    release!()
    // Nothing is in flight as far as the client knows – give the late
    // answer a real turn of the loop to land, and see it land nowhere
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(client.status()).toEqual([])
    expect(client.vesselsAt(NOW)).toEqual([])
  })
})
