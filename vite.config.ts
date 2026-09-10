/// <reference types="vitest/config" />
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import {
  createServer,
  createServerModuleRunner,
  defineConfig,
  loadEnv,
  type DevEnvironment,
  type Plugin,
} from 'vite'
import { extractGtfsDelays } from './src/lib/rt-extract'
import { aisStateVessels, mergeAisMessage, type AisState } from './src/lib/ais-extract'
import { containsLonLat } from './src/lib/city'
import { extractWebcams, windyNearby } from './src/lib/webcams-extract'
import { CITIES, DEFAULT_CITY_SLUG, cityBySlug } from './src/cities/definitions'

const UPSTREAM_RT_URL = 'https://realtime.gtfs.de/realtime-free.pb'
const RT_CACHE_TTL_MS = 60_000

/** The city a request asks for (?city=<slug>), or null for an unknown slug. */
function requestedCity(url: string) {
  const slug = new URL(url, 'http://localhost').searchParams.get('city') ?? DEFAULT_CITY_SLUG
  return cityBySlug(slug) ?? null
}

/** All GTFS trip_ids of a city's schedule.json. */
function loadTripIds(slug: string): Set<string> {
  const schedulePath = fileURLToPath(new URL(`./src/cities/${slug}/schedule.json`, import.meta.url))
  const ids = new Set<string>()
  let schedule: { lines?: Record<string, Record<string, { tripIds?: string[] }>> }
  try {
    schedule = JSON.parse(readFileSync(schedulePath, 'utf8'))
  } catch {
    // A city without a schedule has no trips to match – an empty filter
    return ids
  }
  for (const dirs of Object.values(schedule.lines ?? {})) {
    for (const dir of Object.values(dirs)) {
      for (const id of dir.tripIds ?? []) ids.add(id)
    }
  }
  return ids
}

/**
 * Dev/preview middleware for /api/realtime: fetches the >10 MB Germany feed
 * at most once per minute, filters it server-side down to the trip_ids of
 * the city asked for (?city=<slug>), and delivers only a small JSON to the
 * browser – one upstream fetch serves every city. In production,
 * api/realtime.php performs exactly the same job (see server/api/).
 */
