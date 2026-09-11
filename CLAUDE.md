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
across reruns so the "anything new?" short-circuit still works. Byte-stable
means no date of any shape in the file: the schedule's chosen service day
(`meta.serviceDate`, GTFS's dashless `20260910`) slipped past the
meta-date test and set the full pipeline going nearly every night for four
weeks – found 2026-09-11 with four cities whose nightly diff was that one
line. A date belongs in the run's log and the data commit's message, where
it now is. The feed download is cached under the feed's `Last-Modified`
for the same reason: the feed changes weekly, the refresh runs nightly.

**Typecheck with `npm run typecheck`** (= `tsc -b`), never `npx tsc --noEmit`.
The root tsconfig is solution-style with project references; the `--noEmit`
shortcut skips [tsconfig.app.json](tsconfig.app.json), which is what includes
`tests/`. A tuple error in a test once passed locally and failed CI exactly
this way.

**Unit tests run in Node; a DOM is opted into per file.** The `test` block in
[vite.config.ts](vite.config.ts) sets `environment: 'node'`, and the 18 files
that render or touch `window`/`document` open with
`// @vitest-environment jsdom` on their first line. jsdom cost ~0.7 s per
file on the CI runner – 62 s of a 217 s run when all 85 files got one. A new
component test without the line fails loudly (`document is not defined`), so
the miss is cheap; the trap is the other way round: do not put jsdom back as
the default. The same block pins `maxWorkers: 2` under `CI`: the repo is
private, GitHub's standard runner for private repos has 2 vCPUs, and Vitest 4
defaults to `cpus − 1` workers, which ran the whole suite on one core, file
after file. Measured 2026-09-09: 217 s before, ~90 s expected after, locally
36 s → 28 s with two workers. Per-file cost is the lever from here – a new
test file costs its imports and environment in full, so a check that belongs
to an existing file goes there rather than into a new one, and an assertion
per data point (`network.test.ts` once ran four `expect`s on 331 000 path
points, 15 s) is counted instead.

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
  `en` and `de` tables. The About dialog lists what the map is built from
  (and deliberately never says how many cities there are – the count changed
  often enough to be a trap, so no prose anywhere states it); the keyboard
  tab lists the shortcuts;
  the credits carry the licenses. A German table left behind is the usual miss.
- **Code comments elsewhere** — this codebase explains its decisions in prose
  next to them, so a constant that moves usually invalidates a sentence in
  another file that quotes its old value.
- **Tests** — `tests/<slug>.test.ts` pins per-city line sets, heights and
  vehicle counts; `tests/mode-mapping.test.ts` pins the two mode knobs.
- **This file**, when the change settles something it records as open or
  describes differently.

Worked example: adding a city means `definitions.ts`, the README intro *and*
Cities section *and* attribution list, `city.name.<slug>` in both i18n
tables, a new `tests/<slug>.test.ts`, and a run of
`scripts/build-og-images.mjs` for its link-preview picture — six places,
one of which compiles fine while being wrong (the picture is the one a
test catches: `tests/site-pages.test.ts` wants one per page).

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

**Cesium reads no `oklch()`.** `Color.fromCssColorString` parses hex,
`rgb()` and `hsl()` and nothing else, and fails silently on anything more
modern, so every colour that reaches it — hull colours, the ship name plate,
the globe base — stays hex. Elsewhere the notation is free; the theme tokens
in `index.css` happen to be `oklch()`.

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
About dialog's hero, of the control panel's head, which runs out into the
card's own colour where the card's content begins – except folded away, where
the panel is head and clock and nothing else and so is green all through,
border included – and of the city card's head, which opens from the panel's
and carries the About dialog's small network
([NetworkIllustration](src/components/NetworkIllustration.tsx)) faded into
its corner. Change the green in one place. The
lit green of the eyebrow dot is `--brand-light` beside it, because the About
and the Credits dialog both wear it, and `--brand-mid` is the green for
marks on the card (the About dialog's section icons, the bar before a
link), lifted in the dark theme; the remaining greens in the About dialog
are that dialog's own. `--text-2xs` (10 px) is the eyebrows' size and the
one font size added below Tailwind's own scale.

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

**The welcome screen is a door, not a dialog over the map.** On a plain
visit ([src/lib/welcome.ts](src/lib/welcome.ts) decides) the city chooser
covers the screen and *no city session runs behind it*: the viewer is
built and the world loads, but the session effect in `App.tsx` waits for
the pick, the URL writer stays silent (a path written there would name a
city nobody picked and walk past the door on the next reload) and the
shortcuts are inert. The pick is a `'jump'`, never a flight – there is
nothing on the map to fly from – and it starts the session *while the
screen still stands*: the screen has an `open`, a `loading` and a `closed`
phase (`WelcomePhase`), the session waits only for `open` to end, and the
screen goes once the city's data is in and `WELCOME_LINGER_MS` have
passed, whichever is later (a ceiling of `WELCOME_LINGER_MAX_MS` uncovers
a city that will not load). The session effect depends on a boolean
derived from the phase, not the phase itself, or the step from loading to
closed would tear the city down and put it up again. A link that names a place skips the door,
`?welcome=0` skips it for one visit (every test boots this way – a new
e2e spec or App test needs it), `?welcome=1` forces it. The last visited
city (`mg3d.city`) is still written but no longer read: with the screen
turned off the app opens on the default city, as its checkbox says. On
the green the cards' hover is a white wash (`hover:bg-white/12`), the one
exception to the `--accent` rule besides the About hero's close button,
for the same reason: a black wash sinks into the green.

**A phone gets one sheet, at the foot of the screen.** Under Tailwind's
`sm` (640 px) the panel's wrapper and the five card slots (`CARD_SLOT` in
[src/App.tsx](src/App.tsx)) share one place, `inset-x-3 bottom-9`, and the
panel leaves while a card is up (`cardOpen && 'max-sm:hidden'`): a phone
has room for one sheet, and the card is the one the reader asked for. The
panel opens folded there (`narrowViewport()` in
[src/lib/viewport.ts](src/lib/viewport.ts), read once – a phone does not
become a desktop mid-session) and unfolds to `55dvh`; a card is `60dvh`
and scrolls as a whole (`CARD_SHELL` in
[card-parts.tsx](src/components/card-parts.tsx)). Two traps found on
2026-09-10 while building it: the card's children must not shrink
(`max-sm:[&>*]:shrink-0`) – the head clips its illustration with
`overflow-hidden`, which lets a flex column shrink it to its eyebrow, and
the title went first; and nothing inside a card may call
`scrollIntoView`, which scrolls every scrollable ancestor – the vehicle
card's stop list took the card's head off screen with it, so it scrolls
its own viewport now. The weather moves to the upper left, the readings
to the top centre, the rail to the upper right with `gap-2`, so its three
boxes end above where the sheet opens. The line diagram, the photo mode
and full screen are not offered (`max-sm:hidden`), and `selectView`
refuses `'linear'` on a narrow viewport, so a link cannot open it either.
`e2e/mobile-layout.spec.ts` pins all of it at 393×852 with touch. Not
done, on purpose: a phone held sideways is 640 px and more and gets the
desktop layout; safe-area insets; the diagram itself. The rendering side
is the mobile tier of the render profile (see "Rendering and
performance").

**The camera path is the wall clock's, and it is flown by hand.**
[src/lib/camera-path.ts](src/lib/camera-path.ts) is pure – keyframes
(the URL's pose tuple), a duration, a pace; `viewAlongPath` says where
the camera is at `t`, headings turn the short way round, the segments
share the time equally, the pace eases in and out unless asked not to,
and the hash form (`path=…&dur=…`, `&ease=linear` for the deviation)
rides beside the pose hash. `CesiumMap.playCameraPath` sets the pose per
frame from `performance.now()` in `scene.preUpdate` – not Cesium's
`flyTo`, which arcs long flights upwards, eases on its own terms and can
neither be scrubbed nor stopped – and keeps `flyingUntil` so the loop
renders at full rate. It gives way to anything else that wants the
camera: a drag (`lastInteractionAt` past the start), a follow, another
flight, the next city; `onEnd(false)` says so, `onEnd(true)` marks the
end reached. Two things learnt building it (2026-09-10): the hash writer
waits for Cesium's `moveEnd`, which needs frames after the motion, and
after a flight set per frame the loop draws none until its heartbeat –
so the app writes the pose itself when a flight ends or a keyframe is
reached; and the test API reads `playing`/`progress` in the same task as
the click, so those refs are written with the state, not mirrored on
render. `?play=1` flies the hash's path once the city is ready, once.
The popover lists two keyframes; the model is a list, so a third is an
interface change only. `e2e/camera-path.spec.ts` flies one and reads the
end pose back from the hash. A city switch drops the keyframes (the
session cleanup in `App.tsx`, through `clearCameraPathRef` – the same
clearing the popover's button does, seconds and pace kept): they are
poses over the city that is leaving. A link's path is safe, the cleanup
runs only when a session ends; `tests/app.test.tsx` pins both.

**The three readings at the foot of the map are a radio group, not
tabs.** They were Radix `Tabs` until 2026-09-11, for the look and the
keyboard, but a tab controls a panel and these swap what the whole map
shows – every trigger carried an `aria-controls` pointing at a panel
that never existed, which an accessibility audit flagged. They are a
`SegmentedControl` now ([src/components/ui/segmented-control.tsx](src/components/ui/segmented-control.tsx),
Radix `ToggleGroup type="single"`: `role="radiogroup"`, items
`role="radio"` with `aria-checked`) wearing the tabs list's exact
classes – a before/after screenshot was byte-identical, hover included –
and Radix's roving focus keeps the keys (arrows move the focus, Enter
picks). Pressing the chosen reading again is swallowed by the root;
there is always one. Tests and specs address them as
`getByRole('radio', …)` inside `getByRole('radiogroup', { name: 'View' })`.

**The map's controls live on the rail, not in the panel.** The control panel is
the simulation – the clock, the time-lapse, the lines. What is *drawn* belongs
to the boxes at the lower right: the layers popover (routes, stops, names,
webcams), the camera's block, the photo popover. The Layers block moved out of
the panel on 2026-09-08 for exactly that reason; do not move map switches back
into it. All three boxes are built the same way (`RAIL_BOX` + `GROUPED_CONTROL`
in [src/App.tsx](src/App.tsx)) – a lone button styled by hand comes out 2 px
narrower than the group above it, because the group's border sits outside its
buttons.

**Four kinds of name on the map, and they must not converge.** A vehicle
wears its line's colour with white text ([VehicleLayer](src/map/VehicleLayer.ts),
`lineBadge`). A stop wears no plate at all: light slate text in a thin dark
halo, its lines a shade dimmer ([StopsLayer](src/map/StopsLayer.ts),
`stopNameImage`), over a disc that lies *flat on the ground* – since
2026-09-11 a hand-built instanced DrawCommand
([StopDiscs](src/map/StopDiscs.ts)), because a billboard cannot lie flat
and nothing else in Cesium draws a flat mark that moves with the height
refinement and holds its screen size. It keeps the billboard's two habits:
drawn over the tiles within 3 km (the near-plane trick Cesium's own
billboard shader uses, log-depth varying included) and pickable by a
"stop:" id (one pick colour per instance, `pickId: 'v_pickColor'`). Its
GLSL compiles offline, so every e2e run proves it; the stop-card spec's
real click goes through its pick colours.
A ship wears a dark slate plate with white text
([VesselLayer](src/map/VesselLayer.ts), `NAME_PLATE`). An aircraft, since
2026-09-11, wears its callsign on a blue plate (`#1e40af`, white text –
[AircraftLayer](src/map/AircraftLayer.ts), `NAME_PLATE` there): the sky's
colour, and one no line badge wears as a plain dark ground. Bare text on
land, a dark plate on water, blue in the sky, traffic in colour: that is how
the fleets are told from the network at a glance, so do not give any of
the four the look of another.
The cards keep to the same divide ([card-parts.tsx](src/components/card-parts.tsx)
holds their head, tiles and chips): the city card wears the network's
green, the line and the vehicle card the line's own colour – in white ink
on the deep colours and in near-black on the light ones, chosen by the
colour's luminance (`headInk`; Rostock's light-blue bus 19 and orange
line 6 were unreadable in white) – the vessel card the plate's slate
(`bg-slate-800`), the aircraft card the plate's blue (`bg-blue-800`), and
the stop card the plain card, no colour at all. Do
not paint the ship's card green to match, and do not give a stop a line's
colour – a stop is the network's furniture, not a line's.

