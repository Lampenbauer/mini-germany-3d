# Working notes for Claude

The [README](README.md) says what this project *is* — features, architecture,
data pipeline, deployment. This file says what is easy to get wrong, and what
was decided once and should not be re-litigated. Read the README for the map;
read this before changing it.

The project is **English-first**: folder names, city slugs, identifiers, test
names, comments and README prose are English. German appears only as a UI
translation in [src/lib/i18n.ts](src/lib/i18n.ts) (`de` table) and in
data-facing strings the feeds dictate (`gtfs.nameStrip`, OSM operator regexes,
stop names). A city whose German name differs gets the English slug
(`munich`, `cologne`, `hanover`, `lubeck`) plus a `city.name.<slug>` entry in
*both* message tables — `localizeCityName` picks it up. Write comments and test
titles in English even when the conversation is in German.

---

## Ground rules

**Realism over simulation.** The map mirrors real service. A line that does not
run in reality must not run here, even if that leaves it idle — Munich's U8 is
Saturday-only and correctly sits still on a weekday; do not "fix" it. Synthetic
headways are acceptable only where no real data exists at all (a city without
`schedule.json`). When data fidelity and a livelier map conflict, fidelity wins.
This was stated explicitly after a synthetic fallback ran a line that was
suspended for track works. Known gaps that follow from the same principle and
are *not* modelled: Rostock's construction reroutes (line 1) and split routes
(line 5) during the Werftdreieck works still run on their normal alignment.

**The data pipeline runs in CI, never locally.** The nightly workflow
([.github/workflows/ci.yml](.github/workflows/ci.yml), 02:30 UTC; OSM only on
Sunday nights, GTFS every night) refreshes the committed data files on a free
hosted runner. Never design a step that needs a local run, a pre-downloaded
extract or a cache on disk. Prefer on-demand fetching with in-memory caches,
keep memory modest (a few hundred MB), and make regenerated files byte-stable
across reruns so the "anything new?" short-circuit still works.

**Typecheck with `npm run typecheck`** (= `tsc -b`), never `npx tsc --noEmit`.
The root tsconfig is solution-style with project references; the `--noEmit`
shortcut skips [tsconfig.app.json](tsconfig.app.json), which is what includes
`tests/`. A tuple error in a test once passed locally and failed CI exactly
this way.

**A change is not finished when the code works.** Every change — a fix as much
as a feature — ends with a sweep for what else already talks about the thing
you touched. Grep for the name you changed, the flag you added, the number you
moved, and follow it into:

- **[README.md](README.md)** — it is load-bearing documentation, not a summary:
  the feature table, the URL-parameter table, the `city.json` field list, the
  architecture tree with its file-by-file comments, the scripts table, the
  attribution list. A new URL parameter, script, `city.json` field or terrain
  source that is not in there is only half-added.
- **The app's own prose** — [src/lib/i18n.ts](src/lib/i18n.ts) carries strings
  that repeat facts about the project, and it carries them **twice**, in the
  `en` and `de` tables. The About dialog states the city count in `about.lead`
  and lists what the map is built from; the keyboard tab lists the shortcuts;
  the credits carry the licenses. A German table left behind is the usual miss.
- **Code comments elsewhere** — this codebase explains its decisions in prose
  next to them, so a constant that moves usually invalidates a sentence in
  another file that quotes its old value.
- **Tests** — `tests/<slug>.test.ts` pins per-city line sets, heights and
  vehicle counts; `tests/mode-mapping.test.ts` pins the two mode knobs.
- **This file**, when the change settles something it records as open or
  describes differently.

Worked example: adding a city means `definitions.ts`, the README intro *and*
Cities section *and* attribution list, `about.lead` plus `city.name.<slug>` in
both i18n tables, and a new `tests/<slug>.test.ts` — six places, one of which
compiles fine while being wrong.

