import { Cartesian3, Cartographic } from 'cesium'
import { describe, expect, it } from 'vitest'
import { PLUME_MAX_RATE } from '@/map/FunnelSmoke'
import {
  KELVIN_SPREAD,
  WAKE_CHURN_MPS,
  WAKE_FADE_FRAME_S,
  WAKE_FULL_SPEED_MPS,
  WAKE_LIFE_S,
  WAKE_MIN_SPEED_MPS,
  WAKE_STEP_S,
  WAKE_STREAK_MPS,
  Wake,
  wakeColor,
  wakeIntensity,
  type WakeHull,
  type WakeSample,
} from '@/map/Wake'
import type { FrameState } from '@/map/cesium-renderer'

/**
 * The wakes: where the foam goes for a ship's past poses – behind her
 * when she goes ahead, before her when she goes astern, nowhere when she
 * stands – how it spreads and fades, and when the primitive draws. The
 * shaders compile only on a GL context; e2e/ship-effects.spec.ts proves
 * them in the real renderer.
 */

const host = { sunDirection: null as Cartesian3 | null, overcast: 0 }
const LAT = 54.1
const LON = 12.13
const SURFACE = 40
const hull: WakeHull = { lengthM: 100, beamM: 20, surfaceHeight: SURFACE, seed: 7 }

/** Metres east and north of the reference point, and the height, of a patch's anchor. */
function place(anchor: Cartesian3): { east: number; north: number; height: number } {
  const carto = Cartographic.fromCartesian(anchor)
  const lat = (carto.latitude * 180) / Math.PI
  const lon = (carto.longitude * 180) / Math.PI
  return {
    east: (lon - LON) * 111_320 * Math.cos((LAT * Math.PI) / 180),
    north: (lat - LAT) * 111_132,
    height: carto.height,
  }
}

/**
 * A ship at the reference point now, having come along `courseDeg` at a
 * steady speed over the last WAKE_LIFE_S, with her hull pointing
 * `bearingDeg`.
 */
function straightRun(speedMps: number, courseDeg: number, bearingDeg = courseDeg): WakeSample[] {
  const samples: WakeSample[] = []
  const course = (courseDeg * Math.PI) / 180
  for (let ageS = 0; ageS < WAKE_LIFE_S; ageS += WAKE_STEP_S) {
    const back = speedMps * ageS
    samples.push({
      ageS,
      lon: LON - (Math.sin(course) * back) / (111_320 * Math.cos((LAT * Math.PI) / 180)),
      lat: LAT - (Math.cos(course) * back) / 111_132,
      bearingDeg,
    })
  }
  return samples
}

describe('wakeIntensity', () => {
  it('leaves no foam under a knot, a full wake from ten, more with the way she makes', () => {
    expect(wakeIntensity(0)).toBe(0)
    expect(wakeIntensity(Number.NaN)).toBe(0)
    expect(wakeIntensity(WAKE_MIN_SPEED_MPS - 0.01)).toBe(0)
    expect(wakeIntensity(WAKE_MIN_SPEED_MPS)).toBeCloseTo(0.35, 5)
    expect(wakeIntensity(WAKE_FULL_SPEED_MPS)).toBe(1)
    expect(wakeIntensity(3)).toBeGreaterThan(wakeIntensity(2))
  })
})

describe('wakeColor', () => {
  it('is white in daylight and dark at night', () => {
    const noon = wakeColor(1, 0)
    expect(noon.x).toBeGreaterThan(0.9)
    expect(noon.y).toBeGreaterThan(0.9)
    expect(wakeColor(-0.3, 0).x).toBeLessThan(0.15)
    expect(wakeColor(1, 1).x).toBeLessThan(noon.x)
  })
})

