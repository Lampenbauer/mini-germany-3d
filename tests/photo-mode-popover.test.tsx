import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhotoModePopover } from '@/components/PhotoModePopover'
import { config } from '@/config'
import { setLanguage } from '@/lib/i18n'
import { DEFAULT_PHOTO_SETTINGS, withTiltShift, type PhotoSettings } from '@/lib/photo-settings'

/**
 * The photo button in the camera block: the camera the city is shot with.
 * The state lives in the app – the popover reports a whole settings
 * object per turn of a knob and shows whatever it is handed.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

function photo(settings: PhotoSettings = DEFAULT_PHOTO_SETTINGS) {
  const onChange = vi.fn()
  render(<PhotoModePopover settings={settings} onChange={onChange} />)
  return { onChange }
}

/** Opens the popover the way a viewer does – nothing inside exists before. */
function open(name = 'Photo mode') {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** A keyboard step on a knob – the one way to turn a Radix slider in jsdom. */
function step(name: string, key: 'ArrowRight' | 'ArrowLeft') {
  const thumb = screen.getByRole('slider', { name })
  thumb.focus()
  fireEvent.keyDown(thumb, { key })
}

const CAMERA_KNOBS = ['Focal length', 'Exposure', 'White balance', 'Contrast', 'Saturation', 'Vignette']
const MINIATURE_KNOBS = ['Blur', 'Sharp band', 'Feather', 'Focus line', 'Bokeh', 'Sharpening']

describe('the photo mode popover', () => {
  it('keeps its knobs behind the button until it is opened', () => {
    photo()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    open()
    expect(screen.getAllByRole('slider').length).toBeGreaterThan(0)
  })

  it('offers the camera and picture knobs and the miniature switch', () => {
    photo()
    open()
    for (const name of CAMERA_KNOBS) {
      expect(screen.getByRole('slider', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('switch', { name: 'Show the miniature effect' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    // The effect's own knobs are not there while it is off
    for (const name of MINIATURE_KNOBS) {
      expect(screen.queryByRole('slider', { name })).not.toBeInTheDocument()
    }
  })

  it('shows the miniature knobs while the effect is on', () => {
    photo(withTiltShift(DEFAULT_PHOTO_SETTINGS, true))
    open()
    expect(screen.getByRole('switch', { name: 'Show the miniature effect' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    for (const name of MINIATURE_KNOBS) {
      expect(screen.getByRole('slider', { name })).toBeInTheDocument()
    }
  })

  it('reads the lens as a focal length', () => {
    photo({ ...DEFAULT_PHOTO_SETTINGS, fovDeg: 60 })
    open()
    expect(screen.getByText('31 mm · 60°')).toBeInTheDocument()
  })

  it('reports a turned knob as a whole settings object', () => {
    const { onChange } = photo()
    open()
    step('Exposure', 'ArrowRight')
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_PHOTO_SETTINGS, exposureEv: 0.1 })
    // Still showing what it was given – the state lives in the app
    expect(screen.getByText('0.0 EV')).toBeInTheDocument()
  })

  it('turns the focal length knob towards the longer lens on the right', () => {
    // The slider runs in degrees but reads in millimetres, and a
    // photographer expects "more" on the right to be more lens
    const { onChange } = photo({ ...DEFAULT_PHOTO_SETTINGS, fovDeg: 40 })
    open()
    step('Focal length', 'ArrowRight')
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_PHOTO_SETTINGS, fovDeg: 39 })
  })

  it('turns a miniature knob inside the effect settings', () => {
    const on = withTiltShift(DEFAULT_PHOTO_SETTINGS, true)
    const { onChange } = photo(on)
    open()
    step('Sharpening', 'ArrowRight')
    expect(onChange).toHaveBeenCalledWith({
      ...on,
      tiltShift: { ...on.tiltShift, sharpen: 0.4 },
    })
  })

  it('switches the miniature effect on with the lens it is shot through', () => {
    const { onChange } = photo()
    open()
    fireEvent.click(screen.getByRole('switch', { name: 'Show the miniature effect' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as PhotoSettings
    expect(next.tiltShift.enabled).toBe(true)
    expect(next.fovDeg).toBe(config.camera.fovDeg)
  })

  it('puts every knob back with the reset button, which rests while nothing is adjusted', () => {
    const { onChange } = photo()
    open()
    const reset = screen.getByRole('button', { name: 'Reset to defaults' })
    expect(reset).toBeDisabled()
    cleanup()

    const adjusted = photo({ ...DEFAULT_PHOTO_SETTINGS, whiteBalanceK: 8000, vignette: 0.3 })
    open()
    const resetAdjusted = screen.getByRole('button', { name: 'Reset to defaults' })
    expect(resetAdjusted).toBeEnabled()
    fireEvent.click(resetAdjusted)
    expect(adjusted.onChange).toHaveBeenCalledWith(DEFAULT_PHOTO_SETTINGS)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('lights the button up while any knob stands off its default', () => {
    photo()
    expect(screen.getByRole('button', { name: 'Photo mode' })).not.toHaveClass('bg-primary/90')
    cleanup()
    photo({ ...DEFAULT_PHOTO_SETTINGS, contrast: 1.1 })
    expect(screen.getByRole('button', { name: 'Photo mode' })).toHaveClass('bg-primary/90')
    cleanup()
    // The miniature effect alone is an adjustment too – as its button was
    photo(withTiltShift(DEFAULT_PHOTO_SETTINGS, true))
    expect(screen.getByRole('button', { name: 'Photo mode' })).toHaveClass('bg-primary/90')
  })

  it('translates into German', () => {
    setLanguage('de')
    photo(withTiltShift(DEFAULT_PHOTO_SETTINGS, true))
    open('Fotomodus')
    for (const name of ['Brennweite', 'Belichtung', 'Weißabgleich', 'Unschärfe', 'Schärfeband']) {
      expect(screen.getByRole('slider', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('switch', { name: 'Miniatureffekt anzeigen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Auf Standardwerte zurücksetzen' })).toBeInTheDocument()
  })
})
