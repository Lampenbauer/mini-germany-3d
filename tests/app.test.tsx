import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Cesium needs WebGL – in jsdom the map is replaced by a mock.
vi.mock('@/map/CesiumMap', () => {
  class CesiumMap {
    constructor(_container: HTMLElement, opts?: { onTilesetStatus?: (s: string) => void }) {
      opts?.onTilesetStatus?.('offline')
    }
    addRoutes() {}
    addStops() {}
    setHomeView() {}
    setView() {}
    getCameraView() {
      return { longitude: 12.13, latitude: 54.08, height: 3000, heading: 0, pitch: -38 }
    }
    getGroundHeights() {
      return []
    }
    getTramBoxDriftMeters() {
      return 0
    }
    getTramOpacity() {
      return null
    }
    render() {}
    getRenderHints() {
      return { interacting: false, tilesLoading: false }
    }
    syncTrams() {
      return { anyTramInView: true }
    }
    setRoutesVisible() {}
    setStopsVisible() {}
    setLineRouteVisible() {}
    setSelected() {}
    setFollow() {}
    setCameraHome() {}
    hasTram() {
      return false
    }
    destroy() {}
  }
  return { CesiumMap }
})

import App from '@/App'
import { loadBundledNetwork } from '@/data/network'
import { berlinSecondsOfDay } from '@/lib/clock'

afterEach(() => {
  cleanup()
  window.__mrt = undefined
})

describe('App (UI shell)', () => {
  it('renders title, clock, and status badges', () => {
    render(<App />)
    expect(screen.getByText('Mini Rostock 3D')).toBeInTheDocument()
    expect(screen.getByTestId('sim-clock')).toBeInTheDocument()
    expect(screen.getByTestId('tileset-status')).toHaveTextContent('Offline mode')
    // The data-source badge only appears as a warning for approximated
    // demo geometry – real OSM data shows no badge.
    if (loadBundledNetwork().meta.source === 'osm') {
      expect(screen.queryByTestId('data-source')).not.toBeInTheDocument()
    } else {
      expect(screen.getByTestId('data-source')).toHaveTextContent('Demo data (approximated)')
    }
  })

  it('shows all lines with their switch enabled', () => {
    render(<App />)
    const network = loadBundledNetwork()
    const lineCount = network.lines.length
    const modeCount = new Set(network.lines.map((l) => l.mode)).size
    const switches = screen.getAllByRole('switch', { name: /^Show / })
    // + 2 layer switches (routes, stops) + transit-mode group switches
    // (only visible when there is more than one mode)
    expect(switches).toHaveLength(lineCount + 2 + (modeCount > 1 ? modeCount : 0))
    for (const sw of switches) {
      expect(sw).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('hides a line via its switch', () => {
    render(<App />)
    const firstLine = loadBundledNetwork().lines[0]
    const sw = screen.getByRole('switch', { name: `Show ${firstLine.name}` })
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })

  it('pause button toggles between pause and resume', () => {
    render(<App />)
    const pauseBtn = screen.getByRole('button', { name: 'Pause simulation' })
    fireEvent.click(pauseBtn)
    expect(
      screen.getByRole('button', { name: 'Resume simulation' }),
    ).toBeInTheDocument()
  })

  it('registers the test API window.__mrt', () => {
    render(<App />)
    expect(window.__mrt).toBeDefined()
    expect(window.__mrt!.ready).toBe(true)
    expect(typeof window.__mrt!.tramCount()).toBe('number')
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
  })

  it('shows layer switches for routes and stops', () => {
    render(<App />)
    const panel = screen.getByText('Layers').closest('div')!.parentElement!
    expect(within(panel).getByRole('switch', { name: 'Show routes' })).toBeInTheDocument()
    expect(
      within(panel).getByRole('switch', { name: 'Show stops' }),
    ).toBeInTheDocument()
  })
})
