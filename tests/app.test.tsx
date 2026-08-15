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
    syncTrams() {}
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
    expect(screen.getByTestId('data-source')).toHaveTextContent('Demo-Daten (approximiert)')
  })

  it('zeigt alle 5 Linien mit eingeschaltetem Switch', () => {
    render(<App />)
    const switches = screen.getAllByRole('switch', { name: /Linie \d anzeigen/ })
    expect(switches).toHaveLength(5)
    for (const sw of switches) {
      expect(sw).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('blendet eine Linie über den Switch aus', () => {
    render(<App />)
    const sw = screen.getByRole('switch', { name: 'Linie 1 anzeigen' })
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

  it('zeigt Ebenen-Schalter für Routen und Haltestellen', () => {
    render(<App />)
    const panel = screen.getByText('Ebenen').closest('div')!.parentElement!
    expect(within(panel).getByRole('switch', { name: 'Routen anzeigen' })).toBeInTheDocument()
    expect(
      within(panel).getByRole('switch', { name: 'Haltestellen anzeigen' }),
    ).toBeInTheDocument()
  })
})
