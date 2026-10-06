# Improvement phases

A backlog of improvements found in a code review on 2026-10-05, grouped
into phases and ordered by benefit per CPU/GPU cost: the first phases
change data and arithmetic only, the last ones need measuring before
they are kept. Every phase can be picked on its own unless a dependency
is named. Tick a box to mark a phase as chosen.

The review's basis: the code, the committed data, one measurement of
the simulation (Berlin at 08:30: 20 465 trips, 682 active vehicles,
0.6 ms per `snapshotsAt` call) and the measurements CLAUDE.md records.
Nothing was measured headed in a browser.

---

## Phase 1 – Timetable fidelity and motion, no runtime cost

- [x] **Phase 1** – implemented 2026-10-06 (all ten items; the ring lines' rounds and the ferry loops' legs keep the cruise speed, see CLAUDE.md).

Pure data and arithmetic. Expected cost: none at run time; `schedule.json`
grows by roughly half.

1. **Real stop times from the GTFS feed.** The pipeline keeps only the
   departure at the first stop inside the city
   (`scripts/fetch-gtfs-schedule.mjs`, `firstCityStop`); every later
   arrival is synthesised from a cruise speed per mode plus 25 s dwell
   (`stopOffsets` in `src/lib/timetable.ts`). Store the per-stop offsets
   per trip pattern (patterns shared, deltas, byte-stable) and let
   `tripStateAt` interpolate between real times. This also fixes the
   stop card's departure board and the base the realtime delay shifts.
   Benefit: the single largest fidelity gain; it is what "runs on the
   timetable" should mean.
2. **Acceleration and braking profile** between stops: a trapezoid or
   S-curve at the same segment time, in place of the linear
   `dist = d0 + (d1 - d0) * t` (`tripStateAt`). Pure function, unit
   testable. Most visible in the chase camera.
3. **Delay ramp.** A changed GTFS-RT delay is applied as an instant time
   shift (`Simulation.setRealtimeDelays`, polled every 120 s), which
   moves a tram by delay × speed in one tick (60 s ≈ 500 m). Blend the
   delay in over 10–20 s.
4. **Pitch on gradients.** Pitch and roll are fixed at 0 in
   `VehicleLayer` although every direction carries per-vertex heights;
   `pitch = atan(dh/ds)` from `heightAtDistance` costs one atan per
   vehicle per tick.
5. **Ships and aircraft on curves instead of chords.** `playbackSample`
   and `aircraftPlaybackSample` interpolate linearly between fixes;
   speed steps and direction kinks at every fix, hidden only by a
   400 ms ease. Cubic Hermite with SOG/COG (ships) and ground speed /
   track (aircraft) as tangents; heading from the curve's tangent
   blended with the reported heading.
6. **AIS fixes stamped with the message time**, not the server's
   receive time (`mergeAisMessage` in TS and PHP – keep the parity
   scripts green), so delivery jitter stops becoming speed jitter.
7. **Aircraft roll in the track point**, interpolated at the drawn
   instant; today `AircraftLayer` banks from the latest record, 12 s
   ahead of the body.
8. **Blend from dead reckoning back to the chord** when a late fix
   lands, instead of relying on the ease.
9. **Time-based chase easing**: `FOLLOW_CHASE_EASE = 0.12` per call in
   `FollowCamera` → `1 - exp(-dt/τ)`.
10. **Documentation hygiene.** CLAUDE.md's "known inefficiency"
    about `showBody`/`FRAMING_SCALE` was fixed in 45d6257 (2026-09-05);
    only `VEHICLE_LABEL_VISIBLE_RANGE` is still pinned to the 25° lens.
    Comments in `VehicleLayer.ts` and `RoutesLayer.ts` still say "40 %"
    for `TUNNEL_VISIBILITY = 0.2`; `VehicleLayer.sync`'s header says
    "every frame" for a per-tick call.

## Phase 2 – Articulated consists

