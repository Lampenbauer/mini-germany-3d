import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PHOTO_SETTINGS,
  KNOB_RANGES,
  withTiltShift,
  type PhotoSettings,
} from '@/lib/photo-settings'
import {
  formatCameraHash,
  formatStopHash,
  formatUiStateHash,
  normalizeTimeEntry,
  formatVehicleHash,
  formatVesselHash,
  parseCameraHash,
  parseStopHash,
  parseUiStateHash,
  parseVehicleHash,
  parseVesselHash,
  formatAircraftHash,
  parseAircraftHash,
  type HashUiState,
} from '@/lib/camera-hash'
import { config } from '@/config'

describe('formatCameraHash / parseCameraHash', () => {
  it('formats using the documented scheme', () => {
    const hash = formatCameraHash({
      latitude: 54.084784,
      longitude: 12.131939,
      height: 250.4,
      heading: 0,
      pitch: -35.2,
    })
    expect(hash).toBe('#lat=54.084784&lon=12.131939&height=250&heading=0&pitch=-35')
  })

  it('round trip: format → parse returns the view', () => {
    const view = { latitude: 54.0901, longitude: 12.1405, height: 1234, heading: 187, pitch: -42 }
    const parsed = parseCameraHash(formatCameraHash(view))
    expect(parsed).not.toBeNull()
    expect(parsed!.latitude).toBeCloseTo(view.latitude, 5)
    expect(parsed!.longitude).toBeCloseTo(view.longitude, 5)
    expect(parsed!.height).toBe(1234)
    expect(parsed!.heading).toBe(187)
    expect(parsed!.pitch).toBe(-42)
  })

  it('normalizes heading to 0–360', () => {
    expect(formatCameraHash({ latitude: 54, longitude: 12, height: 100, heading: 359.7, pitch: -30 })).toContain('heading=0')
    const parsed = parseCameraHash('#lat=54&lon=12&height=100&heading=-90&pitch=-30')
    expect(parsed!.heading).toBe(270)
  })

  it('rejects invalid or incomplete hashes', () => {
    expect(parseCameraHash('')).toBeNull()
    expect(parseCameraHash('#foo=bar')).toBeNull()
    expect(parseCameraHash('#lat=54&lon=12')).toBeNull() // height missing
    expect(parseCameraHash('#lat=99&lon=12&height=100')).toBeNull() // lat > 90
    expect(parseCameraHash('#lat=54&lon=181&height=100')).toBeNull()
    expect(parseCameraHash('#lat=54&lon=12&height=-5')).toBeNull()
    expect(parseCameraHash('#lat=abc&lon=12&height=100')).toBeNull()
  })

  it('clamps pitch to [-90, 90]', () => {
    const parsed = parseCameraHash('#lat=54&lon=12&height=100&heading=0&pitch=-135')
    expect(parsed!.pitch).toBe(-90)
  })
})

describe('vehicle selection in the hash', () => {
  const view = { latitude: 54.0901, longitude: 12.1405, height: 800, heading: 61, pitch: -57 }

  it('holds ONLY the trip id and round-trips it', () => {
    const hash = formatVehicleHash('1-0-500-s11071-18627')
    expect(hash).toBe('#vehicle=1-0-500-s11071-18627')
    expect(parseVehicleHash(hash)).toBe('1-0-500-s11071-18627')
    // A vehicle hash carries no camera pose
    expect(parseCameraHash(hash)).toBeNull()
  })

  it('camera hashes carry no vehicle', () => {
    expect(formatCameraHash(view)).not.toContain('vehicle=')
    expect(parseVehicleHash(formatCameraHash(view))).toBeNull()
  })

  it('URL-encodes unusual ids on the way out and decodes on the way in', () => {
    const id = 'FG-0-3&x=1'
    expect(parseVehicleHash(formatVehicleHash(id))).toBe(id)
  })

  it('rejects empty and oversized ids', () => {
    expect(parseVehicleHash('')).toBeNull()
    expect(parseVehicleHash('#vehicle=')).toBeNull()
    expect(parseVehicleHash(`#vehicle=${'x'.repeat(200)}`)).toBeNull()
  })
})