**Commits land on `main`.** `git checkout -b`, `git switch -c` and
`git checkout -- .` are denied by the permission policy here, so the working
tree can never be reset to replay edits topic by topic. To split finished work
into commits, build them **through the index** and leave the working tree at
its final, tested state: diff HEAD against the final files, assign each opcode
to a commit, rebuild each intermediate file state, then
`git hash-object -w --path <f> <state>` + `git update-index --add --cacheinfo
100644,<sha>,<f>` and `git commit -F -` per commit. Assert the last state is
byte-identical to the tested tree — a clean `git status` at the end proves it.
Verify intermediate commits without touching the tree:
`git archive HEAD~n | tar -x -C <tmp>`, symlink `node_modules`, run `npx tsc -b`
and `npx vitest run` in there.

Commit messages: imperative subject, prose body explaining the *why*, ending
with the `Co-Authored-By` trailer. See `git log` for the register.

---

## Interface and styling

**Styling lives in the markup.** Tailwind classes on the element, never a
per-component stylesheet. The About and Credits dialogs each had one and both
were folded back into their components on 2026-09-08; nothing should grow a
`*.css` file next to a `*.tsx` again. What is left in
[src/index.css](src/index.css) is the theme tokens, the preflight corrections,
and the handful of rules that reach markup this app does not own — Cesium's
credit bar, the panels-opaque switch for the offline tests. A repeated class
string belongs in a `const` in the same file, not in a stylesheet.

**Tailwind v4 reads the source as text.** A class name assembled at runtime
(`` `${VARIANT}px-8` ``) is a class no rule is ever generated for, and it fails
silently — the element simply has no padding. Write every candidate out in
full, including the long stacked variants
(`sm:[@media(max-height:560px)]:py-5`).

**Colours are `oklch()`, not hex.** That is what the theme tokens in
`index.css` already speak, and it holds for Tailwind arbitrary values, canvas
`fillStyle`/`shadowColor` and SVG paint attributes alike. The one exception is
forced: Cesium's `Color.fromCssColorString` parses hex, `rgb()` and `hsl()` and
nothing else, so every colour that reaches it — hull colours, the ship name
plate, the globe base — stays hex. A silent failure either way, so keep the two
apart deliberately.

