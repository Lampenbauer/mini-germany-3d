import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScenePopover, type ScenePopoverProps } from '@/components/ScenePopover'
import { setLanguage } from '@/lib/i18n'

/**
 * The scene button in the map controls: the sky the city is shown under,
 * and the miniature look that used to sit among the layer switches.
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

function scene(overrides: Partial<ScenePopoverProps> = {}) {
  const onWeatherModeChange = vi.fn()
  const onToggleTiltShift = vi.fn()
  const props: ScenePopoverProps = {
    weatherMode: 'live',
    onWeatherModeChange,
    liveWeatherAvailable: true,
    temperatureC: null,
    tiltShift: false,
    onToggleTiltShift,
    ...overrides,
  }
  render(<ScenePopover {...props} />)
  return { onWeatherModeChange, onToggleTiltShift }
}

/** Opens the popover the way a viewer does – nothing inside exists before. */
function open(name = 'Scene') {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('the scene popover', () => {
  it('keeps its contents behind the button until it is opened', () => {
    scene()
    expect(screen.queryByRole('radio', { name: 'Sunny' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('switch', { name: 'Show the miniature effect' }),
    ).not.toBeInTheDocument()
    open()
    expect(screen.getByRole('radio', { name: 'Sunny' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Show the miniature effect' })).toBeInTheDocument()
  })

  it('offers the four skies with exactly one of them picked', () => {
    scene({ weatherMode: 'cloudy' })
    open()
    const tiles = screen.getAllByRole('radio')
    expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual([
      'Live weather',
      'Sunny',
      'Cloudy',
      'Rain',
    ])
    const checked = tiles.filter((tile) => tile.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0]).toHaveAttribute('aria-label', 'Cloudy')
  })

  it('reports a picked sky instead of changing on its own', () => {
    const { onWeatherModeChange } = scene({ weatherMode: 'live' })
    open()
    fireEvent.click(screen.getByRole('radio', { name: 'Rain' }))
    expect(onWeatherModeChange).toHaveBeenCalledWith('rain')
    // Still on the sky it was given – the state lives in the app
    expect(screen.getByRole('radio', { name: 'Live weather' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('offers live weather greyed out where there is none to reach', () => {
    const { onWeatherModeChange } = scene({ liveWeatherAvailable: false, weatherMode: 'clear' })
    open()
    const live = screen.getByRole('radio', { name: 'Live weather' })
    expect(live).toBeDisabled()
    fireEvent.click(live)
    expect(onWeatherModeChange).not.toHaveBeenCalled()
    // …and says why, rather than leaving a dead tile
    expect(screen.getByText('No live weather to reach here')).toBeInTheDocument()
    // The other three still work offline: they are set, not polled
    fireEvent.click(screen.getByRole('radio', { name: 'Rain' }))
    expect(onWeatherModeChange).toHaveBeenCalledWith('rain')
  })

  it('carries the temperature beside the icon, and nothing when there is none', () => {
    const { rerender } = render(
      <ScenePopover
        weatherMode="live"
        onWeatherModeChange={vi.fn()}
        liveWeatherAvailable
        temperatureC={12.4}
        tiltShift={false}
        onToggleTiltShift={vi.fn()}
      />,
    )
    // Whole degrees on the button, the exact reading in its label
    expect(screen.getByRole('button', { name: 'Scene, 12 °C' })).toHaveTextContent('12°')

    rerender(
      <ScenePopover
        weatherMode="live"
        onWeatherModeChange={vi.fn()}
        liveWeatherAvailable
        temperatureC={null}
        tiltShift={false}
        onToggleTiltShift={vi.fn()}
      />,
    )
    const bare = screen.getByRole('button', { name: 'Scene' })
    expect(bare).toHaveTextContent('')
  })

  it('keeps showing the temperature under a picked sky', () => {
    // A picked sky is a way to look at the city, not a claim about the
    // weather – the reading beside it stays the real one.
    scene({ weatherMode: 'rain', temperatureC: -3.2 })
    expect(screen.getByRole('button', { name: 'Scene, -3 °C' })).toHaveTextContent('-3°')
  })

  it('switches the miniature look', () => {
    const { onToggleTiltShift } = scene({ tiltShift: false })
    open()
    const toggle = screen.getByRole('switch', { name: 'Show the miniature effect' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(toggle)
    expect(onToggleTiltShift).toHaveBeenCalledWith(true)
  })

  it('translates into German', () => {
    setLanguage('de')
    scene()
    open('Szene')
    expect(screen.getByText('Wetter')).toBeInTheDocument()
    for (const label of ['Live-Wetter', 'Sonnig', 'Bewölkt', 'Regen']) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('switch', { name: 'Miniatureffekt anzeigen' })).toBeInTheDocument()
  })
})