The stop names are deliberately the *quietest* of the three. They had a light
plate until 2026-09-08 — white, then a grey pill — and whatever its colour it
was the brightest thing over Google's tiles and outshouted the line badges. A
vehicle is the news, a stop is the furniture; if the stop names ever draw the
eye before the badges do, that is the bug. Do not give them a plate back.

**A picked thing lights up the same way, whatever it is.** The selected
vehicle's body is washed toward white and rimmed in a 2.5 px silhouette
(`applyVehicleAppearance`), and since 2026-09-10 the selected ship's hull is
too (`VesselLayer.setSelected`, `applyVesselAppearance` – the constants there
are the vehicles' own, borrowed by name), and since 2026-09-11 the selected
aircraft's body (`AircraftLayer.setSelected`). A ship or an aircraft carries
no line colour to brighten, so the blend goes to white itself; everything
else is shared. If a fourth kind of thing ever becomes selectable, it takes
the same two marks rather than inventing a third.

**"Zoom to line" clears the stage, and every layer that draws on it has to
join.** `CesiumMap.focusLine` pulses the line's route for
`ROUTE_PULSE_DURATION_MS` and takes everything else off for exactly that span:
the other routes (`RoutesLayer.startPulse`), the other lines' badges
(`VehicleLayer.startLineFocus`), the discs and names of every stop the line
does not call at (`StopsLayer.startLineFocus`), every ship name
(`VesselLayer.startLineFocus` — no ship belongs to a line, so all of them go)
and every callsign plate (`AircraftLayer.startLineFocus`, the same reason).
Bodies and hulls stay: a name is what covers a route, a body is where the thing
is. None of the three needs a timer — the badges and the ship names expire in
their layer's next sync, the stops in the next frame's `update()`, and the
pulse keeps frames coming to its very end. A new layer that puts something over
the map and does not join is the one thing left standing on the route the pulse
is pointing at, which is how the stops and the ships were found on 2026-09-09,
long after the pulse itself was built.

**The cards state facts the sources state, not simulation results.**
[line-profile.ts](src/lib/line-profile.ts) and
[city-profile.ts](src/lib/city-profile.ts) carry no travel time, no speed
and no vehicle-kilometres, because the app invents those from a cruise
speed and a fixed dwell; a card claiming them would present an assumption
as timetable. The live rows ("Out now", the counts in brackets after the panel's
group headers) are the simulation's and say so by changing. Two measures on the
city card are named carefully on purpose: *stop positions*, not stops
(one per OSM platform node – Doberaner Platz is eight), and *line
kilometres*, not network length (a shared corridor counts once per line).
The service day is the two ends of the longest pause between departures,
not the smallest and largest departure – a feed codes a night bus's 00:30
as 24:30 of the day before and another line's 00:03 as the day's own, so
min/max spans 28 hours in Rostock and reads as a quarter of an hour in
Berlin. A pause under an hour is "round the clock", which the hourly night
buses make true for all cities but two; Lübeck and
Wilhelmshaven keep a night.

**Cesium cannot stack labels — a crowd has to be decluttered, not layered.**
A `LabelCollection` keeps two BillboardCollections of its own, one for every
background and one for every glyph, and updates them in that order: every
plate is drawn, then every name on top of every plate. So a name is never
covered by the label in front of it, whatever the plate's opacity — an opaque
ship plate was tried on its own first and a busy Warnow still came out as a
pile of overlapping names. Do not reach for opacity to fix that; it cannot
work.

`keepNonOverlappingLabels` in [screen-rects.ts](src/map/screen-rects.ts) is
the cure, and both the stop names and the ship names run through it: nearest
wins, the losers are hidden, the webcam pictures are claimed before any label.
It takes the plate's geometry per call (`STOP_LABEL_METRICS`, `NAME_METRICS`)
because the two plates are different sizes, and it is pure so it can be tested
without a scene.

The vehicle badges need none of it: they are canvas billboards, which *do*
occlude one another, and a line number is small enough that a pile of them
still reads. Keep all three plates opaque either way.

---

## URLs and the pages under the map

**The city is the path, the rest is the hash.** `/berlin/` is Berlin,
`/en/berlin/` Berlin in English, `/` and `/en/` the front door
([src/lib/site-path.ts](src/lib/site-path.ts)). Until 2026-09-10 the city
was `#city=berlin` – one URL to Google for every city, and a shared link's
preview was the site's. That form is gone without a trace: there were no
links out there to keep alive, so nothing reads it, `HashUiState` has no
city field, and it must not get one back. The path carries the language the interface
speaks (`getLanguage()` at write time), so a link opens the way it was
seen; `?lang=` wins over the `/en/` prefix for one visit and the next
write moves the path. The welcome screen decides on the path too
(`welcomeWanted` takes the pathname first). An edited path is a page
load; only the hash is applied live (`applyHash`), and a hash naming no
city keeps the city on screen rather than jumping to the default. A slug
must never be one of `RESERVED_PATH_SEGMENTS` (`en`, `api`, `assets`,
`cesium`, `models`, `og`) – `tests/cities.test.ts` pins it, and the
parser names no city for them.

**Every page is built twice: once by the app, once by the build.** The
prerender plugin in [vite.config.ts](vite.config.ts) runs
[src/lib/site-pages.ts](src/lib/site-pages.ts) through Vite's module
runner – the module speaks the app's `@/` aliases and loads a city the
way the app does, which the config's own tsconfig cannot resolve, hence
the local `SitePagesModule` type there – and writes `dist/<slug>/index.html`
and `dist/en/<slug>/index.html` for every city plus the two front doors
and `sitemap.xml`; in dev the same page goes into the index.html served
for the path, so what a crawler would see is a reload away. A page is the
built index.html with its `lang`, the tags between the `<!-- page:head -->`
markers and the content between the `<!-- page:body -->` markers replaced;
the markers stay, so the built root file takes each city in turn, and
`applyPage` throws when they are gone – a build without the pages must
not pass quietly. The content is what the city card states and nothing
else (facts the sources state, no simulation results, *stop positions*,
*line kilometres*), in the interface's own words from both i18n tables
(the `page.*` keys). It carries its own `<style>` – the one exception to
"styling lives in the markup", because it has to read with the bundle
missing, which is exactly the case it exists for; it also lifts the
`overflow: hidden` that index.css puts on html, body and `#root` for the
map, or the page would end at the fold. It is hidden before the body is
parsed: an inline script in index.html's head puts `has-app` on the root
element and the page's stylesheet hides it under that class – `main.tsx`
alone was too late, the page flashed for the moment the bundle took to
load (seen 2026-09-10). The same script takes the class off on `load`
when `main.tsx` has not set `data-app-started`, so a bundle that fails to
load still leaves the page. `main.tsx` then hides it for good
(`showStaticPage(false)`) before the first render and
[ErrorBoundary](src/components/ErrorBoundary.tsx) shows it again with a
notice when the viewer throws – no WebGL, most likely; a white page said
nothing before. Googlebot renders without WebGL, so that fallback is
exactly what Google reads. `e2e/static-page.spec.ts` proves both in a
Chromium started with `--disable-3d-apis`: the page a reader without
scripts gets, and the notice over it when the viewer cannot be built.
Measured 2026-09-10: every city loaded and profiled in under a second,
~200 MB of heap, in `closeBundle`.

**The link previews are committed, not built.** `scripts/build-og-images.mjs`
draws `public/og/<slug>.png` with sharp – two per city where the German
and English names differ (`ogImagePath` in site-pages.ts is the one rule,
the script follows it) and one for the front door – because the picture
carries text and text rendering depends on the fonts of the machine that
draws it; the CI runner's would differ from a local run. A new city needs
a run of the script; `tests/site-pages.test.ts` fails otherwise.

---

## Cities and the data pipeline

The cities in the build are listed in [src/cities/definitions.ts](src/cities/definitions.ts);
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

### Switching cities at runtime

A city switch is a swap, not a reload. `CesiumMap.clearCity` takes the routes,
stops, lamps, vehicles and bridge decks down, the app's own cleanup stops the
pollers, drops the selections and lets the chase go, and on a flight both
happen halfway through it (`CITY_HANDOVER_FRACTION`, see `setCity`). What
survives is every layer *instance* and everything it still holds — which is
where three bugs of one family were found on 2026-09-09:

- **Anything keyed by an identifier needs the thing that actually
  distinguishes it in the key.** Line numbers repeat between cities (24 of
  Frankfurt's 37 are numbers Berlin has too) and the simulation's trip ids are
  `lineId-direction-minute` (`simTripId`), so they collide as well. The badge
  cache handed the next city the colour of the line it had drawn first, and
  the diagram's dots did the same — `badgeCache` carries the colour in its key
  now, `LinearView` repaints a dot whose colour changed under it.
- **What is drawn per city goes down with the city.** `LinearView.buildRows`
  rebuilds the rows but used to leave the dots hanging, so the city the
  diagram was closed in was still on it — nothing syncs a hidden diagram.
- **What the reader switched on has to reach the city that arrives.** The
  underground view outlives the switch, and every layer reads the flag as it
  draws — except the stop billboards, whose colour is written once when they
  are made, so a city entered from below wore its surface stops solid over
  the tunnels. `StopsLayer.add` applies it per record now.

The AIS fleet is the exception that is fine: `clearCity` deliberately leaves
it alone and the app's next tick syncs the new city's ships in, an empty list
first. Async work started in the city being left is guarded everywhere it
lands — the wagon models by record identity, the webcam pictures by their
record, the height bootstrap by `bootstrapGeneration`; keep it that way.

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
`__mg3d.tilesetStatus() === 'google-3d-tiles'` **and** `tileset.tilesLoaded &&
statistics.numberOfTilesWithContentReady > 50` held ~2 s (`tilesLoaded` is true
before the first request), then `gl.beginQuery(ext.TIME_ELAPSED_EXT)` /
`viewer.render()` / `endQuery` per frame. Runtime toggles: `scene.msaaSamples`,
`scene.shadowMap.size` (4 cascades → the texture is 2×size square!),
`viewer.resolutionScale`, the `mg3d_tilt_shift` stage in
`scene.postProcessStages`. `viewer.shadows` must be overridden via
`defineProperty` — `applyShadowState` re-sets it every tick. City comes from the
path (`/berlin/`). The dev build inflates React (jsxDEV).

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

**The time-lapse and a playing camera path pace the whole view (since
2026-09-11).** "In view" is bounded by a render range – 20 km for a
vehicle, 5 km for a ship, at the reference lens – while their labels are
drawn out to 35 km, so a label between the two moves only when
something else earns a frame: at real pace that is the deliberate
economy, under the time-lapse it was stop-motion, and so were the
clouds, whose drift was carried forward in the 250 ms UI block. So the
loop sets `CesiumMap.setPaceWholeView(clock.speed > 1 ||
cameraPathPlaying)`, and with it: both layers count a vehicle or ship as
in view wherever its label is drawn (`host.paceWholeView`), the clouds'
drift is carried per tick and paces the ticks like a fleet does
(`CloudLayer.screenMotionPxPerSecond`), and the tick interval follows
the fastest of the three. At ×1 nothing changes – the idle costs above
were measured there and stay. `renderPacing().paceWholeView` says which
mode is in force; `e2e/app.spec.ts` (time-lapse) and
`e2e/camera-path.spec.ts` pin it.

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
- The desktop's shadow cascade is **8192** (a 16384² texture, ~1 GB — Cesium
  packs the 4 cascades 2×2). The user deliberately raised this back from 4096
  for the shadow edge. **Do not propose lowering it again**; the 256 MB /
  ~2.5 ms it saves are known and were weighed. It lives in the desktop
  profile now (below), which is the only place the number is.
- **Every rendering number above is the desktop profile's.** Since
  2026-09-10 the map draws from a `RenderProfile`
  ([src/lib/render-profile.ts](src/lib/render-profile.ts)) handed in by
  `App.tsx`: two tiers, `desktop` with every number as measured here and
  `mobile` – a touch screen whose shorter side is under 900 CSS px, or
  any device reporting 2 GB or less – with a 2048 cascade (64 MB), no
  MSAA, a pixel-ratio cap of 1.5, tiles at 8 CSS px instead of 6, a
  384 + 192 MB tile budget, a 100k tile-tree limit, bodies out to 2 km
  instead of 3.5, a 600-drop rain pool and no ship effects (smoke,
  wakes). `?tier=` forces either;
  `__mg3d.renderProfile()` and `__mg3d.shadowMap().size` show what is in
  force. The mobile numbers are a first cut, chosen for memory (a
  mid-range phone gives a tab well under a gigabyte) rather than
  measured frame by frame – measure on a phone before tuning them, with
  `renderPacing()` and `tileMemory()`, the same way the desktop's were.
  A new rendering knob goes into the profile, not beside it.
- **MSAA is 2×** since 2026-09-08 (`msaaSamples` in the `Viewer` options), down
  from Cesium's default of 4. It was the most expensive item in a frame — 11.7 of
  the home view's 19 GPU ms — and the sampling rate is spent almost entirely on
  this map's own strokes: 4× against 1× differs in 17 % of the pixels, 4× against
  2× in only 14 %, nearly all of it route-polyline edges. There is no `?msaa=`
  URL knob; `__cesiumViewer.scene.msaaSamples = n` plus `__cesiumViewer.render()`
  changes it live (values 1, 2, 4, 8; the setter silently clamps to the driver's
  `gl.MAX_SAMPLES` and the multisample path is gated on `> 1`).

### Animated effects are stateless shaders, not particle systems

The ships under way trail exhaust since 2026-09-11
([src/map/FunnelSmoke.ts](src/map/FunnelSmoke.ts)): one instanced
DrawCommand after StopDiscs' pattern, twenty puffs per ship, and the
vertex shader places every puff from (seed, time) alone – born at the
funnel that many seconds ago, risen, carried by the apparent wind
(the weather's wind minus the ship's speed, so the plume trails aft),
grown and thinned. The reason it is built this way and not with
Cesium's `ParticleSystem` is the event-driven rendering above: a
particle system simulates from frame to frame, and after a 15-second
heartbeat gap it lets every particle die and emits the whole gap's
worth at once. A stateless plume is right in any frame whatever the
last one was; the same argument applies to any animated effect added
here. Its clock is the ships' (`VesselLayer.sync`'s `nowMs` – the wall
clock live, the simulated one in a replay), so a pause holds it, and
it runs at most `PLUME_MAX_RATE` (3×) real time under the time-lapse.
It asks for frames the way the ships and the clouds do – once its own
motion since the frame last drawn is a visible step at the ship's
distance – and it counts as a moving ship for the tick rate. Which
hulls smoke is `VESSEL_MODELS[…].funnel` (five of thirteen; the
shipyard's `mesh.funnel` is pinned against it in
`tests/vessel-models.test.ts`), from `SMOKE_MIN_SOG_KN` over the ground,
within `SMOKE_MAX_DISTANCE_M`. Offline the shader compiles and draws –
`e2e/ship-effects.spec.ts` puts a ship on the map through
`__mg3d.setAisVessels` and reads the plume off the canvas – and the
primitive draws in the render pass only: no pick, and nothing in the
offscreen passes, or a hull would be clamped onto its own smoke.

