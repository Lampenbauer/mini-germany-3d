// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhotoModePopover } from '@/components/PhotoModePopover'
import { CameraPathBar, type CameraPathControls } from '@/components/CameraPathBar'
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

function photo(settings: PhotoSettings = DEFAULT_PHOTO_SETTINGS, cameraPathOpen = false) {
  const onChange = vi.fn()
  const onToggleCameraPath = vi.fn()
  render(
    <PhotoModePopover
      interfaceHidden={false}
      settings={settings}
      onChange={onChange}
      cameraPathOpen={cameraPathOpen}
      onToggleCameraPath={onToggleCameraPath}
    />,
  )
  return { onChange, onToggleCameraPath }
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
  it('keeps its knobs behind the button until it is opened, and folds them away on a click beside it', async () => {
    photo()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    open()
    expect(screen.getAllByRole('slider').length).toBeGreaterThan(0)
    // Radix arms its outside listener a tick after opening, and acts on
    // the click that follows the pointer going down outside
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.pointerDown(document.body, { button: 0 })
    fireEvent.click(document.body)
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeInTheDocument())
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

  it('puts one knob back on a double click on its caption', () => {
    const { onChange } = photo({ ...DEFAULT_PHOTO_SETTINGS, whiteBalanceK: 8000, vignette: 0.3 })
    open()
    fireEvent.doubleClick(screen.getByText('White balance'))
    // Only that one: the vignette beside it keeps the value it was given
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_PHOTO_SETTINGS,
      whiteBalanceK: DEFAULT_PHOTO_SETTINGS.whiteBalanceK,
      vignette: 0.3,
    })
    // The reading beside the name is part of the caption too, and a knob
    // already home reports nothing at all
    onChange.mockClear()
    fireEvent.doubleClick(screen.getByText('0.0 EV'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('puts a miniature knob back inside the effect settings', () => {
    const on = withTiltShift(DEFAULT_PHOTO_SETTINGS, true)
    const { onChange } = photo({ ...on, tiltShift: { ...on.tiltShift, sharpen: 1 } })
    open()
    fireEvent.doubleClick(screen.getByText('Sharpening'))
    expect(onChange).toHaveBeenCalledWith(on)
  })

  it('puts the focal length back to the lens of the look on screen', () => {
    // The miniature effect is shot on the long lens, so with the effect
    // on that lens is what the knob goes home to – not the wide one the
    // app opens with (see withTiltShift)
    const on = withTiltShift(DEFAULT_PHOTO_SETTINGS, true)
    const { onChange } = photo({ ...on, fovDeg: 55 })
    open()
    fireEvent.doubleClick(screen.getByText('Focal length'))
    expect(onChange).toHaveBeenCalledWith(on)
    expect((onChange.mock.calls[0][0] as PhotoSettings).fovDeg).toBe(config.camera.fovDeg)
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

  it('ends with the button that opens the camera path bar, pressed while the bar is up', () => {
    const { onToggleCameraPath } = photo()
    open()
    // The last control in the popover, after the miniature switch
    const button = screen.getByRole('button', { name: 'Camera path', pressed: false })
    const controls = screen.getAllByRole('button').concat(screen.getAllByRole('switch'))
    const after = controls.filter(
      (el) => el !== button && button.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(after).toHaveLength(0)
    fireEvent.click(button)
    expect(onToggleCameraPath).toHaveBeenCalledTimes(1)
    // The bar itself is not in here – it stands over the map
    expect(screen.queryByTestId('camera-path-bar')).not.toBeInTheDocument()
    cleanup()
    photo(DEFAULT_PHOTO_SETTINGS, true)
    open()
    expect(screen.getByRole('button', { name: 'Camera path', pressed: true })).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Kamerafahrt' })).toBeInTheDocument()
  })
})

/**
 * The camera path bar: the dolly's controls as a strip over the foot of
 * the map (see camera-path.test.ts for the path itself). In this file
 * rather than one of its own because the two are one feature – the bar
 * opens from the popover – and a jsdom file is dear on the runner.
 */
const START = { longitude: 12.1, latitude: 54.06, height: 3000, heading: 350, pitch: -40 }
const END = { longitude: 12.14, latitude: 54.1, height: 1500, heading: 20, pitch: -30 }

function bar(overrides: Partial<CameraPathControls> = {}) {
  const handlers = {
    onSetKeyframe: vi.fn(),
    onGoTo: vi.fn(),
    onDurationChange: vi.fn(),
    onEaseChange: vi.fn(),
    onPlay: vi.fn(),
    onStop: vi.fn(),
    onScrub: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
  }
  render(
    <CameraPathBar
      start={null}
      end={null}
      durationS={20}
      ease="smooth"
      playing={false}
      progress={0}
      {...handlers}
      {...overrides}
    />,
  )
  return handlers
}

describe('the camera path bar', () => {
  it('lists both keyframes, unset until taken, and reports the buttons', () => {
    const h = bar()
    expect(screen.getAllByText('Not saved')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('save the start')
    // Preview stays discoverable, but needs a saved view.
    expect(screen.getByRole('button', { name: 'Play the camera path' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'View start' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Clear saved positions' })).toBeDisabled()
    // Faded while the pointer is elsewhere, back under it or with the focus inside
    expect(screen.getByTestId('camera-path-bar')).toHaveClass(
      'opacity-50',
      'hover:opacity-100',
      'focus-within:opacity-100',
    )
    // Radix marks a disabled thumb with data-disabled rather than aria-disabled
    expect(screen.getByRole('slider', { name: 'Position on the path' })).toHaveAttribute('data-disabled')
    fireEvent.click(screen.getByRole('button', { name: 'Save view as start' }))
    expect(h.onSetKeyframe).toHaveBeenCalledWith('start')
    fireEvent.click(screen.getByRole('button', { name: 'Save view as end' }))
    expect(h.onSetKeyframe).toHaveBeenCalledWith('end')
    fireEvent.click(screen.getByRole('button', { name: 'Close the camera path' }))
    expect(h.onClose).toHaveBeenCalledTimes(1)
    // The hint is the info mark's hidden text – not a line of its own, and
    // not a button: the mark only has to take focus for the tooltip
    const hint = screen.getByText(/Runs on the wall clock/)
    expect(hint).toHaveClass('sr-only')
    expect(hint.parentElement).toHaveAttribute('tabindex', '0')
    expect(screen.queryByRole('button', { name: /Runs on the wall clock/ })).not.toBeInTheDocument()
  })

  it('shows where the keyframes stand and flies, stops and clears between them', () => {
    const h = bar({ start: START, end: END })
    expect(screen.getByTestId('path-start')).toHaveTextContent('54.0600° N 12.1000° E 3.0 km · 350° · −40°')
    expect(screen.getByTestId('path-end')).toHaveTextContent('54.1000° N 12.1400° E 1.5 km · 20° · −30°')
    // A labelled preview puts the camera on the saved view.
    const goToEnd = screen.getByRole('button', { name: 'View end' })
    expect(goToEnd).toHaveTextContent('View')
    fireEvent.click(goToEnd)
    expect(h.onGoTo).toHaveBeenCalledWith('end')
    fireEvent.click(screen.getByRole('button', { name: 'Play the camera path' }))
    expect(h.onPlay).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Clear saved positions' }))
    expect(h.onClear).toHaveBeenCalledTimes(1)
    // Elapsed time and duration stay together beside the timeline.
    expect(screen.getByTestId('path-times')).toHaveTextContent('0:00/0:20')
    cleanup()
    const flying = bar({ start: START, end: END, playing: true, progress: 0.5, durationS: 90 })
    expect(screen.getByTestId('path-times')).toHaveTextContent('0:45/1:30')
    fireEvent.click(screen.getByRole('button', { name: 'Stop the camera path' }))
    expect(flying.onStop).toHaveBeenCalledTimes(1)
  })

  it('guides the next capture without requiring the end to be saved second', () => {
    bar({ start: START })
    expect(screen.getByRole('status')).toHaveTextContent('save the end')
    expect(screen.getByRole('button', { name: 'View start' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'View end' })).toBeDisabled()
    cleanup()
    bar({ end: END })
    expect(screen.getByRole('status')).toHaveTextContent('save the start')
    expect(screen.getByRole('button', { name: 'View end' })).toBeEnabled()
  })

  it('commits a duration on Enter, clamps its range and restores empty or cancelled edits', () => {
    const h = bar()
    const input = screen.getByRole('spinbutton', { name: 'Duration in seconds' })
    input.focus()
    fireEvent.change(input, { target: { value: '450.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.onDurationChange).toHaveBeenLastCalledWith(450.5)
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.blur(input)
    expect(h.onDurationChange).toHaveBeenLastCalledWith(600)
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(h.onDurationChange).toHaveBeenLastCalledWith(1)
    h.onDurationChange.mockClear()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(input).toHaveValue(20)
    input.focus()
    fireEvent.change(input, { target: { value: '72' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue(20)
    expect(h.onDurationChange).not.toHaveBeenCalled()
  })

  it('locks flight editing during playback but allows preview, scrubbing, stop and clear', () => {
    const h = bar({ start: START, end: END, playing: true, progress: 0.5, durationS: 600 })
    expect(screen.getByRole('spinbutton', { name: 'Duration in seconds' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Replace view at start' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Constant' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'View end' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Clear saved positions' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop the camera path' })).toBeEnabled()
    const timeline = screen.getByRole('slider', { name: 'Position on the path' })
    expect(timeline).toHaveAttribute('aria-valuetext', '300 of 600 seconds')
    expect(timeline).toHaveAttribute('aria-valuemax', '600')
    timeline.focus()
    fireEvent.keyDown(timeline, { key: 'End' })
    expect(h.onScrub).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(timeline, { key: 'Home' })
    expect(h.onScrub).toHaveBeenLastCalledWith(0)
  })

  it('turns the duration, the pace and the timeline', () => {
    const h = bar({ start: START, end: END })
    const duration = screen.getByRole('spinbutton', { name: 'Duration in seconds' })
    fireEvent.change(duration, { target: { value: '21' } })
    expect(h.onDurationChange).not.toHaveBeenCalled()
    fireEvent.blur(duration)
    expect(h.onDurationChange).toHaveBeenCalledWith(21)
    expect(screen.getByRole('radio', { name: 'Smooth' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Constant' }))
    expect(h.onEaseChange).toHaveBeenCalledWith('linear')
    step('Position on the path', 'ArrowRight')
    expect(h.onScrub).toHaveBeenCalledWith(0.005)
  })

  it('translates into German', () => {
    setLanguage('de')
    bar()
    expect(screen.getByRole('region', { name: 'Kamerafahrt' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start speichern: aktuelle Ansicht übernehmen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Kamerafahrt abspielen' })).toHaveTextContent('Abspielen')
    expect(screen.getByRole('button', { name: 'Kamerafahrt schließen' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Dauer in Sekunden' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Gleichmäßig' })).toBeInTheDocument()
  })
})
