#!/usr/bin/env node
// What a frame of the map costs, measured the way PROJECT-PLAN-DECISIONS.md
// describes it ("How to actually measure a frame"): headed Chromium on the
// real GPU, the city booted paused at a whole second, the tiles converged –
// the tileset's status google-3d-tiles, `tilesLoaded` and more than fifty
// tiles with content, held for two seconds, no route batch building, no
// tileset swap – and then frames rendered one by one with `viewer.render()`
// inside EXT_disjoint_timer_query_webgl2 queries. Every investigation used to
// rebuild this from the prose, and its traps cost work; they are handled here:
//
// - boot flags go into the query, before the `#`: `&offline=1` appended after
//   a pose hash went into the hash once, and a table was labelled offline
//   that had been measured on the loading tiles;
// - a copy of an older commit (--compare) gets `public/cesium` and the `.env`
//   tokens symlinked beside its dependencies – without the first its dev
//   server answers Cesium's workers with index.html and the copy measures a
//   different map (a Phase 6 baseline was thrown away for it), without the
//   second it falls back to the wireframe globe;
// - the clock is set to a whole second and paused: `?time=12:00` does not
//   start on the millisecond, and two builds once differed by eight vehicles;
// - the subjects are interleaved over rounds, the order reversed each round:
//   sixty frames of one scene varied between runs of the same build by more
//   than the change being measured.
//
// The live layers (ships, aircraft, weather, realtime delays, webcams) are off
// unless --live, so that two runs see the same scene.
//
// Usage: node .claude/skills/measure/measure.mjs --help

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'

const REPO = resolve(import.meta.dirname, '../../..')
const VITE = join(REPO, 'node_modules/vite/bin/vite.js')
/** The config a --compare copy's dev server starts with (written by makeCopy). */
const COPY_CONFIG = 'measure.vite.config.mjs'
const QUIET_FLAGS = 'rt=0&rain=0&webcams=0&ais=0&aircraft=0'
const flag = (value) => value === '1' || value === 'true'
/** What a variant may set, and how its value reads. */
const SETTINGS = {
  msaa: Number,
  shadows: flag,
  shadowSize: Number,
  resolutionScale: Number,
  tiltShift: flag,
  atmosphere: flag,
  fxaa: flag,
}

const HELP = `Measures what a frame of the map costs, or checks that the tile shader compiles.

  node .claude/skills/measure/measure.mjs [frame|shader] [options]

frame (default)  GPU time (timer queries), CPU time in viewer.render(), draw calls executed,
                 commands collected, per subject; rounds interleave the subjects.
shader           Boots online, waits for Google's tiles with content, and fails on a loop
                 error, a render exception or a shader error in the console – the check
                 TIME_OF_DAY_SHADER needs, since offline runs and the e2e suite never compile it.

  --city <slug>        city to boot (default rostock)
  --hash <hash>        the URL hash: a pose (lat=…&lon=…&height=…&heading=…&pitch=…),
                       layer switches (routes=0&stops=0&labels=0) – default: the home view
  --time <HH:MM[:SS]>  simulated time, set to the whole second and paused (default 12:00)
  --query <a=b&…>      further boot flags: tier=mobile, sse=8, lamps=0, seamarks=0 …
  --live               keep the live layers (ships, aircraft, weather, delays, webcams)
  --offline            wireframe globe, no Google tiles – not the real map's cost
  --frames <n>         frames measured per subject and round (default 60)
  --rounds <n>         rounds (default 1, or 4 with --variants or --compare)
  --warmup <n>         frames rendered and dropped after switching subject (default 5)
  --variants <list>    runtime settings compared on one page, comma within a variant,
                       semicolon between: "msaa=1;msaa=2", "shadows=0;shadows=1",
                       "shadowSize=2048", "resolutionScale=0.5", "tiltShift=1",
                       "atmosphere=0", "fxaa=1"
  --compare <rev>      also measure <rev> (commit, tag, branch): a git archive copy in a temp
                       dir with its own dev server, interleaved with the working tree
  --url <base>         measure an already running server instead of starting one
  --port <n>           port of the dev server started (default 5188; a copy takes the next)
  --size <WxH>         CSS viewport (default 1600x1000)
  --dpr <n>            device pixel ratio (default 2)
  --headless           headless – SwiftShader on most machines, frame costs mean nothing there
  --channel <name>     a browser installed on the machine (chrome, msedge) instead of
                       Playwright's Chromium (npx playwright install chromium)
  --settle <s>         how long the tiles must hold still before measuring (default 2)
  --timeout <s>        how long to wait for the tiles (default 180)
  --json <file>        every sample, as JSON`

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    city: { type: 'string', default: 'rostock' },
    hash: { type: 'string', default: '' },
    time: { type: 'string', default: '12:00' },
    query: { type: 'string', default: '' },
    live: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
    frames: { type: 'string', default: '60' },
    rounds: { type: 'string' },
    warmup: { type: 'string', default: '5' },
    variants: { type: 'string', default: '' },
    compare: { type: 'string' },
    url: { type: 'string' },
    port: { type: 'string', default: '5188' },
    size: { type: 'string', default: '1600x1000' },
    dpr: { type: 'string', default: '2' },
    headless: { type: 'boolean', default: false },
    channel: { type: 'string' },
    settle: { type: 'string', default: '2' },
    timeout: { type: 'string', default: '180' },
    json: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const note = (message) => process.stderr.write(`${message}\n`)