The wake ([src/map/Wake.ts](src/map/Wake.ts), same day) is stateless
in a different way: it is placed from the ship's **past**, not from a
clock. For every age up to `WAKE_LIFE_S` (40 s, every 2 s) the layer
asks where she was – `playbackSample` on the AIS track, the timetable
through `Simulation.positionAt` for a scheduled ferry, which is why
`CesiumMapOptions.vehiclePositionAt` exists – and lays ribbons: the
wash from the trailing end of her hull at each pose (the end her
motion leaves behind; her course over the ground against her heading
is going astern and washes at the bow), the bow wave along the flanks
of the leading end, the two Kelvin arms at tan 19.47° of the distance
behind it. A turning ship leaves a curved wake, a stopped one keeps
the wash she left (a still pose only breaks the ribbon), and the layer
keeps reading the track for a wake's length after her last tick under
way (`wakeUntilMs`; the ferries ask the timetable whether she moved a
wake ago). First built as flat discs – it read as a string of pearls
with rings, "zu billig", and was rebuilt as ribbons the same day; the
look to match is the wakes Google's own water tiles carry. The ribbons
lie in the water's tangent plane on the hull's clamped height, and
their depth is written from a point pulled `WAKE_DEPTH_BIAS` (0.3 %)
nearer the eye: Google's water is a mesh of baked waves a flat ribbon
would sink into, and `polygonOffset` is useless under the logarithmic
depth buffer (the depth is written from the fragment shader) – the
bias is the one trick that keeps the foam over its water and still
behind a quay. The replay's track window reaches
`AIS_REPLAY_TRACK_LOOKBACK_MS` (90 s) behind the sampled instant for
this. Two `Wake` primitives, one per fleet, because the two layers
start and commit their sets at different moments of the tick.

