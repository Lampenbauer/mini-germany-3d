import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Cesium needs WebGL – in jsdom the map is replaced by a mock.
vi.mock('@/map/CesiumMap', () => {
  class CesiumMap {
    city: unknown
    constructor(
      _container: HTMLElement,
      opts: { city: unknown; onTilesetStatus?: (s: string) => void },
    ) {
      this.city = opts.city
      opts.onTilesetStatus?.('offline')
    }
    get currentCity() {
      return this.city
    }
    setCity(city: unknown) {
      this.city = city
    }
    clearCity() {}
    setGroundReference() {}
    setRain() {}
    isRainVisible() {
      return false
    }
    setCloudCover() {}
    setWind() {}
    advanceClouds() {}
    setCloudsEnabled() {}
    flyToStop() {}
    setFollowVessel() {}
    syncWebcams() {}
    setWebcamsVisible() {}
    flyToWebcam() {}
    syncVessels() {
      return { anyMovingVesselInView: false }
    }
    getVesselCount() {
      return 0
    }
    addRoutes() {}
    addStops() {}
    addStreetLamps() {}
    focusLine() {}
    setSceneTime() {}
    setView() {}
    getCameraView() {
      return { longitude: 12.13, latitude: 54.08, height: 3000, heading: 0, pitch: -38 }
    }
    getGroundHeights() {
      return []
    }
    getStreetLampInfo() {
      return { drawn: 0, alpha: 0 }
    }
    getVehicleBoxDriftMeters() {
      return 0
    }
    getVehicleOpacity() {
      return null
    }
    render() {}
    getRenderHints() {
      return { interacting: false, tilesLoading: false }
    }
    consumeRenderRequest() {
      return false
    }
    syncVehicles() {
      return { anyVehicleInView: true }
    }
    setRoutesVisible() {}
    setStopsVisible() {}
    setLabelsVisible() {}
    setPhotoSettings() {}
    setLineRouteVisible() {}
    setVisibleLines() {}
    setSelected() {}
    setFollow() {}
    setCameraHome() {}
    hasVehicle() {
      return false
    }
    destroy() {}
  }
  return { CesiumMap }
})

import App from '@/App'
import { loadRostockNetwork } from './cities'
import { berlinSecondsOfDay } from '@/lib/clock'
import { setLanguage } from '@/lib/i18n'

afterEach(() => {
  cleanup()
  setLanguage('en')
  window.__mrt = undefined
  window.localStorage.clear()
  window.history.replaceState(null, '', window.location.pathname)
})