const firstLine = (text) => String(text).split('\n')[0].slice(0, 300)

function quantile(sorted, q) {
  if (sorted.length === 0) return Number.NaN
  const at = (sorted.length - 1) * q
  const below = Math.floor(at)
  const above = Math.ceil(at)
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below)
}

function summary(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  return {
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    n: sorted.length,
  }
}

function parseVariants(text) {
  if (!text.trim()) return [{}]
  return text.split(';').map((part) => {
    const variant = {}
    for (const pair of part.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [key, value] = pair.split('=')
      if (!(key in SETTINGS) || value === undefined) {
        throw new Error(`unknown setting "${pair}" – one of ${Object.keys(SETTINGS).join(', ')}`)
      }
      variant[key] = SETTINGS[key](value)
    }
    return variant
  })
}

function variantLabel(variant) {
  const parts = Object.entries(variant).map(
    ([key, value]) => `${key}=${typeof value === 'boolean' ? Number(value) : value}`,
  )
  return parts.join(',')
}

/** The address a build boots from: the flags in the query, the pose in the hash. */
function bootUrl(base, offline) {
  const query = ['welcome=0', 'paused=1', `time=${opts.time.split(':').slice(0, 2).join(':')}`]
  if (offline) query.push('offline=1')
  if (!opts.live) query.push(QUIET_FLAGS)
  if (opts.query) query.push(opts.query.replace(/^[?&]/, ''))
  const hash = opts.hash.replace(/^#/, '')
  return `${base}/${opts.city}/?${query.join('&')}${hash ? `#${hash}` : ''}`
}

const children = []
const copies = []

async function startServer(cwd, port, config) {
  const args = [VITE, '--port', String(port), '--strictPort']
  if (config) args.push('--config', config)
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let log = ''
  const keep = (chunk) => {
    log = (log + chunk).slice(-4000)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  const base = `http://localhost:${port}`
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the dev server in ${cwd} stopped:\n${log}`)
    try {
      const response = await fetch(`${base}/`)
      if (response.ok) return base
    } catch {
      // not listening yet
    }
    await sleep(500)
  }
  throw new Error(`the dev server in ${cwd} did not answer on ${base} in two minutes:\n${log}`)
}

/**
 * A copy of <rev> to serve beside the working tree. Its node_modules is made
 * of one symlink per entry rather than one for the whole folder, so that the
 * copy's dev server keeps a dependency cache (node_modules/.vite) of its own –
 * two servers optimising into one cache at once is a race.
 */
function makeCopy(rev) {
  const sha = execFileSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim()
  // The real path: on macOS the temp dir is /var/…, a link to /private/var/…, and
  // Vite compares its root by the real one – an allow list in the other spelling
  // refused the copy's own files
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `mg3d-measure-${sha.slice(0, 8)}-`)))
  copies.push(dir)
  execFileSync('sh', ['-c', `git archive ${sha} | tar -x -C "${dir}"`], { cwd: REPO })
  mkdirSync(join(dir, 'node_modules'))
  for (const entry of readdirSync(join(REPO, 'node_modules'))) {
    if (entry === '.vite' || entry === '.tmp' || entry === '.cache') continue
    symlinkSync(join(REPO, 'node_modules', entry), join(dir, 'node_modules', entry))
  }
  mkdirSync(join(dir, 'public'), { recursive: true })
  symlinkSync(join(REPO, 'public/cesium'), join(dir, 'public/cesium'))
  for (const env of ['.env', '.env.local']) {
    if (existsSync(join(REPO, env))) symlinkSync(join(REPO, env), join(dir, env))
  }
  // Vite serves nothing outside the root, and the copy's dependencies resolve
  // to the repository's own files: the Inter font came back 403 without this
  const allow = JSON.stringify([dir, join(REPO, 'node_modules')])
  writeFileSync(
    join(dir, COPY_CONFIG),
    [
      "import { mergeConfig } from 'vite'",
      "import config from './vite.config.ts'",
      '',
      `const extra = { server: { fs: { allow: ${allow} } } }`,
      "export default typeof config === 'function'",
      '  ? async (env) => mergeConfig(await config(env), extra)',
      '  : mergeConfig(config, extra)',
      '',
    ].join('\n'),
  )
  return { sha, dir }
}

async function cleanUp() {
  for (const child of children) {
    if (child.exitCode !== null) continue
    const exited = new Promise((done) => child.once('exit', done))
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(5000)])
  }
  // rmSync removes the symlinks themselves, never what they point to
  for (const dir of copies) rmSync(dir, { recursive: true, force: true })
}

/** Installed into the page once: everything the measurement does in there. */
function probe() {
  if (window.__measure) return
  const viewer = window.__cesiumViewer
  const scene = viewer.scene
  // One frame apart, as a render loop is – or a tenth of a second where a
  // window in the background gets no animation frames
  const nextFrame = () =>
    new Promise((done) => {
      const timer = setTimeout(done, 100)
      requestAnimationFrame(() => {
        clearTimeout(timer)
        done()
      })
    })
  const tileset = () => {
    const primitives = scene.primitives
    for (let i = 0; i < primitives.length; i++) {
      const primitive = primitives.get(i)
      // The shown one: during a swap the replacement waits hidden beside it
      if (primitive?.show && primitive.statistics && 'tilesLoaded' in primitive) return primitive
    }
    return null
  }
  const tiltShift = () => {
    const stages = scene.postProcessStages
    for (let i = 0; i < stages.length; i++) {
      if (stages.get(i)?.name === 'mg3d_tilt_shift') return stages.get(i)
    }
    return null
  }
  const baseline = {
    msaa: scene.msaaSamples,
    shadowSize: scene.shadowMap?.size,
    resolutionScale: viewer.resolutionScale,
    tiltShift: tiltShift()?.enabled,
    atmosphere: scene.skyAtmosphere?.show,
    fxaa: scene.postProcessStages.fxaa?.enabled,
  }
  // The app sets viewer.shadows on every tick (applyShadowState), so a variant
  // that switches them holds the property for as long as it is measured
  const holdShadows = (on) => {
    if (on === undefined) {
      if (Object.hasOwn(viewer, 'shadows')) delete viewer.shadows
      return
    }
    if (!Object.hasOwn(viewer, 'shadows')) {
      Object.defineProperty(viewer, 'shadows', {
        configurable: true,
        get: () => scene.shadowMap.enabled,
        set: () => {},
      })
    }
    scene.shadowMap.enabled = on
  }
  const apply = (variant) => {
    const v = { ...baseline, ...variant }
    if (v.msaa !== undefined && scene.msaaSamples !== v.msaa) scene.msaaSamples = v.msaa
    if (scene.shadowMap && v.shadowSize !== undefined && scene.shadowMap.size !== v.shadowSize) {
      scene.shadowMap.size = v.shadowSize
    }
    if (v.resolutionScale !== undefined && viewer.resolutionScale !== v.resolutionScale) {
      viewer.resolutionScale = v.resolutionScale
    }
    const stage = tiltShift()
    if (stage && v.tiltShift !== undefined) stage.enabled = v.tiltShift
    if (scene.skyAtmosphere && v.atmosphere !== undefined) scene.skyAtmosphere.show = v.atmosphere
    const fxaa = scene.postProcessStages.fxaa
    if (fxaa && v.fxaa !== undefined) fxaa.enabled = v.fxaa
    holdShadows(variant.shadows)
  }
  const render = () => {
    try {
      viewer.render()
      return null
    } catch (error) {
      return String(error?.message ?? error)
    }
  }
  const state = () => {
    // A frame keeps the traversal going while the app's paused loop idles
    const renderError = render()
    const t = tileset()
    const api = window.__mg3d
    return {
      status: api.tilesetStatus?.() ?? null,
      hasTileset: Boolean(t),
      tilesLoaded: t ? t.tilesLoaded : null,
      contentReady: t ? t.statistics.numberOfTilesWithContentReady : 0,
      globeLoaded: scene.globe.show ? scene.globe.tilesLoaded : true,
      building: Boolean(api.renderPacing?.().batchesBuilding),
      replacing: Boolean(api.tileMemory?.()?.replacing),
      loopError: api.lastLoopError?.() ?? null,
      renderError,
    }
  }
  const measure = async (variant, frames, warmup) => {
    const context = scene.context
    const gl = context._gl
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    if (ext) gl.getParameter(ext.GPU_DISJOINT_EXT) // reading it clears it
    // Every draw the frame executes – shadow cascades and passes included
    const ownDraw = Object.hasOwn(context, 'draw')
    const draw = context.draw
    let draws = 0
    context.draw = function (...args) {
      draws += 1
      return draw.apply(this, args)
    }
    const samples = []
    let renderError = null
    try {
      for (let i = 0; i < warmup + frames && !renderError; i++) {
        apply(variant)
        await nextFrame()
        const query = ext && i >= warmup ? gl.createQuery() : null
        draws = 0
        if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
        const start = performance.now()
        renderError = render()
        const cpuMs = performance.now() - start
        if (query) gl.endQuery(ext.TIME_ELAPSED_EXT)
        if (i < warmup) continue
        samples.push({ query, cpuMs, draws, commands: scene.frameState.commandList.length })
      }
    } finally {
      if (ownDraw) context.draw = draw
      else delete context.draw
      holdShadows(undefined)
    }
    // The GPU times arrive frames later, and only once control has gone back
    // to the event loop
    const deadline = performance.now() + 10_000
    const timed = []
    for (const { query, ...sample } of samples) {
      let gpuMs = null
      if (query) {
        while (
          !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) &&
          performance.now() < deadline
        ) {
          await new Promise((done) => setTimeout(done, 10))
        }
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6
        }
        gl.deleteQuery(query)
      }
      timed.push({ ...sample, gpuMs })
    }
    return {
      samples: timed,
      renderError,
      timerQuery: Boolean(ext),
      disjoint: ext ? Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT)) : false,
      buffer: [scene.drawingBufferWidth, scene.drawingBufferHeight],
    }
  }
  const snapshot = () => {
    const t = tileset()
    const api = window.__mg3d
    const stats = t?.statistics
    return {
      tileset: stats
        ? {
            contentReady: stats.numberOfTilesWithContentReady,
            selected: stats.selected,
            commands: stats.numberOfCommands,
            geometryMB: Math.round(stats.geometryByteLength / 1e6),
            texturesMB: Math.round(stats.texturesByteLength / 1e6),
          }
        : null,
      tileMemory: api.tileMemory?.() ?? null,
      shadowMap: api.shadowMap?.() ?? null,
      pacing: api.renderPacing?.() ?? null,
      profile: api.renderProfile?.() ?? null,
      vehicles: api.vehicleCount?.() ?? null,
      secondsOfDay: api.secondsOfDay?.() ?? null,
      loopError: api.lastLoopError?.() ?? null,
    }
  }
  window.__measure = { apply, measure, state, snapshot }
}

/** Boots the city on a server and installs the probe. */
async function boot(browser, base, label, offline) {
  const [width, height] = opts.size.split('x').map(Number)
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: Number(opts.dpr),
  })
  const page = await context.newPage()
  const errors = []
  // A build that loads less than the other measures a different map
  const failedRequests = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`)
  })
  const url = bootUrl(base, offline)
  note(`${label}: booting ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page
    .waitForFunction(() => window.__mg3d?.ready === true && Boolean(window.__cesiumViewer), null, {
      timeout: 180_000,
      polling: 250,
    })
    .catch(() => {
      const seen = [...failedRequests.slice(0, 5), ...errors.slice(0, 5)].join('\n  ')
      throw new Error(`${label}: the map never came up at ${url}\n  ${seen}`)
    })
  await page.evaluate((time) => {
    window.__mg3d.setPaused(true)
    window.__mg3d.setTime(time)
  }, opts.time)
  await page.evaluate(probe)
  return { label, page, errors, failedRequests }
}

/** Waits until the tiles hold still – the documented condition, held for --settle seconds. */
async function converge(build, offline) {
  const start = Date.now()
  const timeoutMs = Number(opts.timeout) * 1000
  const settleMs = Number(opts.settle) * 1000
  let heldSince = null
  let state = null
  while (Date.now() - start < timeoutMs) {
    state = await build.page.evaluate(() => window.__measure.state())
    if (state.renderError || state.loopError) break
    const failed = !offline && state.status !== 'loading' && state.status !== 'google-3d-tiles'
    if (failed) break
    const tiles =
      offline ||
      (state.status === 'google-3d-tiles' &&
        state.hasTileset &&
        state.tilesLoaded &&
        state.contentReady > 50)
    if (tiles && state.globeLoaded && !state.building && !state.replacing) {
      heldSince ??= Date.now()
      if (Date.now() - heldSince >= settleMs) {
        return { converged: true, seconds: (Date.now() - start) / 1000, state }
      }
    } else {
      heldSince = null
    }
    await sleep(250)
  }
  return { converged: false, seconds: (Date.now() - start) / 1000, state }
}

const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '–')
const range = (s) => `${fmt(s.median)} (${fmt(s.p25)}–${fmt(s.p75)})`

function printTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column])).join('   ').trimEnd())
  }
}

async function frameMode(browser, builds) {
  const variants = parseVariants(opts.variants)
  const offline = opts.offline
  await Promise.all(
    builds.map(async (build) => {
      Object.assign(build, await boot(browser, build.base, build.label, offline))
      build.convergence = await converge(build, offline)
      const { converged, seconds, state } = build.convergence
      const after = `${fmt(seconds, 0)} s`
      const tiles = offline ? 'offline' : `${state.contentReady} tiles with content`
      const brief = {
        ...state,
        renderError: state?.renderError && firstLine(state.renderError),
        loopError: state?.loopError && firstLine(state.loopError),
      }
      note(
        converged
          ? `${build.label}: converged in ${after} (${tiles})`
          : `${build.label}: NOT converged after ${after} – ${JSON.stringify(brief)}`,
      )
    }),
  )
  const subjects = builds.flatMap((build) =>
    variants.map((variant) => ({
      build,
      variant,
      label: [builds.length > 1 ? build.label : null, variantLabel(variant) || null]
        .filter(Boolean)
        .join(' · ') || 'as configured',
      samples: [],
      rounds: [],
      errors: [],
    })),
  )
  const frames = Number(opts.frames)
  const warmup = Number(opts.warmup)
  const rounds = Number(opts.rounds ?? (subjects.length > 1 ? 4 : 1))
  let buffer = null
  let timerQuery = true
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? subjects : [...subjects].reverse()
    for (const subject of order) {
      await subject.build.page.bringToFront()
      await sleep(300)
      const result = await subject.build.page.evaluate(
        ([variant, n, w]) => window.__measure.measure(variant, n, w),
        [subject.variant, frames, warmup],
      )
      buffer = result.buffer
      timerQuery &&= result.timerQuery
      if (result.renderError) subject.errors.push(`render: ${firstLine(result.renderError)}`)
      // A disjoint period (the GPU's clock changed) leaves the round's GPU times meaningless
      let usable = result.samples
      if (result.disjoint) {
        subject.errors.push(`round ${round + 1}: GPU disjoint – its GPU times dropped`)
        usable = usable.map((s) => ({ ...s, gpuMs: null }))
      }
      subject.samples.push(...usable)
      subject.rounds.push(usable)
      note(`round ${round + 1}/${rounds} · ${subject.label}: ${usable.length} frames`)
    }
  }
  for (const subject of subjects) {
    subject.snapshot = await subject.build.page.evaluate(() => window.__measure.snapshot())
  }

  const [width, height] = opts.size.split('x')
  const scene = [
    `frame · ${opts.city}`,
    `${width}×${height} CSS @${opts.dpr} → buffer ${buffer?.join('×')}`,
    opts.headless ? 'headless' : 'headed',
    `${opts.time} paused`,
    offline ? 'offline' : 'Google tiles',
    opts.live ? 'live layers' : null,
    opts.hash ? `#${opts.hash.replace(/^#/, '')}` : 'home view',
    opts.query ? `?${opts.query}` : null,
    `${frames} frames × ${rounds} round(s)`,
  ]
  console.log(`\n${scene.filter(Boolean).join(' · ')}\n`)
  const rows = [
    ['subject', 'GPU ms median (p25–p75)', 'CPU ms in render()', 'draws', 'commands', 'GPU per round'],
  ]
  for (const subject of subjects) {
    const gpu = summary(subject.samples.map((s) => s.gpuMs ?? Number.NaN))
    const cpu = summary(subject.samples.map((s) => s.cpuMs))
    rows.push([
      subject.label,
      timerQuery ? range(gpu) : 'no timer query',
      range(cpu),
      fmt(summary(subject.samples.map((s) => s.draws)).median, 0),
      fmt(summary(subject.samples.map((s) => s.commands)).median, 0),
      subject.rounds
        .map((round) => fmt(summary(round.map((s) => s.gpuMs ?? Number.NaN)).median, 1))
        .join(' · '),
    ])
  }
  printTable(rows)
  console.log('')
  for (const build of builds) {
    const shot = subjects.find((s) => s.build === build).snapshot
    const memory = shot.tileMemory
    const facts = [build.convergence.converged ? 'converged' : 'NOT converged']
    if (shot.tileset) {
      facts.push(`${shot.tileset.selected} tiles selected, ${shot.tileset.contentReady} with content`)
    }
    if (memory && memory.effectiveSse > memory.configuredSse) {
      const sse = `${fmt(memory.effectiveSse, 1)} > ${fmt(memory.configuredSse, 1)}`
      facts.push(`the memory ratchet is ON (SSE ${sse}) – LOD knobs are moot`)
    } else if (memory) {
      facts.push(`no memory ratchet (SSE ${fmt(memory.configuredSse, 1)})`)
    }
    if (shot.shadowMap) {
      facts.push(`shadow map ${shot.shadowMap.size} ${shot.shadowMap.enabled ? 'on' : 'off'}`)
    }
    if (shot.profile?.tier) facts.push(`tier ${shot.profile.tier}`)
    if (shot.vehicles !== null) facts.push(`${shot.vehicles} vehicles`)
    console.log(`${build.label}: ${facts.join(' · ')}`)
    if (shot.loopError) console.log(`${build.label}: loop error – ${firstLine(shot.loopError)}`)
    if (build.failedRequests.length > 0) {
      const first = build.failedRequests.slice(0, 3).join(', ')
      console.log(`${build.label}: ${build.failedRequests.length} request(s) failed – ${first}`)
    }
  }
  for (const subject of subjects) {
    for (const error of subject.errors) console.log(`${subject.label}: ${error}`)
  }
  if (!timerQuery) {
    console.log('EXT_disjoint_timer_query_webgl2 is not available here – GPU times are missing.')
  }
  if (opts.json) {
    const out = {
      args: opts,
      buffer,
      builds: builds.map((b) => ({
        label: b.label,
        base: b.base,
        convergence: b.convergence,
        failedRequests: b.failedRequests,
      })),
      subjects: subjects.map((s) => ({
        label: s.label,
        variant: s.variant,
        samples: s.samples,
        snapshot: s.snapshot,
        errors: s.errors,
      })),
    }
    writeFileSync(resolve(opts.json), JSON.stringify(out, null, 2))
    note(`samples written to ${resolve(opts.json)}`)
  }
  const failed = builds.some(({ convergence: { state } }) => state?.loopError || state?.renderError)
  return failed ? 1 : 0
}