### The city handover is one frame – nothing may pile up in it

The map changes hands halfway through the flight to the next city
(`CITY_HANDOVER_FRACTION`), and everything the new city puts up lands in the
single `scene.render()` after it. Measured 2026-09-10, headed Chromium on the
real GPU, production build, `?offline=1`, Munich → Berlin: the worst frame gap
was **398 ms** where a quiet frame is 19 ms — the freeze you can see mid-flight.

The ablation, each by skipping one call and measuring again: routes 0 ms
(`addRoutes` makes no difference), the fleet 0 ms (a budget of 60 new vehicles
per tick changed 398 to 370), the badges 28 ms for all 69 of them, and
**`addStops` 324 ms** — of which 300 ms were the 2682 stop-name canvases and
their atlas upload. Not the JSON: Berlin's three files parse in 12 ms, before
the handover. So the name plates are drawn on approach now
(`STOP_NAME_BUDGET`), which took the handover to **75 ms**.

Two lessons worth keeping:

- **Measure this headed.** Headless SwiftShader made `toDataURL` cost 33 ms a
  badge (2.3 s in total) and sent the first investigation after the badges;
  on the real GPU the same call is 0.41 ms. Canvas readback is exactly what
  software rendering distorts.
- **`StopsLayer.update()` rides the simulation tick, not the frame** (it is
  called from `CesiumMap.syncVehicles`), and that tick is 500 ms while the
  clock is paused with nothing in view. A per-pass budget therefore has to be
  large enough to converge at 2 Hz, not just at 30 Hz — 24 names a pass took
  1.6 s to fill a close view, 48 takes under a second, and a pass of 48 costs
  about 9 ms.

