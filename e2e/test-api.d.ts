export {}

declare global {
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
    __cesiumViewer?: {
      camera: {
        positionCartographic: { longitude: number; latitude: number; height: number }
      }
      clock: { currentTime: unknown }
      entities: {
        values: {
          id: string
          polyline?: {
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