function gtfsRealtimeFilterPlugin(): Plugin {
  let feed: { at: number; message: GtfsRealtimeBindings.transit_realtime.FeedMessage } | null =
    null
  let refreshing: Promise<void> | null = null
  const cache = new Map<string, { at: number; body: string }>()

  const refresh = async (): Promise<void> => {
    const response = await fetch(UPSTREAM_RT_URL, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`)
    const buffer = new Uint8Array(await response.arrayBuffer())
    feed = {
      at: Date.now(),
      message: GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer),
    }
    cache.clear()
  }

  const bodyFor = (slug: string): string => {
    const cached = cache.get(slug)
    if (cached && feed && cached.at === feed.at) return cached.body
    const message = feed!.message
    const body = JSON.stringify({
      timestamp: Number(message.header?.timestamp ?? 0),
      total: message.entity?.length ?? 0,
      delays: extractGtfsDelays(message, loadTripIds(slug)),
    })
    cache.set(slug, { at: feed!.at, body })
    return body
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
    const city = requestedCity(req.url)
    if (!city) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Unknown city' }))
      return
    }
    try {
      if (!feed || Date.now() - feed.at > RT_CACHE_TTL_MS) {
        // Requests arriving in parallel share a single upstream fetch
        refreshing ??= refresh().finally(() => {
          refreshing = null
        })
        await refreshing
      }
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(bodyFor(city.slug))
    } catch (error) {
      // Stale data is better than none
      if (feed) {
        res.setHeader('Content-Type', 'application/json')
        res.end(bodyFor(city.slug))
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
 * open (started lazily on the first request, reconnecting on drops),
 * subscribed to every city's bounding box at once – aisstream allows
 * three connections per account, so one per city would not scale – and
 * serves the merged vessel state as JSON, filtered to the box of the
 * city asked for (?city=<slug>). In production api/ais.php does the same
 * job with short listen windows instead of a permanent socket – shared
 * hosting cannot keep one. Extraction logic is shared via
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
      // aisstream takes [[lat, lon] SW, [lat, lon] NE] per box; api/ais.php
      // reads the same city.json files (scripts/test-ais-parity.mjs checks
      // that both subscribe alike).
      ws.send(
        JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: CITIES.filter((city) => city.ais.enabled).map(({ boundingBox }) => [
            [boundingBox.south, boundingBox.west],
            [boundingBox.north, boundingBox.east],
          ]),
        }),
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
    const city = requestedCity(req.url)
    if (!city) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'Unknown city' }))
      return
    }
    if (!apiKey) {
      res.statusCode = 503
      res.end(JSON.stringify({ error: 'AISSTREAM_KEY is not set - vessel layer disabled' }))
      return
    }
    if (!started) {
      started = true
      connect()
    }
    const now = Date.now()
    const box = city.boundingBox
    const vessels = aisStateVessels(state, now).filter((v) => containsLonLat(box, v.lon, v.lat))
    res.end(JSON.stringify({ timestamp: now, servedAt: now, vessels }))
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

/**
 * Dev/preview middleware for /api/webcams: asks Windy's Webcams API for
 * the cameras around the city asked for (?city=<slug>) and answers the
 * ones inside its box, cached for ten minutes – the cameras refresh at
 * that rate. In production api/webcams.php does the same job; the
 * extraction is shared via src/lib/webcams-extract.ts.
 *
 * Needs WINDY_KEY (env or .env, not VITE_-prefixed – the key must never
 * reach the client bundle). Without it the endpoint answers 503 and the
 * app runs without webcams.
 */
function webcamsPlugin(): Plugin {
  const WINDY_URL = 'https://api.windy.com/webcams/api/v3/webcams'
  const CACHE_TTL_MS = 600_000
  const PAGE_SIZE = 50
  const MAX_CAMERAS = 200
  let apiKey = process.env.WINDY_KEY ?? ''
  const cache = new Map<string, { at: number; body: string }>()

  const fetchCity = async (slug: string): Promise<string> => {
    const city = cityBySlug(slug)!
    const { lat, lon, radiusKm } = windyNearby(city.boundingBox)
    const pages: unknown[] = []
    let offset = 0
    let total = Number.POSITIVE_INFINITY
    while (offset < total && offset < MAX_CAMERAS) {
      const url =
        `${WINDY_URL}?nearby=${lat},${lon},${radiusKm}&limit=${PAGE_SIZE}&offset=${offset}` +
        '&include=images,location,urls'
      const response = await fetch(url, { headers: { 'x-windy-api-key': apiKey } })
      if (!response.ok) throw new Error(`Windy answered HTTP ${response.status}`)
      const data = (await response.json()) as { total?: number; webcams?: unknown[] }
      const page = Array.isArray(data.webcams) ? data.webcams : []
      pages.push(...page)
      total = typeof data.total === 'number' ? data.total : pages.length
      if (page.length === 0) break
      offset += PAGE_SIZE
    }
    const webcams = extractWebcams({ webcams: pages }, city.boundingBox, city.webcams.exclude)
    return JSON.stringify({ servedAt: Date.now(), webcams })
  }

  const handle = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!req.url || !req.url.startsWith('/api/webcams')) {
      next()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    const city = requestedCity(req.url)
    if (!city) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'Unknown city' }))
      return
    }
    if (!apiKey) {
      res.statusCode = 503
      res.end(JSON.stringify({ error: 'WINDY_KEY is not set - webcams disabled' }))
      return
    }
    const cached = cache.get(city.slug)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      res.end(cached.body)
      return
    }
    fetchCity(city.slug)
      .then((body) => {
        cache.set(city.slug, { at: Date.now(), body })
        res.end(body)
      })
      .catch((error: unknown) => {
        // Stale beats nothing: the last answer stays good for the pictures
        if (cached) {
          res.end(cached.body)
          return
        }
        res.statusCode = 502
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
  }

  return {
    name: 'webcams',
    configResolved(config) {
      apiKey ||= loadEnv(config.mode, config.root, '').WINDY_KEY ?? ''
    },
    configureServer(server) {
      server.middlewares.use(handle)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle)
    },
  }
}

/** A page as src/lib/site-pages.ts describes it – what the plugin needs of it. */
interface StaticPage {
  /** Where it is served: `/`, `/en/`, `/kiel/`, `/en/kiel/`. */
  path: string
}

/**
 * What src/lib/site-pages.ts exports, as far as the plugin uses it.
 * Typed here rather than imported: that module speaks the app's `@/`
 * aliases and loads the cities the way the app does, which the config's
 * own tsconfig does not resolve – so it runs through Vite's module
 * runner, where the aliases hold.
 */
interface SitePagesModule {
  allPages(): Promise<StaticPage[]>
  pageFor(pathname: string): Promise<StaticPage | null>
  applyPage(html: string, page: StaticPage): string
  sitemap(pages: readonly StaticPage[]): string
}

/**
 * The pages under the map: after the build, an index.html per city and
 * language – `/berlin/`, `/en/berlin/`, and the front door at `/` and
 * `/en/` – each the built index.html with the page's title, description
 * and link previews in its head and the city as plain HTML under the
 * app's root (see src/lib/site-pages.ts for what, src/lib/site-path.ts
 * for where), plus the sitemap. In dev the same page goes into the
 * index.html served for the path, so what a crawler would see is a
 * reload away.
 *
 * Both run src/lib/site-pages.ts through Vite's module runner – the dev
 * server's own SSR environment, or one made for the build's last step
 * and closed after it. Measured 2026-09-10: every city's data loaded and
 * profiled in under a second, ~200 MB of heap.
 */
function prerenderPlugin(): Plugin {
  let root = ''
  let outDir = ''
  let isBuild = false
  let devPages: Promise<SitePagesModule> | null = null

  const load = (environment: DevEnvironment): Promise<SitePagesModule> =>
    createServerModuleRunner(environment).import('/src/lib/site-pages.ts') as Promise<SitePagesModule>

  return {
    name: 'prerender',
    configResolved(config) {
      root = config.root
      outDir = resolve(config.root, config.build.outDir)
      isBuild = config.command === 'build'
    },
    configureServer(server) {
      devPages = load(server.environments.ssr)
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        // The build's pages are written in closeBundle, from the built file
        if (!ctx.server || !devPages) return html
        const pages = await devPages
        const page = await pages.pageFor(new URL(ctx.originalUrl ?? '/', 'http://localhost').pathname)
        return page ? pages.applyPage(html, page) : html
      },
    },
    async closeBundle() {
      if (!isBuild) return
      // No config file: the app's plugins have nothing to do here, and
      // the alias is all the module graph needs.
      const server = await createServer({
        root,
        configFile: false,
        appType: 'custom',
        logLevel: 'error',
        resolve: { alias: { '@': join(root, 'src') } },
        server: { middlewareMode: true, hmr: false, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
      })
      try {
        const pages = await load(server.environments.ssr)
        const html = readFileSync(join(outDir, 'index.html'), 'utf8')
        const all = await pages.allPages()
        for (const page of all) {
          mkdirSync(join(outDir, page.path), { recursive: true })
          writeFileSync(join(outDir, page.path, 'index.html'), pages.applyPage(html, page))
        }
        writeFileSync(join(outDir, 'sitemap.xml'), pages.sitemap(all))
        console.info(`prerendered ${all.length} pages and the sitemap into ${outDir}`)
      } finally {
        await server.close()
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    gtfsRealtimeFilterPlugin(),
    aisLivePlugin(),
    webcamsPlugin(),
    prerenderPlugin(),
  ],
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
        // Cesium (~3.5 MB) and each city's data change on different
        // cadences than the app code – separate chunks keep them cacheable
        // across deploys and let the browser download them in parallel.
        manualChunks(id: string) {
          // The `cesium` package is a re-export shell – the code lives in
          // the @cesium/engine and @cesium/widgets packages.
          if (id.includes('node_modules/cesium/') || id.includes('node_modules/@cesium/')) {
            return 'cesium'
          }
          // One lazy chunk per city for its generated data. Not city.json:
          // the definitions are imported eagerly by the registry, and
          // putting them in here would drag every city's data along.
          const city = id.match(/src\/cities\/([^/]+)\/(network|schedule|street-lamps)\.json$/)
          if (city) return `city-${city[1]}`
        },
      },
    },
  },
  test: {
    // Node by default: only the component tests need a DOM, and jsdom
    // costs ~0.7 s per file on the CI runner – 62 s of a 217 s run when
    // every one of the 85 files got one. A test that renders declares
    // `// @vitest-environment jsdom` in its first line.
    environment: 'node',
    // The repo is private, and GitHub's standard runner for private repos
    // has 2 vCPUs; Vitest 4 keeps one for its main thread and runs the
    // files on the other, one after another (default: cpus − 1). The main
    // thread mostly waits, so two workers are the better use of the two
    // cores there. Locally the default (all cores but one) stands.
    maxWorkers: process.env.CI ? 2 : undefined,
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
})