describe('ship selection in the hash', () => {
  const view = { latitude: 54.0901, longitude: 12.1405, height: 800, heading: 61, pitch: -57 }

  it('holds ONLY the MMSI and round-trips it', () => {
    const hash = formatVesselHash(211222290)
    expect(hash).toBe('#vessel=211222290')
    expect(parseVesselHash(hash)).toBe(211222290)
    expect(parseCameraHash(hash)).toBeNull()
    expect(parseVehicleHash(hash)).toBeNull()
  })

  it('camera and vehicle hashes carry no ship', () => {
    expect(formatCameraHash(view)).not.toContain('vessel=')
    expect(parseVesselHash(formatCameraHash(view))).toBeNull()
    expect(parseVesselHash(formatVehicleHash('1-0-500'))).toBeNull()
  })

  it('takes nine digits at most and nothing that is not one', () => {
    expect(parseVesselHash('#vessel=')).toBeNull()
    expect(parseVesselHash('#vessel=0')).toBeNull()
    expect(parseVesselHash('#vessel=1234567890')).toBeNull()
    expect(parseVesselHash('#vessel=21122229a')).toBeNull()
    expect(parseVesselHash('#vessel=-211222290')).toBeNull()
    expect(parseVesselHash('#vessel=999999999')).toBe(999999999)
  })
})

describe('aircraft selection in the hash', () => {
  it('holds ONLY the ICAO address and round-trips it', () => {
    const hash = formatAircraftHash('3c65a2')
    expect(hash).toBe('#aircraft=3c65a2')
    expect(parseAircraftHash(hash)).toBe('3c65a2')
    expect(parseCameraHash(hash)).toBeNull()
    expect(parseVehicleHash(hash)).toBeNull()
    expect(parseVesselHash(hash)).toBeNull()
  })

  it('takes six hex digits, upper case included, with the non-ICAO prefix', () => {
    expect(parseAircraftHash('#aircraft=3C65A2')).toBe('3c65a2')
    expect(parseAircraftHash('#aircraft=~2a1b3c')).toBe('~2a1b3c')
    expect(parseAircraftHash('#aircraft=')).toBeNull()
    expect(parseAircraftHash('#aircraft=3c65a')).toBeNull()
    expect(parseAircraftHash('#aircraft=3c65a2b')).toBeNull()
    expect(parseAircraftHash('#aircraft=DLH3Y')).toBeNull()
    expect(parseAircraftHash(formatVesselHash(211222290))).toBeNull()
  })
})

