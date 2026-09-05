/**
 * Live webcams client: polls /api/webcams?city=<slug> – the dev
 * middleware in vite.config.ts, api/webcams.php in production, both
 * asking Windy's Webcams API with the key that never reaches the browser
 * – and hands the map the cameras of the city (see map/WebcamsLayer.ts).
 * Polled every ten minutes: that is how often the cameras send a new
 * picture, and how long a picture URL is good for on the free tier.
 */

import type { Webcam, WebcamsApiResponse } from './webcams-extract'

export type { Webcam } from './webcams-extract'

export interface WebcamsStatus {
  state: 'connecting' | 'live' | 'error'
  webcamCount: number
  lastSuccessAt: number | null
  lastError: string | null
}

export type WebcamsUpdateHandler = (status: WebcamsStatus, webcams: Webcam[]) => void

export class WebcamsClient {
  private timer: number | null = null
  private stopped = false
  private status: WebcamsStatus = {
    state: 'connecting',
    webcamCount: 0,
    lastSuccessAt: null,
    lastError: null,
  }

  constructor(
    private readonly url: string,
    private readonly onUpdate: WebcamsUpdateHandler,
  ) {}

  start(intervalMs = 600_000): void {
    this.stopped = false
    const tick = async () => {
      if (this.stopped) return
      await this.poll()
      if (!this.stopped) {
        this.timer = window.setTimeout(tick, intervalMs)
      }
    }
    void tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetch(this.url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as WebcamsApiResponse
      if (typeof data !== 'object' || data === null || !Array.isArray(data.webcams)) {
        throw new Error('Unexpected response format from the webcams endpoint')
      }
      this.status = {
        state: 'live',
        webcamCount: data.webcams.length,
        lastSuccessAt: Date.now(),
        lastError: null,
      }
      if (!this.stopped) this.onUpdate(this.status, data.webcams)
    } catch (error) {
      // The pictures already on the map stay – a failed poll is not a
      // reason to take a city's cameras down.
      this.status = {
        ...this.status,
        state: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      }
      if (!this.stopped) this.onUpdate(this.status, [])
    }
  }
}
