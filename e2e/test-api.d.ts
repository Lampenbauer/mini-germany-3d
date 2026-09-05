

declare global {
  /** One frame as the linear-view probe sees it (see linear-view.spec.ts). */
  interface LinearProbeFrame {
    drawnByMap: number
    drawnByDiagram: number
    diagramShown: boolean
  }

  interface Window {
    /** Test hook of raf-stall.spec.ts: freezes requestAnimationFrame. */
    __stopRaf?: boolean
    __mrt?: {
      ready: boolean
      vehicleCount: () => number
      visibleVehicleCount: () => number
      vehicles: () => {
        id: string
        lineId: string
        nextStopName: string
        lat: number
        lon: number
        inTunnel: boolean
      }[]
      setTime: (hhmm: string) => void
      setSpeed: (speed: number) => void
      setPaused: (paused: boolean) => void
      setRealtimeDelays: (delays: Record<string, number>) => void
      /** Slug of the city on the map, and the picker's way to another one. */
      city: () => string
      setCity: (slug: string) => void
      /** Whether the lines are drawn pulled straight instead of on the map. */
      linear: () => boolean
      setLinear: (linear: boolean) => void
      setRain: (precipitationMm: number) => void
      setCloudCover: (cloudCoverPercent: number) => void
      rainDropsVisible: () => number
      selectVehicle: (id: string | null) => void
      selectedVehicleId: () => string | null
      selectStop: (id: string | null) => void
      selectedStopId: () => string | null
      vehicleScreenPosition: (id: string) => { x: number; y: number } | null
      stopScreenPosition: (id: string) => { x: number; y: number } | null
      dataSource: string
      /** Which basemap the map ended up on ('offline' with ?offline=1). */
      tilesetStatus: () => 'loading' | 'google-3d-tiles' | 'offline' | 'failed'
      /** GTFS-RT feed state and matched trips (null = disabled). */
      realtimeStatus: () => { state: string; matchedCount: number } | null
      lineIds: () => string[]
      secondsOfDay: () => number
      loopTicks: () => number
      lastLoopError: () => string | null
      vehicleBoxDriftMeters: () => number
      vehicleOpacity: (id: string) => number | null
      renderRate: () => number
      anyVehicleInView: () => boolean
      streetLamps: () => { drawn: number; alpha: number }
      /** The miniature effect: on, how much the pose carries, passes compiled. */
      tiltShiftState: () => { enabled: boolean; strength: number; ready: boolean }
      renderPacing: () => {
        animating: boolean
        rainActive: boolean
        vehicleInView: boolean
        interacting: boolean
        tilesLoading: boolean
        intervalMs: number
      }
      tunnelTransition: () => {
        id: string
        tunnelTime: number
        surfaceTime: number
      } | null
    }
    /** Per-frame samples a spec collects from inside the page (linear-view.spec.ts). */
    __linearProbe?: LinearProbeFrame[]
    __cesiumViewer?: {
      /** One frame, drawn synchronously – see frameDetail in app.spec.ts. */
      render: () => void
      canvas: HTMLCanvasElement
      camera: {
        positionCartographic: { longitude: number; latitude: number; height: number }
        /** Where the camera looks, in radians clockwise from north. */
        heading: number
        /** How far it looks down, in radians (0 = horizon, -π/2 = straight down). */
        pitch: number
        /** The ground rectangle currently in view, in radians. */
        computeViewRectangle: () =>
          | { west: number; south: number; east: number; north: number }
          | undefined
      }
      clock: { currentTime: unknown }
      scene: {
        /**
         * Ground-clamped geometry: the entity visualizers keep an (often
         * empty) collection of their own in here, so what counts is the
         * primitives inside those, not the top-level length.
         */
        groundPrimitives: { length: number; get: (index: number) => object }
      }
      entities: {
        values: {
          id: string
          /** Whether the entity is drawn at all. */
          show: boolean
          polyline?: {
            clampToGround?: { getValue: (time: unknown) => boolean | undefined }
            material?: {
              color?: {
                getValue: (time: unknown) => { alpha: number } | undefined
              }
            }
          }
        }[]
      }
    }
  }
}

export {}