### `camera.lookAt` does not give back the pitch it was given

It places the camera by the local vertical at the **subject**, while
`camera.pitch` measures the view against the vertical where the **camera**
stands, and the earth curves between the two: at the 140 m chase range that
is a constant 0.0012°, always in the same direction. So a loop that reads the
camera's pose and re-applies it — which is what `FollowCamera.update` did for
a follow left in free orbit — adds that much every frame. Measured 2026-09-10:
the camera climbed ~0.035°/s, minutes of following and it is looking down from
above. Reproduced with a standing subject: ask for −16.0000°, read back
−16.0012°, ask for that, read −16.0024°.

The cure is to keep the offset as the authority and never adopt a reading as
a value: `FollowCamera` remembers the pose the camera reported right after its
own `lookAt` (`applied`) and moves the offset by the **difference** from it,
so a hand that stays still contributes exactly zero. Anything else that steers
this camera per frame has to hold its readings against the same reference.

### Tile LOD: check the memory ratchet first

Cesium raises `memoryAdjustedScreenSpaceError` by 2 %/frame whenever selected
tiles exceed `cacheBytes + maximumCacheOverflowBytes`, **silently overriding
every LOD knob**. Before proposing any SSE change, check
`window.__mg3d.tileMemory()`: `effectiveSse > configuredSse` means the ratchet is
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
by URL → one region per line+colour+delay). The colour belongs in the badge
cache's own key for the same reason it belongs in the atlas's: `badgeCache`
outlives the city switch, and a line number met in an earlier city otherwise
keeps that city's colour while its card shows the right one (fixed 2026-09-09;
up to 24 of a city's lines were wrong after one switch).
`WebcamsLayer.clear` destroys its collection per city for the same reason.

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
in a headless Chromium, wait for `__mg3d.tilesetStatus() === 'google-3d-tiles'`,
then check `__mg3d.lastLoopError()` and the console. Google tiles answer many
requests with HTTP 429 under SwiftShader, so only coarse tiles load — enough to
prove the shader compiles, not enough to judge the look.

