// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeatherPopover, type WeatherPopoverProps } from '@/components/WeatherPopover'
import { setLanguage } from '@/lib/i18n'

/**
 * The weather button in the upper right: the sky the city is shown under.
 * The miniature look used to share this popover; it is a lens rather than
 * a sky and lives in the camera block now (see App.tsx).
 */

afterEach(() => {
  cleanup()
  setLanguage('en')
})

function weather(overrides: Partial<WeatherPopoverProps> = {}) {
  const onWeatherModeChange = vi.fn()
  const onToggleClouds = vi.fn()
  const props: WeatherPopoverProps = {
    interfaceHidden: false,
    weatherMode: 'live',
    onWeatherModeChange,
    liveWeatherAvailable: true,
    temperatureC: null,
    showClouds: true,
    onToggleClouds,
    ...overrides,
  }
  render(<WeatherPopover {...props} />)
  return { onWeatherModeChange, onToggleClouds }
}

/** Opens the popover the way a viewer does – nothing inside exists before. */
function open(name = 'Weather') {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('the weather popover', () => {
  it('keeps its contents behind the button until it is opened', () => {
    weather()
    expect(screen.queryByRole('radio', { name: 'Sunny' })).not.toBeInTheDocument()
    open()
    expect(screen.getByRole('radio', { name: 'Sunny' })).toBeInTheDocument()
  })

  it('has no lens in it any more – that is the camera block\'s', () => {
    weather()
    open()
    expect(
      screen.queryByRole('switch', { name: 'Show the miniature effect' }),
    ).not.toBeInTheDocument()
  })

  it('offers the four skies with exactly one of them picked', () => {
    weather({ weatherMode: 'cloudy' })
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
    const { onWeatherModeChange } = weather({ weatherMode: 'live' })
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
    const { onWeatherModeChange } = weather({ liveWeatherAvailable: false, weatherMode: 'clear' })
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
      <WeatherPopover
        interfaceHidden={false}
        weatherMode="live"
        onWeatherModeChange={vi.fn()}
        liveWeatherAvailable
        temperatureC={12.4}
        showClouds
        onToggleClouds={vi.fn()}
      />,
    )
    // Whole degrees on the button, the exact reading in its label
    expect(screen.getByRole('button', { name: 'Weather, 12 °C' })).toHaveTextContent('12°')

    rerender(
      <WeatherPopover
        interfaceHidden={false}
        weatherMode="live"
        onWeatherModeChange={vi.fn()}
        liveWeatherAvailable
        temperatureC={null}
        showClouds
        onToggleClouds={vi.fn()}
      />,
    )
    const bare = screen.getByRole('button', { name: 'Weather' })
    expect(bare).toHaveTextContent('')
  })

  it('keeps showing the temperature under a picked sky', () => {
    // A picked sky is a way to look at the city, not a claim about the
    // weather – the reading beside it stays the real one.
    weather({ weatherMode: 'rain', temperatureC: -3.2 })
    expect(screen.getByRole('button', { name: 'Weather, -3 °C' })).toHaveTextContent('-3°')
  })

  it('offers the switch for the volumetric clouds and reports a flip', () => {
    const { onToggleClouds } = weather({ showClouds: true })
    open()
    const clouds = screen.getByRole('switch', { name: 'Show the 3D clouds' })
    expect(clouds).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(clouds)
    expect(onToggleClouds).toHaveBeenCalledWith(false)
    // Still on – the state lives in the app
    expect(clouds).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the clouds switch off when they are, without lighting the button', () => {
    weather({ showClouds: false })
    // The button lights up for a picked sky only; the clouds are how the
    // sky is drawn, not which one it is
    expect(screen.getByRole('button', { name: 'Weather' })).not.toHaveClass('bg-primary/90')
    open()
    expect(screen.getByRole('switch', { name: 'Show the 3D clouds' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('translates into German', () => {
    setLanguage('de')
    weather()
    open('Wetter')
    expect(screen.getByText('Wetter')).toBeInTheDocument()
    for (const label of ['Live-Wetter', 'Sonnig', 'Bewölkt', 'Regen']) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('switch', { name: '3D-Wolken anzeigen' })).toBeInTheDocument()
  })
})
