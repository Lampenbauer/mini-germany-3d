import { describe, expect, it } from 'vitest'
import {
  formatCameraHash,
  formatStopHash,
  formatUiStateHash,
  formatVehicleHash,
  formatVesselHash,
  parseCameraHash,
  parseStopHash,
  parseUiStateHash,
  parseVehicleHash,
  parseVesselHash,
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

describe('layer and pause state in the hash', () => {
  const view = { latitude: 54.0901, longitude: 12.1405, height: 800, heading: 61, pitch: -57 }

  const miniatureDefault = config.camera.miniatureDefault
  const cloudsDefault = config.weather.clouds3dDefault
  /** What the hash says when the miniature look deviates from its default. */
  const tiltDeviation = miniatureDefault ? '&tiltshift=0' : '&tiltshift=1'

  it('appends only deviations from the defaults', () => {
    expect(
      formatUiStateHash({
        city: null,
      view: 'surface',
      weather: null,
        routesHidden: false,
        stopsHidden: false,
        labelsHidden: false,
        webcamsHidden: false,
        clouds: cloudsDefault,
        tiltShift: miniatureDefault,
        paused: false,
      }),
    ).toBe('')
    expect(
      formatUiStateHash({
        city: null,
      view: 'surface',
      weather: null,
        routesHidden: true,
        stopsHidden: true,
        labelsHidden: true,
        webcamsHidden: false,
        clouds: cloudsDefault,
        tiltShift: !miniatureDefault,
        paused: true,
      }),
    ).toBe(`&routes=0&stops=0&labels=0${tiltDeviation}&paused=1`)
  })

  it('names the city first, whichever city it is', () => {
    const state: HashUiState = {
      city: null,
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      tiltShift: miniatureDefault,
      paused: false,
    }
    expect(formatUiStateHash(state)).toBe('')
    expect(formatUiStateHash({ ...state, city: 'kiel', routesHidden: true })).toBe(
      '&city=kiel&routes=0',
    )
    // The default city is written out too – the app hands it in like any
    // other, so a link always says which city it is of
    expect(formatUiStateHash({ ...state, city: 'rostock' })).toBe('&city=rostock')
    expect(parseUiStateHash('#lat=53.55&lon=9.99&height=800&city=kiel').city).toBe('kiel')
    expect(parseUiStateHash('#lat=53.55&lon=9.99&height=800').city).toBeNull()
  })

  it('names the sky, and reads back only a sky it knows', () => {
    const state: HashUiState = {
      city: null,
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      tiltShift: miniatureDefault,
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
      city: null,
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      tiltShift: miniatureDefault,
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
      city: null,
      view: 'surface',
      weather: null,
      routesHidden: true,
      stopsHidden: false,
      labelsHidden: true,
      webcamsHidden: false,
      clouds: cloudsDefault,
      tiltShift: !miniatureDefault,
      paused: true,
    })
    const withCamera = formatCameraHash(view) + suffix
    const withVehicle = formatVehicleHash('1-0-500') + suffix
    for (const hash of [withCamera, withVehicle]) {
      expect(parseUiStateHash(hash)).toEqual({
        city: null,
      view: 'surface',
      weather: null,
        routesHidden: true,
        stopsHidden: false,
        labelsHidden: true,
        webcamsHidden: false,
        clouds: cloudsDefault,
        tiltShift: !miniatureDefault,
        paused: true,
      })
    }
    // The extra params disturb neither the camera nor the vehicle parser
    expect(parseCameraHash(withCamera)).not.toBeNull()
    expect(parseVehicleHash(withVehicle)).toBe('1-0-500')
  })

  it('defaults everything when absent', () => {
    expect(parseUiStateHash('#lat=54&lon=12&height=100')).toEqual({
      city: null,
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: cloudsDefault,
      tiltShift: miniatureDefault,
      paused: false,
    })
  })

  it('carries the clouds only when they deviate from the default, from either spelling', () => {
    expect(parseUiStateHash('#lat=54&lon=12&height=100').clouds).toBe(cloudsDefault)
    expect(parseUiStateHash('#lat=54&lon=12&height=100&clouds=1').clouds).toBe(true)
    expect(parseUiStateHash('#lat=54&lon=12&height=100&clouds=0').clouds).toBe(false)
    const flipped: HashUiState = {
      city: null,
      view: 'surface',
      weather: null,
      routesHidden: false,
      stopsHidden: false,
      labelsHidden: false,
      webcamsHidden: false,
      clouds: !cloudsDefault,
      tiltShift: miniatureDefault,
      paused: false,
    }
    expect(formatUiStateHash(flipped)).toBe(cloudsDefault ? '&clouds=0' : '&clouds=1')
    expect(parseUiStateHash(formatUiStateHash(flipped)).clouds).toBe(!cloudsDefault)
  })

  it('reads the miniature look from either spelling, whatever the default', () => {
    expect(parseUiStateHash('#lat=54&lon=12&height=100&tiltshift=1').tiltShift).toBe(true)
    expect(parseUiStateHash('#lat=54&lon=12&height=100&tiltshift=0').tiltShift).toBe(false)
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