async function shaderMode(browser, base) {
  const build = await boot(browser, base, 'working tree', false)
  const start = Date.now()
  const timeoutMs = Number(opts.timeout) * 1000
  let state = null
  let framesWithTiles = 0
  while (Date.now() - start < timeoutMs) {
    state = await build.page.evaluate(() => window.__measure.state())
    if (state.renderError || state.loopError) break
    if (state.status !== 'loading' && state.status !== 'google-3d-tiles') break
    // Three seconds of frames over tiles that carry the shader
    const withTiles = state.status === 'google-3d-tiles' && state.contentReady > 20
    if (withTiles && ++framesWithTiles >= 12) break
    await sleep(250)
  }
  // A compile error carries the whole shader source, every frame again
  const distinct = (list) => [...new Set(list.map(firstLine))]
  const shaderErrors = distinct(build.errors.filter((e) => /shader|glsl|compil|link/i.test(e)))
  const otherErrors = distinct(build.errors.filter((e) => !/shader|glsl|compil|link/i.test(e)))
  const broke = Boolean(state?.renderError || state?.loopError || shaderErrors.length > 0)
  const problems = []
  if (state?.status !== 'google-3d-tiles') {
    const status = state?.status
    problems.push(`the tiles did not come up (${status}) – is VITE_CESIUM_ION_TOKEN in .env?`)
  } else if (!broke && framesWithTiles < 12) {
    problems.push(`no tiles with content within ${opts.timeout} s – nothing exercised the shader`)
  }
  if (state?.renderError) problems.push(`a frame threw: ${firstLine(state.renderError)}`)
  if (state?.loopError) problems.push(`the render loop failed: ${firstLine(state.loopError)}`)
  for (const error of shaderErrors) problems.push(`console: ${error}`)
  console.log(
    `\nshader · ${opts.city} · ${state?.contentReady ?? 0} tiles with content after ` +
      `${fmt((Date.now() - start) / 1000, 0)} s`,
  )
  if (problems.length === 0) console.log('OK – the tile shader compiled and drew; no loop error.')
  for (const problem of problems) console.log(`FAIL – ${problem}`)
  if (otherErrors.length > 0) {
    console.log(`\nother console errors (not counted):\n  ${otherErrors.slice(0, 10).join('\n  ')}`)
  }
  if (build.failedRequests.length > 0) {
    console.log(`\nfailed requests:\n  ${build.failedRequests.slice(0, 10).join('\n  ')}`)
  }
  return problems.length === 0 ? 0 : 1
}

