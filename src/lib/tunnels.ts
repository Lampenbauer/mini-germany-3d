/**
 * Tunnel/underground sections of a route, expressed as distance ranges
 * (meters along the direction path). The data pipeline derives them from
 * the OSM way tags (tunnel=*, location=underground, negative layer) and
 * stores them per direction in network.json; map and simulation use them
 * to render affected route sections and vehicles at reduced visibility.
 */

import { heightAtDistance, sampleAtDistance } from '@/lib/geo'
import type { LonLat } from '@/lib/geo'

/** [start, end] in meters along the direction path (start < end). */
export type TunnelRange = [number, number]

/**
 * Sanitizes raw ranges from network.json: keeps only finite pairs, clamps
 * them to [0, totalLength], drops empty ranges, sorts them, and merges
 * overlapping/touching ones. The result is safe for binary-search-free
 * scans and for path splitting.
 */
export function normalizeTunnelRanges(
  raw: readonly (readonly number[])[] | undefined,
  totalLength: number,
): TunnelRange[] {
  if (!raw || raw.length === 0 || !(totalLength > 0)) return []
  const clamped: TunnelRange[] = []
  for (const range of raw) {
    if (!Array.isArray(range) || range.length < 2) continue
    const start = Math.max(0, Math.min(totalLength, Number(range[0])))
    const end = Math.max(0, Math.min(totalLength, Number(range[1])))
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (end - start <= 0) continue
    clamped.push([start, end])
  }
  clamped.sort((a, b) => a[0] - b[0])
  const merged: TunnelRange[] = []
  for (const range of clamped) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

/**
 * Ranges for the opposite direction of a mirrored path: [a, b] becomes
 * [L - b, L - a], and the order is reversed so the result stays sorted.
 */
export function mirrorTunnelRanges(
  ranges: readonly TunnelRange[],
  totalLength: number,
): TunnelRange[] {
  return [...ranges]
    .map(([start, end]): TunnelRange => [totalLength - end, totalLength - start])
    .reverse()
}

/**
 * true if `dist` (meters along the path) lies inside a tunnel section.
 * Binary search over the sorted, non-overlapping ranges – O(log n) even
 * for directions with many underground sections.
 */
export function isInTunnel(ranges: readonly TunnelRange[], dist: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = ranges[mid]
    if (dist < start) hi = mid - 1
    else if (dist > end) lo = mid + 1
    else return true
  }
  return false
}

/** A contiguous portion of a direction path, above ground or in a tunnel. */
export interface PathPiece {
  path: LonLat[]
  /**
   * Distance of every piece vertex along the whole direction path, in
   * meters – what the map needs to look a vertex up in a profile that is
   * kept per direction rather than per piece (the measured bridge decks).
   */
  cum: number[]
  tunnel: boolean
  /** Per-vertex heights of the piece – present iff heights were passed in. */
  heights?: number[]
}

/**
 * Splits a direction path into alternating above-ground/tunnel pieces along
 * the (normalized) tunnel ranges. Neighboring pieces share their boundary
 * point, so the rendered polylines connect seamlessly. Expects `ranges` to
 * be normalized (sorted, merged, within [0, total]). Optional per-vertex
 * heights are split alongside, interpolated at the piece boundaries.
 */
export function splitPathByTunnels(
  path: LonLat[],
  cum: number[],
  ranges: readonly TunnelRange[],
  heights?: readonly number[],
): PathPiece[] {
  const wholePath = (): PathPiece[] => [
    { path, cum: [...cum], tunnel: false, ...(heights ? { heights: [...heights] } : {}) },
  ]
  if (ranges.length === 0 || path.length < 2) return wholePath()
  const total = cum[cum.length - 1]
  const pieces: PathPiece[] = []
  let cursor = 0
  const pushPiece = (start: number, end: number, tunnel: boolean): void => {
    const slice = slicePath(path, cum, start, end, heights)
    if (slice.path.length >= 2) {
      pieces.push({
        path: slice.path,
        cum: slice.cum,
        tunnel,
        ...(slice.heights ? { heights: slice.heights } : {}),
      })
    }
  }
  for (const [start, end] of ranges) {
    if (start > cursor) pushPiece(cursor, start, false)
    pushPiece(Math.max(cursor, start), end, true)
    cursor = end
  }
  if (cursor < total) pushPiece(cursor, total, false)
  return pieces.length > 0 ? pieces : wholePath()
}

/**
 * Sub-polyline between two distances: interpolated boundary points plus all
 * original vertices strictly in between (consecutive duplicates dropped),
 * each with its distance along the whole path.
 */
function slicePath(
  path: LonLat[],
  cum: number[],
  start: number,
  end: number,
  heights?: readonly number[],
): { path: LonLat[]; cum: number[]; heights?: number[] } {
  const out: LonLat[] = []
  const dists: number[] = []
  const hs: number[] | undefined = heights ? [] : undefined
  const push = (lon: number, lat: number, d: number, h: number | undefined): void => {
    const prev = out[out.length - 1]
    if (prev && prev[0] === lon && prev[1] === lat) return
    out.push([lon, lat])
    dists.push(d)
    if (hs && h !== undefined) hs.push(h)
  }
  const first = sampleAtDistance(path, cum, start)
  push(first.lon, first.lat, start, heights ? heightAtDistance(heights, cum, start) : undefined)
  for (let i = 0; i < path.length; i++) {
    if (cum[i] <= start) continue
    if (cum[i] >= end) break
    push(path[i][0], path[i][1], cum[i], heights?.[i])
  }
  const last = sampleAtDistance(path, cum, end)
  push(last.lon, last.lat, end, heights ? heightAtDistance(heights, cum, end) : undefined)
  return { path: out, cum: dists, heights: hs }
}
