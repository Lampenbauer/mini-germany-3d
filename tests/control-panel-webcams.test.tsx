import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel, type ControlPanelProps } from '@/components/ControlPanel'
import { setLanguage } from '@/lib/i18n'

/**
 * The Webcams row in the Layers block: a switch like the other layers',
 * a caret that folds the city's cameras out, and a click on a camera
 * that flies to it.
 */

beforeEach(() => {
  setLanguage('en')
})

function panel(overrides: Partial<ControlPanelProps> = {}) {
  const onToggleWebcams = vi.fn()
  const onFlyToWebcam = vi.fn()
  const props: ControlPanelProps = {
    city: { slug: 'rostock', name: 'Rostock', modes: ['tram'] },
    cities: [{ slug: 'rostock', name: 'Rostock', modes: ['tram'] }],
    cityLoading: false,
    onSelectCity: vi.fn(),
    clockText: '12:00:00',
    speed: 1,
    paused: false,
    onSpeedChange: vi.fn(),
    onTogglePause: vi.fn(),
    onSetTime: vi.fn(),
    onResetTime: vi.fn(),
    lines: [],
    onToggleLine: vi.fn(),
    onFocusLine: vi.fn(),
    onSetLinesVisible: vi.fn(),
    showRoutes: true,
    onToggleRoutes: vi.fn(),
    showStops: true,
    onToggleStops: vi.fn(),
    showLabels: true,
    onToggleLabels: vi.fn(),
    webcams: [
      { id: 1738068941, title: 'Schmarl: Rostock - Schifffahrtsmuseum' },
      { id: 1397655670, title: 'Rostock: Warnemünde' },
    ],
    showWebcams: true,
    webcamsDisabled: false,
    onToggleWebcams,
    onFlyToWebcam,
    aisAvailable: false,
    showAisVessels: false,
    onToggleAisVessels: vi.fn(),
    ...overrides,
  }
  render(<ControlPanel {...props} />)
  return { onToggleWebcams, onFlyToWebcam }
}

describe('the Webcams row in the Layers block', () => {
  it('is left out while the city has no cameras', () => {
    panel({ webcams: [] })
    expect(screen.queryByRole('switch', { name: 'Show webcams' })).not.toBeInTheDocument()
  })

  it('switches the pictures on and off like the other layers', () => {
    const h = panel()
    const toggle = screen.getByRole('switch', { name: 'Show webcams' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(h.onToggleWebcams).toHaveBeenCalledWith(false)
  })

  it('folds the cameras out, and a click flies to one', () => {
    const h = panel()
    const trigger = screen.getByRole('button', { name: 'Webcams' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Fly to Rostock: Warnemünde' })).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Fly to Rostock: Warnemünde' }))
    expect(h.onFlyToWebcam).toHaveBeenCalledWith(1397655670)
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('goes grey in the underground view, where the pictures are off the map', () => {
    const h = panel({ webcamsDisabled: true })
    const toggle = screen.getByRole('switch', { name: 'Show webcams' })
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(h.onToggleWebcams).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Webcams' }))
    const camera = screen.getByRole('button', { name: 'Fly to Rostock: Warnemünde' })
    expect(camera).toBeDisabled()
    fireEvent.click(camera)
    expect(h.onFlyToWebcam).not.toHaveBeenCalled()
  })

  it('speaks German', () => {
    setLanguage('de')
    panel()
    expect(screen.getByRole('switch', { name: 'Webcams anzeigen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Webcams' })).toBeInTheDocument()
  })
})
