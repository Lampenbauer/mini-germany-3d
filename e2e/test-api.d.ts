export {}

declare global {
  interface Window {
    __mrt?: {
      ready: boolean
      tramCount: () => number
      visibleTramCount: () => number
      trams: () => {
        id: string
        lineId: string
        nextStopName: string
        lat: number
        lon: number
      }[]
      setTime: (hhmm: string) => void
      setSpeed: (speed: number) => void
      setPaused: (paused: boolean) => void
      selectTram: (id: string | null) => void
      dataSource: string
      lineIds: () => string[]
      secondsOfDay: () => number
      loopTicks: () => number
      lastLoopError: () => string | null
      tramBoxDriftMeters: () => number
    }
    __cesiumViewer?: {
      camera: {
        positionCartographic: { longitude: number; latitude: number; height: number }
      }
    }
  }
}
