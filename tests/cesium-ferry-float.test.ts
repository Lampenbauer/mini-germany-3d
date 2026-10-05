import { Cartesian3, Cartographic, Entity, Intersect, PrimitiveCollection, type Primitive, type Viewer } from 'cesium'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '@/config'
import type { VehicleSnapshot } from '@/engine/simulation'
import { VehicleLayer } from '@/map/VehicleLayer'
import { WAKE_LIFE_S, WAKE_STEP_S, Wake } from '@/map/Wake'

/**
 * The scheduled ferries float on the tiles' own water: clamped like the
 * AIS fleet, rationed per tick, on the route profile's level until a
 * pick answers, and with their own hull, badge and route kept off the
 * pick.
 */

let clockMs = 0

beforeEach(() => {
  clockMs = 50_000
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const OFFSET = 36.5

function snapshot(id: string, mode: 'ferry' | 'tram', lon = 12.1): VehicleSnapshot {
  return {
    id,
    lineId: mode === 'ferry' ? 'FG' : '1',
    lineName: mode === 'ferry' ? 'FG' : 'Linie 1',
    color: '#e2001a',
    mode,
    vehicle: config.vehicles[mode],
    direction: 0,
    distance: 0,
    lon,
    lat: 54.0,
    bearing: 0,
    status: 'moving',
    nhn: 0,
    inTunnel: false,
    gradient: 0,
    nextStopName: 'Beta',
    destination: 'Beta',
    origin: 'Alpha',
    delaySeconds: 0,
    realtime: false,
  }
}

function harness(
  surface: (lon: number, lat: number) => number | undefined,
  effects?: {
    wake: Wake
    /** Where the timetable had a vehicle some seconds ago (Simulation.positionAt). */
    positionAt: (id: string, secondsAgo: number) => { lon: number; lat: number; bearing: number; status: 'dwell' | 'moving' } | null
  },
  /** 0 = day … 1 = full night, as the map reports it – the ferries' lights follow it. */
  night = 0,
) {
  const viewer = {
    scene: {
      primitives: {
        add: (primitive: Primitive) => primitive,
        remove: () => true,
      },
    },
    entities: {
      add: (options: Entity.ConstructorOptions) => new Entity(options),
      remove: () => true,
      suspendEvents: vi.fn(),
      resumeEvents: vi.fn(),
    },
    camera: {
      // Ahead of the ferry (she heads north) and high up – from where her
      // screened lights show both sidelights and the masthead light
      positionWC: Cartesian3.fromDegrees(12.1, 54.004, 1500),
      directionWC: new Cartesian3(0, 0, -1),
      upWC: new Cartesian3(0, 1, 0),
      frustum: {
        computeCullingVolume: () => ({ computeVisibility: () => Intersect.INSIDE }),
      },
    },
  } as unknown as Viewer
  let generation = 0
  const clamp = vi.fn(surface)
  const layer = new VehicleLayer(viewer, {
    requestRender: () => {},
    sampleGroundHeight: () => undefined,
    defaultGroundHeight: 30,
    routeHeightOffset: OFFSET,
    clampToSurface: (lon: number, lat: number) => clamp(lon, lat),
    surfaceGeneration: () => generation,
    nightFactor: night,
    pixelRatio: 1,
    flatGround: false,
    fixedGroundHeight: undefined,
    noteCameraFlight: () => {},
    ...(effects ? { wake: effects.wake, vehiclePositionAt: effects.positionAt } : {}),
  })
  const visible = new Set(['FG', '1'])
  const groundOf = (id: string) =>
    (layer as unknown as { vehicles: Map<string, { groundHeight: number; group: PrimitiveCollection }> })
      .vehicles.get(id)!.groundHeight
  return { layer, clamp, visible, groundOf, bumpGeneration: () => generation++ }
}

describe('ferries float on the tiles', () => {
  it('take the clamped water height, the tram its profile', () => {
    const h = harness(() => 37.9)
    h.layer.sync([snapshot('f', 'ferry'), snapshot('t', 'tram')], h.visible)
    expect(h.groundOf('f')).toBe(37.9)
    expect(h.groundOf('t')).toBe(OFFSET)
    expect(h.clamp).toHaveBeenCalledTimes(1)
  })

  it('ride the profile until a pick answers, and pick again only when moved or the tiles changed', () => {
    let answer: number | undefined = undefined
    const h = harness(() => answer)
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.groundOf('f')).toBe(OFFSET)
    // No tile under her yet: not asked again until the tiles change
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(1)
    answer = 38.2
    h.bumpGeneration()
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.groundOf('f')).toBe(38.2)
    // At rest on the same tiles: no further pick
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(2)
    // 30 m on: a pick; a load cycle: a pick
    h.layer.sync([snapshot('f', 'ferry', 12.1 + 30 / (111_320 * Math.cos(54 * (Math.PI / 180))))], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(3)
    h.bumpGeneration()
    h.layer.sync([snapshot('f', 'ferry', 12.1 + 30 / (111_320 * Math.cos(54 * (Math.PI / 180))))], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(4)
  })

  it('keep the profile where the pick stands on a twin at the pier or a bridge deck, and take the water', () => {
    // The photographed ferry at her pier: 23 m over the profile's water
    let answer = 60
    const h = harness(() => answer)
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.groundOf('f')).toBe(OFFSET)
    expect(h.layer.ferryClampReport).toEqual({
      counts: { accepted: 0, confirmed: 0, held: 1 },
      ferries: [{ id: 'f', pickedM: 60, acceptedM: null, heldM: null, heldPicks: 0, profileM: OFFSET }],
    })
    // Held like answered: not asked again until the tiles change
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(1)
    answer = 38.2
    h.bumpGeneration()
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.groundOf('f')).toBe(38.2)
  })

  it('pick at most three ferries a tick, the rest follow next tick', () => {
    const h = harness(() => 37.9)
    const fleet = ['a', 'b', 'c', 'd'].map((id) => snapshot(id, 'ferry'))
    h.layer.sync(fleet, h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(3)
    expect(h.groundOf('d')).toBe(OFFSET)
    h.layer.sync(fleet, h.visible)
    expect(h.clamp).toHaveBeenCalledTimes(4)
    expect(h.groundOf('d')).toBe(37.9)
  })
})

describe('the ferries’ wake', () => {
  const wakeHost = { sunDirection: null, overcast: 0 }
  /** Northbound at 4 m/s: where she was `secondsAgo` seconds before now. */
  const northbound = (id: string, secondsAgo: number) =>
    id === 'f'
      ? { lon: 12.1, lat: 54.0 - (4 * secondsAgo) / 111_132, bearing: 0, status: 'moving' as const }
      : null

  it('is laid from where the timetable had her, behind her stern, on her water', () => {
    const wake = new Wake(wakeHost)
    const h = harness(() => 37.9, { wake, positionAt: northbound })
    h.layer.sync([snapshot('f', 'ferry'), snapshot('t', 'tram')], h.visible)
    // The wash, the bow wave and the arms – for the ferry alone, a tram leaves none
    expect(wake.drawn).toBeGreaterThan(20)
    const fresh = Cartographic.fromCartesian(wake.segmentAt(0).from)
    // Her stern, half her length south of her centre, on the clamped water
    const southM = ((54.0 * Math.PI) / 180 - fresh.latitude) * 111_132 / (Math.PI / 180)
    expect(southM).toBeCloseTo(config.vehicles.ferry.length / 2, 0)
    expect(fresh.height).toBeCloseTo(37.9, 0)
  })

  it('needs the timetable to read her past, and is left while she dwells with none behind her', () => {
    const wake = new Wake(wakeHost)
    const noPast = harness(() => 37.9, { wake, positionAt: () => null })
    noPast.layer.sync([snapshot('f', 'ferry')], noPast.visible)
    expect(wake.drawn).toBe(0)
    // Dwelling now and a wake's length ago: nothing to lay
    const dwelling = harness(() => 37.9, {
      wake,
      positionAt: () => ({ lon: 12.1, lat: 54.0, bearing: 0, status: 'dwell' as const }),
    })
    dwelling.layer.sync([{ ...snapshot('f', 'ferry'), status: 'dwell' }], dwelling.visible)
    expect(wake.drawn).toBe(0)
  })

  it('fades at the pier she reached: still laid while the timetable had her moving a wake ago', () => {
    const wake = new Wake(wakeHost)
    // Moored now, under way until ten seconds ago
    const arrived = (id: string, secondsAgo: number) =>
      id === 'f' && secondsAgo > 10
        ? { lon: 12.1, lat: 54.0 - (4 * (secondsAgo - 10)) / 111_132, bearing: 0, status: 'moving' as const }
        : { lon: 12.1, lat: 54.0, bearing: 0, status: 'dwell' as const }
    const h = harness(() => 37.9, { wake, positionAt: arrived })
    h.layer.sync([{ ...snapshot('f', 'ferry'), status: 'dwell' }], h.visible)
    // She stands now: no bow wave, no arms – only the wash she left, and
    // only from the steps she was still under way
    expect(wake.drawn).toBeGreaterThan(0)
    expect(wake.drawn).toBeLessThan(WAKE_LIFE_S / WAKE_STEP_S - 2)
  })
})

describe('ferries show their navigation lights at night', () => {
  // The camera of the harness stands ahead of the ferry and high up, so it
  // sees both sidelights and the masthead light, three points – and none
  // by day
  it('three of them from overhead at night, none by day – and the tram beside her its two headlights', () => {
    const night = harness(() => 37.9, undefined, 1)
    night.layer.sync([snapshot('f', 'ferry'), snapshot('t', 'tram')], night.visible)
    expect(night.layer.lightCount).toBe(5)
    const day = harness(() => 37.9, undefined, 0)
    day.layer.sync([snapshot('f', 'ferry')], day.visible)
    expect(day.layer.lightCount).toBe(0)
  })

  it('keeps them on at the pier – a ferry in service is under way between crossings', () => {
    const h = harness(() => 37.9, undefined, 1)
    h.layer.sync([{ ...snapshot('f', 'ferry'), status: 'dwell' }], h.visible)
    expect(h.layer.lightCount).toBe(3)
  })

  it('takes them down with the ferry, and with her line', () => {
    const h = harness(() => 37.9, undefined, 1)
    h.layer.sync([snapshot('f', 'ferry')], h.visible)
    expect(h.layer.lightCount).toBe(3)
    h.layer.sync([snapshot('f', 'ferry')], new Set())
    expect(h.layer.lightCount).toBe(0)
    h.layer.sync([], h.visible)
    expect(h.layer.lightCount).toBe(0)
  })
})

describe('the road and rail vehicles show headlights and tail lights at night', () => {
  // The harness camera stands north of the vehicle: ahead of one heading
  // north, behind one heading south
  it('two white from ahead, two red from behind, none by day or ghosted in a tunnel', () => {
    const ahead = harness(() => 37.9, undefined, 1)
    ahead.layer.sync([snapshot('t', 'tram')], ahead.visible)
    expect(ahead.layer.lightCount).toBe(2)
    const behind = harness(() => 37.9, undefined, 1)
    behind.layer.sync([{ ...snapshot('b', 'tram'), bearing: 180 }], behind.visible)
    expect(behind.layer.lightCount).toBe(2)
    const day = harness(() => 37.9, undefined, 0)
    day.layer.sync([snapshot('t', 'tram')], day.visible)
    expect(day.layer.lightCount).toBe(0)
    const tunnel = harness(() => 37.9, undefined, 1)
    tunnel.layer.sync([{ ...snapshot('t', 'tram'), inTunnel: true }], tunnel.visible)
    expect(tunnel.layer.lightCount).toBe(0)
  })

  it('goes with the body: none for a vehicle its line has switched off', () => {
    const h = harness(() => 37.9, undefined, 1)
    h.layer.sync([snapshot('t', 'tram')], new Set())
    expect(h.layer.lightCount).toBe(0)
  })
})