describe('Wake', () => {
  /** The wash segments of a wake laid alone – the first ribbon, from the trailing end back. */
  const washSegments = (wake: Wake, poses: number) =>
    Array.from({ length: poses - 1 }, (_, i) => wake.segmentAt(i))

  it('lays the wash behind a ship going ahead: from her stern, wider and fainter with age', () => {
    const wake = new Wake(host)
    wake.begin(0)
    // North at 5 m/s: her stern is 50 m south of her centre
    wake.add(straightRun(5, 0), hull)
    wake.commit()
    // Twenty poses: a wash of eighteen segments between nineteen of them,
    // the bow wave on both flanks, an arm to either side as long as the wash
    const poses = WAKE_LIFE_S / WAKE_STEP_S - 1
    expect(wake.drawn).toBe(poses - 1 + 4 + 2 * (poses - 1))
    const wash = washSegments(wake, poses)
    const fresh = place(wash[0].from)
    expect(fresh.north).toBeCloseTo(-50, 0)
    expect(Math.abs(fresh.east)).toBeLessThan(0.5)
    expect(fresh.height).toBeCloseTo(SURFACE, 1)
    // Each segment carries on where the last one ended, further astern,
    // its foam made that much earlier (the pattern's phase runs back)
    for (let i = 1; i < wash.length; i++) {
      expect(Cartesian3.distance(wash[i].from, wash[i - 1].to)).toBeLessThan(0.01)
      expect(place(wash[i].to).north).toBeLessThan(place(wash[i].from).north)
      expect(wash[i].phaseFrom).toBeCloseTo(wash[i - 1].phaseTo, 5)
      expect(wash[i].phaseFrom).toBeCloseTo(wash[i - 1].phaseFrom - WAKE_STEP_S * WAKE_STREAK_MPS, 5)
    }
    const oldest = wash[wash.length - 1]
    expect(oldest.halfWidthTo).toBeGreaterThan(wash[0].halfWidthFrom)
    expect(oldest.alphaTo).toBeLessThan(wash[0].alphaFrom)
    expect(oldest.alphaTo).toBeGreaterThan(0)
    // Fresh at the hull the wash is about half a beam wide either side
    expect(wash[0].halfWidthFrom).toBeCloseTo(hull.beamM * 0.45, 5)
  })

  it('puts the bow wave and the Kelvin arms at the end that leads, the arms at their angle', () => {
    const wake = new Wake(host)
    wake.begin(0)
    wake.add(straightRun(5, 0), hull)
    wake.commit()
    const poses = WAKE_LIFE_S / WAKE_STEP_S - 1
    // After the wash: two flanks of two segments each, from the stem back
    const flank = wake.segmentAt(poses - 1)
    expect(place(flank.from).north).toBeCloseTo(50, 0)
    expect(place(flank.to).north).toBeLessThan(50)
    expect(Math.abs(place(flank.to).east)).toBeCloseTo(0.42 * hull.beamM, 0)
    expect(flank.alphaFrom).toBeGreaterThan(flank.alphaTo)
    // Then the arms: from the stem, spreading at tan 19.47° of the distance behind it
    const arm = wake.segmentAt(poses - 1 + 4)
    expect(place(arm.from).north).toBeCloseTo(50, 0)
    expect(Math.abs(place(arm.from).east)).toBeLessThan(0.5)
    const behind = 50 - place(arm.to).north
    expect(Math.abs(place(arm.to).east) / behind).toBeCloseTo(KELVIN_SPREAD, 1)
    expect(arm.alphaFrom).toBeLessThan(wake.segmentAt(0).alphaFrom)
  })

  it('lays it before a ship going astern – her motion against her heading – and the bow wave at her stern', () => {
    const wake = new Wake(host)
    wake.begin(0)
    // Moving south at 2 m/s with the hull pointing north
    wake.add(straightRun(2, 180, 0), hull)
    wake.commit()
    // The trailing end is the bow, 50 m north of her centre
    expect(place(wake.segmentAt(0).from).north).toBeCloseTo(50, 0)
    // …and the bow wave along her stern
    const poses = WAKE_LIFE_S / WAKE_STEP_S - 1
    expect(place(wake.segmentAt(poses - 1).from).north).toBeCloseTo(-50, 0)
  })

  it('leaves nothing for a ship that stands, and only as much wake as she has moved', () => {
    const wake = new Wake(host)
    wake.begin(0)
    wake.add(
      Array.from({ length: 20 }, (_, i) => ({ ageS: i * WAKE_STEP_S, lon: LON, lat: LAT, bearingDeg: 90 })),
      hull,
    )
    wake.commit()
    expect(wake.drawn).toBe(0)
    // Under way for the last eight seconds only: four moving poses – three
    // segments of wash, the bow wave, three of each arm
    const run = straightRun(5, 90)
    const stopped = run.map((s, i) => (i <= 4 ? s : run[4]))
    wake.begin(0)
    wake.add(stopped, hull)
    wake.commit()
    expect(wake.drawn).toBe(3 + 4 + 2 * 3)
    // A single pose says nothing about her way
    wake.begin(0)
    wake.add([run[0]], hull)
    wake.commit()
    expect(wake.drawn).toBe(0)
  })

  it('keeps the foam in the water: the same spot wears the same phase after the ship ran on', () => {
    const wake = new Wake(host)
    wake.begin(10_000, 0)
    wake.add(straightRun(5, 0), hull)
    wake.commit()
    const laid = wake.segmentAt(0)
    // A step later she is 10 m further north: the water her stern was
    // over is now the second pose's, with the phase it had
    wake.begin(10_000 + WAKE_STEP_S * 1000, WAKE_STEP_S * 1000)
    const ahead = straightRun(5, 0).map((s) => ({ ...s, lat: s.lat + (5 * WAKE_STEP_S) / 111_132 }))
    wake.add(ahead, hull)
    wake.commit()
    const later = wake.segmentAt(1)
    expect(Cartesian3.distance(later.from, laid.from)).toBeLessThan(0.01)
    expect(later.phaseFrom).toBeCloseTo(laid.phaseFrom, 4)
    // The fresh foam at her stern is newer by the step
    expect(wake.segmentAt(0).phaseFrom).toBeCloseTo(laid.phaseFrom + WAKE_STEP_S * WAKE_STREAK_MPS, 4)
    // The bow wave's foam streams aft along the flank: the stem is newest
    const poses = WAKE_LIFE_S / WAKE_STEP_S - 1
    const flank = wake.segmentAt(poses - 1)
    expect(flank.phaseFrom).toBeGreaterThan(flank.phaseTo)
  })

  it('churns on the ships’ clock – held by a pause, capped under the time-lapse – and owes a frame once that shows', () => {
    const wake = new Wake(host)
    wake.begin(0, 0)
    wake.markRendered()
    expect(wake.metersSinceRendered).toBe(0)
    // A second of the ships' clock in a second of real time
    wake.begin(1000, 1000)
    expect(wake.state.churnS).toBeCloseTo(1, 6)
    expect(wake.metersSinceRendered).toBeCloseTo(WAKE_CHURN_MPS, 6)
    wake.markRendered()
    expect(wake.metersSinceRendered).toBe(0)
    // The clock stands (a pause): no churn, however long the real time
    wake.begin(1000, 5000)
    expect(wake.state.churnS).toBeCloseTo(1, 6)
    // A minute of the clock in a second of real time: the smoke's cap
    wake.begin(61_000, 6000)
    expect(wake.state.churnS).toBeCloseTo(1 + PLUME_MAX_RATE, 6)
    // A clock set back leaves it standing
    wake.begin(1000, 7000)
    expect(wake.state.churnS).toBeCloseTo(1 + PLUME_MAX_RATE, 6)
  })

  it('starts each tick afresh, and asks for a frame while foam fades unseen', () => {
    const wake = new Wake(host)
    wake.begin(1_000)
    wake.add(straightRun(5, 0), hull)
    wake.commit()
    expect(wake.drawn).toBeGreaterThan(0)
    // Never drawn yet: a frame is owed
    expect(wake.fadeFrameDue).toBe(true)
    wake.markRendered()
    expect(wake.fadeFrameDue).toBe(false)
    wake.begin(1_000 + WAKE_FADE_FRAME_S * 1000)
    wake.commit()
    expect(wake.drawn).toBe(0)
    expect(wake.fadeFrameDue).toBe(true)
  })

  it('draws in the render pass only, and nothing while there is no foam', () => {
    const wake = new Wake(host)
    const frame = (passes: FrameState['passes'], instancedArrays = true): FrameState => ({
      context: { instancedArrays, webgl2: true, createPickId: () => ({ color: {} as never, destroy() {} }) },
      commandList: [],
      passes,
    })
    const empty = frame({ render: true })
    wake.update(empty)
    expect(empty.commandList).toEqual([])
    wake.begin(0)
    wake.add(straightRun(5, 0), hull)
    wake.commit()
    const pick = frame({ render: false, pick: true })
    wake.update(pick)
    expect(pick.commandList).toEqual([])
    const offscreen = frame({ render: true, offscreen: true })
    wake.update(offscreen)
    expect(offscreen.commandList).toEqual([])
    const plain = frame({ render: true }, false)
    wake.update(plain)
    expect(plain.commandList).toEqual([])
    expect(wake.state.supported).toBe(false)
  })
})
