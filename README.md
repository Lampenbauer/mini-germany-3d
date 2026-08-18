# 🚋 Mini Rostock 3D

**Rostock's tram network, live on a photorealistic 3D map** – inspired by
[mini-tokyo-3d](https://github.com/nagix/mini-tokyo-3d), built with
[CesiumJS](https://cesium.com/platform/cesiumjs/) and
[Google Photorealistic 3D Tiles](https://cesium.com/learn/cesiumjs-learn/cesiumjs-photorealistic-3d-tiles/).

The RSAG trams (lines 1, 2, 3, 5, 6) run schedule-based along their real routes
through the city – with time-lapse, line filters, a stops layer, and a UI styled
after [shadcn/ui](https://ui.shadcn.com/).

![Screenshot (offline mode with wireframe globe)](docs/screenshots/offline-overview.png)

> The screenshot comes from the network-free **offline mode** used by the test
> environment (`?offline=1`, wireframe instead of photo textures). With internet
> access the app renders the photorealistic Google 3D Tiles of Rostock.

---

## Milestone 1 – Status

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Cesium map with Google 3D Tiles | ✅ `createGooglePhotorealistic3DTileset` via Cesium ion, falls back to a wireframe globe when unreachable |
| 2 | Trams as simple boxes on real routes | ✅ 3D boxes (32 m × 2.65 m × 3.6 m) with line labels, schedule-based simulation (see [Data](#data--gtfs--gtfs-realtime--osm)) |
| 3 | Routes/lines on the map | ✅ Polylines draped onto the ground/3D tiles in line colors + stops layer |
| 4 | shadcn(-style) interface | ✅ Tailwind v4 + Radix primitives, shadcn component styling (Card, Button, Badge, Switch, Slider) |
| 5 | Automated tests | ✅ Unit tests (Vitest) and functional E2E tests (Playwright) |

## Quick start

```bash
npm install        # also copies the Cesium assets to public/cesium (postinstall)
npm run dev        # → http://localhost:5173
```

**Cesium ion token:** A default token ships in `src/config.ts` and can be overridden
via `.env` without touching the code (see `.env.example`):

```bash
VITE_CESIUM_ION_TOKEN=your-token
```

> Ion tokens are client-side, publishable tokens – they inevitably end up in the
> browser bundle. It is still a good idea to restrict the token to your own domains
> in the [Cesium ion dashboard](https://ion.cesium.com/tokens). For the Google 3D
> Tiles, access to *Google Photorealistic 3D Tiles* (asset 2275207) must be enabled
> in the ion account.

### Usage

- **Simulation time:** The panel lets you set the clock directly (e.g. jump to rush
  hour); "Now" restores the real time. Time-lapse 1–120× and pause work at any time.
- **Selecting a tram:** Clicking a box opens the info card (line, destination, next
  stop). "Follow" pins the camera to the vehicle and rides along – orbiting/zooming
  with the mouse remains possible; clicking empty map, "Stop following", or a camera
  reset ends the follow mode.
- **Camera sharing:** The camera pose is saved to the URL hash every 1.5 s
  (`#lat=…&lon=…&height=…&heading=…&pitch=…`) and restored on load – views survive
  a reload and can be shared as a link.

### Useful URL parameters

| Parameter | Effect |
|-----------|--------|
| `?offline=1` | No ion/Google access, wireframe globe (basis of the tests) |
| `?speed=60` | Initial time-lapse factor (1–600) |
| `?time=08:30` | Set the simulation time (Europe/Berlin) |
| `?paused=1` | Start with the simulation frozen |
| `#lat=…&lon=…&height=…` | Saved camera pose (maintained automatically) |

## Tests

```bash
npm test               # Unit tests (Vitest): geodesy, timetable engine, clock, network validation, UI
npm run test:e2e       # Functional E2E tests (Playwright, fully offline & deterministic)
```

The E2E tests start the real app in offline mode with a frozen simulation time
(08:30) and render Cesium headless via SwiftShader. Everything runs automatically
in CI (GitHub Actions), see `.github/workflows/ci.yml`.

## Data – GTFS / GTFS-Realtime / OSM

### What the app currently uses

- **Routes & stops:** `src/data/network.json` contains the **real OSM track
  geometries** of all six RSAG tram lines (1 Mecklenburger Allee ↔ Hafenallee,
  2 Kurt-Schumacher-Ring ↔ Reutershagen, 3 Neuer Friedhof ↔ Dierkower Allee,
  4 Campus Südstadt ↔ Dierkower Allee, 5 Mecklenburger Allee ↔ Südblick,
  6 Campus Südstadt ↔ Neuer Friedhof) including direction-specific paths and the
  line colors from OSM – recognizable by the "OSM geometry" badge in the app.
  An approximated demo dataset can be restored at any time with
  `node scripts/build-approx-network.mjs`.
- **Buses & ferries:** `npm run data:update` additionally fetches all
  **RSAG bus lines** (route=bus with operator RSAG) as well as the two ferries
  **Kabutzenhof – Gehlsdorf** (OSM relation 56291, 19.9 × 6.6 m) and
  **Warnemünde – Hohe Düne** (relation 56296, 39 × 11 m). Each line in
  `network.json` carries its mode of transport (`mode`: `tram`/`bus`/`ferry`),
  and ferries their real vessel dimensions; the 3D boxes, travel speeds, and
  synthetic headways adapt accordingly. The line panel groups by mode of
  transport (with per-group toggles) as soon as more than one is present.
- **Tunnels & underground sections:** `data:update` derives per-direction
  tunnel ranges from the OSM tags of each route's member ways (`tunnel=*`,
  `location=underground`, or a negative `layer` – e.g. the tram tunnel under
  Rostock Hauptbahnhof) and stores them as meter ranges (`tunnels`) in
  `network.json`. The map renders those route sections at **40 % opacity**,
  and while a vehicle travels through one, its 3D box and label fade to 40 %
  as well; the info card of a selected vehicle then shows "in tunnel".
- **Timetable:** `src/data/schedule.json` contains real GTFS departure times per
  line/direction (typical weekday). Lines/directions without GTFS data stay off
  the map – if the feed does not serve a line that day (e.g. suspended due to
  construction work), the app does not run it either. Only when no
  `schedule.json` exists at all (development without data) does a synthetic,
  RSAG-like headway from `src/lib/timetable.ts` kick in for the whole network.
  Travel time between stops is derived from the real track distance; like
  mini-tokyo-3d, the vehicles run **schedule-based**, not on real-time
  positions.

### Importing real data (recommended, requires unrestricted internet access)

```bash
npm run data:update    # Real track geometries + stops from OpenStreetMap (Overpass API)
npm run data:gtfs      # Real departure times from a GTFS feed → src/data/schedule.json
npm test               # validates the new datasets
```

- `data:update` overwrites `network.json` with the real OSM relations for
  tram, RSAG bus, and the two ferries
  (© OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)).
- `data:gtfs` downloads the free Germany-wide public transport feed from
  [gtfs.de](https://gtfs.de) (DELFI-based) by default. With `GTFS_URL`/`GTFS_FILE`
  the official VVW feed can be used instead. The script looks up timetables for
  all lines in `network.json` (tram `route_type` 0, bus 3, ferry 4; ferries are
  matched via the pier names in `route_long_name`). Rostock relevance is
  established via the stop coordinates; a per-line agency overview in the log
  reveals route-number collisions. Lines without a GTFS match stay off the map
  (they are considered not running that day). **Important:** re-run `data:gtfs`
  after every `data:update` so the new bus lines get timetables.
- The unit tests adapt to the data source: the strict RSAG checks only run
  against the demo dataset, while structural checks (monotonicity, city bounds,
  lengths) run against every dataset.

**Data pipeline troubleshooting**

| Problem | Solution |
|---------|----------|
| Overpass responds with 403/406/429 | The script sends a User-Agent and automatically tries several mirrors (overpass-api.de → kumi.systems → osm.ch). Set your own endpoint via `OVERPASS_URL=… npm run data:update` or feed in a saved response via `OVERPASS_FILE=response.json`. |
| GTFS download takes long | The feed (~260 MB) is cached at `scripts/.cache/gtfs.zip`; delete the file for a fresh download. Reuse an existing zip via `GTFS_FILE=path.zip`. |
| CI/sandbox without unrestricted internet access | Overpass/gtfs.de are unreachable there – the bundled dataset stays active. |

### GTFS-Realtime (implemented, filtered server-side)

The app connects to the **free GTFS-Realtime feed from gtfs.de**
(`https://realtime.gtfs.de/realtime-free.pb`, DELFI-based):

- The feed provides **TripUpdates (delays)** – not vehicle positions. The app
  overlays them on the schedule simulation: a tram running +3 min is drawn where it
  would have been on schedule 3 minutes ago. The panel badge "GTFS-RT · n live"
  shows the number of currently matched trips, and a vehicle's info card shows
  its delay.
- **Server-side filtering:** The Germany-wide feed is >10 MB. The browser therefore
  does NOT download it itself but polls the **`/api/realtime`** endpoint (a few KB
  of JSON, every 60 s). Behind it sits a Vite middleware in the dev/preview server
  (Node, `vite.config.ts`) and, in production, **`api/realtime.php`**
  (shared-hosting friendly, with its own minimal protobuf parser and no
  dependencies). Both fetch the feed at most once per minute, filter it down to
  the Rostock `trip_ids` from `schedule.json`, and cache the result – all visitors
  share a single upstream fetch. A parity test (`node scripts/test-php-parser.mjs`,
  also run in CI) ensures the PHP and Node implementations extract identical data.
- **Matching:** The feed's GTFS `trip_id`s match the static gtfs.de feed.
  `npm run data:gtfs` stores them in `schedule.json` (`tripIds` alongside
  `departures`) – without them the badge stays at "0 live".
- **Configuration:** `VITE_GTFS_RT_URL` overrides the endpoint URL, an empty string
  disables realtime; the URL parameters `?rt=1`/`?rt=0` take precedence (default:
  on, except in offline mode).
- **Limits of the free variant:** reduced coverage, only trip_ids matching the
  gtfs.de static feed, attribution required. The official VVW route (registration
  via the [Connect platform](https://www.verkehrsverbund-warnow.de/service/open-data.html))
  remains the option for complete real-time data.

## Deployment (all-inkl webhosting)

`.github/workflows/ci.yml` tests and builds the app and then uploads it via
rsync/SSH to the all-inkl webhosting (Apache + PHP) at
`https://minirostock3d.lampenbauer.com`:

1. **One-time setup:** Create the secret **`KAS_SSH_PASSWORD`** in the repository
   settings (Settings → Secrets and variables → Actions) – the SSH password of the
   user `***REMOVED***`. Host, user, and target directory are defined directly in
   the workflow.
2. After a push to `main` – in particular after a PR merge – the deploy job waits
   for the CI job to succeed completely: typecheck, unit tests, PHP parity test,
   build, and E2E tests. Only then are `dist/`, `api/realtime.php`, and
   `api/schedule.json` rsynced to the document root
   `***REMOVED***/`. PR checks, feature-branch pushes,
   and failed tests do not deploy. A manual run of the CI workflow on `main` also
   goes through all tests first, which makes it suitable as a recovery deploy.
3. The deployed `.htaccess` maps `/api/realtime` to the PHP script and sets cache
   headers (hashed assets one year, `index.html` no-cache, Cesium static files
   one day).
4. **Nightly data refresh:** A scheduled run (02:30 UTC) additionally executes
   `npm run data:update`, `npm run data:simplify`, and `npm run data:gtfs` before
   the test steps, so the OSM geometry and – more importantly – the day-specific
   GTFS departures (weekday vs. weekend service) stay current. Only if the full
   test suite passes on the refreshed dataset is the result deployed and the new
   `src/data/*.json` committed back to `main`; a failed Overpass/GTFS fetch or a
   failing test leaves both the site and the repository untouched.

> Note: After a data update (`npm run data:gtfs`), commit the new `schedule.json` –
> it is rolled out as `api/schedule.json` during deploy so that browser matching
> and the server filter use the same trip_ids.

## Architecture

```
src/
├── config.ts               # Token, initial camera position, simulation parameters
├── data/
│   ├── network.json        # Line network (generated; see scripts below)
│   ├── schedule.json       # optional real departure times (GTFS)
│   └── network.ts          # Loading + preparation (distances, direction mirroring)
├── lib/
│   ├── geo.ts              # Haversine, bearing, polyline interpolation/projection
│   ├── clock.ts            # Simulation clock (time-lapse, pause, Europe/Berlin)
│   └── timetable.ts        # Headway timetable synthesis + trip states (dwell/moving)
├── engine/simulation.ts    # Clock + timetable → tram snapshots per frame
├── map/CesiumMap.ts        # Viewer, Google 3D Tiles, routes, stops, tram boxes
├── components/             # shadcn-style UI (ControlPanel, TramCard, ui/*)
└── App.tsx                 # Wiring, render loop, test API (window.__mrt)

scripts/
├── build-approx-network.mjs  # generates the bundled demo dataset
├── fetch-osm-network.mjs     # real geometry from OSM/Overpass   (npm run data:update)
├── fetch-gtfs-schedule.mjs   # real departure times from GTFS    (npm run data:gtfs)
└── copy-cesium-assets.mjs    # Cesium static files → public/cesium (postinstall)
```

**How the simulation works:** Departure times come from schedule.json (real GTFS
departures, including short workings that only serve part of a route – trips carry a
span and start/end mid-route); lines without GTFS data do not run. Only a missing
schedule.json activates the synthetic headway for the whole network, whose return
direction departs offset by half the headway so shuttle
services like the Warnow ferries run as the single vessel they are. The travel time
between two stops follows from the real track distance (~30 km/h + 25 s dwell time). Every frame, the distance along the route is
interpolated for each active trip and translated into a position + travel direction
(heading of the 3D box). Vehicles and stops do not use Cesium's `HeightReference`
clamping (unreliable on 3D tiles); their height is set explicitly from tile heights
measured by ray casts. Since those heights depend on the tile LOD currently loaded,
they are re-measured as the camera approaches – otherwise a stop measured from the
overview would keep floating several meters above the roofs up close.

## Roadmap (Milestone 2+)

- GTFS-RT with VehiclePositions (full gtfs.de or VVW feed) instead of TripUpdates only
- More detailed vehicles (low-poly 6N2 instead of boxes), acceleration/braking profiles
- Stop popups with departure boards, day/night lighting, performance tuning

## Attribution

- Map rendering: [CesiumJS](https://cesium.com) (Apache-2.0), tiles © Google –
  use of the Photorealistic 3D Tiles is subject to the Google Maps Platform terms;
  the attribution is displayed automatically by Cesium.
- Network data (after `npm run data:update`): © OpenStreetMap contributors, ODbL 1.0
- Timetable data (after `npm run data:gtfs`): gtfs.de / DELFI or VVW – observe the source's license terms