**The offline globe still has tiles, and a spec that waits for them has
to mind its pose.** The grid imagery refines by the globe's screen-space
error like any imagery, and a view along the water from a low camera
(60 m up, pitch −10°) selects ~150 tiles – the CI runner's software
renderer, which loads a handful per frame at a few frames a second, did
not get them in within a minute, twice in a row (2026-09-11,
`e2e/ship-effects.spec.ts`); the same scene looked at steeply from
400 m needs 29 and straight down from 700 m 18. A spec that polls
`renderPacing().tilesLoading` before comparing frames (the clouds, the
ship effects) keeps the horizon out of the frame; measure with
`scene.globe._surface._tilesToRender.length` before choosing a pose.
The same runner is slow enough to show the other seam in a
before/after picture: a ship put on the map wears a placeholder box
until her glTF hull is in (`VesselLayer.attachModel`), and a frame
taken a second after `setAisVessels` had water where the next one had
the hull. The spec waits for the model (`hullReady`), and it keeps its
frames in the page – four million numbers over the wire cost that
runner half a minute per frame.

### `window.__mg3d`

The debug/test API ([src/App.tsx](src/App.tsx), `Mg3dTestApi`) is the first stop
for any "the map is doing X" question: `tileMemory()` (incl. `tilesTotal`,
`replacing`), `renderPacing()` (incl. `tickIntervalMs`, `motionPxPerSecond`),
`renderRate()`, `shadowMap()`, `tilesetStatus()`, `lastLoopError()`,
`cloudState()`, `funnelSmoke()`, `wake()`, `tiltShiftState()`,
`groundHeights()`, `aisReplay()`, `aircraftCount()`; `setAisVessels(list)`
and `setAircraft(list)` put a fleet on the map where no poll runs (offline,
the tests).

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
`.env`; production reads `aisstream.io-api-key.txt` and `windy-api-key.txt`
from the folder above the docroot – two levels up from the scripts in
`api/`, which is how they look for it (see the header comments in
[server/api/ais.php](server/api/ais.php) and
[server/api/webcams.php](server/api/webcams.php); the README's Deployment
section draws the layout). Keys are never `VITE_`-prefixed. The webspace
moved on 2026-09-11 from `apps/mini-germany-3d/` (docroot, key beside it
in `apps/`) to `websites/mini-germany-3d/website/` (docroot) with the key
and the archive in `websites/mini-germany-3d/` – nothing in the code
changed for it, only `KAS_TARGET_DIR` and the domain's path in KAS.

Which real vessels the map already runs from a timetable — so their AIS twins
are left out of the backdrop — lives per city in `city.json` under
`ais.simulatedByMmsi` (Rostock FG/FW, Kiel F1/F2, Hamburg 18× HADAG).

**A ship is shareable (`#vessel=<mmsi>`, since 2026-09-10) but not
reproducible.** The MMSI is as stable an id as a trip id, yet whether she is
still in the harbour is the harbour's business, so the restore is the
vehicle's mechanism with a longer fuse — `SHARED_VESSEL_TIMEOUT_MS` is 90 s
against the vehicle's 20 s, because a trip is in the very first snapshot the
simulation makes while a ship waits for the poller's first answer and then for
her own next fix. It expires silently, and it must stay that way: a link that
opened an empty card would be worse than one that opens the harbour.

