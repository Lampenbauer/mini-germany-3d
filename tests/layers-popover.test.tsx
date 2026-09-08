// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LayersPopover, type LayersPopoverProps } from '@/components/LayersPopover'
import { setLanguage } from '@/lib/i18n'

/**
 * The layers popover on the map's control rail: the switches for routes,
 * stops and names, and under them the Webcams row – a switch like the
 * others, a caret that folds the city's cameras out, and a click on a
 * camera that flies to it.
 */

beforeEach(() => {
  setLanguage('en')
})

/** Renders the popover and opens it – its contents exist only while it is up. */
function layers(overrides: Partial<LayersPopoverProps> = {}) {
  const onToggleWebcams = vi.fn()
  const onFlyToWebcam = vi.fn()
  const onToggleRoutes = vi.fn()
  const props: LayersPopoverProps = {
    showRoutes: true,
    onToggleRoutes,
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
    ...overrides,
  }
  render(<LayersPopover {...props} />)
  // The only button before the popover opens, and its name follows the
  // interface language – the German case would not find "Layers".
  fireEvent.click(screen.getByRole('button'))
  return { onToggleWebcams, onFlyToWebcam, onToggleRoutes }
}

describe('the layers popover', () => {
  it('carries the switches for what is drawn on the map', () => {
    const h = layers()
    expect(screen.getByRole('switch', { name: 'Show stops' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('switch', { name: 'Show vehicle and ship labels' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Show routes' }))
    expect(h.onToggleRoutes).toHaveBeenCalledWith(false)
  })

  it('is left out while the city has no cameras', () => {
    layers({ webcams: [] })
    expect(screen.queryByRole('switch', { name: 'Show webcams' })).not.toBeInTheDocument()
  })

  it('switches the pictures on and off like the other layers', () => {
    const h = layers()
    const toggle = screen.getByRole('switch', { name: 'Show webcams' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(h.onToggleWebcams).toHaveBeenCalledWith(false)
  })

  it('lists the cameras straight away, and a click flies to one', () => {
    const h = layers()
    // No caret to open any more – the list is the bottom of the popover
    expect(screen.queryByRole('button', { name: 'Webcams' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Fly to Rostock: Warnemünde' }))
    expect(h.onFlyToWebcam).toHaveBeenCalledWith(1397655670)
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  it('goes grey in the underground view, where the pictures are off the map', () => {
    const h = layers({ webcamsDisabled: true })
    const toggle = screen.getByRole('switch', { name: 'Show webcams' })
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(h.onToggleWebcams).not.toHaveBeenCalled()
    const camera = screen.getByRole('button', { name: 'Fly to Rostock: Warnemünde' })
    expect(camera).toBeDisabled()
    fireEvent.click(camera)
    expect(h.onFlyToWebcam).not.toHaveBeenCalled()
  })

  it('speaks German', () => {
    setLanguage('de')
    layers()
    expect(screen.getByRole('switch', { name: 'Webcams anzeigen' })).toBeInTheDocument()
    expect(screen.getByText('Webcams')).toBeInTheDocument()
  })
})
