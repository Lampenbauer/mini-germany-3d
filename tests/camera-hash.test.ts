import { describe, expect, it } from 'vitest'
import { formatCameraHash, parseCameraHash } from '@/lib/camera-hash'

describe('formatCameraHash / parseCameraHash', () => {
  it('formatiert im dokumentierten Schema', () => {
    const hash = formatCameraHash({
      latitude: 54.084784,
      longitude: 12.131939,
      height: 250.4,
      heading: 0,
      pitch: -35.2,
    })
    expect(hash).toBe('#lat=54.084784&lon=12.131939&height=250&heading=0&pitch=-35')
  })

  it('Roundtrip: format → parse liefert die Ansicht zurück', () => {
    const view = { latitude: 54.0901, longitude: 12.1405, height: 1234, heading: 187, pitch: -42 }
    const parsed = parseCameraHash(formatCameraHash(view))
    expect(parsed).not.toBeNull()
    expect(parsed!.latitude).toBeCloseTo(view.latitude, 5)
    expect(parsed!.longitude).toBeCloseTo(view.longitude, 5)
    expect(parsed!.height).toBe(1234)
    expect(parsed!.heading).toBe(187)
    expect(parsed!.pitch).toBe(-42)
  })

  it('normalisiert Heading auf 0–360', () => {
    expect(formatCameraHash({ latitude: 54, longitude: 12, height: 100, heading: 359.7, pitch: -30 })).toContain('heading=0')
    const parsed = parseCameraHash('#lat=54&lon=12&height=100&heading=-90&pitch=-30')
    expect(parsed!.heading).toBe(270)
  })

  it('lehnt ungültige oder unvollständige Hashes ab', () => {
    expect(parseCameraHash('')).toBeNull()
    expect(parseCameraHash('#foo=bar')).toBeNull()
    expect(parseCameraHash('#lat=54&lon=12')).toBeNull() // height fehlt
    expect(parseCameraHash('#lat=99&lon=12&height=100')).toBeNull() // lat > 90
    expect(parseCameraHash('#lat=54&lon=181&height=100')).toBeNull()
    expect(parseCameraHash('#lat=54&lon=12&height=-5')).toBeNull()
    expect(parseCameraHash('#lat=abc&lon=12&height=100')).toBeNull()
  })

  it('begrenzt Pitch auf [-90, 90]', () => {
    const parsed = parseCameraHash('#lat=54&lon=12&height=100&heading=0&pitch=-135')
    expect(parsed!.pitch).toBe(-90)
  })
})