**The harbour is recorded, and a clock set back replays it (since
2026-09-11).** Every fix the keeper hears also goes into an archive – one
NDJSON file per city and UTC hour, a snapshot of every ship alive at the
top of each so an hour reads on its own, three days kept
(`AIS_ARCHIVE_KEEP_HOURS`), the writer in
[src/lib/ais-archive.ts](src/lib/ais-archive.ts) with its PHP twin in
`ais.php` and `scripts/test-ais-archive-parity.mjs` holding the two to the
same files. The app asks the same endpoint for `&hour=…` whenever the
simulated clock is more than a minute behind the real one
(`aisReplayWanted`), polls the open hour's tail (`&from=<byte>`) every
20 s, and hands the layer the fleet as of the simulated moment with that
moment as its clock. Decisions that should not be re-litigated: the
replay renders `AIS_PLAYBACK_DELAY_MS` behind the *simulated* clock,
exactly as the live fleet renders behind the real one – not for the data
(the archive is complete) but because it is what makes the two sources
meet without a jump, at the edge and after a pause; a clock set ahead is
live (the user's choice), a pause holds whichever source drew the
picture; where nothing was recorded – before the archive began, an hour
the keeper missed, a day older than the retention – the water is empty,
never today's ships on yesterday's date. The calendar in the panel offers
the two days behind today for exactly this (`DATE_PICKER_DAYS_BACK`), the
timetable being the same service day throughout. Two traps: the archive
directory is **above the docroot** beside the API keys (`ais-archive/`),
because the deploy's `rsync --delete` empties the docroot nightly – never
put it, or anything else written at runtime, under `dist/`; and
`src/lib/ais-archive-fs.ts` is Node-only and excluded from
`tsconfig.app.json`, so a unit test cannot import it – the writer is
tested against an in-memory store, the file store through the parity
script. The first hours after a deploy are thin: the archive starts with
the first window after it, and a moment before that is an empty harbour.
`__mg3d.aisReplay()` says whether the replay is on, which hours are held
and how many ships the recording places at the simulated moment.

**Ships are clamped to the tiles, and the clamps are rationed.** Until
2026-09-08 every ship sat on sea level plus the calibrated offset, which put
Frankfurt's fleet 87 m and Berlin's 31 m under the tiles (the Main is a
staircase of lock reaches, Berlin sits on two water levels). Two cures were
built and compared the same day: a measured water surface per lock reach in
`city.json` (more data, more logic; shelved) and a `scene.clampToHeight`
pick per hull ([VesselLayer](src/map/VesselLayer.ts)), which the user chose
for being less code. Measured cost: 1.4 ms per pick, an offscreen render
with a `readPixels` stall, so never clamp per tick — the layer picks only
for ships on screen and only when the ship moved 25 m or the tileset's
`allTilesLoaded` fired (`surfaceGeneration` in `CesiumMap`), capped at
three a tick; a fleet at rest costs nothing. The pick answers with whatever
LOD is loaded (coarse and fine differ by metres, a ship at a quay can land
on a baked-in crane or on Google's own photographed hull), which is why the
generation bump re-reads it after every load cycle. The ships' own
primitives are on the pick's exclusion list, or a hull would be set on its
own deck. The **scheduled ferries** (VehicleLayer, mode `ferry`) float the same
way since 2026-09-08: the same `clampToSurface`, 3 picks a tick, again
after 25 m or a `surfaceGeneration` bump, the route profile until the
first answer, with hull, badge and the line's own polylines on the
exclusion list; `FERRY_FLOAT_LIFT` stays on top for the mesh's crests.
The **ferry route lines** drape over the tiles the same way
since 2026-09-08: `clampToGround` polylines, the per-frame classification
every other route avoids, because NHN 0 plus offset plus a 1.25 m lift
(`FERRY_ROUTE_EXTRA_LIFT`, gone) still dipped into the water or floated
over it. A clamped line does not pulse on "zoom to line" (Cesium's
per-material batch does not re-evaluate colours per frame). Offline the
ferry lines lie on the ellipsoid like every other route. `tileset.getHeight` (CPU, 0.3 ms) was rejected: it answered for
only half the fleet. `sampleHeightMostDetailed` was rejected harder: it
loads the finest tiles under every ship (10 000 tiles and 100 MB for one
fleet) and feeds the tile-tree leak.

**Bridge decks are measured on the tiles too, with a CPU ray, not a pick.**
The pipeline's bridge profile is a straight deck between the terrain heights
at both ends of a bridge range (`applyBridgeProfile`); the terrain model is
bare earth, so a viaduct whose ends meet the ground comes out at street
level – Berlin's Stadtbahn (one 6.2 km bridge range, OSM tags it
correctly) had the S-Bahn in its own arches and 10 m under the
Hauptbahnhof's upper level, and every Hochbahn (Berlin U1/U3, Hamburg U3,
Cologne 13) is the same case. Since 2026-09-08
[bridge-decks.ts](src/map/bridge-decks.ts) reads the deck off the tiles per
route vertex inside a bridge range, plus stations every 30 m where a
straight bridge way has none (Frankfurt's Friedensbrücke: one vertex in
289 m; the routes draw through the stations) – on screen only, 6 per 200 ms pass,
nearest first, again after each `surfaceGeneration`, kept for the visit,
one point shared by every line on the same OSM way (Berlin: 1281 points
for 107 directions) – and vehicles and route polylines take it, blending
into the profile at the portals (`heightAt`). It uses `tileset.getHeight`, the tool the ships
rejected, for two reasons that do not apply to ships: a route vertex has
the route's own polyline drawn exactly on it at exactly the wrong height,
which `clampToHeight` would pick without a long exclusion list (badges,
stop names, lamps too), and a vertex that gets no answer this pass is
simply asked again; measured 2026-09-08 on real tiles: ~1 ms a ray. A ray
answers with whatever is on top, or – where the mesh lost a thin bridge,
as at the Humboldthafen – with the water underneath, so a sample is
trusted only 2.5 m and more above the profile (`DECK_ABOVE_PROFILE_M`;
between 1 m and that it is weak and sets its own point where no trusted
one encloses it – the Friedensbrücke's deck stands 1.3 m over the
profile – and below that the profile stands, which is right at a portal
and no worse than before over a hole), and among the trusted ones station halls (the
Stadtbahn's stand 12–16 m over the rails, the Hauptbahnhof's 8 m over the
southern tracks) and survey-day trains are pruned as samples no deck
could climb to from their neighbours at the mode's gradient
(`pruneRoofs`, a slope-limited lower envelope; `DECK_MAX_GRADIENT`: 3 %
rail, 5 % tram, 8 % bus – a steeper real ramp is softened to it, and a
hall longer than twice its roof height over it keeps a tent in its
middle). Route rewrites are rationed to one per direction per second –
each re-batches the polyline geometry. Stops on a
viaduct are untouched: they already re-measure themselves near the camera
(`StopsLayer.resolveHeights`). `__mg3d.bridgeDecks()` shows the progress,
`__mg3d.bridgeDecks(lineId)` a line's vertices with sample and verdict.
Real fix, if ever wanted: a surface model (DOM1) for bridge ranges in
`data:heights`; it was weighed against this and deferred for needing one
source per state.

For any AIS change, mind the PHP/TS parity: `scripts/test-ais-parity.mjs`,
`scripts/test-ais-state.mjs`, `scripts/test-ais-archive-parity.mjs` and
`scripts/test-php-parser.mjs` run in CI. If ships appear undersized, check
production for null `lengthM` first — that is a learning/window problem, not a
model bug.

---

## ADS-B (live air traffic)

Built 2026-09-11 after the AIS pattern: `/api/aircraft?city=<slug>` (the
Vite middleware, `server/api/aircraft.php` in production, the extraction
shared in [src/lib/aircraft-extract.ts](src/lib/aircraft-extract.ts) and
held to the PHP twin by `scripts/test-aircraft-parity.mjs`),
[AircraftLayer](src/map/AircraftLayer.ts) after VesselLayer, an
`AircraftCard`, `#aircraft=<hex>`, `?aircraft=0`, the panel row after the
ships. Decisions, taken with the user, that should not be re-litigated:

- **The source is adsb.fi's open data API** (`opendata.adsb.fi/api/v3`),
  a readsb aggregator with second-by-second updates, no key, one request
  a second for personal use, and a link asked for in return (the layer's
  static credit). OpenSky was the alternative and lost on resolution (10 s
  anonymous, 5 s registered, credits per day). Both sides keep the rate
  limit for every city together: a 4 s per-city TTL and upstream calls
  spaced a second apart, in PHP through the lock file's mtime. If adsb.fi
  ever requires a key for non-feeders (adsb.lol has announced it), the
  same shape is spoken by airplanes.live and adsb.lol – only the URL and
  the query helper (`adsbQuery`) would change.
- **No altitude filter.** The user wants the traffic at cruise as much as
  the approach, so every aircraft over the city is drawn, at 12 km up as
  at 400 m. The plates are drawn out to 60 km and the bodies to 40 km for
  that reason. A wide-body at cruise is a few pixels and its plate; that
  is the picture asked for.
- **The sky is a circle, not the box.** The endpoint serves everything
  within the circle it asks adsb.fi for – the box's corner distance plus
  `AIRCRAFT_MARGIN_NM` (6 nm) – while the camera's leash stays the box.
  Since 2026-09-11, for the soft end of a follow: where the chase would
  carry the camera out of the box, `FollowCamera` parks it at the edge
  (`clampToLeash` on every layer host, `CesiumMap.clampToLeash`) and
  looks at the subject from there, turning after it until it leaves
  the circle a minute later and the card closes. Before, the aircraft
  vanished at the box's edge and the follow ended with the camera
  snapping back inside. The ships get the same soft end at the box's
  edge, though their data still ends there. `e2e/aircraft.spec.ts`
  flies one out over Rostock's eastern edge.