async function main() {
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  const mode = positionals[0] ?? 'frame'
  if (mode !== 'frame' && mode !== 'shader') {
    throw new Error(`unknown mode "${mode}" – frame or shader`)
  }
  if (!existsSync(join(REPO, 'src/cities', opts.city))) throw new Error(`no city "${opts.city}"`)
  if (!existsSync(join(REPO, 'public/cesium'))) {
    throw new Error('public/cesium is missing – run `node scripts/copy-cesium-assets.mjs` first')
  }
  if (mode === 'shader' && opts.offline) {
    throw new Error('the shader check needs the tiles – no --offline')
  }
  parseVariants(opts.variants) // fails early on a typo

  const builds = []
  const port = Number(opts.port)
  if (opts.url) {
    builds.push({ label: 'working tree', base: opts.url.replace(/\/$/, '') })
  } else {
    note(`starting the dev server on ${port}…`)
    builds.push({ label: 'working tree', base: await startServer(REPO, port) })
  }
  if (opts.compare) {
    if (mode === 'shader') throw new Error('--compare is for frame measurements')
    const { sha, dir } = makeCopy(opts.compare)
    const label = `${opts.compare} (${sha.slice(0, 8)})`
    note(`${label} copied to ${dir}; starting its dev server on ${port + 1}…`)
    builds.push({ label, base: await startServer(dir, port + 1, COPY_CONFIG) })
  }

  const [width, height] = opts.size.split('x').map(Number)
  const browser = await chromium
    .launch({
      headless: opts.headless,
      channel: opts.channel,
      args: [
        `--window-size=${width + 40},${height + 140}`,
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    })
    .catch((error) => {
      if (!String(error).includes("Executable doesn't exist")) throw error
      throw new Error(
        "Playwright's Chromium is not installed: `npx playwright install chromium`, " +
          'or pass --channel chrome to use the Chrome installed on this machine',
      )
    })
  try {
    if (mode === 'shader') return await shaderMode(browser, builds[0].base)
    return await frameMode(browser, builds)
  } finally {
    await browser.close()
  }
}

process.on('SIGINT', () => {
  cleanUp().finally(() => process.exit(130))
})

let code = 1
try {
  code = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  await cleanUp()
}
process.exit(code)
