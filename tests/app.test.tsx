import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Cesium benötigt WebGL – im jsdom wird die Karte durch einen Mock ersetzt.
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

describe('App (UI-Shell)', () => {
  it('rendert Titel, Uhr und Status-Badges', () => {
    render(<App />)
    expect(screen.getByText('Mini Rostock 3D')).toBeInTheDocument()
    expect(screen.getByTestId('sim-clock')).toBeInTheDocument()
    expect(screen.getByTestId('tileset-status')).toHaveTextContent('Offline-Modus')
    const expectedSource =
      loadBundledNetwork().meta.source === 'osm' ? 'OSM-Geometrie' : 'Demo-Daten (approximiert)'
    expect(screen.getByTestId('data-source')).toHaveTextContent(expectedSource)
  })

  it('zeigt alle Linien mit eingeschaltetem Switch', () => {
    render(<App />)
    const lineCount = loadBundledNetwork().lines.length
    const switches = screen.getAllByRole('switch', { name: /anzeigen$/ })
    // + 2 Ebenen-Switches (Routen, Haltestellen)
    expect(switches).toHaveLength(lineCount + 2)
    for (const sw of switches) {
      expect(sw).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('blendet eine Linie über den Switch aus', () => {
    render(<App />)
    const firstLine = loadBundledNetwork().lines[0]
    const sw = screen.getByRole('switch', { name: `${firstLine.name} anzeigen` })
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })

  it('Pause-Button wechselt zwischen Pause und Fortsetzen', () => {
    render(<App />)
    const pauseBtn = screen.getByRole('button', { name: 'Simulation pausieren' })
    fireEvent.click(pauseBtn)
    expect(
      screen.getByRole('button', { name: 'Simulation fortsetzen' }),
    ).toBeInTheDocument()
  })

  it('registriert die Test-API window.__mrt', () => {
    render(<App />)
    expect(window.__mrt).toBeDefined()
    expect(window.__mrt!.ready).toBe(true)
    expect(typeof window.__mrt!.tramCount()).toBe('number')
  })

  it('setzt die Simulationszeit über das Zeit-Eingabefeld und stellt Echtzeit wieder her', () => {
    render(<App />)
    const input = screen.getByLabelText('Simulationszeit setzen')
    fireEvent.change(input, { target: { value: '08:00' } })
    expect(window.__mrt!.secondsOfDay()).toBeGreaterThanOrEqual(8 * 3600)
    expect(window.__mrt!.secondsOfDay()).toBeLessThan(8 * 3600 + 5)

    fireEvent.click(screen.getByRole('button', { name: 'Jetzt' }))
    const realNow = berlinSecondsOfDay(Date.now())
    const diff = Math.abs(window.__mrt!.secondsOfDay() - realNow)
    expect(Math.min(diff, 86400 - diff)).toBeLessThan(5)
  })

  it('zeigt Ebenen-Schalter für Routen und Haltestellen', () => {
    render(<App />)
    const panel = screen.getByText('Ebenen').closest('div')!.parentElement!
    expect(within(panel).getByRole('switch', { name: 'Routen anzeigen' })).toBeInTheDocument()
    expect(
      within(panel).getByRole('switch', { name: 'Haltestellen anzeigen' }),
    ).toBeInTheDocument()
  })
})