- **Live only, no archive.** A clock set into the past shows an empty sky
  (`aisReplayWanted` decides, as for the ships – there is no recording to
  replay, and yesterday's clock must not show today's aircraft). A
  recording after the AIS archive's pattern is the obvious follow-up and
  was deliberately left out of the first cut.
- **Heights.** `alt_geom` is a height above the WGS84 ellipsoid and goes
  into Cesium as it is; where an aircraft reports only `alt_baro` the
  layer adds `routes.heightOffset` (the geoid height the routes are
  calibrated against) and lives with the pressure error. An aircraft on
  the ground is clamped to the tiles like a ship (three picks a tick,
  again after 25 m or a `surfaceGeneration` bump); nothing else is
  clamped – the feed's number is the truth.
- **Playback 12 s behind, reckoned 20 s ahead.** The ships wait at their
  last fix when data dries up; an aircraft flies on from its last speed,
  track and climb rate for `AIRCRAFT_RECKON_MAX_MS`, then freezes –
  hanging in the sky is the lesser wrong, flying into a building the
  greater. An aircraft unheard for `AIRCRAFT_EXPIRE_MS` (60 s) leaves.
- **Pose.** The nose follows `true_heading` where reported (the crab
  angle off the track), the pitch is `atan2(vertical rate, ground speed)`
  capped at 12°, the bank is the reported `roll` or the coordinated turn
  the track rate implies, capped at 35°. Cesium's HPR frame: positive
  pitch is nose up, positive roll is right wing down, which is what
  readsb's `roll` means too.
- **Bodies.** Seven archetypes in `scripts/lib/aircraft-fleet.mjs`,
  stretched per type from the table in
  [src/lib/aircraft-info.ts](src/lib/aircraft-info.ts) (ICAO designator →
  archetype, length, span, height; the emitter category as fallback). A
  helicopter's length there is the fuselage's, nose to tail rotor, not
  the "rotors turning" figure – the model is built that long.
  `tests/aircraft-models.test.ts` pins the GLB bounds against
  `ARCHETYPE_SIZE` and `AIRCRAFT_DIMS`. Surface vehicles (emitter
  category C) are dropped in the extraction: the map has no body for a
  follow-me car. Rounder than the vehicles on purpose (the user asked,
  2026-09-11: "ein wenig mehr Polygone ist in Ordnung"): sixteen-sided
  fuselages, nacelles and wheels, up to ~1700 triangles, the budget in
  the test 2500. The first cockpit was a box and broke through the nose
  taper on every side – glass is laid ON the shell now (`glaze` in the
  workshop: the extrusion's ring at any length, interpolated as its faces
  are), never as a solid poked into it. The first glazing was also big
  rectangular panes and a dark wrap-around cockpit, which the user read
  as a WWII bomber (2026-09-11): the cabin windows are a row of small
  octagonal portholes at an airliner's frame pitch (`portholeRow`, one
  fan of nine vertices each – most of a model's triangles), the cockpit
  a narrow band of three panes a side from 20° to 55° above the centre
  line, and the nose drops away under it (`noseDroop`) as an airliner's
  does. Keep the windows small: at map distance a window is a dot. Rotors and propellers are
  see-through discs (`rotor` material, alpha 0.3 – the one translucent
  material; `toGlb` writes alphaMode BLEND for an alpha under 1). The
  retractable gear is a glTF node of its own (`mesh.parts.gear`, `toGlb`
  writes every part as a node), which `AircraftLayer` shows only within
  `GEAR_DOWN_AGL_M` (600 m) of the city's ground – an airliner at cruise
  with its wheels out read as a toy. The vehicle and vessel GLBs came out
  byte-identical through the writer change; keep it that way.
- **Lights.** [NavLights](src/map/NavLights.ts) is one
  PointPrimitiveCollection per layer, pooled, fed begin/add/commit per
  tick like the plumes; what is on comes from the clock alone
  ([src/lib/nav-lights.ts](src/lib/nav-lights.ts), pure, tested) – the
  stateless rule again, so a pause holds every flash. Aircraft: red
  port, green starboard, white tail (steady), red beacons top and bottom
  (1.2 s period, 160 ms on – over 100 ms so a 100 ms tick catches it),
  white strobes at the tips (1.6 s, 120 ms) in flight only; nothing
  parked; 35 % by day, full at night. Ships: sidelights, masthead, stern
  for a ship that MOVES, the anchor light lying still with status 1,
  nothing otherwise, nothing by day. Motion is the only thing trusted:
  the nav status is set by hand and stale in both directions – the
  GRANDE INGHILTERRA came down the Elbe at 12 kn as "moored", and 139
  of Hamburg's ships said "under way" at their berths against 40 that
  moved (the tugs at Neumühlen among them, which lit up on the first
  rule). Do not bring the status back as a reason for running lights.
  The scheduled ferries (VehicleLayer) wear the same lights whenever
  they are on the map at night, dwelling at the pier included – a ferry
  in service keeps them on; `tests/cesium-ferry-float.test.ts` pins it. The screened lights show over
  their real arcs (112.5° sidelights at sea, 110° in the air, the stern
  and tail light the rest) – from the chase camera behind an aircraft
  the tail light and the strobes, never the red and green. A flash that
  changed on an aircraft on screen requests a frame; a ship's lights
  are steady and ask for none. The light positions per archetype are
  the workshop's `mesh.lights` copied into `AIRCRAFT_MODELS[…].lights`
  (glTF x,y,z → layer y,z,x), pinned by the model test; a ship's come
  from her hull's dimensions and funnel. The collections are on both
  layers' clamp exclusion lists, or a beacon over an aircraft on the
  apron would be what the apron pick hits. `__mg3d.navLights()` counts
  them per fleet.
- **Shadows and pacing** join the existing gates: the nearest drawn body
  and its span feed `applyShadowState` like the nearest hull, and an
  aircraft in view paces the ticks like a tram – the render range for
  that is 15 km at the reference lens, three times the ships', because
  an airliner moves on screen from much further out.

Verified 2026-09-11 with a live answer over Frankfurt: 50 aircraft in a
21 nm circle, 39 with `alt_geom`, 32 with `roll`, 3 on the ground, 2
multilaterated; that answer is the fixture (`tests/fixtures/adsb-aircraft.json`).
`e2e/aircraft.spec.ts` puts two aircraft on the offline map through
`__mg3d.setAircraft` and checks bodies, plates, the hash and the empty
sky in the past. Two traps met writing it: a spec that wants aircraft
must boot on the real clock – `?time=12:00`, which every other spec
uses, is a clock in the past for the rest of the day, and the sky is
empty then by design – and the injected track has to outlast the
runner's slow model loads (ten minutes around the rendered instant),
or the playback reaches the reckoning window and freezes before the
pacing assertion runs.
