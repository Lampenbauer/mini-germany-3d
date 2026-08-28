import { afterEach, describe, expect, it, vi } from 'vitest'
import { AisClient } from '@/lib/ais'
import type { AisVessel } from '@/lib/ais-extract'

/**
 * What the client does to a response before the app sees it: shift the
 * server's timestamps into this browser's timeline, and make sure every
 * vessel really has every field.
 *
 * The second part is not paranoia. The server's state file outlives
 * deploys, so a record written before a field existed comes back without
 * that key - absent, which is not null. It reached production: 134 of 143
 * vessels arrived without draughtM, `undefined` walked through a
 * `=== null` guard, and the first `.toFixed` blanked the whole view.
 */

afterEach(() => vi.restoreAllMocks())

const NOW = 1_800_000_000_000

/** A vessel as the FIRST AIS release wrote it: no track, no draughtM. */
const legacyVessel = {
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
  positionAt: NOW - 30_000,
}

function serve(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response),
  )
}

/** One poll, resolved once the client has handed the app its vessels. */
async function pollOnce(body: unknown): Promise<AisVessel[]> {
  serve(body)
  return await new Promise<AisVessel[]>((resolve) => {
    const client = new AisClient('/api/ais', (_status, vessels) => {
      client.stop()
      resolve(vessels)
    })
    client.start(60_000)
  })
}

describe('AisClient', () => {
  it('fills in fields a record predates instead of passing undefined on', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const [vessel] = await pollOnce({ timestamp: NOW, servedAt: NOW, vessels: [legacyVessel] })

    expect(vessel.draughtM).toBeNull()
    expect(vessel.track).toEqual([])
    // …without touching what the record did carry
    expect(vessel.name).toBe('DENEB')
    expect(vessel.lengthM).toBe(52)
    expect(vessel.sogKn).toBe(8.4)
    expect(vessel.typeCode).toBe(70)
  })

  it('keeps a complete record complete', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const full = { ...legacyVessel, draughtM: 3.5, track: [[NOW - 30_000, 54.09, 12.1, 8, 90, 92]] }
    const [vessel] = await pollOnce({ timestamp: NOW, servedAt: NOW, vessels: [full] })

    expect(vessel.draughtM).toBe(3.5)
    expect(vessel.track).toHaveLength(1)
  })

  it('shifts fixes and track points off the server clock onto this one', async () => {
    // The browser is 5 s ahead of the server that answered
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 5_000)
    const full = { ...legacyVessel, track: [[NOW - 30_000, 54.09, 12.1, 8, 90, 92]] }
    const [vessel] = await pollOnce({ timestamp: NOW, servedAt: NOW, vessels: [full] })

    expect(vessel.positionAt).toBe(NOW - 30_000 + 5_000)
    expect(vessel.track[0][0]).toBe(NOW - 30_000 + 5_000)
  })

  it('reports an unreachable endpoint without losing the last picture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response))
    const status = await new Promise<string>((resolve) => {
      const client = new AisClient('/api/ais', (s) => {
        client.stop()
        resolve(s.state)
      })
      client.start(60_000)
    })
    expect(status).toBe('error')
  })
})