- [x] **Phase 2** – implemented 2026-10-06. Measured (`renderPacing().vehicleSyncAvgMs`, headless, offline, Berlin 08:30): home view 2.76 → 1.83 ms a tick, 1.2 km over Alexanderplatz 2.63 → 2.30, 400 m over it 2.65 → 2.35 – cheaper than before, since hidden bodies' wagons are no longer composed every tick.

Expected cost: one binary search and one matrix per drawn wagon per
tick (Berlin: about 1 000 per tick). Measure the tick before and after
in Berlin's home view; skip hidden wagons.

1. **Place every wagon at its own path distance** instead of the rigid
   offsets along the centre's axis (`composeWagonMatrix`,
   `wagonOffsets`). A 133 m S-Bahn (`sbahn-423`) leaves the track in
   curves today.
2. **Heading from two points a bogie's length apart** rather than the
   current segment's bearing (`sampleAtDistance`), which snaps at every
   vertex of the 0.3 m simplified path. This removes the snapping the
   chase camera eases around.
3. Dependency for Phase 8 (long trains).

## Phase 3 – Heights without new tile sampling

- [x] **Phase 3** – implemented 2026-10-06: vertical densification in the pipeline (Berlin +2 183 vertices, 5.6 %), the offset field from the stops already measured (`src/map/height-field.ts`), the near lift at the vehicles' 0.3 m, the sampler's zoom-fallback warning; three hotspots looked up (a tunnel portal, a cutting, an underpass – no missing tags), Stuttgart's still to look up.

Expected cost: pipeline only, plus a few more route vertices. No new
runtime picks.

1. **Vertical Douglas–Peucker before height sampling**
   (`scripts/fetch-route-heights.mjs`): insert vertices only where the
   height chord misses the terrain by more than 0.3 m. Not a blanket
   20 m densification – that would be ×3.5 vertices in Berlin
   (38 678 → 135 779) and hit the polyline geometry and the network
   test that already runs over 331 000 points. Segments today: p50
   30 m, p99 451 m, 1 008 segments over 300 m, longest 3.5 km (Berlin).
2. **Offset field from the stops already measured.** The route offset
   is one city-wide median of 40 bootstrap stops picked by index
   stride (`StopsLayer.bootstrapSamples`, `CesiumMap` calibration,
   accepted between 20 and 60 m). `StopsLayer.resolveHeights` already
   measures stops near the camera on the mesh; interpolate
   (measured − `stop.nhn`) along each direction instead. Do NOT add
   bootstrap samples: `sampleHeightMostDetailed` loads the finest tiles
   under every sample and kept the tileset loading for minutes.
3. **Same lift for lines and vehicles.** Lines ride 0.15/0.8 m plus up
   to 1.05 m of per-line stagger (`RoutesLayer`), vehicles 0.3 m, stops
   0.5 m on the mesh.
4. **Warn when the terrain sampler answers below the city's zoom**
   (`scripts/lib/terrain.mjs` falls back silently down to the 30 m
   surface model); only Hamburg is patched.
5. **Review the spike hotspots** for missing bridge tags (profile
   more than 3 m off its neighbours outside tagged bridges):
   Hamburg S1/S2 53.5508, 10.0090 (+4.9 m); Berlin S3 52.50959,
   13.23148 (+6.5 m); Stuttgart U3 48.7278, 9.1393 (+5.0 m); Munich
   bus 56 48.15196, 11.45646 (+5.5 m).

## Phase 4 – Decluttering and night lights

- [ ] **Phase 4**

Expected cost: negative (fewer billboards) or one point collection.

1. **Badge and name budget by camera height.** Badges and ship names
   are drawn out to 35 km and cover the Hamburg home view. From afar:
   ship names for moving ships only, badges shrunk with distance or
   capped to the N nearest.
2. **Route line width in steps** (like the near/far lift switch at
   500 m), not a per-frame `CallbackProperty`, which would make every
   polyline dynamic. Width is a constant 5 px today.
