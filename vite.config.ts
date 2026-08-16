/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import { defineConfig, type Plugin } from 'vite'
import { extractGtfsDelays } from './src/lib/rt-extract'

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

export default defineConfig({
  plugins: [react(), tailwindcss(), gtfsRealtimeFilterPlugin()],
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
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
})