describe('App (UI shell)', () => {
  it('renders title and clock', () => {
    render(<App />)
    expect(screen.getByText('Mini Rostock 3D')).toBeInTheDocument()
    expect(screen.getByTestId('sim-clock')).toBeInTheDocument()
  })

  it('reports the basemap and the data source it ended up with', async () => {
    // The panel used to carry these as badges. They are still worth
    // asserting – offline mode is what the whole test run depends on –
    // so they moved to the debug API rather than out of the suite.
    render(<App />)
    expect(window.__mrt?.tilesetStatus()).toBe('offline')
    // The city's data is a lazy chunk – ready flips once it is in
    await waitFor(() => expect(window.__mrt?.ready).toBe(true))
    expect(window.__mrt?.dataSource).toBe(loadRostockNetwork().meta.source)
    expect(window.__mrt?.city()).toBe('rostock')
  })

  it('points the compass needle where the camera looks', () => {
    render(<App />)
    const controls = screen.getByRole('group', { name: 'View controls' })
    const needle = within(controls).getAllByRole('button')[0].querySelector('svg')
    // The view opens facing north, and the arrow is drawn pointing north –
    // so it stands as drawn, and every later heading is a plain rotation.
    expect(needle).toHaveAttribute('style', expect.stringContaining('rotate(0deg)'))
  })

  it('offers the compass as the turn it will make', () => {
    render(<App />)
    // Facing north already, so the press ahead is the quarter after it
    expect(screen.getByRole('button', { name: 'Face east' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Face north' })).not.toBeInTheDocument()
  })

  it('shows all lines with their switch enabled', async () => {
    render(<App />)
    const network = loadRostockNetwork()
    const lineCount = network.lines.length
    const modeCount = new Set(network.lines.map((l) => l.mode)).size
    // + 3 layer switches (routes, stops, labels – the miniature effect
    // moved to the scene popover) + transit-mode group switches (only
    // visible when there is more than one mode). The lines arrive with
    // the city's data, a moment after the first render.
    const expected = lineCount + 3 + (modeCount > 1 ? modeCount : 0)
    await waitFor(() =>
      expect(screen.getAllByRole('switch', { name: /^Show / })).toHaveLength(expected),
    )
    for (const sw of screen.getAllByRole('switch', { name: /^Show / })) {
      expect(sw).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('hides a line via its switch', async () => {
    render(<App />)
    const firstLine = loadRostockNetwork().lines[0]
    const sw = await screen.findByRole('switch', { name: `Show ${firstLine.name}` })
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })

  it('zooming to a hidden line switches it back on', async () => {
    render(<App />)
    const firstLine = loadRostockNetwork().lines[0]
    const sw = await screen.findByRole('switch', { name: `Show ${firstLine.name}` })
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByRole('button', { name: `Fly to ${firstLine.name}` }))
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })

  it('play carries on from a time set by hand, "Now" returns to the real time', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause simulation' }))
    // Time-travel while paused – play must continue from there, not
    // snap back to the present.
    window.__mrt!.setTime('03:00')
    expect(window.__mrt!.secondsOfDay()).toBeCloseTo(3 * 3600, -1)
    fireEvent.click(screen.getByRole('button', { name: 'Resume simulation' }))
    expect(Math.abs(window.__mrt!.secondsOfDay() - 3 * 3600)).toBeLessThan(5)
    // The way back to the present is the "Now" button
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    const drift = Math.abs(window.__mrt!.secondsOfDay() - berlinSecondsOfDay(Date.now()))
    expect(drift).toBeLessThan(5)
  })

  it('pause button toggles between pause and resume', () => {
    render(<App />)
    const pauseBtn = screen.getByRole('button', { name: 'Pause simulation' })
    fireEvent.click(pauseBtn)
    expect(
      screen.getByRole('button', { name: 'Resume simulation' }),
    ).toBeInTheDocument()
  })

  it('registers the test API window.__mrt', async () => {
    render(<App />)
    expect(window.__mrt).toBeDefined()
    // Not ready until the city's data is on the map
    await waitFor(() => expect(window.__mrt!.ready).toBe(true))
    expect(typeof window.__mrt!.vehicleCount()).toBe('number')
  })

  it('names the city in the title and lists the others behind the caret', async () => {
    render(<App />)
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    // The caret waits for the city's data before it offers a move
    await waitFor(() => expect(window.__mrt!.ready).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Choose a city' }))
    expect(screen.getByRole('option', { name: 'Rostock' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Switch to Kiel' })).toBeInTheDocument()
  })

  it('switches the city from the picker and remembers it', async () => {
    render(<App />)
    await waitFor(() => expect(window.__mrt!.ready).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Choose a city' }))
    fireEvent.click(screen.getByRole('option', { name: 'Switch to Kiel' }))
    // The old city's session ends at once …
    expect(window.__mrt!.city()).toBe('kiel')
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Kiel 3D')
    // … and the new one is ready once its data is in
    await waitFor(() => expect(window.__mrt!.ready).toBe(true))
    expect(window.__mrt!.lineIds()).toContain('F1')
    expect(window.__mrt!.lineIds()).not.toContain('FG')
    expect(window.location.hash).toContain('city=kiel')
    expect(window.localStorage.getItem('mg3d.city')).toBe('kiel')
  })

  it('sets the simulation time via the time input and restores real time', () => {
    render(<App />)
    const input = screen.getByLabelText('Set simulation time')
    fireEvent.change(input, { target: { value: '08:00' } })
    expect(window.__mrt!.secondsOfDay()).toBeGreaterThanOrEqual(8 * 3600)
    expect(window.__mrt!.secondsOfDay()).toBeLessThan(8 * 3600 + 5)

    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    const realNow = berlinSecondsOfDay(Date.now())
    const diff = Math.abs(window.__mrt!.secondsOfDay() - realNow)
    expect(Math.min(diff, 86400 - diff)).toBeLessThan(5)
    // The field goes back to its default: it must not keep showing 08:00
    expect(input).toHaveValue('')
  })

  it('scrolls only the line list, not the whole panel', () => {
    render(<App />)
    // The panel itself must not scroll – the clock and the layer switches
    // stay put however long the line list gets.
    const list = screen.getByTestId('line-list')
    expect(list.className).toContain('overflow-y-auto')
    // Same fade the vehicle card's stop list uses
    expect(list.className).toContain('scroll-fade-y')
    const panel = screen.getByText('Mini Rostock 3D').closest('[data-slot="card"]')!
    expect(panel.className).toContain('overflow-hidden')
    expect(panel.className).not.toContain('overflow-y-auto')
  })

  it('shows layer switches for routes and stops', () => {
    render(<App />)
    const panel = screen.getByText('Layers').closest('div')!.parentElement!
    expect(within(panel).getByRole('switch', { name: 'Show routes' })).toBeInTheDocument()
    expect(
      within(panel).getByRole('switch', { name: 'Show stops' }),
    ).toBeInTheDocument()
  })

  it('takes the whole interface away on H and brings it back', () => {
    render(<App />)
    const overlay = screen.getByTestId('ui-overlay')
    expect(overlay.className).toContain('contents')
    expect(overlay.className).not.toContain('hidden')

    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    expect(screen.getByTestId('ui-overlay').className).toContain('hidden')
    // The map is not interface: it keeps its canvas, its labels and the
    // credit line Cesium draws into it.
    expect(screen.getByTestId('cesium-container')).toBeInTheDocument()
    expect(screen.getByTestId('cesium-container').className).not.toContain('hidden')

    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')
  })

  it('takes an upper-case H too, for whoever has caps lock on', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'H', code: 'KeyH' })
    expect(screen.getByTestId('ui-overlay').className).toContain('hidden')
  })

  it('keeps the panel mounted while it is hidden, so its state survives', () => {
    // display:none rather than an unmount – a collapsed panel must not
    // spring open again just because the interface was away for a moment.
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }))
    expect(screen.getByRole('button', { name: 'Expand panel' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    expect(screen.getByRole('button', { name: 'Expand panel' })).toBeInTheDocument()
  })

  it('leaves the interface alone for anything that is not a bare H', () => {
    render(<App />)
    for (const event of [
      // Every one of these is somebody else's shortcut: Ctrl+H and Cmd+H
      // belong to the browser and to macOS, the rest are not H at all.
      { key: 'h', code: 'KeyH', ctrlKey: true },
      { key: 'h', code: 'KeyH', metaKey: true },
      { key: 'h', code: 'KeyH', altKey: true },
      { key: 'H', code: 'KeyH', shiftKey: true },
      { key: 'g', code: 'KeyG' },
      // Dvorak: the physical H key carries a D there, and D is not the
      // shortcut – the letter on the cap is what counts, not the position.
      { key: 'd', code: 'KeyH' },
      // A held key would flicker the interface instead of toggling it
      { key: 'h', code: 'KeyH', repeat: true },
    ]) {
      fireEvent.keyDown(window, event)
      expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')
    }
  })

  it('lets a letter be a letter while a field has the focus', () => {
    // The one bare-key risk worth guarding: typing an h somewhere must not
    // take the interface away.
    render(<App />)
    const field = screen.getByLabelText('Set simulation time')
    field.focus()
    fireEvent.keyDown(field, { key: 'h', code: 'KeyH' })
    expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')
  })

  it('offers a full-screen button where the browser can do it', () => {
    // jsdom implements no Fullscreen API, so the flag has to be faked –
    // which is also the case the button is guarded for (iOS Safari).
    const original = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled')
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    try {
      render(<App />)
      const button = screen.getByRole('button', { name: 'Full screen' })
      expect(button).toHaveAttribute('aria-pressed', 'false')
      const request = vi.fn().mockResolvedValue(undefined)
      document.documentElement.requestFullscreen = request
      fireEvent.click(button)
      expect(request).toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(document, 'fullscreenEnabled', original)
      else delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled
    }
  })

  it('leaves the full-screen button out where the browser cannot', () => {
    render(<App />)
    expect(screen.queryByRole('button', { name: 'Full screen' })).not.toBeInTheDocument()
  })

  it('renders the interface in German when the browser prefers German', async () => {
    setLanguage('de')
    render(<App />)
    expect(screen.getByText('Verkehr')).toBeInTheDocument()
    expect(screen.getByText('Ebenen')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Routen anzeigen' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Haltestellen anzeigen' })).toBeInTheDocument()
    // Line names from the (English) dataset are localized for display
    const firstLine = loadRostockNetwork().lines[0]
    if (firstLine.name.startsWith('Line ')) {
      const germanName = firstLine.name.replace(/^Line /, 'Linie ')
      expect(
        await screen.findByRole('switch', { name: `${germanName} anzeigen` }),
      ).toBeInTheDocument()
    }
  })
})
