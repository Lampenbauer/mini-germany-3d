import { Cartesian3, Cartographic, Entity, Intersect, Model, type Primitive, type Viewer } from 'cesium'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIRCRAFT_PLAYBACK_DELAY_MS, type Aircraft, type AircraftTrackPoint } from '@/lib/aircraft-extract'
import { aircraftSize } from '@/lib/aircraft-info'
import { AircraftLayer } from '@/map/AircraftLayer'

/**
 * The traffic's heights through a landing: the approach on the altitudes
 * the feed reports, the rollout on the apron the tiles answer with, and
 * between the two nothing the feed did not say. The bodies stay boxes –
 * no glTF in a unit test – and the pose drawn is what is read.
 */

afterEach(() => vi.restoreAllMocks())

const NOW = 1_800_000_000_000
/** Hamburg's numbers: the geoid height the routes carry, and the runway as the tiles answer (ellipsoid metres). */
const GEOID = 40
const RUNWAY = 56
const HEX = '3c648d'
const SIZE = aircraftSize('A321', 'A3', 'DLH3PK')
/** Where the A321's body centre stands on the runway. */
const ON_RUNWAY = RUNWAY + SIZE.heightM / 2

/** A fix on the approach to Fuhlsbüttel's runway 23, `alt` null on the ground. */
function fix(t: number, lonOff: number, alt: number | null, geometric = alt !== null): AircraftTrackPoint {
  return [t, 53.64, 10.0 - lonOff, alt, alt === null ? 99 : 130, 230, alt === null ? null : -3.6, 230, geometric]
}

/** The record as the poll delivers it: its fields those of its last fix, its track the fixes so far. */
function dlh3pk(track: AircraftTrackPoint[]): Aircraft {
  const last = track[track.length - 1]
  const onGround = last[3] === null
  return {
    hex: HEX,
    callsign: 'DLH3PK',
    registration: 'D-AIDM',
    typeCode: 'A321',
    description: 'AIRBUS A-321',
    category: 'A3',
    lat: last[1],
    lon: last[2],
    altGeomM: onGround || !last[8] ? null : last[3],
    // A pressure altitude some way under the geometric one, as on any day
    altBaroM: onGround ? null : last[8] ? (last[3] as number) - GEOID - 20 : last[3],
    onGround,
    gsKn: last[4],
    trackDeg: 230,
    headingDeg: 230,
    verticalRateMps: last[6],
    rollDeg: null,
    squawk: '',
    source: 'adsb',
    positionAt: last[0],
    track,
  }
}

function harness() {
  // The glTF body never arrives: the box stands in, and nothing is fetched
  vi.spyOn(Model, 'fromGltfAsync').mockReturnValue(new Promise<Model>(() => {}))
  const viewer = {
    scene: {
      primitives: {
        add: (primitive: Primitive) => primitive,
        remove: (primitive: Primitive) => primitive,
      },
    },
    entities: {
      suspendEvents: () => {},
      resumeEvents: () => {},
      add: (options: Entity.ConstructorOptions) => new Entity(options),
      remove: () => true,
    },
    camera: {
      positionWC: Cartesian3.fromDegrees(9.99, 53.63, 400),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: {
        computeCullingVolume: () => ({ computeVisibility: () => Intersect.INTERSECTING }),
      },
    },
  } as unknown as Viewer
  const picks: [number, number][] = []
  const layer = new AircraftLayer(viewer, {
    requestRender: () => {},
    defaultGroundHeight: 50,
    geoidHeight: GEOID,
    clampToSurface: (lon, lat) => {
      picks.push([lon, lat])
      return RUNWAY
    },
    surfaceGeneration: () => 1,
    noteCameraFlight: () => {},
  })
  const records = (layer as unknown as { aircraft: Map<string, { displayPosition: Cartesian3 }> }).aircraft
  /**
   * The height drawn after a tick at `renderMs` – the instant the
   * playback shows. Ticks two seconds and more apart, so the display ease
   * has caught up with the target (see SMOOTH_TAU_MS).
   */
  const heightAt = (track: AircraftTrackPoint[], renderMs: number): number => {
    layer.sync([dlh3pk(track)], renderMs + AIRCRAFT_PLAYBACK_DELAY_MS)
    return Cartographic.fromCartesian(records.get(HEX)!.displayPosition).height
  }
  return { heightAt, picks }
}

describe('AircraftLayer heights', () => {
  // Fixes every five seconds down the glide path, the last one in the air
  // sixteen metres over the runway, then the ground
  const approach = [fix(NOW, 0, 92), fix(NOW + 5_000, 0.005, 82), fix(NOW + 10_000, 0.01, 72)]
  const landed = [...approach, fix(NOW + 15_000, 0.014, null)]
  const rolling = [...landed, fix(NOW + 20_000, 0.017, null)]

  it('flies the approach on, unlifted, once the record reports the ground', () => {
    // The record is twelve seconds ahead of the picture: it reports the
    // ground while the playback is still on the glide path. The fixes
    // there carry geometric altitudes, and are drawn as such – read off
    // the record, they took the geoid height on top, and every landing
    // hovered forty metres over the runway until the playback reached the
    // ground, where it dropped onto it (2026-10-03)
    const { heightAt } = harness()
    expect(heightAt(approach, NOW + 3_000)).toBeCloseTo(86, 1)
    expect(heightAt(landed, NOW + 6_000)).toBeCloseTo(80, 1)
  })

  it('comes down onto the runway at its own rate, never through it, and rolls there', () => {
    const { heightAt, picks } = harness()
    heightAt(landed, NOW + 6_000)
    expect(picks).toHaveLength(0)
    // A second past the last fix in the air: 3.6 m lower and coming down,
    // where the last altitude reported was held until 2026-10-03 – and
    // the runway under it already asked for
    const descending = heightAt(landed, NOW + 11_000)
    expect(descending).toBeLessThan(72 - 3.6 + 0.01)
    expect(descending).toBeGreaterThan(ON_RUNWAY)
    expect(picks.length).toBeGreaterThan(0)
    // Its rate has carried it below the runway by now: it stands on it
    expect(heightAt(landed, NOW + 13_000)).toBeCloseTo(ON_RUNWAY, 3)
    // …and rolls on after the first fix on the ground
    expect(heightAt(rolling, NOW + 17_000)).toBeCloseTo(ON_RUNWAY, 3)
  })

  it('lifts a pressure altitude by the geoid height', () => {
    const { heightAt } = harness()
    const pressure = [fix(NOW, 0, 400, false), fix(NOW + 5_000, 0.005, 420, false)]
    expect(heightAt(pressure, NOW + 2_500)).toBeCloseTo(410 + GEOID, 1)
  })
})