3. ~~**Headlights and tail lights** as points in a
   `PointPrimitiveCollection`, the `NavLights` pattern; the cabin glow
   pool stays.~~ Done 2026-10-06 (`addVehicleLights` in VehicleLayer).

## Phase 5 – Instanced wagon rendering

- [x] **Phase 5** – implemented 2026-10-06 (`src/map/InstancedWagons.ts`). Measured headed, the close views with Google's tiles still loading (not offline, as first written – see CLAUDE.md): Berlin 1.2 km over Alexanderplatz render CPU 13.4 · 13.8 → 10.9 · 11.1 ms, commands 1 570 · 1 610 → 887 · 909; Hamburg harbour CPU 12.7 · 13.0 → 11.8 · 11.9 ms, commands 1 348 → 1 090; with the tiles settled Berlin's close view 14.2 · 14.5 → 12.2 · 12.3 ms CPU. GPU per frame offline (interleaved, 480 frames) 9.69 → 6.03 ms median, mostly because Cesium's environment-map queue no longer holds 12 000+ passes for the wagon Models. The selected vehicle keeps its Models for the silhouette.

Expected cost: a large CPU win – the 3 002 wagon `Model` primitives
are 16.8 of Berlin's 22 ms render CPU – and a neutral GPU. The risk is
engineering, not performance.

1. One instanced `DrawCommand` per consist model after `StopDiscs` /
   `FunnelSmoke`, with the GLB's one merged primitive as geometry
   (vertex colour + palette texel are already there), a matrix and a
   line-colour tint per instance.
2. Open points: pick colour per instance (StopDiscs shows how), the
   shadow pass, the selection highlight and the window-glow luminance
   rule. Cesium 1.144 has no runtime instancing API; glTF
   `EXT_mesh_gpu_instancing` is static at load.
3. Makes Phase 8 comfortable in Berlin.

Follow-up found while measuring Phase 5:

- [ ] **Spatial sub-batches for the wagons' shadow pass** – tried on
  2026-10-06 and left out. Cells of 1 or 2 km, a command, an instance
  buffer and a vertex array each, cut the wagons drawn into the four
  cascades in Berlin's close view from 4 × 486 to about 480 and those in
  the main pass from 922 to 342, but the GPU frame at the desktop's 8192
  cascade stayed where it was (5.6–5.8 ms either way); render CPU +0.1 ms
  in Berlin, −0.4 ms in Hamburg, twice the commands. With a 2048 shadow
  map, the mobile tier's, the wagons' shadow share fell from 0.88 to
  0.25 ms and the frame from 4.4 to 3.6 ms. Worth building only for the
  mobile tier, and only after a measurement on a phone shows the GPU
  there is the limit (CLAUDE.md, "The wagons are instanced", has the
  numbers and the method).

## Phase 6 – Routes that follow the mesh near the camera

- [x] **Phase 6** – done 2026-10-06, not as planned: the measurement
  found most of the error elsewhere, and the ground follow itself was
  built, measured and left out.

Expected cost: real and unmeasured. Extend the bridge-deck mechanism
(`bridge-decks.ts`: 6 `tileset.getHeight` rays per 200 ms, on screen,
re-read per `surfaceGeneration`) to every route vertex within a band
of ±2–3 m around the profile, with the existing roof pruning. A ray is
0.3–1 ms; a budget that converges in seconds is 5–10 % of the main
thread while tiles refine, and every accepted change re-batches a
polyline (rationed to one per direction per second today). Measure
headed before keeping it. Optional `depthFailMaterial` on the
polylines draws every line twice; measure on the GPU.

