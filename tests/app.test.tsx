// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How often the map was sent back to the city's home view. Hoisted with
 * the mock factory (vitest only lets a factory reach variables named
 * mock*), so a test can watch what the camera reset does.
 */
const mockCameraHomeCalls = vi.hoisted(() => ({ count: 0 }))

/**
 * The little the map double remembers about its camera: enough for the
 * controls that read the pose back before they act (the 2D/3D button asks
 * the map which way it is looking, rather than trusting a flag).
 */
const mockCamera = vi.hoisted(() => ({ orientations: 0, tiltShift: false, pitch: -38 }))

/** How each city move was asked for – a flight from the picker, a jump from a link or the welcome screen. */
const mockMoves = vi.hoisted(() => ({
  transitions: [] as string[],
  renderProfile: undefined as unknown,
  /** The ground the map was built on, and every switch since (see setBasemap). */
  basemaps: [] as string[],
}))

// Cesium needs WebGL – in jsdom the map is replaced by a mock.
vi.mock('@/map/CesiumMap', () => {
  class CesiumMap {
    city: unknown
    constructor(
      _container: HTMLElement,
      opts: {
        city: unknown
        renderProfile?: unknown
        basemap?: string
        onTilesetStatus?: (s: string) => void
      },
    ) {
      this.city = opts.city
      mockMoves.renderProfile = opts.renderProfile
      mockMoves.basemaps = [opts.basemap ?? '3d']
      opts.onTilesetStatus?.('offline')
    }
    setBasemap(kind: string) {
      mockMoves.basemaps.push(kind)
    }
    flatMapState() {
      return { shown: false, day: false, night: false, nightAlpha: 0 }
    }
    get currentCity() {
      return this.city
    }
    setCity(city: unknown, transition?: unknown, onArrive?: () => void) {
      this.city = city
      mockMoves.transitions.push(String(transition))
      // No flight here, so the camera is over the new city at once – the
      // app waits for this before it puts the new city's data up.
      onArrive?.()
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
    setSelectedVessel() {}
    syncWebcams() {}
    setWebcamsVisible() {}
    flyToWebcam() {}
    syncVessels() {
      return { anyMovingVesselInView: false }
    }
    getVesselCount() {
      return 0
    }
    setFollowAircraft() {}
    setSelectedAircraft() {}
    syncAircraft() {
      return { anyMovingAircraftInView: false }
    }
    getAircraftCount() {
      return 0
    }
    navLightsState() {
      return { aircraft: 0, ships: 0, ferries: 0 }
    }
    hasAircraft() {
      return false
    }
    addRoutes() {}
    addStops() {}
    addStreetLamps() {}
    addAirfieldLights() {}
    addBuoys() {}
    addLighthouses() {}
    focusLine() {}
    setSceneTime() {}
    setView() {}
    getCameraView() {
      return { longitude: 12.13, latitude: 54.08, height: 3000, heading: 0, pitch: mockCamera.pitch }
    }
    getGroundHeights() {
      return []
    }
    getStreetLampInfo() {
      return { drawn: 0, alpha: 0 }
    }
    getAirfieldLightInfo() {
      return { drawn: 0, alpha: 0, floods: 0 }
    }
    setVisibility() {}
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
    // The tick interval is worked out from this; without it the loop's
    // arithmetic came out NaN and the simulation never ticked in here
    get motionThresholdCssPx() {
      return 0.5
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
    setPhotoSettings(settings: { tiltShift: { enabled: boolean } }) {
      mockCamera.tiltShift = settings.tiltShift.enabled
    }
    setCameraOrientation(orientation: { pitchDeg?: number } = {}) {
      mockCamera.orientations++
      if (orientation.pitchDeg !== undefined) mockCamera.pitch = orientation.pitchDeg
    }
    setLineRouteVisible() {}
    setVisibleLines() {}
    setSelected() {}
    setFollow() {}
    setCameraHome() {
      mockCameraHomeCalls.count++
    }
    setUnderground() {}
    // The credit link and the list behind it are Cesium's own DOM; the
    // dialog that borrows them is covered in credits-dialog.test.tsx.
    onCreditsRequested() {}
    borrowCreditList() {}
    hasVehicle() {
      return false
    }
    // The render loop's pacing and the camera path, as the tick reaches
    // them: a stub that lacks one of these throws out of the loop, which
    // only logs it – and every tick after the throw is lost.
    setPaceWholeView() {}
    cloudMotionPxPerSecond() {
      return 0
    }
    isChasing() {
      return false
    }
    cameraMovedSinceRender() {
      return false
    }
    playCameraPath() {}
    stopCameraPath() {}
    scrubCameraPath() {}
    destroy() {}
  }
  return { CesiumMap }
})

import App from '@/App'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { loadRostockNetwork } from './cities'
import { berlinDateKey, berlinSecondsOfDay } from '@/lib/clock'
import { DEFAULT_PHOTO_SETTINGS } from '@/lib/photo-settings'
import { setLanguage } from '@/lib/i18n'

// The welcome screen stands between a plain visit and the map (see
// lib/welcome.ts); every test but its own opens the app past it, the way
// the E2E suite does.
beforeEach(() => {
  window.history.replaceState(null, '', '/?welcome=0')
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  setLanguage('en')
  mockMoves.transitions.length = 0
  mockCamera.orientations = 0
  mockCamera.tiltShift = false
  mockCamera.pitch = -38
  window.__mg3d = undefined
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
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
    expect(window.__mg3d?.tilesetStatus()).toBe('offline')
    // The city's data is a lazy chunk – ready flips once it is in
    await waitFor(() => expect(window.__mg3d?.ready).toBe(true))
    expect(window.__mg3d?.dataSource).toBe(loadRostockNetwork().meta.source)
    expect(window.__mg3d?.city()).toBe('rostock')
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
    // The panel is the lines and nothing else now: routes, stops and
    // labels moved out to the layers popover on the map's rail, and the
    // miniature effect to the photo popover before them. What is left is
    // one switch per line plus the transit-mode group switches (only
    // there when the city has more than one mode). The lines arrive with
    // the city's data, a moment after the first render.
    const expected = lineCount + (modeCount > 1 ? modeCount : 0)
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
    window.__mg3d!.setTime('03:00')
    expect(window.__mg3d!.secondsOfDay()).toBeCloseTo(3 * 3600, -1)
    fireEvent.click(screen.getByRole('button', { name: 'Resume simulation' }))
    expect(Math.abs(window.__mg3d!.secondsOfDay() - 3 * 3600)).toBeLessThan(5)
    // The way back to the present is the "Now" button
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    const drift = Math.abs(window.__mg3d!.secondsOfDay() - berlinSecondsOfDay(Date.now()))
    expect(drift).toBeLessThan(5)
  })

  it('a clock moved past the present says once that ships and aircraft stay in real time', async () => {
    // The real clock alone is faked, so the loop's rAF and the UI tick
    // run as they do – Date.now() is what the notice's cooldown reads
    vi.useFakeTimers({ toFake: ['Date'] })
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    const title = 'Ships and aircraft stay in real time'
    expect(screen.queryByText(title)).not.toBeInTheDocument()
    // The first UI tick sets the notice's baseline – wait for the clock to show
    await waitFor(() => expect(screen.getByTestId('sim-clock')).not.toHaveTextContent('--:--:--'))
    // A day ahead by the calendar (the same day's time field could wrap
    // into the past near midnight)
    const tomorrow = berlinDateKey(Date.now() + 86_400_000)
    window.__mg3d!.setDate(tomorrow)
    await waitFor(() => expect(screen.getAllByText(title)).toHaveLength(1))
    expect(
      screen.getByText(/Ships and aircraft cannot be shown in the future/),
    ).toBeInTheDocument()
    // Back to the present and ahead again: nothing new within the cooldown
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    window.__mg3d!.setDate(tomorrow)
    await waitFor(() => expect(window.__mg3d!.dateKey()).toBe(tomorrow))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(screen.getAllByText(title)).toHaveLength(1)
    // Fifteen minutes on, the next move says it again
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    vi.setSystemTime(Date.now() + 15 * 60_000)
    await new Promise((resolve) => setTimeout(resolve, 600))
    window.__mg3d!.setDate(berlinDateKey(Date.now() + 86_400_000))
    await waitFor(() => expect(screen.getAllByText(title)).toHaveLength(2))
    // Each notice carries its own X, and it takes only that one away
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss the notice' })[0])
    await waitFor(() => expect(screen.getAllByText(title)).toHaveLength(1))
  })

  it('fades the rail out after ten seconds without a move, and back on the first one', async () => {
    vi.useFakeTimers()
    render(<App />)
    const rail = screen.getByTestId('map-rail')
    expect(rail).not.toHaveClass('opacity-0')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(rail).not.toHaveClass('opacity-0')
    await vi.advanceTimersByTimeAsync(1)
    expect(rail).toHaveClass('opacity-0')
    // The focus inside keeps it readable for a keyboard whatever the pointer does
    expect(rail).toHaveClass('focus-within:opacity-100')
    fireEvent.pointerMove(window)
    expect(rail).not.toHaveClass('opacity-0')
  })

  it('pause button toggles between pause and resume', () => {
    render(<App />)
    const pauseBtn = screen.getByRole('button', { name: 'Pause simulation' })
    fireEvent.click(pauseBtn)
    expect(
      screen.getByRole('button', { name: 'Resume simulation' }),
    ).toBeInTheDocument()
  })

  it('registers the test API window.__mg3d', async () => {
    render(<App />)
    expect(window.__mg3d).toBeDefined()
    // Not ready until the city's data is on the map
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(typeof window.__mg3d!.vehicleCount()).toBe('number')
  })

  it('names the city in the title and lists the others behind it', async () => {
    render(<App />)
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    // The title waits for the city's data before it offers a move
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    expect(screen.getByRole('option', { name: 'Rostock' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Switch to Kiel' })).toBeInTheDocument()
  })

  it('switches the city from the picker and remembers it', async () => {
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    fireEvent.click(screen.getByRole('option', { name: 'Switch to Kiel' }))
    // The old city's session ends at once …
    expect(window.__mg3d!.city()).toBe('kiel')
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Kiel 3D')
    // … and the new one is ready once its data is in
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(window.__mg3d!.lineIds()).toContain('F1')
    expect(window.__mg3d!.lineIds()).not.toContain('FG')
    // Every URL names its city in the path, the default one included, in
    // the language the interface speaks (English here – see lib/site-path.ts)
    expect(window.location.pathname).toBe('/en/kiel/')
    expect(window.location.search).toBe('?welcome=0')
    expect(window.location.hash).not.toContain('city=')
    // The sky the session shows rides in the hash – under Vitest there is
    // none to poll, so it is the clear one such a session opens on
    expect(window.location.hash).toContain('weather=clear')
    expect(window.localStorage.getItem('mg3d.city')).toBe('kiel')
  })

  it('drops the camera path with the city it was shot over, keeping its seconds and pace', async () => {
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    window.__mg3d!.setCameraPath({
      keyframes: [
        { longitude: 12.1, latitude: 54.06, height: 3000, heading: 350, pitch: -40 },
        { longitude: 12.14, latitude: 54.1, height: 1500, heading: 20, pitch: -30 },
      ],
      durationS: 12,
      ease: 'linear',
    })
    await waitFor(() => expect(window.__mg3d!.cameraPath().path).not.toBeNull())
    await waitFor(() => expect(window.location.hash).toContain('path='))
    // The bar is up, and the readings beside it are a column of icons
    // on the same baseline: no spelled-out label, the group stacked
    expect(screen.getByTestId('camera-path-bar')).toBeInTheDocument()
    const readings = screen.getByRole('radiogroup', { name: 'View' })
    expect(readings).toHaveClass('sm:flex-col')
    expect(within(readings).getByText('Surface')).toHaveClass('sr-only')
    expect(within(readings).getByText('Surface')).not.toHaveClass('min-[1120px]:not-sr-only')
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    fireEvent.click(screen.getByRole('option', { name: 'Switch to Kiel' }))
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    // The keyframes were poses over Rostock: gone, with the hash they rode in
    expect(window.__mg3d!.cameraPath()).toMatchObject({ path: null, playing: false, progress: 0 })
    await waitFor(() => expect(window.location.hash).not.toContain('path='))
    // The seconds and the pace are settings, not places – they stay
    // for the next shot
    expect(screen.getByRole('button', { name: 'Photo mode' })).toBeInTheDocument()
    // The bar stays up, emptied, like the seconds and the pace: it was
    // opened by the reader, and the next shot is over the new city
    expect(screen.getByTestId('camera-path-bar')).toBeInTheDocument()
    expect(screen.getAllByText('Not saved')).toHaveLength(2)
  })

  it('asks for a city on a plain visit, keeps the map bare behind the door and jumps there', async () => {
    window.history.replaceState(null, '', '/')
    render(<App />)
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    // Cesium is up, nothing of a city is: no session, no data, no hash
    expect(screen.getByTestId('cesium-container')).toBeInTheDocument()
    expect(window.__mg3d!.welcomeOpen()).toBe(true)
    expect(window.__mg3d!.ready).toBe(false)
    expect(window.__mg3d!.vehicleCount()).toBe(0)
    expect(screen.getByTestId('ui-overlay').className).toContain('hidden')
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/')
    // Neither do the shortcuts reach the map behind it
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR' })
    expect(mockCameraHomeCalls.count).toBe(0)

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Open Kiel' }))
    // The screen stands, with a spinner on the card, while the city
    // starts behind it – a jump, not a flight, there was nothing on the
    // map to fly from – and its data comes in
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    expect(screen.getByTestId('welcome-spinner')).toBeInTheDocument()
    expect(window.__mg3d!.welcomeOpen()).toBe(true)
    expect(mockMoves.transitions).toEqual(['jump'])
    expect(window.__mg3d!.city()).toBe('kiel')
    await vi.waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    // Two seconds after the pick, and not before, the screen goes
    await vi.advanceTimersByTimeAsync(1500)
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(600)
    expect(screen.queryByTestId('welcome-screen')).not.toBeInTheDocument()
    expect(window.__mg3d!.welcomeOpen()).toBe(false)
    expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')
    expect(window.location.pathname).toBe('/en/kiel/')
    // The box was left unticked: the door stays for the next visit
    expect(window.localStorage.getItem('mg3d.welcome')).toBeNull()
  })

  it('stays away once asked to, and opens on the default city then, not the last one', async () => {
    window.history.replaceState(null, '', '/')
    render(<App />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Don’t show this welcome screen on your next visit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Kiel' }))
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(window.localStorage.getItem('mg3d.welcome')).toBe('hidden')
    expect(window.localStorage.getItem('mg3d.city')).toBe('kiel')
    cleanup()

    // The next plain visit
    window.history.replaceState(null, '', '/')
    render(<App />)
    expect(screen.queryByTestId('welcome-screen')).not.toBeInTheDocument()
    expect(window.__mg3d!.welcomeOpen()).toBe(false)
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Rostock 3D')
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    // A link still says where to go, door or no door – in its path
    cleanup()
    window.localStorage.removeItem('mg3d.welcome')
    window.history.replaceState(null, '', '/kiel/')
    render(<App />)
    expect(screen.queryByTestId('welcome-screen')).not.toBeInTheDocument()
    expect(screen.getByTestId('app-title')).toHaveTextContent('Mini Kiel 3D')
  })

  it('opens the legal page’s notice over the door when its address is the one visited', async () => {
    window.history.replaceState(null, '', '/impressum/')
    render(<App />)
    // The path names no city: the door stands, and the notice over it
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    expect(window.__mg3d!.welcomeOpen()).toBe(true)
    // A commit after the door, so that the door is what it hides from a
    // screen reader and not the other way round as well
    const notice = await screen.findByRole('dialog', { name: 'Legal notice' })
    expect(notice).toHaveAttribute('data-testid', 'legal-dialog')
    expect(screen.getByTestId('welcome-screen').closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true')
    expect(notice.closest('[aria-hidden]')).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByTestId('legal-dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('welcome-screen')).toBeInTheDocument()
    // The door's own links open it again
    fireEvent.click(within(screen.getByTestId('welcome-screen')).getByRole('link', { name: 'Privacy' }))
    expect(screen.getByRole('dialog', { name: 'Privacy' })).toBeInTheDocument()
    // No city was picked, so no path was written over the page's
    expect(window.location.pathname).toBe('/impressum/')
  })

  it('writes the German path when the interface speaks German, and keeps the boot options', async () => {
    setLanguage('de')
    window.history.replaceState(null, '', '/en/kiel/?welcome=0&offline=1')
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(window.__mg3d!.city()).toBe('kiel')
    // The German page has no language prefix (lib/site-path.ts)
    expect(window.location.pathname).toBe('/kiel/')
    expect(window.location.search).toBe('?welcome=0&offline=1')
  })

  it('builds the map with the device tier the URL forces', async () => {
    // jsdom reads as a desktop (no touch points); ?tier=mobile overrides the reading
    window.history.replaceState(null, '', '/kiel/?welcome=0&tier=mobile')
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(window.__mg3d!.renderProfile().tier).toBe('mobile')
    expect(mockMoves.renderProfile).toBe(window.__mg3d!.renderProfile())
    cleanup()
    window.history.replaceState(null, '', '/kiel/?welcome=0')
    render(<App />)
    expect(window.__mg3d!.renderProfile().tier).toBe('desktop')
    expect(window.__mg3d!.renderProfile().shadowMapSize).toBe(8192)
  })

  it('opens on the flat map a link names, and the switch writes it back into the hash', async () => {
    window.history.replaceState(null, '', '/kiel/?welcome=0&offline=1#basemap=flat')
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    // Built on the flat map, not switched to it after the first frame
    expect(mockMoves.basemaps).toEqual(['flat'])
    expect(window.__mg3d!.basemap()).toBe('flat')
    await waitFor(() => expect(window.location.hash).toContain('basemap=flat'))

    // The switch in the layers popover
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }))
    const flat = screen.getByRole('switch', { name: 'Draw a flat street map instead of the 3D city' })
    expect(flat).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(flat)
    expect(mockMoves.basemaps).toEqual(['flat', '3d'])
    expect(window.__mg3d!.basemap()).toBe('3d')
    // The tiles are the map as it opens, never written out
    await waitFor(() => expect(window.location.hash).not.toContain('basemap='))

    // An edited hash switches the map the same way
    window.location.hash = window.location.hash + '&basemap=flat'
    await waitFor(() => expect(mockMoves.basemaps).toEqual(['flat', '3d', 'flat']))
    expect(window.__mg3d!.basemap()).toBe('flat')
  })

  it('shows the static page again and says why when the app cannot start', () => {
    const page = document.createElement('div')
    page.id = 'static-page'
    page.hidden = true
    document.body.append(page)
    // As index.html's inline script and main.tsx leave the document
    document.documentElement.classList.add('has-app')
    document.documentElement.setAttribute('data-app-started', '')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Boom(): never {
      throw new Error('The browser does not support WebGL.')
    }
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      )
      expect(screen.getByRole('alert')).toHaveTextContent('The map could not start.')
      expect(screen.getByRole('alert')).toHaveTextContent('The browser does not support WebGL.')
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
      expect(page.hidden).toBe(false)
      expect(document.documentElement.classList.contains('has-app')).toBe(false)
    } finally {
      quiet.mockRestore()
      page.remove()
      document.documentElement.removeAttribute('data-app-started')
    }
  })

  it('sets the simulation time via the time input and restores real time', () => {
    render(<App />)
    const input = screen.getByLabelText('Set simulation time')
    fireEvent.change(input, { target: { value: '08:00' } })
    expect(window.__mg3d!.secondsOfDay()).toBeGreaterThanOrEqual(8 * 3600)
    expect(window.__mg3d!.secondsOfDay()).toBeLessThan(8 * 3600 + 5)
    // The time typed goes into the URL as typed …
    expect(window.location.hash).toContain('&time=08:00')
    // … and stays what was typed while the clock runs on from it: moved
    // by anything but the field, and written again, the hash still says
    // 08:00 – a link that ticked would never be the same twice
    window.__mg3d!.setTime('09:30')
    fireEvent.click(screen.getByRole('button', { name: 'Pause simulation' }))
    expect(window.location.hash).toContain('&time=08:00')
    expect(window.location.hash).not.toContain('09:30')
    fireEvent.click(screen.getByRole('button', { name: 'Resume simulation' }))
    // The field emptied withdraws the entry and leaves the clock alone
    fireEvent.change(input, { target: { value: '' } })
    expect(window.location.hash).not.toContain('time=')
    expect(window.__mg3d!.secondsOfDay()).toBeGreaterThanOrEqual(9.5 * 3600)
    fireEvent.change(input, { target: { value: '08:00' } })
    expect(window.location.hash).toContain('&time=08:00')

    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    const realNow = berlinSecondsOfDay(Date.now())
    const diff = Math.abs(window.__mg3d!.secondsOfDay() - realNow)
    expect(Math.min(diff, 86400 - diff)).toBeLessThan(5)
    // The field goes back to its default: it must not keep showing 08:00,
    // and neither may the URL
    expect(input).toHaveValue('')
    expect(window.location.hash).not.toContain('time=')
  })

  it('opens on the day and the time a link carries, and shows them in the panel', async () => {
    const tomorrow = berlinDateKey(Date.now() + 86_400_000)
    window.history.replaceState(
      null,
      '',
      `/?welcome=0#lat=54.08&lon=12.13&height=3000&heading=0&pitch=-38&date=${tomorrow}&time=06:15`,
    )
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(window.__mg3d!.dateKey()).toBe(tomorrow)
    expect(window.__mg3d!.secondsOfDay()).toBeGreaterThanOrEqual(6 * 3600 + 15 * 60)
    expect(window.__mg3d!.secondsOfDay()).toBeLessThan(6 * 3600 + 15 * 60 + 5)
    // The panel shows what the link set, as if it had been typed here
    expect(screen.getByLabelText('Set simulation time')).toHaveValue('06:15')
    expect(
      screen.getByRole('button', { name: 'Set simulation date (two days back to a week ahead)' }),
    ).toHaveTextContent(`${parseInt(tomorrow.slice(8), 10)}.`)
    // … and the hash keeps carrying it, unchanged by the running clock
    fireEvent.click(screen.getByRole('button', { name: 'Pause simulation' }))
    expect(window.location.hash).toContain(`&date=${tomorrow}&time=06:15&paused=1`)
  })

  it('writes a traffic category switched off as a whole into the URL, and a link switches it off again', async () => {
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    const busSwitch = screen.getByRole('switch', { name: 'Show all Bus lines' })
    expect(busSwitch).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(busSwitch)
    expect(busSwitch).toHaveAttribute('aria-checked', 'false')
    expect(window.location.hash).toContain('&hide=bus&')
    // A single line is not in the URL – a category is; the trams
    // switched off one by one are, once the last one is
    const tramSwitch = screen.getByRole('switch', { name: 'Show all Tram lines' })
    const tramGroup = tramSwitch.closest<HTMLElement>('.flex-col')!
    const tramLineSwitches = within(tramGroup)
      .getAllByRole('switch')
      .filter((element) => element !== tramSwitch)
    expect(tramLineSwitches.length).toBeGreaterThan(1)
    for (const lineSwitch of tramLineSwitches.slice(0, -1)) fireEvent.click(lineSwitch)
    expect(window.location.hash).toContain('&hide=bus&')
    expect(window.location.hash).not.toContain('tram')
    fireEvent.click(tramLineSwitches.at(-1)!)
    expect(tramSwitch).toHaveAttribute('aria-checked', 'false')
    expect(window.location.hash).toContain('&hide=tram,bus&')
    fireEvent.click(busSwitch)
    fireEvent.click(tramSwitch)
    expect(window.location.hash).not.toContain('hide=')
    cleanup()

    // A link with the trams and both fleets off: the tram lines start
    // hidden, and the fleets stay off in the URL though this build has
    // no row for them (offline, in the tests – see aisAvailable)
    window.history.replaceState(null, '', '/?welcome=0#lat=54.08&lon=12.13&height=3000&hide=tram,ais,aircraft')
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(screen.getByRole('switch', { name: 'Show all Tram lines' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('switch', { name: 'Show all Bus lines' })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(window.__mg3d!.vehicleCount()).toBeGreaterThan(0))
    expect(window.__mg3d!.visibleVehicleCount()).toBeLessThan(window.__mg3d!.vehicleCount())
    fireEvent.click(screen.getByRole('button', { name: 'Pause simulation' }))
    expect(window.location.hash).toContain('&hide=tram,ais,aircraft&')
    // The category outlives the city, as the layer switches do: Kiel has
    // no trams, keeps the word for the next city, and its own buses show
    fireEvent.click(screen.getByRole('button', { name: 'Mini Rostock 3D' }))
    fireEvent.click(screen.getByRole('option', { name: 'Switch to Kiel' }))
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    expect(screen.getByRole('switch', { name: 'Show all Bus lines' })).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(window.location.hash).toContain('&hide=tram,ais,aircraft&'))
  })

  it('carries the photo mode in the URL knob by knob, and opens on it', async () => {
    window.history.replaceState(
      null,
      '',
      '/?welcome=0#lat=54.08&lon=12.13&height=3000&tiltshift=1&fov=40&con=1.2&bok=4',
    )
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    const opened = window.__mg3d!.photoSettings()
    expect(opened.tiltShift.enabled).toBe(true)
    expect(opened.fovDeg).toBe(40)
    expect(opened.contrast).toBe(1.2)
    expect(opened.tiltShift.highlightGain).toBe(4)
    expect(opened.saturation).toBe(1)
    // A knob turned goes into the URL as the value it stands at
    fireEvent.click(screen.getByRole('button', { name: 'Photo mode' }))
    const contrast = screen.getByRole('slider', { name: 'Contrast' })
    contrast.focus()
    fireEvent.keyDown(contrast, { key: 'ArrowRight' })
    expect(window.__mg3d!.photoSettings().contrast).toBeCloseTo(1.21, 6)
    expect(window.location.hash).toContain('&tiltshift=1&fov=40&con=1.21&bok=4')
    // Back to the defaults: every knob leaves the URL with it
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    expect(window.__mg3d!.photoSettings()).toEqual(DEFAULT_PHOTO_SETTINGS)
    for (const key of ['tiltshift=', 'fov=', 'con=', 'bok=']) {
      expect(window.location.hash).not.toContain(key)
    }
  })

  it('takes an edited entry off the address bar: a half named is set, a half gone is the real clock', async () => {
    render(<App />)
    await waitFor(() => expect(window.__mg3d!.ready).toBe(true))
    const tomorrow = berlinDateKey(Date.now() + 86_400_000)
    // A hashchange comes from outside – a typed edit, a history step
    window.location.hash = `#lat=54.08&lon=12.13&height=3000&date=${tomorrow}&time=22:00`
    fireEvent(window, new HashChangeEvent('hashchange'))
    expect(window.__mg3d!.dateKey()).toBe(tomorrow)
    expect(window.__mg3d!.secondsOfDay()).toBeGreaterThanOrEqual(22 * 3600)
    expect(screen.getByLabelText('Set simulation time')).toHaveValue('22:00')
    // The time taken out again: the day stays, the time of day is the real one
    window.location.hash = `#lat=54.08&lon=12.13&height=3000&date=${tomorrow}`
    fireEvent(window, new HashChangeEvent('hashchange'))
    expect(window.__mg3d!.dateKey()).toBe(tomorrow)
    const diff = Math.abs(window.__mg3d!.secondsOfDay() - berlinSecondsOfDay(Date.now()))
    expect(Math.min(diff, 86400 - diff)).toBeLessThan(5)
    expect(screen.getByLabelText('Set simulation time')).toHaveValue('')
  })

  it('sets the simulated day from the calendar, two days back to a week ahead, and Now brings it back', async () => {
    render(<App />)
    const trigger = screen.getByRole('button', {
      name: 'Set simulation date (two days back to a week ahead)',
    })
    // The button opens on the day the simulation stands on – today, until
    // one is picked – in the one shape every language gets: "8. Sep 2026"
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const shortDay = (key: string) =>
      `${parseInt(key.slice(8), 10)}. ${MONTHS[parseInt(key.slice(5, 7), 10) - 1]} ${key.slice(0, 4)}`
    expect(trigger).toHaveTextContent(shortDay(berlinDateKey(Date.now())))
    fireEvent.click(trigger)
    // react-day-picker's month is a grid; its day buttons carry data-day
    const calendar = await screen.findByRole('grid')
    // The calendar's days: the two days before today – the ones the AIS
    // archive still holds – and a week from today can be picked, the rest
    // is disabled
    const today = berlinDateKey(Date.now())
    const tomorrow = berlinDateKey(Date.now() + 86_400_000)
    const twoDaysAgo = berlinDateKey(Date.now() - 2 * 86_400_000)
    const dayButtons = [...calendar.querySelectorAll<HTMLButtonElement>('button[data-day]')]
    const enabled = dayButtons.filter((b) => !b.disabled)
    expect(enabled).toHaveLength(10)
    const dayNumber = String(parseInt(tomorrow.slice(8), 10))
    const tomorrowButton = enabled.find((b) => b.textContent === dayNumber)!
    const secondsBefore = window.__mg3d!.secondsOfDay()
    fireEvent.click(tomorrowButton)
    expect(window.__mg3d!.dateKey()).toBe(tomorrow)
    // The time of day stays: only the day moved – and the day picked is
    // in the URL, the time (not typed) is not
    expect(Math.abs(window.__mg3d!.secondsOfDay() - secondsBefore)).toBeLessThan(2)
    expect(window.location.hash).toContain(`&date=${tomorrow}`)
    expect(window.location.hash).not.toContain('time=')
    // The trigger now names the day picked, and the calendar closed itself
    expect(trigger).toHaveTextContent(shortDay(tomorrow))
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    // Back into the past: the day before yesterday is the earliest offered
    fireEvent.click(trigger)
    const reopened = await screen.findByRole('grid')
    const earliest = [...reopened.querySelectorAll<HTMLButtonElement>('button[data-day]')].filter(
      (b) => !b.disabled,
    )[0]
    expect(earliest.textContent).toBe(String(parseInt(twoDaysAgo.slice(8), 10)))
    fireEvent.click(earliest)
    expect(window.__mg3d!.dateKey()).toBe(twoDaysAgo)
    expect(trigger).toHaveTextContent(shortDay(twoDaysAgo))
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    expect(window.__mg3d!.dateKey()).toBe(today)
    // … and gives the day up again with the clock, back to today, off the URL
    expect(trigger).toHaveTextContent(shortDay(today))
    expect(window.location.hash).not.toContain('date=')
  })

  it('brings a running time-lapse back to real pace along with the real time', () => {
    render(<App />)
    window.__mg3d!.setSpeed(30)
    expect(window.__mg3d!.speed()).toBe(30)
    fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    expect(window.__mg3d!.speed()).toBe(1)
    expect(screen.getByTestId('speed-value')).toHaveTextContent('×1')
  })

  it('scrolls only the line list, not the whole panel', () => {
    render(<App />)
    // The panel itself must not scroll – the clock and the layer switches
    // stay put however long the line list gets.
    const list = screen.getByTestId('line-list')
    // A scroll area of its own (Radix): the element that scrolls is its
    // viewport, and the fade the vehicle card's stop list uses sits there
    const viewport = list.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).not.toBeNull()
    expect(viewport!.className).toContain('scroll-fade-y')
    const panel = screen.getByText('Mini Rostock 3D').closest('[data-slot="card"]')!
    expect(panel.className).toContain('overflow-hidden')
    expect(panel.className).not.toContain('overflow-y-auto')
  })

  it('shows layer switches for routes and stops, behind the rail button', () => {
    render(<App />)
    // Not in the control panel any more, and not on screen until asked for
    expect(screen.queryByRole('switch', { name: 'Show routes' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }))
    expect(screen.getByRole('switch', { name: 'Show routes' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Show stops' })).toBeInTheDocument()
  })

  it('closes an open popover when H takes the interface away, and leaves it closed after', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }))
    expect(screen.getByRole('switch', { name: 'Show routes' })).toBeInTheDocument()
    // Radix portals the popover to the body, outside the wrapper H hides –
    // it has to close on its own, or it stands over a bare map
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    expect(screen.queryByRole('switch', { name: 'Show routes' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    expect(screen.queryByRole('switch', { name: 'Show routes' })).not.toBeInTheDocument()
    // And the same for a dialog going up over it
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }))
    fireEvent.keyDown(window, { key: '?' })
    expect(screen.queryByRole('switch', { name: 'Show routes' })).not.toBeInTheDocument()
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

  it('takes the interface away while a dialog is up, and gives it back', () => {
    // A dialog is something to read; the panel and the cards behind it are
    // not part of the reading. What is read stays: the dialog is portaled
    // to the body, so it is never inside the wrapper that goes away.
    render(<App />)
    expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')

    fireEvent.click(screen.getByRole('button', { name: 'About this project' }))
    const about = screen.getByRole('dialog', { name: 'Mini Germany 3D' })
    expect(screen.getByTestId('ui-overlay').className).toContain('hidden')
    expect(screen.getByTestId('ui-overlay').contains(about)).toBe(false)

    fireEvent.click(within(about).getByRole('button', { name: 'Close about dialog' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')
  })

  it('gives back what H had left, not the interface, after a dialog', () => {
    // The two hides mean different things. H is the reader's own choice and
    // has to outlive a dialog opened on top of it – otherwise looking a
    // shortcut up would undo the clear map it was looked up for.
    render(<App />)
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    expect(screen.getByTestId('ui-overlay').className).toContain('hidden')

    fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true })
    const about = screen.getByRole('dialog', { name: 'Mini Germany 3D' })
    fireEvent.click(within(about).getByRole('button', { name: 'Close about dialog' }))
    expect(screen.getByTestId('ui-overlay').className).toContain('hidden')

    // And H still works as the way back, once nothing is on top of it.
    fireEvent.keyDown(window, { key: 'h', code: 'KeyH' })
    expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')
  })

  it('pauses and plays again on Space', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Pause simulation' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    expect(screen.getByRole('button', { name: 'Resume simulation' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    expect(screen.getByRole('button', { name: 'Pause simulation' })).toBeInTheDocument()
    // A held or modified Space is somebody else's, as it is for H
    for (const event of [
      { key: ' ', code: 'Space', ctrlKey: true },
      { key: ' ', code: 'Space', metaKey: true },
      { key: ' ', code: 'Space', repeat: true },
    ]) {
      fireEvent.keyDown(window, event)
      expect(screen.getByRole('button', { name: 'Pause simulation' })).toBeInTheDocument()
    }
  })

  it('leaves Space to the button the keyboard stands on', () => {
    // Space is how a keyboard clicks a focused control; pausing instead
    // would leave the interface unusable without a mouse.
    render(<App />)
    const button = screen.getByRole('button', { name: 'Pause simulation' })
    fireEvent.keyDown(button, { key: ' ', code: 'Space' })
    expect(screen.getByRole('button', { name: 'Pause simulation' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }))
    const stopsSwitch = screen.getByRole('switch', { name: 'Show stops' })
    fireEvent.keyDown(stopsSwitch, { key: ' ', code: 'Space' })
    expect(screen.getByRole('button', { name: 'Pause simulation' })).toBeInTheDocument()
  })

  it('leaves P alone now that Space pauses', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'p', code: 'KeyP' })
    expect(screen.getByRole('button', { name: 'Pause simulation' })).toBeInTheDocument()
    expect(screen.getByTestId('ui-overlay').className).not.toContain('hidden')
  })

  it('goes under the city on U and back up on S', () => {
    // The third reading, the diagram, is a morph with a camera flight in
    // front of it and belongs to the E2E suite (e2e/linear-view.spec.ts).
    render(<App />)
    // The readings are one choice of three – a radio group, not tabs
    // (a tab controls a panel these never had; see ui/segmented-control.tsx)
    const reading = (name: string) =>
      within(screen.getByRole('radiogroup', { name: 'View' })).getByRole('radio', { name })
    expect(reading('Surface')).toHaveAttribute('aria-checked', 'true')
    expect(reading('Surface')).not.toHaveAttribute('aria-controls')
    fireEvent.keyDown(window, { key: 'u', code: 'KeyU' })
    expect(reading('Underground')).toHaveAttribute('aria-checked', 'true')
    expect(reading('Surface')).toHaveAttribute('aria-checked', 'false')
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    expect(reading('Surface')).toHaveAttribute('aria-checked', 'true')
    // Upper case counts too, for whoever has caps lock on
    fireEvent.keyDown(window, { key: 'U', code: 'KeyU' })
    expect(reading('Underground')).toHaveAttribute('aria-checked', 'true')
    // Pressing the chosen reading again leaves it chosen – there is always one
    fireEvent.click(reading('Underground'))
    expect(reading('Underground')).toHaveAttribute('aria-checked', 'true')
  })

  it('tells what the map is, and is not, on the button below the controls', async () => {
    render(<App />)
    const button = screen.getByRole('button', { name: 'About this project' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    button.focus()
    fireEvent.click(button)
    const about = screen.getByRole('dialog', { name: 'Mini Germany 3D' })
    // The project story opens first; details and shortcuts have their own tabs.
    expect(about).toHaveTextContent('mini-tokyo-3d')
    expect(about).toHaveTextContent('legible-cities')
    // The project comes first on that tab, the person behind it after it
    const text = about.textContent ?? ''
    expect(text.indexOf('The city, seen from above.')).toBeGreaterThan(-1)
    expect(text.indexOf('Hi, I’m Mario')).toBeGreaterThan(text.indexOf('The city, seen from above.'))
    // The two ancestors are linked, and the links leave the page safely
    const link = within(about).getByRole('link', { name: 'legible-cities' })
    expect(link).toHaveAttribute('href', 'https://richc117.github.io/legible-cities/')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    fireEvent.mouseDown(within(about).getByRole('tab', { name: 'Good to know' }), { button: 0, ctrlKey: false })
    expect(about).toHaveTextContent('Their positions are calculated')
    fireEvent.mouseDown(within(about).getByRole('tab', { name: 'Keyboard' }), { button: 0, ctrlKey: false })
    expect(about).toHaveTextContent('Pause and play')
    expect(about).toHaveTextContent('Space')
    // A dialog, not a card wearing the word: while it is up the map and
    // its controls are hidden from a screen reader entirely.
    expect(screen.queryByRole('button', { name: 'About this project' })).not.toBeInTheDocument()
    fireEvent.click(within(about).getByRole('button', { name: 'Close about dialog' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(button).toHaveFocus())
    expect(screen.getByRole('button', { name: 'About this project' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('opens the same dialog on ? and takes it away again', () => {
    render(<App />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true })
    expect(screen.getByRole('dialog', { name: 'Mini Germany 3D' })).toHaveTextContent('The city, seen from above.')
    // ? again puts it away …
    fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // … and so does Escape, which the dialog handles itself (the key
    // travels from whatever inside it has the focus)
    fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('steps the time-lapse on + and −', () => {
    render(<App />)
    expect(screen.getByTestId('speed-value')).toHaveTextContent('×1')
    fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true })
    expect(screen.getByTestId('speed-value')).toHaveTextContent('×2')
    fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true })
    expect(screen.getByTestId('speed-value')).toHaveTextContent('×5')
    fireEvent.keyDown(window, { key: '-', code: 'Minus' })
    expect(screen.getByTestId('speed-value')).toHaveTextContent('×2')
    // The bottom and the top are where it stops
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: '-', code: 'Minus' })
    expect(screen.getByTestId('speed-value')).toHaveTextContent('×1')
    for (let i = 0; i < 12; i++) fireEvent.keyDown(window, { key: '=', code: 'Equal' })
    expect(screen.getByTestId('speed-value')).toHaveTextContent('×120')
  })

  it('flattens the view on 2 and tips it back on 3', async () => {
    render(<App />)
    await waitFor(() => expect(window.__mg3d?.ready).toBe(true))
    expect(screen.getByRole('button', { name: 'Switch to 2D view' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '2', code: 'Digit2' })
    expect(screen.getByRole('button', { name: 'Switch to 3D view' })).toBeInTheDocument()
    // The digit says which view to be in: a second 2 leaves it flat
    fireEvent.keyDown(window, { key: '2', code: 'Digit2' })
    expect(screen.getByRole('button', { name: 'Switch to 3D view' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '3', code: 'Digit3' })
    expect(screen.getByRole('button', { name: 'Switch to 2D view' })).toBeInTheDocument()
  })

  it('turns the view on C and switches the lens on M', () => {
    render(<App />)
    const turns = mockCamera.orientations
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC' })
    expect(mockCamera.orientations).toBe(turns + 1)
    expect(mockCamera.tiltShift).toBe(false)
    fireEvent.keyDown(window, { key: 'm', code: 'KeyM' })
    expect(mockCamera.tiltShift).toBe(true)
    fireEvent.keyDown(window, { key: 'm', code: 'KeyM' })
    expect(mockCamera.tiltShift).toBe(false)
  })

  it('puts the camera back on the city on R', () => {
    render(<App />)
    const before = mockCameraHomeCalls.count
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR' })
    expect(mockCameraHomeCalls.count).toBe(before + 1)
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
    fireEvent.click(screen.getByRole('button', { name: 'Ebenen' }))
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
