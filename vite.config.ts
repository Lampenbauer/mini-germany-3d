/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { extractGtfsDelays } from './src/lib/rt-extract'
import { aisStateVessels, mergeAisMessage, type AisState } from './src/lib/ais-extract'

const UPSTREAM_RT_URL = 'https://realtime.gtfs.de/realtime-free.pb'
const RT_CACHE_TTL_MS = 60_000
const scheduleJsonPath = fileURLToPath(new URL('./src/data/schedule.json', import.meta.url))

/** All Rostock GTFS trip_ids from schedule.json. */
function loadTripIds(): Set<string> {
  const schedule = JSON.parse(readFileSync(scheduleJsonPath, 'utf8')) as {
    lines?: Record<string, Record<string, { tripIds?: string[] }>>
  }
  const ids = new Set<string>()
  for (const dirs of Object.values(schedule.lines ?? {})) {
    for (const dir of Object.values(dirs)) {
      for (const id of dir.tripIds ?? []) ids.add(id)
    }
  }
  return ids
}

/**
 * Dev/preview middleware for /api/realtime: fetches the >10 MB Germany feed
 * at most once per minute, filters it server-side down to the Rostock
 * trip_ids, and delivers only a small JSON to the browser. In production,
 * api/realtime.php performs exactly the same job (see server/api/).
 */
function gtfsRealtimeFilterPlugin(): Plugin {
  let cache: { at: number; body: string } | null = null
  let refreshing: Promise<void> | null = null

  const refresh = async (): Promise<void> => {
    const response = await fetch(UPSTREAM_RT_URL, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`)
    const buffer = new Uint8Array(await response.arrayBuffer())
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer)
    const delays = extractGtfsDelays(feed, loadTripIds())
    cache = {
      at: Date.now(),
      body: JSON.stringify({
        timestamp: Number(feed.header?.timestamp ?? 0),
        total: feed.entity?.length ?? 0,
        delays,
      }),
    }
  }

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    if (!req.url || !req.url.startsWith('/api/realtime')) {
      next()
      return
    }
    try {
      if (!cache || Date.now() - cache.at > RT_CACHE_TTL_MS) {
        // Requests arriving in parallel share a single upstream fetch
        refreshing ??= refresh().finally(() => {
          refreshing = null
        })
        await refreshing
      }
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(cache!.body)
    } catch (error) {
      // Stale data is better than none
      if (cache) {
        res.setHeader('Content-Type', 'application/json')
        res.end(cache.body)
        return
      }
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: String(error) }))
    }
  }

  return {
    name: 'gtfs-realtime-filter',
    configureServer(server) {
      server.middlewares.use(handle)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle)
    },
  }
}

/**
 * Dev/preview middleware for /api/ais: holds ONE aisstream.io WebSocket
 * open (started lazily on the first request, reconnecting on drops) and
 * serves the merged vessel state as JSON. In production api/ais.php does
 * the same job with short listen windows instead of a permanent socket –
 * shared hosting cannot keep one. Extraction logic is shared via
 * src/lib/ais-extract.ts and pinned by tests/ais-parity.test.ts.
 *
 * Needs AISSTREAM_KEY (env or .env, not VITE_-prefixed – the key must
 * never reach the client bundle). Without it the endpoint answers 503 and
 * the app runs without the vessel layer, like offline mode does.
 */
function aisLivePlugin(): Plugin {
  const state: AisState = new Map()
  let apiKey = process.env.AISSTREAM_KEY ?? ''
  let started = false

  const connect = (): void => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream')
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ APIKey: apiKey, BoundingBoxes: [[[53.83, 11.64], [54.43, 12.61]]] }),
      )
    }
    ws.onmessage = async (event) => {
      const text = typeof event.data === 'string' ? event.data : await (event.data as Blob).text()
      try {
        mergeAisMessage(state, JSON.parse(text), Date.now())
      } catch {
        // one malformed message must not kill the stream
      }
    }
    // Covers errors too – an errored socket closes right after.
    ws.onclose = () => setTimeout(connect, 10_000)
  }

  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!req.url || !req.url.startsWith('/api/ais')) {
      next()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    if (!apiKey) {
      res.statusCode = 503
      res.end(JSON.stringify({ error: 'AISSTREAM_KEY is not set - vessel layer disabled' }))
      return
    }
    if (!started) {
      started = true
      connect()
    }
    res.end(JSON.stringify({ timestamp: Date.now(), vessels: aisStateVessels(state, Date.now()) }))
  }

  return {
    name: 'ais-live',
    configResolved(config) {
      // .env values (unprefixed ones included) are not in process.env –
      // loadEnv picks them up without exposing them to the client.
      apiKey ||= loadEnv(config.mode, config.root, '').AISSTREAM_KEY ?? ''
    },
    configureServer(server) {
      server.middlewares.use(handle)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), gtfsRealtimeFilterPlugin(), aisLivePlugin()],
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
    __BUILD_ID__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        // Cesium (~3.5 MB) and the network/schedule data change on different
        // cadences than the app code – separate chunks keep them cacheable
        // across deploys and let the browser download them in parallel.
        manualChunks(id: string) {
          // The `cesium` package is a re-export shell – the code lives in
          // the @cesium/engine and @cesium/widgets packages.
          if (id.includes('node_modules/cesium/') || id.includes('node_modules/@cesium/')) {
            return 'cesium'
          }
          if (id.includes('src/data/') && id.endsWith('.json')) return 'data'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
})