describe('layer and pause state in the hash', () => {
  const view = { latitude: 54.0901, longitude: 12.1405, height: 800, heading: 61, pitch: -57 }

  const miniatureDefault = config.camera.miniatureDefault
  const cloudsDefault = config.weather.clouds3dDefault
  /** What the hash says when the miniature look deviates from its default. */
  const tiltDeviation = miniatureDefault ? '&tiltshift=0' : '&tiltshift=1'

  it('appends only deviations from the defaults', () => {
    expect(
      formatUiStateHash({
      view: 'surface',
      weather: null,
        routesHidden: false,
        stopsHidden: false,
        labelsHidden: false,
        webcamsHidden: false,
        clouds: cloudsDefault,
        hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
        date: null,
        time: null,
        paused: false,
      }),
    ).toBe('')
    expect(
      formatUiStateHash({
      view: 'surface',
      weather: null,
        routesHidden: true,
        stopsHidden: true,
        labelsHidden: true,
        webcamsHidden: false,
        clouds: cloudsDefault,
        hiddenTraffic: new Set(),
        photo: withTiltShift(DEFAULT_PHOTO_SETTINGS, !miniatureDefault),
        date: null,
        time: null,
        paused: true,
      }),
    ).toBe(`&routes=0&stops=0&labels=0${tiltDeviation}&paused=1`)
  })

  it('carries no city – the path does (lib/site-path.ts)', () => {
    const state: HashUiState = {
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    }
    expect(formatUiStateHash(state)).toBe('')
    expect(formatUiStateHash({ ...state, routesHidden: true })).toBe('&routes=0')
    // A stray city= in a hash is simply not a reading
    expect(parseUiStateHash('#lat=53.55&lon=9.99&height=800&city=kiel&routes=0')).toEqual({
      ...state,
      routesHidden: true,
    })
  })

  it('names the sky, and reads back only a sky it knows', () => {
    const state: HashUiState = {
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    }
    // Live is a pick like any other: written out, not left implied
    expect(formatUiStateHash({ ...state, weather: 'live' })).toBe('&weather=live')
    expect(formatUiStateHash({ ...state, weather: 'rain', paused: true })).toBe(
      '&weather=rain&paused=1',
    )
    expect(parseUiStateHash('#lat=54&lon=12&height=100&weather=cloudy').weather).toBe('cloudy')
    // No sky named, or one this build does not have: the app decides what
    // such a hash opens on (see hashWeatherMode)
    expect(parseUiStateHash('#lat=54&lon=12&height=100').weather).toBeNull()
    expect(parseUiStateHash('#lat=54&lon=12&height=100&weather=snow').weather).toBeNull()
  })

  it('carries whichever reading is on screen, and names the map by omission', () => {
    const state: HashUiState = {
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    }
    expect(formatUiStateHash({ ...state, view: 'linear' })).toBe('&view=linear')
    expect(formatUiStateHash({ ...state, view: 'underground' })).toBe('&view=underground')
    // The surface is the map itself – an absent view= is what says so
    expect(formatUiStateHash({ ...state, view: 'surface' })).toBe('')
    expect(parseUiStateHash('#lat=54&lon=12&height=100&view=linear').view).toBe('linear')
    expect(parseUiStateHash('#lat=54&lon=12&height=100&view=underground').view).toBe('underground')
    expect(parseUiStateHash('#lat=54&lon=12&height=100').view).toBe('surface')
    // A reading this build does not have is the map, not a crash
    expect(parseUiStateHash('#lat=54&lon=12&height=100&view=isometric').view).toBe('surface')
  })

  it('round-trips alongside both hash forms', () => {
    const suffix = formatUiStateHash({
      view: 'surface',
      weather: null,
      routesHidden: true,
      stopsHidden: false,
      labelsHidden: true,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: withTiltShift(DEFAULT_PHOTO_SETTINGS, !miniatureDefault),
      date: null,
      time: null,
      paused: true,
    })
    const withCamera = formatCameraHash(view) + suffix
    const withVehicle = formatVehicleHash('1-0-500') + suffix
    for (const hash of [withCamera, withVehicle]) {
      expect(parseUiStateHash(hash)).toEqual({
      view: 'surface',
      weather: null,
        routesHidden: true,
        stopsHidden: false,
        labelsHidden: true,
        webcamsHidden: false,
        clouds: cloudsDefault,
        hiddenTraffic: new Set(),
        photo: withTiltShift(DEFAULT_PHOTO_SETTINGS, !miniatureDefault),
        date: null,
        time: null,
        paused: true,
      })
    }
    // The extra params disturb neither the camera nor the vehicle parser
    expect(parseCameraHash(withCamera)).not.toBeNull()
    expect(parseVehicleHash(withVehicle)).toBe('1-0-500')
  })

  it('defaults everything when absent', () => {
    expect(parseUiStateHash('#lat=54&lon=12&height=100')).toEqual({
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    })
  })

  it('carries the clouds only when they deviate from the default, from either spelling', () => {
    expect(parseUiStateHash('#lat=54&lon=12&height=100').clouds).toBe(cloudsDefault)
    expect(parseUiStateHash('#lat=54&lon=12&height=100&clouds=1').clouds).toBe(true)
    expect(parseUiStateHash('#lat=54&lon=12&height=100&clouds=0').clouds).toBe(false)
    const flipped: HashUiState = {
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: !cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    }
    expect(formatUiStateHash(flipped)).toBe(cloudsDefault ? '&clouds=0' : '&clouds=1')
    expect(parseUiStateHash(formatUiStateHash(flipped)).clouds).toBe(!cloudsDefault)
  })

  it('reads the miniature look from either spelling, whatever the default', () => {
    expect(parseUiStateHash('#lat=54&lon=12&height=100&tiltshift=1').photo.tiltShift.enabled).toBe(true)
    expect(parseUiStateHash('#lat=54&lon=12&height=100&tiltshift=0').photo.tiltShift.enabled).toBe(false)
  })

  it("names the traffic categories switched off under one key, in the panel's order", () => {
    const state: HashUiState = {
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    }
    expect(formatUiStateHash({ ...state, hiddenTraffic: new Set(['bus']) })).toBe('&hide=bus')
    // Whatever order they were switched off in
    expect(
      formatUiStateHash({ ...state, hiddenTraffic: new Set(['aircraft', 'bus', 'tram', 'ais']) }),
    ).toBe('&hide=tram,bus,ais,aircraft')
    // Before the sky, after the layers – the list of what is off, all together
    expect(
      formatUiStateHash({ ...state, routesHidden: true, hiddenTraffic: new Set(['ais']), weather: 'live' }),
    ).toBe('&routes=0&hide=ais&weather=live')
    expect(parseUiStateHash('#hide=tram,ais').hiddenTraffic).toEqual(new Set(['tram', 'ais']))
    // A category the panel does not know, an empty list: not a category
    expect(parseUiStateHash('#hide=bus,zeppelin,').hiddenTraffic).toEqual(new Set(['bus']))
    expect(parseUiStateHash('#hide=').hiddenTraffic).toEqual(new Set())
    expect(parseUiStateHash('#lat=54&lon=12&height=100').hiddenTraffic).toEqual(new Set())
  })

  it('carries every photo knob off its default under a short key, the value in full', () => {
    const state: HashUiState = {
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    }
    const on = withTiltShift(DEFAULT_PHOTO_SETTINGS, true)
    const shot: PhotoSettings = {
      ...on,
      grid: true,
      fovDeg: 40,
      exposureEv: 0.5,
      whiteBalanceK: 5600,
      contrast: 1.2,
      saturation: 0.8,
      vignette: 0.3,
      tiltShift: {
        ...on.tiltShift,
        maxBlurRadius: 0.034,
        bandHalfHeight: 0.2,
        bandFeather: 0.5,
        focusY: 0.45,
        highlightGain: 4,
        sharpen: 0.6,
      },
    }
    const written = formatUiStateHash({ ...state, photo: shot })
    expect(written).toBe(
      `${miniatureDefault ? '' : '&tiltshift=1'}&grid=1&fov=40&ev=0.5&wb=5600&con=1.2&sat=0.8&vig=0.3` +
        '&blur=0.034&band=0.2&fthr=0.5&foc=0.45&bok=4&shp=0.6',
    )
    // … and back, knob for knob
    expect(parseUiStateHash(`#lat=54&lon=12&height=100${written}`).photo).toEqual(shot)
    // The lens is measured against the look's own: the miniature switch
    // brings the long lens along, so it is no deviation on its own
    expect(formatUiStateHash({ ...state, photo: on })).toBe(miniatureDefault ? '' : '&tiltshift=1')
    expect(parseUiStateHash('#tiltshift=1').photo.fovDeg).toBe(on.fovDeg)
    expect(parseUiStateHash('#tiltshift=1&fov=40').photo.fovDeg).toBe(40)
    // The effect's knobs keep their values across the switch, so they are
    // written with the effect off too
    const off = { ...DEFAULT_PHOTO_SETTINGS, tiltShift: { ...DEFAULT_PHOTO_SETTINGS.tiltShift, sharpen: 0.6 } }
    expect(formatUiStateHash({ ...state, photo: off })).toBe('&shp=0.6')
  })

  it('holds a knob a hash names inside its slider, and reads nothing into one it cannot', () => {
    expect(parseUiStateHash('#con=9').photo.contrast).toBe(KNOB_RANGES.contrast.max)
    expect(parseUiStateHash('#ev=-5').photo.exposureEv).toBe(KNOB_RANGES.exposureEv.min)
    expect(parseUiStateHash('#wb=12000').photo.whiteBalanceK).toBe(KNOB_RANGES.whiteBalanceK.max)
    expect(parseUiStateHash('#fov=10').photo.fovDeg).toBe(KNOB_RANGES.fovDeg.min)
    expect(parseUiStateHash('#bok=0').photo.tiltShift.highlightGain).toBe(KNOB_RANGES.highlightGain.min)
    expect(parseUiStateHash('#con=warm').photo.contrast).toBe(1)
    expect(parseUiStateHash('#con=').photo.contrast).toBe(1)
    expect(parseUiStateHash('#grid=yes').photo.grid).toBe(false)
    // A hash naming no knob is the photo mode the app opens on
    expect(parseUiStateHash('#lat=54&lon=12&height=100').photo).toEqual(DEFAULT_PHOTO_SETTINGS)
  })

  it('carries the clock as it was set – the day picked and the time typed – and only that', () => {
    const state: HashUiState = {
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      hiddenTraffic: new Set(),
      photo: DEFAULT_PHOTO_SETTINGS,
      date: null,
      time: null,
      paused: false,
    }
    // Either half on its own, both together, the pause after them
    expect(formatUiStateHash({ ...state, time: '08:30' })).toBe('&time=08:30')
    expect(formatUiStateHash({ ...state, date: '2026-09-14' })).toBe('&date=2026-09-14')
    expect(formatUiStateHash({ ...state, date: '2026-09-14', time: '08:30', paused: true })).toBe(
      '&date=2026-09-14&time=08:30&paused=1',
    )
    const parsed = parseUiStateHash('#lat=54&lon=12&height=100&date=2026-09-14&time=08:30')
    expect(parsed.date).toBe('2026-09-14')
    expect(parsed.time).toBe('08:30')
    // The real clock is what an absent entry means
    expect(parseUiStateHash('#lat=54&lon=12&height=100')).toMatchObject({ date: null, time: null })
  })

  it('spells a typed time the way the field does, and drops what is no day or no time', () => {
    // A bare hour, a time with seconds: the field's own spelling
    expect(parseUiStateHash('#time=8:30').time).toBe('08:30')
    expect(parseUiStateHash('#time=08:30:00').time).toBe('08:30')
    expect(parseUiStateHash('#time=08:30:15').time).toBe('08:30:15')
    expect(normalizeTimeEntry('7:05')).toBe('07:05')
    expect(normalizeTimeEntry('')).toBeNull()
    // Not a time of day, not a day of any calendar
    expect(parseUiStateHash('#time=25:00').time).toBeNull()
    expect(parseUiStateHash('#time=noon').time).toBeNull()
    expect(parseUiStateHash('#date=2026-02-30').date).toBeNull()
    expect(parseUiStateHash('#date=14.09.2026').date).toBeNull()
    expect(parseUiStateHash('#date=2026-09-14T08:30').date).toBeNull()
  })
})

describe('stop hash', () => {
  it('round-trips a stop id', () => {
    expect(parseStopHash(formatStopHash('osm-241200227'))).toBe('osm-241200227')
  })

  it('encodes ids that need escaping', () => {
    const id = 'weird id/with?chars'
    expect(parseStopHash(formatStopHash(id))).toBe(id)
  })

  it('ignores hashes without a stop and oversized ids', () => {
    expect(parseStopHash('#lat=54&lon=12&height=100')).toBeNull()
    expect(parseStopHash('')).toBeNull()
    expect(parseStopHash(`#stop=${'x'.repeat(200)}`)).toBeNull()
  })
})
