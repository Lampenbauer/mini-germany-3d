/**
 * The NHN→ellipsoid offset the routes and the vehicles ride on, as a field
 * along every direction rather than one number for the city.
 *
 * The number was the median of (tile height − DGM height) over forty
 * stops, measured once per visit (CesiumMap.bootstrapGroundHeights), and
 * it still is the base of the field. But Google's mesh is a surface
 * model and the DGM is bare earth, and where the two differ from place
 * to place – a road on an embankment, a mesh bias of a metre or two in
 * one quarter – a constant offset floats the line or sinks it. The stops
 * are measured on the mesh anyway, the ones nearest the camera a few at
 * a time (StopsLayer.resolveHeights), so every stop measured FINE – from
 * within FIELD_FINE_RANGE_M, where the tiles under it are the fine ones;
 * a coarse tile answers metres too high – and in band (within
 * FIELD_BAND_M of the base: a hall roof or a tree crown over a stop is
 * not the ground) becomes a sample of the field at its distance along
 * every direction that calls there. Between samples the offset runs
 * from one to the next; a sample's say fades to the base over
 * FIELD_REACH_M either way, so one measured stop does not pull a whole
 * line, and a direction with no sample is on the base as before.
 *
 * Pure: no scene, no clock – the layers hand it measurements and ask it
 * for offsets. Tested in tests/height-field.test.ts.
 */

import type { PreparedNetwork } from '@/data/network-types'

/** A stop measured from further away than this is on coarse tiles and says nothing. */
export const FIELD_FINE_RANGE_M = 1500
/** A measured offset further than this from the base is a roof, not the ground. */
export const FIELD_BAND_M = 4
/** How far along the path a sample's say reaches before the base takes over. */
export const FIELD_REACH_M = 1000
/** A re-measurement that moved a sample less than this changes nothing drawn. */
const FIELD_SETTLED_M = 0.3

interface DirectionStops {
  key: string
  /** The direction's stops by distance along its path. */
  stops: { id: string; dist: number }[]
}

export interface FieldSample {
  dist: number
  offset: number
}

function directionKey(lineId: string, direction: 0 | 1): string {
  return `${lineId}|${direction}`
}

export class HeightField {
  private base: number
  /** stopId → the measured offset (tile height − DGM height), fine ones only. */
  private measured = new Map<string, number>()
  private directions = new Map<string, DirectionStops>()
  /** stopId → the keys of every direction calling there. */
  private stopDirections = new Map<string, string[]>()
  /** Per direction the samples in band, by distance – rebuilt lazily. */
  private cache = new Map<string, FieldSample[]>()

  constructor(base: number) {
    this.base = base
  }

  /** The city-wide offset the field falls back to between and beyond its samples. */
  get baseOffset(): number {
    return this.base
  }

  /** The base changed (the bootstrap's calibration): every direction reads differently. */
  setBase(base: number): void {
    if (base === this.base) return
    this.base = base
    this.cache.clear()
  }

  /** The directions of a city, with the stops each calls at. */
  add(network: PreparedNetwork): void {
    for (const line of network.lines) {
      for (const dir of line.directions) {
        const key = directionKey(line.id, dir.direction)
        const stops = dir.stops.map((stop) => ({ id: stop.id, dist: stop.dist }))
        this.directions.set(key, { key, stops })
        for (const stop of stops) {
          const keys = this.stopDirections.get(stop.id)
          if (keys) keys.push(key)
          else this.stopDirections.set(stop.id, [key])
        }
      }
    }
    this.cache.clear()
  }

  /** The city left: its directions and measurements go with it, the base stays. */
  clear(): void {
    this.measured.clear()
    this.directions.clear()
    this.stopDirections.clear()
    this.cache.clear()
  }

  /** How many stops the field holds a fine measurement for. */
  get sampleCount(): number {
    return this.measured.size
  }

  /**
   * A stop was measured on the tiles: `offset` is its tile height less
   * its DGM height, `fromDistance` how far the camera stood (0 for the
   * bootstrap's most detailed sample). Returns the directions whose field
   * changed by it – none for a coarse measurement, one that merely
   * confirmed the sample, or a stop no direction calls at.
   */
  measure(stopId: string, offset: number, fromDistance: number): string[] {
    if (!Number.isFinite(offset) || fromDistance > FIELD_FINE_RANGE_M) return []
    const keys = this.stopDirections.get(stopId)
    if (!keys) return []
    const before = this.measured.get(stopId)
    if (before !== undefined && Math.abs(before - offset) < FIELD_SETTLED_M) return []
    this.measured.set(stopId, offset)
    for (const key of keys) this.cache.delete(key)
    return keys
  }

  /** The samples of a direction in band, by distance (tests and the debug API). */
  samples(lineId: string, direction: 0 | 1): FieldSample[] {
    return this.samplesOf(directionKey(lineId, direction))
  }

  private samplesOf(key: string): FieldSample[] {
    const cached = this.cache.get(key)
    if (cached) return cached
    const dir = this.directions.get(key)
    const samples: FieldSample[] = []
    if (dir) {
      for (const stop of dir.stops) {
        const offset = this.measured.get(stop.id)
        if (offset === undefined || Math.abs(offset - this.base) > FIELD_BAND_M) continue
        samples.push({ dist: stop.dist, offset })
      }
    }
    this.cache.set(key, samples)
    return samples
  }

  /**
   * The offset at `distance` meters along a direction: the base, moved
   * toward the samples within FIELD_REACH_M by their nearness – at a
   * sample exactly its own offset, between two of them their blend,
   * fading back to the base where none reaches.
   */
  offsetAt(lineId: string, direction: 0 | 1, distance: number): number {
    const samples = this.samplesOf(directionKey(lineId, direction))
    if (samples.length === 0) return this.base
    let weight = 0
    let sum = 0
    for (const sample of samples) {
      const away = Math.abs(sample.dist - distance)
      if (away >= FIELD_REACH_M) continue
      const w = 1 - away / FIELD_REACH_M
      weight += w
      sum += w * (sample.offset - this.base)
    }
    if (weight === 0) return this.base
    return this.base + sum / Math.max(1, weight)
  }
}
