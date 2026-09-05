import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OVERPASS_MIRRORS,
  RETRY_DELAY_MS,
  isTransientOverpassFailure,
  postOverpass,
} from '../scripts/lib/overpass.mjs'

/**
 * The pipeline's Overpass access: the mirror list is walked once, and
 * when every mirror failed for a reason that passes with time (load, a
 * gateway timeout, an empty answer) it is walked a second time after a
 * pause. A query the instances reject as such is not repeated.
 */

const answer = (elements: unknown[]) =>
  new Response(JSON.stringify({ elements }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const failure = (status: number) => new Response(`<html>Error ${status}</html>`, { status })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('postOverpass', () => {
  it('returns the first mirror’s answer without waiting', async () => {
    const fetchImpl = vi.fn(async () => answer([{ id: 1 }]))
    const sleepImpl = vi.fn(async () => {})
    const data = await postOverpass('rel(1);out;', { fetchImpl, sleepImpl })
    expect(data).toEqual({ elements: [{ id: 1 }] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sleepImpl).not.toHaveBeenCalled()
  })

  it('moves on to the next mirror within a round', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchImpl = vi.fn().mockResolvedValueOnce(failure(504)).mockResolvedValueOnce(answer([{ id: 2 }]))
    const sleepImpl = vi.fn(async () => {})
    const data = await postOverpass('rel(1);out;', { fetchImpl, sleepImpl })
    expect(data).toEqual({ elements: [{ id: 2 }] })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toBe(OVERPASS_MIRRORS[0])
    expect(fetchImpl.mock.calls[1][0]).toBe(OVERPASS_MIRRORS[1])
    expect(sleepImpl).not.toHaveBeenCalled()
  })

  it('waits and walks the mirrors again when all of them failed under load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failure(504))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(answer([{ id: 3 }]))
    const sleepImpl = vi.fn(async () => {})
    const data = await postOverpass('rel(1);out;', { fetchImpl, sleepImpl })
    expect(data).toEqual({ elements: [{ id: 3 }] })
    expect(sleepImpl).toHaveBeenCalledTimes(1)
    expect(sleepImpl).toHaveBeenCalledWith(RETRY_DELAY_MS)
    expect(fetchImpl).toHaveBeenCalledTimes(OVERPASS_MIRRORS.length + 1)
  })

  it('treats an implausible answer like an outage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => answer([]))
    const sleepImpl = vi.fn(async () => {})
    await expect(
      postOverpass('rel(1);out;', { validate: (d) => ((d as { elements: unknown[] }).elements.length ?? 0) > 0, fetchImpl, sleepImpl }),
    ).rejects.toThrow(/All Overpass endpoints failed/)
    expect(sleepImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(OVERPASS_MIRRORS.length * 2)
  })

  it('does not repeat a query the mirrors reject as such', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A fresh Response per call – a body can only be read once
    const fetchImpl = vi.fn(async () => failure(400))
    const sleepImpl = vi.fn(async () => {})
    await expect(postOverpass('rel(;', { fetchImpl, sleepImpl })).rejects.toThrow(/HTTP 400/)
    expect(sleepImpl).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(OVERPASS_MIRRORS.length)
  })
})

describe('isTransientOverpassFailure', () => {
  it('counts load and network trouble as passing, a bad query as not', () => {
    expect(isTransientOverpassFailure(429)).toBe(true)
    expect(isTransientOverpassFailure(504)).toBe(true)
    expect(isTransientOverpassFailure(500)).toBe(true)
    expect(isTransientOverpassFailure(undefined)).toBe(true)
    expect(isTransientOverpassFailure(400)).toBe(false)
    expect(isTransientOverpassFailure(403)).toBe(false)
  })
})