**Every hover is one value.** `--accent` in `index.css` is a wash of the
ground colour (50 % black in the dark theme), not shadcn's grey step: it is
what a control takes on under the pointer, and it is also the ground the
date/time field and the time-lapse track stand on, so the two read as the same
surface. A wash rather than a fixed grey because the same controls sit over
the panel's green head, over its card body and over a popover, and no one grey
sits on all three. Do not hard-code a hover colour on a control; move
`--accent` instead. Two places deliberately use it for something that is not a
hover — the current city in the picker and the calendar's "today" — and both
carry a second marker (a check, the selected day's own fill) so a subtle wash
is enough.

**The green is one value.** `--brand` in `index.css` is the deep green of the
About dialog's hero and of the control panel's head, which runs out into the
card's own colour where the card's content begins – except folded away, where
the panel is head and clock and nothing else and so is green all through,
border included. Change the green in one place. The
lighter greens beside it (`oklch(0.8254 0.1241 174.21)`, `oklch(0.6283 0.0988
174.84)`) are local to the dialog that uses them.

**Dates are written `12. Sep 2026`, in every language.** One shape everywhere:
day, full stop, the month's own abbreviation without a trailing full stop
(German's "Sep." loses it), four-digit year. An all-numeric date reads as two
different days on either side of the Channel, which is the reason. The control
panel's date button is the only place a calendar date is shown, and it is
built there by hand rather than by `Intl` — see `shownDayLabel` in
[src/components/ControlPanel.tsx](src/components/ControlPanel.tsx). Its row is
tight: 320 px hold the date, a 96 px time field and the "Now" button, and
"28. Mär 2026" wants about 91 px of the remainder. Measure before adding
anything to that row – the failure is a truncated date, which no test catches.


---

## Cities and the data pipeline

Thirteen cities are in the build ([src/cities/definitions.ts](src/cities/definitions.ts));
Rostock is the default. The README's [Cities](README.md#cities) section documents
`city.json` field by field and the `add-city` → pipeline sequence. What follows
is what the data itself taught.

### Terrain

Heights come from **Mapterhorn** tiles (Terrarium WebP, decoded with sharp) at
**zoom 15** (≈1.4 m/px, judged sufficient). Rostock verified against the old MV
DGM5: 6 cm mean deviation.

Before adding a city, sample a few known heights *and a transect* — a surface
model betrays itself with 10–30 m jumps between 100 m samples in built-up areas.
Mapterhorn's Hamburg import is missing 20 whole 2 km DGM1 squares and falls back
there to the 30 m GLO-30 *surface* model (Mönckebergstraße 33 m NHN instead of 9);
upstream issue [mapterhorn#131](https://github.com/mapterhorn/mapterhorn/issues/131)
is still open. The hole is closed by a committed tile patch:
`scripts/build-terrain-patch.mjs --city hamburg` rebuilds every z15 tile
touching a missing square from the DGM1 zip (202 tiles, 27 MB, byte-stable,
~25 min, network-bound) into `src/cities/hamburg/terrain/`, which the sampler
reads before asking the server.

Never store per-vertex heights in a city folder — vertices and lamps are
resampled after every OSM refresh, only a raster survives.

Two dead ends already walked for Hamburg, so nobody walks them twice: the 2016
DGM1 zip Mapterhorn imports *does* contain the centre tiles (~110 MB each), so
the gap is an upstream import problem, not missing source data; and
`geodienste.hamburg.de/HH_WMS_DGM1` is a rendering service, not a bulk source —
`GetMap` returns colour-class PNG/TIFF with no raw heights, and
`GetFeatureInfo` returns a real value per point but also nodata markers
(200, −20) depending on scale.

### The two mode-mapping knobs

Both live in `city.json` and are pinned by [tests/mode-mapping.test.ts](tests/mode-mapping.test.ts):

- `network.overpass.<mode>.osmRoutes` — which OSM `route=*` values a mode takes.
  Stuttgart's Stadtbahn is tagged `light_rail`, which the default map reads as an
  S-Bahn, so it names `subway: ["light_rail"]` **and** `train: ["train"]`. Two
  modes claiming the same route value now throws.
- `gtfs.routeTypes.<mode>` — which GTFS `route_type` a mode is looked up under.
  Hanover's Stadtbahn is a tram on the map and route_type 1 in the feed; without
  `tram: ["0","900","1"]` all 15 lines stand still. Stuttgart needs none.

### Import mechanisms worth knowing before debugging a city

- **Platform fallback:** most Kiel relations list 2 stop positions and ~30
  platforms, so a platform with no stop position within 50 m and no same-named
  stop stands in for the stop. Symptom without it: a line with 2–3 stops over 15 km.
- **Fixed-line from/to cut:** Kiel's F1 relation runs past Laboe to summer piers
  and back (41 km), so a fixed line's `from`/`to` cut the relation at the first
  pass of the pier.
- **Ferries by short name:** the GTFS feed carries the SFK ferries as KVG routes
  F1/F2/F3 with empty long names.
- **Loop trips split:** F2 runs Reventlou→Dietrichsdorf→Wellingdorf→Reventlou and
  is split at the turning pier into two directions.
- **Ring lines:** a ring relation (S41) can be stitched the other way round than
  its stops — the importer turns a path around when most stops run against it.
  Projection is order-aware (`after: lastDist`), which also keeps stub-end stops
  on out-and-back routes. GTFS ring trips end where they begin and are classified
  as one round by a stop a quarter of the way in (`ringLines` in
  `fetch-gtfs-schedule.mjs`). S41/S42 have ~240 rounds a day each.
- **Same-ref relations elsewhere:** the importer used to pick the two *longest*
  relations per line before testing whether they touch the city — Frankfurt's
  S5/S6 share a ref with 100 km Rhein-Neckar lines and both were lost. Relations
  with no path point inside the clip area are now dropped first (log:
  "N relation(s) of the same number run elsewhere – ignored"). This can only
  *add* lines, so other cities may gain lines at a later nightly refresh.
- **Overpass flakiness** is normal: 504s for minutes on end, rate limits on the
  lamps step. Rerunning a single step (`data:lamps`) works; CI has retries.

### Per-city notes

| City | Watch out for |
|---|---|
| **Rostock** | The default city and the byte-stability canary — its output stayed identical through every pipeline change above |
| **Kiel** | `clip: "box"` so Laboe/Strande stay on the map; ~1800 community-mapped lamps (2/km vs Rostock's 16/km) — lamps are always on, there is no per-city switch |
| **Hamburg** | Rebuilt from scratch 2026-09-05 via `add-city 62782` at the user's explicit request — **do not restore files from git history before 3e57f1c**. Terrain patch above. Open: the "St. Pauli" AIS twin (the only AIS "ST. PAULI" is a 19×6 m launch, not the 30 m ferry) |
| **Berlin** | Buses limited to `^(M[0-9]+\|100\|200\|300)$` for load — 685 vehicles at 08:30, twice Rostock; measure the 08:30 snapshot in [tests/berlin.test.ts](tests/berlin.test.ts) before adding more. `waterLevelNhn: null` because the Berlin DGM carries the lakes |
| **Cologne** | KVB 181 excluded — its OSM relation is a four-stop stub (53 ways with gaps) that placed 18 of 216 GTFS trips; re-admit once the relation is whole. Line 197 has no GTFS departures |
| **Munich** | U8 is Saturday-only in reality and correctly idle on weekdays. Bus limited to MetroBus/ExpressBus; the 80 StadtBus lines would double the fleet |
| **Bremen** | RS30 has no valid direction, RS3/RS4 are 2-stop stubs, RS4 got no GTFS match — open. Lines 66 and N94 have no GTFS trips |
| **Lübeck / Schwerin** | Priwall and Pfaffenteich ferries have no GTFS and are left off |
| **Frankfurt** | X express lines are regional (X95 has 450 m inside the city) and excluded; tram 11 has no operator tag, so trams come by network RMV |

Vehicles at 08:30 (the number each `tests/<slug>.test.ts` pins): Berlin 685,
Hamburg 458, Rostock/Cologne/Munich ~370, Stuttgart 257, Bremen 223,
Frankfurt 219, Hanover 184, Lübeck 93, Schwerin 38, Wilhelmshaven 17.

Consists are composed from existing meshes wherever possible — see
`VEHICLE_CONSISTS` in [src/map/VehicleLayer.ts](src/map/VehicleLayer.ts).
`tests/cities.test.ts` uses Paris as its "outside every box" point.

---

## Rendering and performance

Everything here was measured. Do not propose changes to it from first
principles without measuring first.

### The macOS GPU gauge is not a cost signal

"Device Utilization %" (`ioreg -r -c IOAccelerator`, the source Activity
Monitor uses) is peak-windowed, not energy-proportional. One cheap ~8 ms Cesium
frame per second reads as 27–41 %; 30× the frames barely moves it. Any ~1 Hz
repaint reads ~13 %; truly idle reads 0 %. A GPU-% complaint says something
about render *frequency*, not about frame cost. Two investigations went down
the wrong path before this was understood.

### How to actually measure a frame

Headed Playwright Chromium + `EXT_disjoint_timer_query_webgl2` (available there
on this Mac; readPixels-synced timing has ~7 ms of sync overhead). Wait for
`__mrt.tilesetStatus() === 'google-3d-tiles'` **and** `tileset.tilesLoaded &&
statistics.numberOfTilesWithContentReady > 50` held ~2 s (`tilesLoaded` is true
before the first request), then `gl.beginQuery(ext.TIME_ELAPSED_EXT)` /
`viewer.render()` / `endQuery` per frame. Runtime toggles: `scene.msaaSamples`,
`scene.shadowMap.size` (4 cascades → the texture is 2×size square!),
`viewer.resolutionScale`, the `mrt_tilt_shift` stage in
`scene.postProcessStages`. `viewer.shadows` must be overridden via
`defineProperty` — `applyShadowState` re-sets it every tick. City comes from the
hash (`#city=berlin`). The dev build inflates React (jsxDEV).

Baseline 2026-09-05 (M5 Pro, 1600×1000 CSS at DPR 2, SSE 6 CSS px, real Google
tiles). MSAA was still 4 then, which is what the "MSAA 4" column costs — the app
runs 2× since, so a frame today is cheaper than the totals below:

| view | GPU/frame | CPU in `viewer.render()` | of which shadows | MSAA 4 | sky atmosphere |
|---|---|---|---|---|---|
| Rostock home (5.8 km, −40°) | 19 ms | 7.5 ms | 9.5 ms | 11.7 ms | 1.9 ms |
| Rostock chase cam (94 m) | 25 ms | 16 ms | 6.5 ms | 10 ms | 2 ms |
| Berlin home 08:30 | 19 ms | 21.6 ms (CPU-bound) | 10 ms | 12 ms | 2.3 ms |

FXAA is off by default in Cesium 1.144. `Cesium.Model.update` runs the full
scene-graph update even for `show=false` models — only `submitDrawCommands`
checks `show` — so a hidden *parent* `PrimitiveCollection` is the only way to
skip children.

Where Berlin's CPU actually goes, measured the same day: of 22 ms render CPU in
the home view, 16.8 ms are the 3002 wagon `Model` primitives (13.2 ms for the
969 shown bodies, 3.6 ms for the 2033 hidden ones); tiles and everything else
are 5.2 ms. A known inefficiency sits there: `showBody` uses the `FRAMING_SCALE`
pinned to the 25° lens even when the 60° lens is on, so bodies are drawn out to
7.7 km, where a wagon is about 3 px.

### Rendering is event-driven and motion-paced

Idle renders happen on `CesiumMap.requestRender()` flags plus a 15 s heartbeat.
**Every new visible scene mutation in `CesiumMap` must call `requestRender()`**,
or it stays invisible for up to 15 seconds. Two related budgets from the same
pass: the stop-height bootstrap samples only ~40 stops (full sampling kept the
tileset loading for minutes), and vehicles count as "in view" only within 12 km.

Since 2026-09-05, frames and sim ticks are paced by on-screen motion:
`VehicleLayer`/`VesselLayer` measure each in-view object's screen motion since
the last *rendered* pose and request a frame only past
`MOTION_RENDER_DEVICE_PX = 0.5` device px
([src/map/screen-motion.ts](src/map/screen-motion.ts)). A camera that moved
since the last frame also earns one. Tick interval =
`clamp(threshold / px-per-second, 33, 100)` ms; 33 ms while interacting,
chasing or with the diagram open; 500 ms paused or with nothing in view. Home
view renders ~5–6 fps instead of 30; Berlin's main thread sits at 18–25 %
instead of 99 %.

Consequences to keep in mind:

- Motion alone only counts for in-view vehicles and ships — new per-tick visual
  changes in the layers still need an explicit `requestRender()`.
- Entity events are batched with `entities.suspendEvents()/resumeEvents()`
  around both sync loops, so **test doubles of `viewer.entities` must provide
  both methods**.
- Each vehicle has its own `PrimitiveCollection` (`record.group`) holding body,
  wagons and glow; `group.show` is the body cutoff.
- Shadows are gated by projected caster size (`SHADOW_MIN_CASTER_PX = 2` CSS px),
  and the sky atmosphere is hidden while the horizon is out of the frustum
  (Cesium draws it every frame with no frustum test otherwise).
- `SHADOW_MAP_SIZE` is **8192** (a 16384² texture, ~1 GB — Cesium packs the 4
  cascades 2×2). The user deliberately raised this back from 4096 for the shadow
  edge. **Do not propose lowering it again**; the 256 MB / ~2.5 ms it saves are
  known and were weighed.
- **MSAA is 2×** since 2026-09-08 (`msaaSamples` in the `Viewer` options), down
  from Cesium's default of 4. It was the most expensive item in a frame — 11.7 of
  the home view's 19 GPU ms — and the sampling rate is spent almost entirely on
  this map's own strokes: 4× against 1× differs in 17 % of the pixels, 4× against
  2× in only 14 %, nearly all of it route-polyline edges. There is no `?msaa=`
  URL knob; `__cesiumViewer.scene.msaaSamples = n` plus `__cesiumViewer.render()`
  changes it live (values 1, 2, 4, 8; the setter silently clamps to the driver's
  `gl.MAX_SAMPLES` and the multisample path is gated on `> 1`).

### Tile LOD: check the memory ratchet first

Cesium raises `memoryAdjustedScreenSpaceError` by 2 %/frame whenever selected
tiles exceed `cacheBytes + maximumCacheOverflowBytes`, **silently overriding
every LOD knob**. Before proposing any SSE change, check
`window.__mrt.tileMemory()`: `effectiveSse > configuredSse` means the ratchet is
active and SSE tuning is moot. Budgets were raised in
`CesiumMap.loadGoogleTiles` (2 GB cache on ≥8 GB devices, 1 GB otherwise, 1 GB
overflow). The base budget is `TILE_SSE_CSS_PX = 6` CSS px × pixelRatio
(user-picked); `?sse=<n>` overrides it live. Dynamic-SSE factor tuning is
visually near-irrelevant (~1–7 px on a ~23 px budget).

### The tile-tree leak (and why the tileset gets rebuilt)

`Cesium3DTile.unloadContent` returns early for non-renderable content, so every
external-tileset subtree Google's globe is stitched from stays in the tree for
the tileset's life (~3 KB per tile, +35–45k per city visited). Seven cities in
four minutes took `numberOfTilesTotal` 31k → 282k and the JS heap 195 MB →
1.06 GB while tile *content* stayed at 200–390 MB — V8's ~4 GB cap then means GC
stutter and a tab crash.

Destroying the tileset is the only way to release a tree, so
`CesiumMap.replaceTileset` builds a hidden copy (`preloadWhenHidden`) and swaps
it in when it holds the current view: at every city switch (started on
**arrival**, not with the flight) and, **only with the camera at rest and with
no deadline**, past `TILE_TREE_LIMIT = 300_000` (5-min cooldown, dropped the
moment the camera moves). Both tilesets share the one time-of-day CustomShader.

**Any tree threshold must be measured against a 5K buffer.** The first version
used 120k with a 60 s deadline and started the copy with the flight: on a
5120×2880 buffer the *home view alone* puts ~124k tiles in the tree (31k at
3200×2000 — the SSE budget is per CSS px, so more pixels means finer tiles), so
it rebuilt before the camera even moved, five times in four minutes, with two
traversals per frame in between.

Destroyed tilesets are still retained by stale `DrawCommand` references in
Cesium scratch arrays that are never trimmed (frustum command bins, the pick
offscreen view's command extents, and the shadow map's pass command lists, which
are only reset while shadows are *on*). `purgeStaleCommands` in `CesiumMap.ts`
runs from postRender after a swap and when shadows go off. Separately,
`releaseShadowMap` frees the shadow texture `SHADOW_MAP_RELEASE_MS = 5000` after
shadows are gated off (GPU process 2.95 instead of 4.1 GB; the first shadowed
frame after a release costs 23–28 ms instead of 18–20).

Also: a canvas assigned as a billboard image gets a fresh GUID per billboard and
a `TextureAtlas` never frees regions, so vehicle badges are **data URLs** (keyed
by URL → one region per line+delay). `WebcamsLayer.clear` destroys its
collection per city for the same reason.

When measuring heap: readings without `HeapProfiler.collectGarbage` are
garbage-inclusive and mislead. `Runtime.queryObjects` on
`Cesium3DTileset.prototype` shows how many tilesets are really alive.

### Offline mode does not compile the tile shader

`?offline=1` and the whole e2e suite render the wireframe globe with **no
tileset**, so `TIME_OF_DAY_SHADER` (the tileset CustomShader, which also carries
the cloud shadow) is never compiled there — a GLSL error in it surfaces in
neither unit nor e2e tests. Custom `DrawCommand` shaders (`CloudLayer`) *do*
compile offline and are covered by `e2e/clouds.spec.ts`.

After editing `TIME_OF_DAY_SHADER`, load the dev server **without** `offline=1`
in a headless Chromium, wait for `__mrt.tilesetStatus() === 'google-3d-tiles'`,
then check `__mrt.lastLoopError()` and the console. Google tiles answer many
requests with HTTP 429 under SwiftShader, so only coarse tiles load — enough to
prove the shader compiles, not enough to judge the look.

### `window.__mrt`

The debug/test API ([src/App.tsx](src/App.tsx), `MrtTestApi`) is the first stop
for any "the map is doing X" question: `tileMemory()` (incl. `tilesTotal`,
`replacing`), `renderPacing()` (incl. `tickIntervalMs`, `motionPxPerSecond`),
`renderRate()`, `shadowMap()`, `tilesetStatus()`, `lastLoopError()`,
`cloudState()`, `tiltShiftState()`, `groundHeights()`.

---

## AIS (live harbour traffic)

Fully live on `main` since 2026-08-27 (PR #10).

**Operationally critical:** the production cron must call
`/api/ais?listen=45` every minute. The bare URL gives 12 s windows, which
stutters moving ships and almost never catches the 6-minute `ShipStaticData`
frames, so ferries render as small default hulls. `?listen=` bypasses the TTL
check and queues for the lock (a fix from 2026-08-28: before that the browser's
own short windows kept the state fresh and the keeper answered from cache —
measured duty cycle 27 %). Healthy looks like: window starts alternating
~49 s / ~12 s, duty cycle ~93 %, ~35 position updates/min. Diagnose via the fix
ages of fast movers against the `listenedAt` age in the response, and verify the
keeper's window is actually *running*, not merely configured.

**Hard ceiling of the source:** aisstream does not pass AIS on-air rates
through — measured 0.5 position messages/s total on a permanently open socket,
and a ship under way on a 30 s grid, mostly every 60 s. ~450 m between fixes at
15 kn is physics, not a bug. Never chase it with more polling.

**Keys, never in the repo:** dev takes `AISSTREAM_KEY` / `WINDY_KEY` from
`.env`; production reads `aisstream.io-api-key.txt` and `windy-api-key.txt` two
levels above the docroot (see the header comments in
[server/api/ais.php](server/api/ais.php) and
[server/api/webcams.php](server/api/webcams.php)). Keys are never
`VITE_`-prefixed.

Which real vessels the map already runs from a timetable — so their AIS twins
are left out of the backdrop — lives per city in `city.json` under
`ais.simulatedByMmsi` (Rostock FG/FW, Kiel F1/F2, Hamburg 18× HADAG).

For any AIS change, mind the PHP/TS parity: `scripts/test-ais-parity.mjs` and
`scripts/test-php-parser.mjs` run in CI. If ships appear undersized, check
production for null `lengthM` first — that is a learning/window problem, not a
model bug.
