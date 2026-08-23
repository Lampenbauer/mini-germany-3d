import { describe, expect, it } from 'vitest'
import {
  formatCameraHash,
  formatUiStateHash,
  formatVehicleHash,
  parseCameraHash,
  parseUiStateHash,
  parseVehicleHash,
} from '@/lib/camera-hash'

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

describe('layer and pause state in the hash', () => {
  const view = { latitude: 54.0901, longitude: 12.1405, height: 800, heading: 61, pitch: -57 }

  it('appends only deviations from the defaults', () => {
    expect(
      formatUiStateHash({ routesHidden: false, stopsHidden: false, paused: false }),
    ).toBe('')
    expect(formatUiStateHash({ routesHidden: true, stopsHidden: true, paused: true })).toBe(
      '&routes=0&stops=0&paused=1',
    )
  })

  it('round-trips alongside both hash forms', () => {
    const suffix = formatUiStateHash({ routesHidden: true, stopsHidden: false, paused: true })
    const withCamera = formatCameraHash(view) + suffix
    const withVehicle = formatVehicleHash('1-0-500') + suffix
    for (const hash of [withCamera, withVehicle]) {
      expect(parseUiStateHash(hash)).toEqual({
        routesHidden: true,
        stopsHidden: false,
        paused: true,
      })
    }
    // The extra params disturb neither the camera nor the vehicle parser
    expect(parseCameraHash(withCamera)).not.toBeNull()
    expect(parseVehicleHash(withVehicle)).toBe('1-0-500')
  })

  it('defaults everything when absent', () => {
    expect(parseUiStateHash('#lat=54&lon=12&height=100')).toEqual({
      routesHidden: false,
      stopsHidden: false,
      paused: false,
    })
  })
})