What happened (CLAUDE.md, "The calibration's samples see the tiles
alone" and the two paragraphs after it):

- Measured headed on the real tiles – the ground every visible vertex
  within 1 km is drawn on, lift taken off, against the mesh – the lines
  floated in most cities: Munich 3.06 m on the median, Stuttgart 1.0–1.2,
  Hamburg 1.10, Cologne 0.30, Frankfurt 0.40; Berlin and Rostock were
  right. The cause was the boot's calibration: its
  `sampleHeightMostDetailed` at the stops answered with the route lines
  themselves wherever a city's fallback offset stood too high. With an
  exclusion list of everything but the tiles: Munich −0.08 m (88 % of the
  vertices within ±0.5 m, 14 % before), Hamburg −0.06 (77 %, 12 %),
  Stuttgart 0.03 (90 %, 6 %), Cologne −0.13 (88 %, 42 %), Frankfurt 0.08
  (100 %, 71 %), Berlin 0.00 (82 %, 72 %). No runtime cost.
- The ground follow over that: +7 points in Berlin, +4 in Stuttgart, +31
  on a 33-vertex view, nothing in Hamburg, Rostock, Frankfurt and
  Cologne, −6 in Munich – for rays of 1–2 ms near the camera, half a
  minute at a tenth of a core per view or minutes at a budget that does
  not show. Left out; it wants a cheaper ray first (a triangle grid per
  tile, built once).
- Kept from the work: every route rewrite – field, decks – batched into
  one rebuild a second at most (a rebuild of the city's polyline batch is
  20–25 ms of main thread, measured, however few directions changed),
  a rewrite waiting for the last rebuild to come in and the rebuild drawn
  at the streaming rate (some 170 ms; at the paused 2 Hz the rewrites had
  started it over until they stopped), and the switch
  between the near and the far lift reading the camera's height over the
  city's ground (Munich's lines had ridden the far lift from every camera).
- Found on the way: a coarse tile under a camera that had just arrived
  answered 478 m over Hamburg's Hauptbahnhof, and seven bus lines stood
  up into the sky as bridge decks; a deck sample more than 80 m over the
  profile is a roof now. (The same tile pushes Cesium's camera collision
  up to 480 m there at boot – not touched.)
- `depthFailMaterial` was not tried: with the lines on the mesh there is
  less to draw through.

## Phase 7 – Per-frame interpolation in the chase

- [ ] **Phase 7**

Expected cost: high if done globally, acceptable if fenced. Poses are
written per tick (33–100 ms, `App.tsx` tick gate); nothing
interpolates in `scene.preUpdate`. Interpolating every frame for every
vehicle would give every frame a reason to render and undo the
motion-paced loop (home view at 5–6 fps, Berlin's main thread at 20 %).
Rules: only while chasing or interacting, where frames are drawn every
15–33 ms anyway; never as an extra render request; only the subject
and the bodies in view. Even then the chase stays GPU-bound at DPR 2
(25 ms GPU per chase frame measured before MSAA went off).

## Phase 8 – Regional and long-distance trains

- [ ] **Phase 8**

Depends on Phase 2; Phase 5 recommended for Berlin. The gtfs.de feed
is the full one with RE/RB/IC/ICE; OSM has them as `route=train` with
`service=regional` / `long_distance`; the pipeline cuts at the city
limits and already drops same-ref relations elsewhere. Runtime cost
about 14 µs render CPU per drawn wagon (Berlin measurement). The risk
is the pipeline: ICE relations are hundreds of kilometres long and
the Overpass fetch must stay within the CI runner's memory. Needs one
or two train models (ICE 4, Dosto), README cities table, i18n, tests.
Other modes do not carry: the Cologne and Berlin cable cars have no
GTFS, no city has a trolleybus.

## Phase 9 – Cosmetics, unmeasured

- [ ] **Phase 9**

1. **Turning wheels.** As separate glTF nodes they break "one primitive
   per part" and raise the draw-command count that was Firefox's
   lever; as a vertex-shader rotation in the one primitive they stay
   cheap. Only worth it on the chased vehicle.
2. **Hull heel in turns and a slight wave pitch**; rate of turn from
   AIS is not read today.
3. **Door states at stops** – not recommended; cost for little.
