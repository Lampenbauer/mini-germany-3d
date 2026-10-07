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
This was decided after a synthetic fallback ran a line that was
suspended for track works. A known gap that follows from the same principle
and is *not* modelled: construction reroutes and temporarily split routes
still run on their normal alignment.

**The data pipeline is built for the CI runner, and may be run locally
when a result is wanted now.** The nightly workflow
([.github/workflows/ci.yml](.github/workflows/ci.yml), 02:30 UTC every
night – every second night was tried, to spare Actions minutes, and
dropped again; GTFS every night, the OSM network and its heights on
Sunday nights, the lamps, airfield lights, buoys and lighthouses only on
the first Sunday of the month, to spare Overpass the lamps query, which
is the one that hits its rate limits, for data that is mapped once and
touched rarely; `refresh_osm` by hand does all of it) refreshes the committed
data files on a free hosted runner, and that runner is what every step
is designed for: never a step that needs a pre-downloaded extract or a
cache on disk – prefer on-demand fetching with in-memory caches, keep
memory modest (a few hundred MB; the GTFS step is the exception, it
holds the feed's 2.2 GB `stop_times.txt` unpacked), and make
regenerated files byte-stable across reruns so the "anything new?"
short-circuit still works. A local run of a step
(`npm run data:<step> -- --city <slug>`, with the `PREV_*` file from
HEAD as ci.yml passes it) is fine when a result is wanted now – it has
been done for the lighthouses and for the whole monthly tier – and
its files are committed like the nightly run's. Byte-stable means no
date of any shape in the file: the schedule's chosen service day
(`meta.serviceDate`, GTFS's dashless `20260910`) slipped past the
meta-date test and set the full pipeline going nearly every night for
four weeks – found with four cities whose nightly diff was
that one line. A date belongs in the run's log and the data commit's
message, where it now is. The feed download is cached under the feed's
`Last-Modified` for the same reason: the feed changes weekly, the
refresh runs nightly. The GTFS step runs ONCE for every city
(`npm run data:gtfs`, no `--city`): the feed is unpacked once and
`stop_times.txt` streamed once, each city's trips picked out of the same
rows (`prepareCity` → `scanStopTimes` → `finishCity` in
[fetch-gtfs-schedule.mjs](scripts/fetch-gtfs-schedule.mjs)); a city
at a time was thirteen scans of the same 38 million rows, 47 s each on
the runner, ten minutes a night for a minute's work. A city that fails
keeps its schedule with a warning annotation; the step fails only when
every city did. **The nightly run skips the E2E suite** (a settled
decision, to save Actions minutes – running every second night instead
was weighed, later tried as well, and dropped again): the suite is
fifteen of the run's twenty minutes and tests the code, which the night
does not change and whose push run already had it; of
the data it sees Rostock alone, offline, and what it reads there the
unit tests pin for every city. The nightly E2E failures before the
change were runner timing flakes. A manual
`refresh_data` run keeps the full suite. The accepted risk: the night
deploys `main` on the unit tests alone, so a push whose own E2E run was
left red goes out with the next data commit – keep push runs green.

**A city test pins a line as running that day, not as on the road at
one second.** The twelve `tests/<slug>.test.ts` read their line set
from `linesOutInTheMorning` in [tests/cities.ts](tests/cities.ts) – the
hour from 08:00 sampled every five minutes – and keep the 08:30
snapshot for the fleet size alone. A nightly run failed
on Berlin's 100 at 08:30:00: the feed's busiest day of the three weeks
ahead was the Friday of the Marathon weekend, on which the 100 is a
3 km shuttle Zoo ↔ Nordische Botschaften (the trips carry `spans`), 11
minutes on a 15-minute headway, and both directions were between trips
at that second – the data was right, the pin was too sharp. A new
city's test uses the helper; a line absent from it on the chosen day is
a fact to look at in the feed's calendar, not a reason to widen the
window. The count of lines with departures is the same kind of pin,
and the chosen day's weekday is not fixed either: Cologne's was a
Friday one night and a Monday the night after, on which KVB's
five weekend-night rings have no trip, and that nightly run
failed on 74 of 80 lines against a tolerance of three. A
line that runs on some days of the week alone is named in its city's
test and left out of the count (`WEEKEND_NIGHT_LINES` in
`tests/cologne.test.ts`, `PART_WEEK_FERRIES` in `tests/berlin.test.ts`),
not absorbed by a wider tolerance. Berlin's were found by
running the GTFS step in a scratch copy of the repo (`git archive
HEAD`) with its day loop held to one date and the unit suite over the
result: a Monday broke Berlin's count as well, a Wednesday nothing.

**Typecheck with `npm run typecheck`** (= `tsc -b`), never `npx tsc --noEmit`.
The root tsconfig is solution-style with project references; the `--noEmit`
shortcut skips [tsconfig.app.json](tsconfig.app.json), which is what includes
`tests/`. A tuple error in a test once passed locally and failed CI exactly
this way.

**There is no formatter, and no linter either.** The repo carries no
Prettier configuration (no `.prettierrc`, no `prettier` key in
`package.json`, no `format` script) and no ESLint config – the code is
formatted by hand: single quotes, no semicolons, trailing commas, lines
around 100 columns where the file keeps to it. `npx prettier --write`
therefore runs with Prettier's defaults – double quotes, semicolons,
80 columns – and rewrites every line of every file it touches. It did
once: four component files were restored from HEAD with
`git show HEAD:<file> > <file>` and the edits made again by hand. Do
not run it; match the surrounding code instead.

**Unit tests run in Node; a DOM is opted into per file.** The `test` block in
[vite.config.ts](vite.config.ts) sets `environment: 'node'`, and the files
that render or touch `window`/`document` open with
`// @vitest-environment jsdom` on their first line. jsdom cost ~0.7 s per
file on the CI runner – 62 s of a 217 s run when every file got one. A new
component test without the line fails loudly (`document is not defined`), so
the miss is cheap; the trap is the other way round: do not put jsdom back as
the default. The same block pins `maxWorkers: 2` under `CI`: GitHub's
standard runner for a private repository has 2 vCPUs (a public one's 4), and
Vitest 4 defaults to `cpus − 1` workers, which ran the whole suite on one
core, file after file. Measured: 217 s before, ~90 s expected after, locally
36 s → 28 s with two workers. Per-file cost is the lever from here – a new
test file costs its imports and environment in full, so a check that belongs
to an existing file goes there rather than into a new one, and an assertion
per data point (`network.test.ts` once ran four `expect`s on 331 000 path
points, 15 s) is counted instead.

**Playwright specs are written and run as cheaply as they can be.** The
e2e suite is the long pole of CI: one worker, software-rendered WebGL
(SwiftShader) on GitHub's 2-vCPU runner, about three times slower than
the development machine – the suite takes 5 minutes on that machine and
~15 of the ~18-minute run on the runner. Every boot of the page costs
10–20 s on the runner before a test can start, and every second of
real time a test waits for is a second of CI. So: one page per spec,
booted in `beforeAll` and reused across its tests where a test does not
need a fresh boot; boot with
`routes=0&stops=0&labels=0` unless the test is about them, and paused
where nothing has to move; put the map into the state under test
through `__mg3d` (`setTime`, `setAisVessels`, `setAircraft`, injected
delays) rather than waiting for it; place a subject where the test's
poll catches it within seconds, not where it takes half a minute to
arrive; poll with `expect.poll` and growing intervals, never a fixed
`waitForTimeout` longer than a couple of seconds; keep frames and
their pixels inside the page and bring only counts out (a frame is four
million numbers, half a minute over the wire on the runner); and put a
check into an existing spec when it fits there – a new spec is a new
boot. Where the behaviour is pure, a unit test is the right place and
costs milliseconds. Measure before restructuring, though: a boot is not
always the dear part – `linear-view.spec.ts` boots seven times because
a second pass through the morph on one scene cost 56 s more on CI than
the boot it replaced. Measured (the development machine, headless
SwiftShader): the suite in 4.3 minutes, the two newest specs the
outliers at 44 s and 31 s until their fixed waits and second boots went
– a negative is proved by a simulated second going by (`secondsOfDay`,
`loopTicks`), a moving subject by its known position on the wall clock,
never by sleeping.

**A change is not finished when the code works.** Every change — a fix as much
as a feature — ends with a sweep for what else already talks about the thing
you touched. Grep for the name you changed, the flag you added, the number you
moved, and follow it into:

- **[README.md](README.md)** — it is load-bearing documentation, not a summary:
  the "What you see" section, the cities table, the URL-parameter table, the
  `city.json` field list, the live-data table, the architecture tree, the
  attribution list. A new URL parameter, script, `city.json` field or terrain
  source that is not in there is only half-added. It is deliberately
  short: a decision and its reasons belong in this file, the README gets
  the one sentence a visitor needs. Its screenshots are
  `docs/screenshots/*.jpg`, made by `scripts/build-readme-screenshots.mjs`
  from the live site (the method and the views are in its header; the
  aircraft one has to be re-aimed at an aircraft that is over Frankfurt
  at the time).
- **The app's own prose** — [src/lib/i18n.ts](src/lib/i18n.ts) carries strings
  that repeat facts about the project, and it carries them **twice**, in the
  `en` and `de` tables. The About dialog lists what the map is built from
  (and deliberately never says how many cities there are – the count changed
  often enough to be a trap, so no prose anywhere states it); the keyboard
  tab lists the shortcuts;
  the credits carry the licenses. A German table left behind is the usual miss.
- **What Google, the welcome screen and the About dialog say the map is** —
  a feature that changes what the map shows changes the prose that
  describes it: the pages' descriptions and the front door's text in
  [src/lib/site-pages.ts](src/lib/site-pages.ts) (`page.description`,
  `page.cityDescription`, the mode words per city; the link previews in
  `public/og/` if the picture's words change), the welcome screen's lead
  (`welcome.lead`), and the About dialog's story (`about.project`, the
  "what is live" and "what it is not" sections, `about.built`). Ask
  whether the sentence a crawler or a first visitor reads is still the
  whole truth, in both tables. The live ships were missing from all
  three for weeks; the aircraft went in on the day they were added.
- **Code comments elsewhere** — this codebase explains its decisions in prose
  next to them, so a constant that moves usually invalidates a sentence in
  another file that quotes its old value.
- **Tests** — `tests/<slug>.test.ts` pins per-city line sets, heights and
  vehicle counts; `tests/mode-mapping.test.ts` pins the two mode knobs.
- **This file**, when the change settles something it records as open or
  describes differently.

Worked example: adding a city means `definitions.ts`, the README's cities
table *and* attribution list, `city.name.<slug>` in both i18n
tables, a new `tests/<slug>.test.ts`, a run of
`scripts/build-og-images.mjs` for its link-preview picture and one of
`scripts/build-globe-images.mjs` for the rail globe's three stills of
it — seven places, two of which compile fine while being wrong (the
pictures are what a test catches: `tests/site-pages.test.ts` wants one
per page, `tests/globe-illustration.test.tsx` three per city).

**Commits land on `main`.** Commit messages: imperative subject, prose body
explaining the *why*, ending with the `Co-Authored-By` trailer. See `git log`
for the register. A commit can be verified without touching the working
tree: `git archive <rev> | tar -x -C <tmp>`, symlink `node_modules`, run
`npx tsc -b` and `npx vitest run` in there. To run the app from such a
copy – a before/after measurement – symlink `public/cesium` as well (the
postinstall's copy, untracked): without it the dev server answers
Cesium's workers with index.html, no entity geometry is ever built, and
the copy measures a different map (a Phase 6 baseline was thrown away
for it).

---

## Interface and styling

**Styling lives in the markup.** Tailwind classes on the element, never a
per-component stylesheet. The About and Credits dialogs each had one and both
were folded back into their components; nothing should grow a
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

**A card stands at the weather button's height, and the button steps
left beside it.** `CARD_SLOT` is `top-4` like the
button's wrapper; while `cardOpen` the wrapper takes `WEATHER_BESIDE_CARD`
(`sm:right-[26.75rem]`: the card's 400 px, `w-100` in `CARD_SHELL`, plus
its 1rem from the edge plus a 0.75rem gap – a card width that changes
changes this number) with a short slide, and comes back into the corner
when the card goes. The card stood under the button before. On a phone
nothing of it applies: the card is a sheet at the foot and the button
at the upper left. `e2e/app.spec.ts` measures both places.

**A phone gets one sheet, at the foot of the screen.** Under Tailwind's
`sm` (640 px) the panel's wrapper and the card slots (`CARD_SLOT` in
[src/App.tsx](src/App.tsx)) share one place, `inset-x-3 bottom-12`
(`bottom-9` once, which left the sheet's foot too close to the credit
line: 13 px over the credit bar, 24 now – move the two together, they
are one sheet), at `z-20` over the map's controls,
which are `z-10` like every other wrapper (where a card reaches into
the rail, the card lies on top – a settled decision, after a short
phone's rail stood over the sheet's head). The credit line under
the sheet breaks between credits: Cesium writes a
credit, its "•" and the next credit with no whitespace between them,
one unbreakable run, and on a phone the line broke inside Windy's
credit 60 px short of the edge – `.cesium-credit-delimiter` is an
inline-block in [index.css](src/index.css), a soft wrap opportunity on
either side; the phone spec injects three credits and wants every line
filled. The same rule pads the bar so the line starts and ends 7 px
from the sides and stands 4 px over the bottom edge (Cesium's own 5, 5
and 3; chosen by eye) – padding, because the Viewer writes `left`,
`right` and `bottom` as inline styles on every resize and an offset
would need an `!important`. And the
panel leaves while a card is up (`cardOpen && 'max-sm:hidden'`): a phone
has room for one sheet, and the card is the one the reader asked for. The
panel opens folded there (`narrowViewport()` in
[src/lib/viewport.ts](src/lib/viewport.ts), read once – a phone does not
become a desktop mid-session) and unfolds to `55dvh`; a card is at most
`60dvh` (`CARD_SHELL` in
[card-parts.tsx](src/components/card-parts.tsx)) – and the screen less
its margin on a desktop – with its head standing and its body scrolling
under it (`CardBody`, the app's ScrollArea), never the card as a whole:
it did once, and a long stop list carried the head with the
close button and the follow off the top of the screen. Every
card folds to its head there, with the panel's fold button
(`ArrowsToLineIcon`/`ArrowsFromLineIcon`) beside the close button, and
its one action – the follow, the flight to the stop or the line –
stands in the head as an icon button before the fold button, so that
it is there with the card folded (both by design; the
city card has no action). Both are the parts' business, not the
cards': `CardShell` (the card in the shell's clothes) holds the fold
and the `action` a card declares on it (`CardAction`: label, click,
`pressed` for a running follow) and hands them down by context,
`CardHead` shows the two buttons, `CardBody` renders nothing while
folded, as the panel does, and on a desktop ends with the action as
the labelled button it always was there – a card is the three in a
row and carries nothing of it itself, so a new card cannot miss it.
Whether it is a phone's sheet the shell reads once when made
(`narrowViewport`, the panel's way), not with a `max-sm:` variant like
everything else on a phone: the action stands in a different place of
the DOM on the two, and the same button twice, one hidden by a
stylesheet, is two buttons of one name to every jsdom test and to a
reader without the stylesheet. So jsdom, which has no `matchMedia`,
renders every card as a desktop's, and a test of the phone's head
calls `onAPhone()` from `tests/phone.ts` before rendering (and
`offThePhone()` after). The pressed follow in the head is a wash of the
head's own ink (`aria-pressed:bg-current/20`), white on the deep
colours and dark on the light ones, where a fixed white sank into
Rostock's bus 19. The head's own rows (the stop's lines, the city's mode
chips) stay with the head: a follow on a phone ran behind a sheet that
covered a good half of the screen, and folded the head still names
what was picked. A card opens unfolded (it was asked for) and keeps its
fold from one vehicle to the next while it stays up. The vehicle card's
stop list is its own component (`TripStops`), so that it centres
its marker when the body comes back. Each card's test pins the fold
and the action's two places, `e2e/mobile-layout.spec.ts` measures both
and `e2e/app.spec.ts` wants the desktop's labelled button and no fold.
Two traps found
while building it: the head must not shrink (`shrink-0` on
`CardHead`'s header; the body takes the squeeze with `min-h-0`) – it
clips its illustration with `overflow-hidden`, which lets a flex column
shrink it to its eyebrow, and the title went first; and nothing inside a
card may call `scrollIntoView`, which scrolls every scrollable ancestor –
the vehicle card's stop list took the card's body along with it, so it
scrolls its own viewport now. The weather moves to the upper left, the readings
to the top centre, the rail to the upper right as a column of round
buttons with `gap-2` – the globe among them at button size – which ends
above where the sheet opens; the three share one top edge, the phone's
12 px inset (`top-3`; the weather kept the desktop's `top-4` and stood
4 px under the rail's first button once – edges are what
the eye aligns by, not centres: the readings' box is 10 px taller than
the round buttons and starts on the same line). The popovers keep to
that edge too: a popover's collision padding is the inset of the
viewport it opens on (`PHONE_POPOVER_EDGE_PADDING`, 12, against
`POPOVER_EDGE_PADDING`'s 16 – in [ui/popover.tsx](src/components/ui/popover.tsx),
read through `narrowViewport` when the content renders), so the
weather's opens on its button's top edge rather than 4 px under it, and
the layers popover hangs from the top of the rail's column on a phone
(`railRef`, a `PopoverAnchor` in place of the button; top-aligned) so
it opens on the same line beside the column, where from its button it
opened 38 px down the screen. On a desktop nothing of this applies. The line diagram, the photo mode
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
end reached. Two things learnt building it: the hash writer
waits for Cesium's `moveEnd`, which needs frames after the motion, and
after a flight set per frame the loop draws none until its heartbeat –
so the app writes the pose itself when a flight ends or a keyframe is
reached; and the test API reads `playing`/`progress` in the same task as
the click, so those refs are written with the state, not mirrored on
render. `?play=1` flies the hash's path once the city is ready, once.
The bar lists two keyframes; the model is a list, so a third is an
interface change only. `e2e/camera-path.spec.ts` flies one and reads the
end pose back from the hash. A city switch drops the keyframes (the
session cleanup in `App.tsx`, through `clearCameraPathRef` – the same
clearing the bar's reset button does, seconds and pace kept): they are
poses over the city that is leaving. A link's path is safe, the cleanup
runs only when a session ends; `tests/app.test.tsx` pins both.

The controls are a bar of their own
([src/components/CameraPathBar.tsx](src/components/CameraPathBar.tsx)):
a compact editor – two saved-view cards with labelled save/replace and
preview actions, duration as a number field (1–600 seconds, committed
on blur/Enter, empty input restored, Escape cancels), smooth/constant
motion as a segmented choice, and playback below. A status line guides
the next capture and explains that play starts from the beginning.
While playing, capture, duration and motion are disabled: the flight
uses a snapshot, so changing its settings would misrepresent what is
being flown. Preview, scrubbing, stop and clear remain available. The
timeline speaks seconds (0.1-second steps, Home/End to the endpoints),
with elapsed/total together beside it; clearing drops only the saved
positions, as the button's name says. The bar stands at half its
opacity while the pointer is elsewhere and comes back under it or with
the focus inside it (`focus-within`, or a keyboard could never see it) –
the picture is the thing looked at while a shot is composed – but a bar
just opened stays at full opacity for `BAR_SETTLE_MS` (4 s) first: it
was asked for and should be read once before it steps back. The bar
shares the foot of the map with the readings' radio group, both on the
same baseline in one wrapper: while the bar is up (`pathBarShown` in
`App.tsx`) the readings fold into a column of icons at its lower right,
their labels `sr-only` at every width, and unfold into their row again
when it closes. It was
a column at the end of the photo popover, which covered a good part of
the frame a shot was being set up in; the popover's last button (after
the miniature switch, `aria-pressed` while the bar is up) opens and
closes it now, the bar's X closes it, and a path from outside – a link,
the test API's `setCameraPath` – opens with it up. With the keyframes
gone from the popover, a click beside it closes it again like every
other popover (the `onInteractOutside` guard left with them). The bar
goes with the map, not with the diagram, like the popover it opens
from, and a phone never gets it. The play button lays both its faces in
one grid cell so its width does not change with the word on it, and the
timeline beside it stays put. `tests/photo-mode-popover.test.tsx` holds
the bar's tests beside the popover's – one jsdom file for one feature.

**The night is graded on the whole frame, and the miniature's colour
steps aside for it.** The tiles' time-of-day shader
tints and desaturates the photographed daylight into a blue night, and on
its own that night was pale and flat – the look wanted was found in
the photo popover with the miniature effect on: its toy-plastic grade
(saturation 1.35, contrast 1.15) and −30 saturation and −3 contrast on
the knobs over it. So `NIGHT_GRADE` in
[PhotoGradeEffect.ts](src/map/PhotoGradeEffect.ts) (contrast 1.12,
saturation 0.95 – the two steps folded into one product, which saturation
followed by contrast about mid-grey allows exactly) is multiplied into
the knobs' values along the map's sun ramp (`updateNightFactor`, the
lamps' ramp), and the photo grade's pass runs at night whatever the knobs
say – one full-size pass of a handful of multiplies, the same the knobs
cost, off by day at neutral. The miniature's own grade
(`TiltShiftEffect.setNightLevel`) fades to neutral along the same ramp
and keeps its blur and vignette, so the night looks the same with the
effect on or off; stacked, it was the neon the comment there had warned
of. Measured over Rostock at 23:00 on the real tiles (headed Chrome, a
rainy night): mean luminance 34 → 23 of 255, spread 16 → 18. The contrast
is what darkens: a night frame lies almost wholly under mid-grey. A
night's brightness or colour is tuned in those two numbers, not in the
tile shader's `nightTint`, which the beams' block reads too.
`tests/photo-grade.test.ts` and `tests/tilt-shift.test.ts` pin the two
ramps, `e2e/app.spec.ts` sees the pass compiled and on at 23:00 and off
at noon.

**The three readings at the foot of the map are a radio group, not
tabs.** They were Radix `Tabs` once, for the look and the
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

**A clock moved past the present says so once, in a toast.** The ships
and the aircraft are live and cannot be shown in the future, so a clock
set ahead leaves them in real time under a timetable that has run on
(the panel's help says it too). The first crossing in a
session puts a Sonner info toast at the top centre
([src/components/ui/sonner.tsx](src/components/ui/sonner.tsx), shadcn's
wrapper minus next-themes – the app has one theme), and the rule is pure
in [src/lib/future-notice.ts](src/lib/future-notice.ts), fed by the
loop's UI tick: the future begins where the replay edge ends
(`CLOCK_AHEAD_MS` = `REPLAY_EDGE_MS`, a minute), so the time field, the
calendar and a time-lapse that runs on all count the same way; a
crossing within `FUTURE_NOTICE_COOLDOWN_MS` (15 min, on the real clock
from the last toast shown) of the last is swallowed for good, and the
boot's clock is the baseline, not a move – a link with `?time=` ahead,
which every e2e spec is at times of day, opens without one. The Toaster
sits inside the `ui-overlay` wrapper so H takes a notice away with the
rest. `tests/clock.test.ts` pins the rule, `tests/app.test.tsx` the toast
– that test is also what made the App tests' map double grow
`motionThresholdCssPx`: without it the tick interval was NaN and the
simulation had never ticked in jsdom.

**The time-lapse runs both ways.** The slider is meant to be dragged
left to rewind. The clock needed nothing for it –
`SimClock` is an anchor plus the real time elapsed times the factor, so
`setSpeed` merely keeps the sign now (magnitude 0.1 at least) – and
neither did most of what the map shows, each a function of the moment:
the timetable positions, the recordings of the harbour and the sky
(`vesselsAt`/`aircraftAt`), the sun, the lamps, the weather. The
slider rests on detents ([clock.ts](src/lib/clock.ts): its scale is the
index into `SPEED_STEPS`, the sixteen factors the keyboard's `+`/`-`
walk – ×−120 to ×−1 and ×1 to ×120, mirrored – spaced evenly along the
track, `sliderFromSpeed`/`speedFromSlider`), real pace in the middle and
no ×0 – the step left of ×1 is ×−1, both real pace – its fill running
from the middle (the `origin` prop of
[ui/slider.tsx](src/components/ui/slider.tsx) – a hairline at the middle
was tried and dropped, the thumb or the fill always covered it), the
value written `×30` either way (`formatSpeed`) – the row's label and
icon switch to "Rewind"/"Rücklauf" with lucide's `Rewind` while the
clock runs backward, and the slider's `aria-valuetext` says "×30
backward" (`sim.speedBackward`); it read `×−30` for a day and the two
signs before the number read ugly, so the sign is not the
number's to show; a factor
off the steps (a link's `?speed=50`) runs as asked and rests the thumb
on the nearest detent until the next drag. The first version was a
linear scale from ×−120 to ×120 and slid without a stop: ×1 to ×10 lay
on eleven pixels of it, and detents replaced it at once –
do not give the slider a free scale back. `?speed=` takes a negative
factor (`clampUrlSpeed`), and "Now" puts ×1 back as before. What did assume a forward clock, each changed with it: the
archive client's prefetch lead reaches behind the moment instead of
ahead while the pace read off consecutive calls is negative
(`HourArchiveClient.follow`), the clouds' drift is carried back with the
clock (`CloudLayer.advance`, a jump over a day still re-seeds), the
whole-view pacing and the clouds' screen motion read `Math.abs` of the
factor, and the three stateless effect clocks – the smoke, the wake's
churn, the lighthouse optics – run backward under the same 3× cap: the
rewind is the film played backward, so the plume draws back into the
funnel and the optics turn the other way, which is what a rewound
picture should do; the wakes are laid from the sim past and needed
nothing, a ship backs along her own wake. Not changed, on purpose: the
live ships still render on the real clock until the replay edge (a
minute back), where the recording takes over as it does for a time
typed in; the future toast reacts to forward crossings alone. Pinned in
`tests/clock.test.ts` (the scale, the clamp, the clock), the keyboard
test in `tests/app.test.tsx`, and the effect, cloud and archive tests
named above.

**The map's controls live on the rail, not in the panel.** The control panel is
the simulation – the clock, the time-lapse, the lines. What is *drawn* belongs
to the rail at the lower right: the layers popover (routes, stops, names,
webcams), the camera's buttons, the photo popover, and the ground itself. The Layers block moved out of
the panel for exactly that reason; do not move map switches back
into it. The rail is a **dial** (a design carried over from
an earlier project): a round globe in the middle, 84 px (`size-21`;
100 and 92 were tried and found large – the buttons stand on the ring
a 92 px globe would fill, `ORBIT_RING_PX`, and only the globe shrank)
– the ground switch, Google's tiles or
the flat street map, wearing the look a click brings: the city on the
map from above, as Mapbox's light map while the tiles are up, the dark
map crossfaded over it along the night ramp (`globeNight` in App.tsx,
the map's `nightLevel` in twentieths), the satellite picture on the
flat map ([GlobeIllustration](src/components/GlobeIllustration.tsx)).
A city switch crossfades to the next city's picture: the one left
behind stays beneath while the next fades in over `GLOBE_FADE_MS`
through `@starting-style` (Tailwind's `starting:` variant – the
`animate-in`/`fade-in` classes shadcn's popover carries are dead in
this build, no `tw-animate-css` is installed) and is dropped on
`transitionend`, or after the same time where none fires. The stills
are three per city from Mapbox's Static Images API in `public/globe/`
(the city limits centred, zoomed to fit the disc with a quarter level
of margin), drawn once by `scripts/build-globe-images.mjs` with the
unrestricted token and committed – nothing is fetched at run time, so
the privacy notice is untouched, and their credit stands in the credit
list (`CesiumMap.addGlobeCredit`), as Mapbox's terms want when the
picture carries none. A new city needs a run of the script;
`tests/globe-illustration.test.tsx` fails until it has one. No gloss
and no border on the globe (a settled decision): the picture with its rim
of shade is the button. A vector globe from Natural Earth came first
and showed the whole of Europe, then Germany, then Germany as Mapbox's
still; the city is the picture wanted. Every other button is round
and stands on an arc around it, 35° apart from the About button at
the lower left over the layers, the photo mode, the compass and 2D/3D
at the top to the camera reset and full screen on the right
([src/lib/rail-orbit.ts](src/lib/rail-orbit.ts), pure; `tests/rail-orbit.test.ts`
proves nothing overlaps). Each button carries its own glass
(`ROUND_CONTROL` in [src/App.tsx](src/App.tsx)); the columns of boxes
and their `RAIL_BOX`/`GROUPED_CONTROL` are gone. The slots are absolute
positions from `sm` up, handed over as CSS variables (`OrbitSlot`), and
a plain column below it – a phone gets the same buttons stacked at the
upper right, the globe among them at button size; the diagram keeps a
short column of full screen and About, since nothing else on the dial
is on screen there. A button the browser has not got (full screen on
iOS) leaves its slot empty rather than moving the rest. No zoom and no
measure button, by design. The rail stands at half its opacity
while the pointer is elsewhere (`railDimmed`, the camera
path bar's manner) and comes back under it or with the focus inside;
the step down waits a second, because the wrapper lets the pointer
through to the map between the buttons and a pointer crossing the dial
would otherwise flicker at every gap – never where `(hover: none)` holds,
where a finger never hovers and the rail would stay dim for good. The rail fades out once the pointer has rested
`RAIL_IDLE_MS` (10 s) – a slow fade, a quick return on the first movement,
press, wheel or key ([src/lib/pointer-idle.ts](src/lib/pointer-idle.ts),
`watchPointerIdle` on the window, `railIdle` in App.tsx) – and keeps
`focus-within:opacity-100` for a reader stepping through it by keyboard.
Never where `(hover: none)` holds: a finger between touches is always at
rest, and the rail would fade into every visit for good. The buttons stay
in the layout and clickable while faded; the pointer that reaches them
has moved, so they are back before it arrives.

**Four kinds of name on the map, and they must not converge.** A vehicle
wears its line's colour with white text ([VehicleLayer](src/map/VehicleLayer.ts),
`lineBadge`). A stop wears no plate at all: light slate text in a thin dark
halo, its lines a shade dimmer ([StopsLayer](src/map/StopsLayer.ts),
`stopNameImage`), over a disc that lies *flat on the ground* –
a hand-built instanced DrawCommand
([StopDiscs](src/map/StopDiscs.ts)), because a billboard cannot lie flat
and nothing else in Cesium draws a flat mark that moves with the height
refinement and holds its screen size. It keeps the billboard's two habits:
drawn over the tiles within 3 km (the near-plane trick Cesium's own
billboard shader uses, log-depth varying included) and pickable by a
"stop:" id (one pick colour per instance, `pickId: 'v_pickColor'`). Its
GLSL compiles offline, so every e2e run proves it; the stop-card spec's
real click goes through its pick colours.
A ship wears a dark slate plate with white text
([VesselLayer](src/map/VesselLayer.ts), `NAME_PLATE`). An aircraft
wears its callsign on a blue plate (`#1e40af`, white text –
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
plate once — white, then a grey pill — and whatever its colour it
was the brightest thing over Google's tiles and outshouted the line badges. A
vehicle is the news, a stop is the furniture; if the stop names ever draw the
eye before the badges do, that is the bug. Do not give them a plate back.

**A picked thing lights up the same way, whatever it is.** The selected
vehicle's body is washed toward white and rimmed in a 2.5 px silhouette
(`applyVehicleAppearance`), and the selected ship's hull is
too (`VesselLayer.setSelected`, `applyVesselAppearance` – the constants there
are the vehicles' own, borrowed by name), and the selected
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
is pointing at, which is how the stops and the ships were found,
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
([src/lib/site-path.ts](src/lib/site-path.ts)). The city was once
`#city=berlin` – one URL to Google for every city, and a shared link's
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
`cesium`, `models`, `og`, and the legal pages' four words below) –
`tests/cities.test.ts` pins it, and the parser names no city for them.

**The legal notice and the privacy notice are one text in two
places.** [src/lib/legal.ts](src/lib/legal.ts) holds both,
in both languages, with the provider's details (`OPERATOR`) at its top –
read from the build's environment (`VITE_OPERATOR_NAME`, `_STREET`,
`_PLACE`, `_EMAIL`: `.env` locally, the repository's `OPERATOR_*` secrets
in ci.yml), never written in the source, since the repository is public
and a legal notice names a person and an address; without them the
notices show placeholders that say what is missing. The app shows them in
[LegalDialog](src/components/LegalDialog.tsx), a sibling of the Credits
dialog and deliberately *not* a fourth tab of the About dialog (a settled
decision: the tabs are about the map, these are about the site); the links
stand at the foot of the welcome screen, right of the checkbox on its
line, and at the foot of the About dialog under every tab. The same text
is a page under the map – `/impressum/`, `/datenschutz/`, `/en/imprint/`,
`/en/privacy/` (`LEGAL_PATH_SEGMENTS`, `formatLegalPath`; either word
reads in either place, the prefix says the language) – linked from every
page's foot, because a crawler and a WebGL-less reader never see the
dialog; the pages carry `noindex, follow` and stay out of the sitemap
(by design; `StaticPage.noindex`). The app's links are real `href`s
that a plain click turns into the dialog (`LegalLinks`), and an address
that names a page opens the dialog over the door – from an effect, a
commit *after* the welcome screen: two Radix modals mounted in one commit
each mark the other `aria-hidden`, and neither can be read (found by
`tests/app.test.tsx`). What the privacy notice says about the browser's
own requests (Google's tiles through Cesium ion, Open-Meteo, Windy's
pictures), about what goes through this site's API (aisstream, adsb.fi,
gtfs.de), about localStorage and about there being no cookies has to
stay true: a new third-party request from the browser, a cookie or an
analytics script is a change to `legal.ts` as much as to the code, and
to the German text first – it is the binding one, the English says so.
The email in `OPERATOR` is written obfuscated on purpose, in the variable
itself – it is shown as written. The hosting
section mirrors the hosting's log setting – IP addresses shortened by
two octets (11.22.0.0), log files deleted after 90 days, a Webalizer-style access
statistic generated from them – so a change to that setting is a change
to the text, and the other way round.

**The clock rides in the hash as it was set, never as it runs.**
`date=YYYY-MM-DD` is the day picked in the panel's
calendar, `time=HH:MM` the time typed into its field, each written the
moment it is entered and left alone while the simulation runs on from
it – a settled decision: a link that ticked would never be the same
twice, and the moment set is the one meant. The
entry lives in `App.tsx` (`clockEntry`, `ClockEntry` =
`Pick<HashUiState, 'date' | 'time'>`; a ref for the writer, state for
the panel) and the panel only shows it – `ControlPanel` lost its own
`pickedDate` and the uncontrolled time input for it, so a link's entry
appears in the field and on the date button as if typed there. Rules
that follow: `?time=` in the search string stays the boot flag every
spec uses and makes no entry (the hash's wins over it at boot); the
test API's `setTime`/`setDate` move the clock and make no entry either
(`e2e/app.spec.ts` normalises the clock through them and empties the
field with `fill('')`); an emptied field withdraws the entry and leaves
the clock where it is; "Now" (and `n`) clears both halves with the
speed; an edited hash whose half went missing puts that half back on
the real clock (today, the real time of day) – the same way the layer
switches read an absent key. `tests/app.test.tsx` pins all of it,
`tests/camera-hash.test.ts` the spelling (a bare `8:30` reads back as
`08:30`, seconds only when given, Feb 30 is no day).

**The traffic categories and the photo knobs ride in the hash too,
and single lines do not.** `hide=tram,bus,ais,aircraft`
is one key for what the panel's traffic list has switched off as a
whole – a mode is off when none of its lines shows, whether the group
switch or the lines one by one did it (`noteHiddenModes` in `App.tsx`
derives it after every toggle), the two fleets from their switches – in
`TRAFFIC_CATEGORIES` order, so the hash is stable. A single line
switched off is deliberately not in the URL (a settled decision). The
modes live in `hiddenModesRef`, apart from the line set, because they
outlive the city like the layer switches: a city arriving puts its
lines of those modes up hidden, and a mode the city does not have keeps
its place for the next one. The photo mode travels whole:
`HashUiState.photo` is a `PhotoSettings`, `tiltshift=1/0` stays the
miniature switch's key, and every other knob off its default is written
under a short key with the value in full (short names by design) –
the table is `formatPhotoHash`/`parsePhotoHash` in
[photo-settings.ts](src/lib/photo-settings.ts), beside `KNOB_RANGES`,
which the popover's sliders and the parser's clamp both read, so a link
can put a knob anywhere the slider goes and nowhere else. The lens is
measured against the look's own (`lensFovDeg(tiltShift.enabled)`):
`tiltshift=1` alone opens on the long lens, `fov=` only names a focal
length set by hand. The map is built with the miniature flag alone and
gets the knobs through `setPhotoSettings` right after – before the
first frame, where `CameraLens.setFovDeg` writes the lens without a
dolly walk. `__mg3d.photoSettings()` reads them back; `e2e/camera-hash.spec.ts`
opens a link with `hide=bus&con=1.2` and takes both away with an edited
hash.

**The flat map swaps the ground, and everything on it lies at
0 m.** The globe in the middle of the rail's dial
(`basemap=flat` in the hash, `CesiumMap.setBasemap`) takes Google's
tileset off – destroyed, not hidden: a hidden tileset is still traversed,
and the tree is what the city switch rebuilds to let go of – and shows
the bare globe with Mapbox raster tiles on it
([FlatBasemap](src/map/FlatBasemap.ts)): two `MapboxStyleImageryProvider`
layers, one style by day and one at night, the night one laid over the
day's at `nightFactor` as its alpha and a style that would be invisible
switched off rather than faded (Cesium requests tiles for every shown
layer whatever its alpha, and Mapbox counts each against the account's
200 000 a month). Settled decisions: **no terrain** – the map is meant
to be flat, so every height the city carries is 0 m there,
the route profile, the stops, the lamps (they follow `groundHeightForNhn`
on their own through `builtAnchor`), the water the ships ride
(`waterSurfaceHeight` is 0 on the flat map, but keeps the tiles' number
offline: the specs' poses were set to it), the apron; the aircraft come
down by `groundReference` (`flattenedGroundM` on their host) so an
approach reads as 300 m over the map, not 300 m plus the airport's
height; the camera comes down and back up with the ground
(`shiftCameraHeight`) so the picture stands, never in a follow. It is the
offline path with pictures: `flatGround` (offline or flat) is what
RoutesLayer and VehicleLayer read instead of `offline` for the heights,
`defaultGroundHeight` is a getter over `groundReference` since, and every
clamping layer has a `resetClamps()`/`resetHeights()` for the switch. The
styles must be **classic** Mapbox styles (built from layers): the site's
own two Studio styles (a day and a night one) are built on Mapbox
Standard – an `imports` block, no layers of their own – which the Static
Tiles API answers with empty 235-byte PNGs, and the map was a bare globe
until `mapbox/light-v11` and `mapbox/dark-v11` went into `config.flatMap`
instead; rebuilt on a classic template, own style ids go back there.
The token rides like the ion token: `VITE_MAPBOX_TOKEN` from `.env`, the
domain-locked one in ci.yml; none means no request and a bare globe.
The tile shader's night, rain wash and cloud shadow do not reach the
flat map (the imagery is not the tileset); the underground view dims the
imagery layers' `brightness` instead. Mapbox's attribution is an
on-screen credit like Windy's, and the privacy notice has a section for
it in both languages. `tests/flat-basemap.test.ts` pins the blend and
the layers, `tests/cesium-route-lift.test.ts` the flattened routes,
`tests/app.test.tsx` the hash, and `e2e/app.spec.ts` throws the switch
offline (no pictures there – no token in the tests, and no network).

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
load. The same script takes the class off on `load`
when `main.tsx` has not set `data-app-started`, so a bundle that fails to
load still leaves the page. `main.tsx` then hides it for good
(`showStaticPage(false)`) before the first render and
[ErrorBoundary](src/components/ErrorBoundary.tsx) shows it again with a
notice when the viewer throws – no WebGL, most likely; a white page said
nothing before. Googlebot renders without WebGL, so that fallback is
exactly what Google reads. `e2e/static-page.spec.ts` proves both in a
Chromium started with `--disable-3d-apis`: the page a reader without
scripts gets, and the notice over it when the viewer cannot be built.
Measured: every city loaded and profiled in under a second,
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
Rostock is the default. The README's [Data](README.md#data) section documents
`city.json` field by field and the `add-city` → pipeline sequence, its
[Cities](README.md#cities) table says what each city carries. What follows
is what the data itself taught.

**The box is the limits plus 20 km on every side, and the camera ceiling
is 30 km (15 km and 25 km before).** `add-city` pads
`DEFAULT_PADDING_METERS`, every city carries its own `paddingMeters`, and
the ceiling is `config.cameraLimits.maxHeightMeters`. The cities in the
build were re-padded by rewriting `paddingMeters` and the
recomputed `boundingBox` in each `city.json` (`tests/cities.test.ts`
names the numbers when a box is off) – and nothing else, because the
box is what the lamps, the airfield lights, a `clip: "box"` network and
the AIS subscription are fetched for, and those files are the nightly
pipeline's: the band between 15 and 20 km stays empty until the OSM run
after the change fills it (accepted). Widen a box only with
that in mind, and never as a side effect. The camera leash, the AIS box
and the cloud slab follow the JSON at once; a spec that needs an edge
reads it from the definition (`cityBySlug(…).boundingBox`) rather than
pinning the number.

**Every trip runs on its own stop times, from the feed.** The GTFS
step writes, per direction, `patterns` – a trip's time points as one
flat array, `[meters along the path, arrival, departure, …]` relative
to the trip's departure from its first city stop, each stop_times row
projected onto the direction's path on the first pass at or after the
stop before it (`computeTripPattern` in
[fetch-gtfs-schedule.mjs](scripts/fetch-gtfs-schedule.mjs); a path that
passes a stop twice has two candidates, and the single nearest point put
stops on the wrong pass) – and `patternIds`, parallel to the departures,
the patterns shared between the trips that run alike and written one per
line (`scheduleJsonText`; JSON.stringify's indentation gave every number
a line). The runtime (`stopTimesFromTimePoints` in
[timetable.ts](src/lib/timetable.ts)) gives a network stop within
`TIME_POINT_SNAP_M` (150 m) of a point that point's times, passes a stop
between two points at the time its distance says, and reaches one
outside every point at the cruise speed; the feed has arrival equal
departure at most stops, so the vehicle stands `dwellSeconds` before a
departure where the run before allows it – a stop is a stop. Before this
only the departure at the first city stop was the feed's and everything
after it the route length over one speed per mode plus 25 s a stop: a
tram with twenty stops ran minutes off its timetable by the end, the
stop card's board showed invented times, and the realtime delay shifted
an invented base. Settled: a ring's round and a ferry loop's leg carry no
pattern (their stops run round a closed path; `classifyLoopTrip`) and
keep the cruise speed, as does a trip whose pattern the reader rejects
(`timePointsFromPattern`: distances and times must run forward, and the
whole must not run faster than `MAX_TIME_POINT_MPS`). Two traps the first
run found. **The free feed repeats a trip's first time at every stop for
some operators** – Bremen's VBN and Hanover's GVH: 04:18:00 at forty
stops – so a stop with the time of the stop before it, more than 100 m
on, is dropped as no time point, and a pattern left with nothing but
its first time is none (Bremen keeps the RS lines' 61 patterns, Hanover
the S-Bahn's 38; their buses and trams run at the cruise speed as
before, which the first version compressed into five-second hops across
the city and emptied the 08:30 fleet). **A cached feed whose calendar
has run out** chooses a service day with no trip at all: `finishCity`
now fails the city rather than write an empty schedule (the local cache
in `scripts/.cache/gtfs.zip` is unconditional – delete it for a fresh
feed; the first run wrote thirteen empty files from a month-old one).

**The height chord is densified where it misses the terrain, and the
offset is a field.** Two of the reasons a line floated or sank (Phase 3
of [docs/improvement-phases.md](docs/improvement-phases.md), 2026-10-06):

- The simplify step is two-dimensional, so a straight street kept only
  its end vertices whatever the ground did between them (Berlin: a
  thousand segments over 300 m, the longest 3.5 km), and the height
  between two vertices was a chord. `densifyByHeight` in
  [route-heights.mjs](scripts/lib/route-heights.mjs) halves a segment,
  recursively, while the terrain at its middle lies more than 0.3 m off
  the chord and the piece is longer than 20 m – not inside a bridge
  range, whose profile is the deck – and writes the inserted indices as
  `inserted` on the direction, which only the pipeline reads: the reuse
  from `PREV_NETWORK` keys the heights by the path WITHOUT them, so an
  unchanged network still fetches no tile, and the simplify step drops
  the field with the heights. Berlin gained 2 183 vertices (5.6 %); a
  blanket 20 m densification would have been ×3.5 and was rejected for
  it (`tests/network.test.ts` runs over every point).
- The NHN→ellipsoid offset was one median per city, and Google's mesh
  is a surface model whose distance to the bare-earth DGM differs from
  quarter to quarter. [height-field.ts](src/map/height-field.ts) (pure,
  tested) keeps that median as its base and takes every stop the stops
  layer measures on the tiles – fine, from within `FIELD_FINE_RANGE_M`
  (1.5 km) with the tiles loaded (`tilesLoading`, the ships' rule; a
  coarse tile answers metres too high), in band, within
  `FIELD_BAND_M` (4 m) of the base, or it is a hall roof – as a sample
  at the stop's distance along every direction calling there; between
  samples the offset runs from one to the next, a sample's say fades to
  the base over `FIELD_REACH_M` (1 km), a direction with no sample is on
  the base as before. The routes (`offsetAt` on the host, per vertex),
  the vehicles (`groundOffsetAt`) and the bridge decks' portals read it;
  the lamps and the airfield lights keep the base. No new tile sampling:
  the stops were measured anyway (`StopsLayer.resolveHeights`, four a
  pass near the camera; the host's `stopMeasured` hands them on), and
  more bootstrap samples are the one thing NOT to add
  (`sampleHeightMostDetailed` loads the finest tiles under every sample
  – minutes, and the tile-tree leak). A direction whose field changed
  has its routes rewritten with the next batch (see the routes'
  rewrites below); the vehicles read the field on their next tick.
  `__mg3d.groundOffsets(lineId, direction, distance)` reads the base,
  the sample count, the pending rewrites, the routes' lift and the
  offset at a point.

**The calibration's samples see the tiles alone.** The field's base is
the median, over the forty bootstrap stops, of `sampleHeightMostDetailed`'s
answer less the stop's NHN height – and that pick answers with whatever
is on top: over a stop, the route line itself, the stop's disc and name,
a vehicle at the platform. A city whose `geoidOffsetFallback` stood too
high had its lines over the tiles at boot and calibrated them on
themselves – fallback plus lift plus slot, a metre and more over the
fallback, and every route higher still. Found by Phase 6's measurement
(2026-10-06; headed, real tiles, the ground every vertex on screen within
1 km is drawn on, lift taken off, against the mesh under it): with the
routes shown, half of Munich's samples on a route answered at the
drawn line, which stood 4.1 m over the tiles on the median; hidden, none
did. Before → after, the
median of line minus mesh and the share within ±0.5 m: Munich 3.06 m
(14 %) → −0.08 m (88 %), Hamburg 1.10 (12 %) → −0.06 (77 %), Stuttgart
1.01 (6 %) → 0.03 (90 %), Cologne 0.30 (42 %) → −0.13 (88 %), Frankfurt
0.40 (71 %) → 0.08 (100 %), Berlin 0.01 (72 %) → 0.00 (82 %), Rostock
unchanged at 94 % – a fallback under the truth leaves the tiles on top.
The pick spans frames and cannot hide the rest for its pass as
`clampToSurface` does, so it takes an exclusion list of everything else
(`tilesOnlyExclusions`, [pick-exclusions.ts](src/map/pick-exclusions.ts)):
every primitive, every collection walked, every entity – an excluded hit
costs a second pass from under it, which forty samples at boot afford.

**The routes are rewritten together, once a second at most.** Rewriting a
direction (`RoutesLayer.refreshDirection`) replaces its pieces'
positions, and Cesium rebuilds the one batch that holds every route
polyline of the city – Berlin's 432 pieces and 43 700 vertices, 20–25 ms
of main thread over three frames, the middle one 15 ms longer than its
neighbours, the geometry made in a worker between them (measured headed
on the real tiles) – however few directions changed. So the field's
directions (a stop measured) and the decks' (a deck read)
go into one set, `routesDirty`, rewritten in one go once every
`ROUTE_REWRITE_INTERVAL_MS` (1 s) at most, and the decks publish only in
a tick that may rewrite (`BridgeDecks.update(now, mayPublish)`), so a
vehicle, which reads a published deck at once, never runs ahead of its
line. The field's rewrites went one direction per 250 ms before – four
rebuilds a second while a camera came down over the stops. A rewrite
also waits for the last rebuild to come in, and the loop draws at the
streaming rate while one is building (`batchesBuilding` in the render
hints, from what `DataSourceDisplay.update` returns – its `ready` stays
true once it was), for `ENTITY_BATCH_WAIT_MS` (3 s) at most: Cesium makes
the geometry in workers over three frames and swaps it in with a fourth.
At the paused 2 Hz that took 1.5 s, the rewrites a second apart while the
field filled in started it over each time, and the new heights came in
only once the rewriting stopped – measured over Berlin, one rebuild that
did not finish in the ten seconds after the tiles settled, against nine
that came in after some 170 ms each now; before the change the frame
after the last rewrite could be the 15 s heartbeat's.

**The ground near the camera was measured and left out (2026-10-06).**
Phase 6 extended the decks to every route vertex within 1.5 km of the
camera: stations every 30 m filed in cells, a sample taken for ground
within ±2.5 m of the field's profile and with two neighbours in that
band, a car or a survey-day train pruned against the residuals' lower
envelope (2 %), a hole against the lower quartile of its neighbours, the
residual interpolated between trusted samples and faded to the profile
beyond them, published with the routes' batch. With the calibration
fixed, over the same eight views (converged, headed, real tiles) it took
the share of visible vertices within ±0.5 m of the mesh from 82 to 89 %
in Berlin, 90 to 94 % in Stuttgart's centre and 69 to 100 % north of its
station (33 vertices), left Hamburg (77 → 78 %), Rostock, Frankfurt and
Cologne where they were, and made Munich worse (88 → 82 %). Against that,
a ray near the camera costs 1–2 ms – `tileset.getHeight` tests every
triangle of every tile the ray crosses – so a view's 100–600 points took
half a minute at a tenth of a core in blocks of 20–30 ms, or up to two
minutes at a budget that does not show (3 ms a pass: five points a
second), and every publish rebuilt the polyline batch.
The calibration had been most of the error; the rest was not worth that.
A second attempt needs a cheaper ray first – a triangle grid per tile,
built once – before the estimator above is worth its cost.

Two smaller things from Phase 3: the near lift of the lines is
the vehicles' 0.3 m now (`ROUTE_BASE_LIFT_NEAR`; it was 0.15, and the
wheels stood a hand over their line) – and since Phase 6 the switch to
the far lift reads the camera's height over the city's ground (its
ground reference), not over the ellipsoid, where Munich's 570 m had kept
every line on the far lift, half a metre over the wheels – and the
terrain sampler counts
the samples a Mapterhorn hole answered from a coarser zoom
(`stats.fallbackSamples`), which `data:heights` prints as a warning –
below z13 that is the 30 m surface model, metres over the ground, and
only Hamburg carries tiles of its own against it. The four hotspots the
review listed were looked up in OSM: Hamburg's S1/S2 at 53.5508,
10.0090 is the City-S-Bahn's tunnel portal under the Altmannbrücke and
Berlin's S3 at 52.50959, 13.23148 the cutting under the Passenheimer
Straße, Munich's bus 56 at 48.15196, 11.45646 the Lortzingstraße where
it passes under the railway's bridges – surface DGM over a portal, a
bridge's abutments, the embankment beside an underpass, no missing
bridge tag among them; Stuttgart's U3 at 48.7278, 9.1393 could not be
looked up (Overpass answered with server errors) and stays open.

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
| **Hamburg** | Rebuilt from scratch via `add-city 62782` — **do not restore files from git history before 3e57f1c**. Terrain patch above. Open: the "St. Pauli" AIS twin (the only AIS "ST. PAULI" is a 19×6 m launch, not the 30 m ferry) |
| **Berlin** | Buses limited to `^(M[0-9]+\|100\|200\|300)$` for load — some 700 vehicles at 08:30, twice Rostock; measure the 08:30 snapshot in [tests/berlin.test.ts](tests/berlin.test.ts) before adding more. `waterLevelNhn: null` because the Berlin DGM carries the lakes. The ferries F21 and F23 sail Tuesday to Sunday, the F24 at weekends – idle, correctly, on a Monday's service day, the F24 on every weekday's |
| **Cologne** | KVB 181 is not on the map: its OSM relation came back as a four-stop stub (53 ways with gaps) that placed 18 of 216 GTFS trips – check the relation before expecting it. Line 197 has no GTFS departures. The night rings 123, 156, 165, 166 and 167 run Friday to Sunday only and are idle, correctly, on a service day from Monday to Thursday |
| **Munich** | U8 is Saturday-only in reality and correctly idle on weekdays. Bus limited to MetroBus/ExpressBus; the 80 StadtBus lines would double the fleet |
| **Bremen** | RS3/RS4 are 2-stop stubs (both leave the city one stop after the station). Lines 66 and N94 have no GTFS trips |
| **Lübeck / Schwerin** | Priwall and Pfaffenteich ferries have no GTFS and are left off |
| **Frankfurt** | X express lines are regional (X95 has 450 m inside the city) and excluded; tram 11 has no operator tag, so trams come by network RMV |

**The airfield lighting comes from OSM one light at a time, and it is
all steady.** `data:airfield-lights`
([scripts/fetch-airfield-lights.mjs](scripts/fetch-airfield-lights.mjs),
the selection in `scripts/lib/airfield-lights.mjs`, tested) takes the
`aeroway=navigationaid` nodes of the box that the map has a light for –
runway edge, centre line, threshold, touchdown zone, approach, PAPI,
taxiway edge and centre line, stop bars, guard lights – in the colour
ICAO gives the kind unless `light:colour` says otherwise, and the
apron's floodlight masts (`tower:type=lighting`, inside the
`aeroway=aerodrome` polygons only, via `map_to_area` – a stadium's
masts burn on match nights) as the kind `flood`, with a terrain height
like the lamps', into `airfield-lights.json`; the first Sunday of the
month with the lamps and the seamarks, heights reused through
`PREV_AIRFIELD_LIGHTS`.
The count per box runs from Frankfurt's ten thousand to Kiel's two –
sparse light is real light, as with the lamps – and a box without an
airfield gets an empty list, so every city has the file. Closed airfields
need no rule: the mappers took Tegel's and Tempelhof's lights down with
the airports. [AirfieldLightsLayer](src/map/AirfieldLightsLayer.ts)
draws them as one PointPrimitiveCollection per city – points, not the
lamps' ground pools, so the lit runway reads from the home view; no
camera-height fade, half size far out – and the floodlight masts as
pools of lit apron through a second `StreetLampsLayer` (its pool is a
parameter, `PoolOptions`; `APRON_FLOOD_POOL`: 90 m, cooler
white, up to a 15 km camera), on the airfield's own level
(`airfieldLightLevel`) rather than the streets' night; the pool and no
point at the mast top, by design. Both built lazily along the night
ramp like the lamps, and by day once the weather's visibility drops
(`LOW_VISIBILITY_M`, 4 km full, fading in from 6 km – the tower's
practice is the lighting on under roughly five kilometres; the ramp
keeps a reading near the threshold from flicking the runway every
quarter hour): `visibility` rides in the weather series, the UI tick
hands it to `CesiumMap.setVisibility`, a picked sky brings its own
(`WEATHER_PRESETS[…].visibilityM`, the rainy one's 4 km lights the
airfield, the test API's `setVisibility` forces one), out underground,
off with `?lamps=0`, which covers
both lightings. Two decisions: no flashing, though the approach
system's sequenced flashers and the guard lights' wig-wags are real –
OSM does not tell them apart from the steady lights beside them, and a
flash would keep the loop ticking wherever an airfield is in view; and
the points stand 1.5 m over the terrain height with the depth test on,
so a light is hidden by a terminal in front of it but never sinks into
Google's runway mesh. A surface pick (`CesiumMap.clampToSurface`)
never sees them – nor anything else but the tiles, see "Ships are
clamped to the tiles" under AIS – or an aircraft on the apron would
stand on a taxiway light. (Before, the lights were kept off the
picks with exclusion lists, expanded to their points because Cesium
matches a pick against the point, its `primitive` and its `id`, never
the collection – the bare collection on the list had excluded nothing,
which the buoys' lanterns showed. That machinery is gone with the
lists.) `__mg3d.airfieldLights()` counts them and reads
their alpha; `e2e/street-lamps.spec.ts` checks them on the lamps' scene
(Rostock-Laage is in the box).

**The buoys come from OSM's seamark tagging, float on the tiles like
the ships, and are lit steadily.** `data:buoys`
([scripts/fetch-buoys.mjs](scripts/fetch-buoys.mjs), the selection in
`scripts/lib/buoys.mjs`, tested) takes the `seamark:type=buoy_*` nodes
of the box that are red, green or yellow all over – a first
cut: the banded cardinal, isolated-danger, safe-water and
preferred-channel marks, the white bathing spheres and the beacons
stay out, and `classifyBuoy` is where to widen it – with their shape
(`seamark:<type>:shape`; no model for it → the pillar buoy when lit,
the spar otherwise) and light (colour, character, period, kept for a
flashing rule one day) into `buoys.json`, the first Sunday of the month
with the lamps and the lights, no heights (`PREV_BUOYS` only guards against a half-synced mirror).
The models are the buoy fleet in `scripts/lib/buoy-fleet.mjs` – six
shapes in three colours, 18 GLBs of 3–22 kB, baked colours rather than
a runtime tint so a lantern stays grey – with the origin ON THE
WATERLINE, unlike the ships' mid-height origin; `BUOY_SHAPES` there
and `BUOY_MODELS` in [BuoysLayer](src/map/BuoysLayer.ts) are held
together by `tests/buoy-models.test.ts`, and the road/rail GLBs came
out byte-identical (the palette only gained entries). The layer clamps
each buoy with the ships' pick (`clampToSurface`), with three rules of
its own: six a tick, not three, because a harbour view sets down
dozens at once; a pick is made once per surface generation
(`surfaceGeneration`) and a failed one only with the next – a buoy
never moves, so nothing else can change the answer (that is every
layer's rule, see the AIS section); and no plausibility
band against the
fallback surface, because inland (Berlin's Havel, about a thousand marks) the
fallback lies thirty metres under the river – the fallback is the
ships' (`routes.heightOffset` + `WATER_SURFACE_FALLBACK_LIFT`), which
is also the offline height. Models are built per 0.02° cell the first
time the camera comes within `BODY_RANGE_M` (4 km) and hidden with the
cell when it leaves (a hidden parent collection is what skips
`Model.update`), so a home view loads none. The lanterns are one
PointPrimitiveCollection for the city, drawn always, on
`airfieldLightLevel` – dusk or poor visibility – and steady for the
airfield's reason (a flash keeps the loop ticking wherever a harbour is
in view). Two things the real tiles
taught (headed Chromium): with the
clock at 04:00 the marks climbed a lantern's height on every load
cycle and sat right by day – the pick under a buoy goes straight down
through the lantern over it, and a PointPrimitiveCollection on the
then exclusion list excluded nothing (see the airfield paragraph; a
pick sees the tiles alone now); and a level view
across the Breitling set the marks three kilometres out between 9 m
under and 18 m over the water, off the coarse tiles loaded that far
out, so a buoy is clamped only within `CLAMP_RANGE_M` (1.5 km) of the
camera and keeps its height or the fallback beyond it. Measured after
both: eighteen marks re-clamped through five camera moves, day and
night, all within a 2.2 m band – the water mesh's own undulation.
`__mg3d.buoys().heightsOverFallbackM` is the reading. A third: the
lantern point sits inside the lantern housing, under
the topmark, and from 88 m the housing hid it entirely (from afar the
point's four pixels reach past the housing's two), so the lanterns are
drawn without the depth test within `LANTERN_THROUGH_HOUSING_M`
(600 m) – the glow through the glass, at the price of a hull in front
of a buoy not hiding its light that close. Google's tiles carry the
real buoy as a blurred lump a few metres from the OSM position, where
it was swinging on its chain the day it was photographed; that is not
a bug of the layer. And the lanterns fade with the distance to the
camera (`translucencyByDistance`: full within 1.5 km, 30 % from
12 km out – the far end and the rim's width chosen by eye) – without
it they burned as bright from 30 km up as from the quay; the
airfield's lights keep their strength
on purpose, a runway is read from the home view. The count per box runs from Berlin's thousand (the Havel lakes, a
dozen of them lit) to Hanover's two dozen; the Main's and the Rhine's
carry no lights. Over the real tiles the marks were seen floating on
the Breitling's water by day and lit at night (headed Chromium).
`?seamarks=0` leaves them out
with the lighthouses; `ship-effects`, `clouds`, `rain-gate` and
`street-lamps` boot so because their frames are compared or their
scene is low over the Warnow. `__mg3d.buoys()` counts them; `tests/cesium-buoys-layer.test.ts`
pins the cells, the clamps and the lights with a model double
(`host.loadModel`), `e2e/app.spec.ts` brings the camera down to them.

**The lighthouses have no model: the light stands on the tiles' own
tower.** `data:lighthouses`
([scripts/fetch-lighthouses.mjs](scripts/fetch-lighthouses.mjs), the
selection in `scripts/lib/lighthouses.mjs`, tested) takes the
`man_made=lighthouse` and `seamark:type=light_major|light_minor` nodes
and ways of the box that name a lit sector – the tagging is untidy
(Warnemünde's tower is a `landmark` building way, the mole lights are
`beacon_lateral`, a leading light front is `man_made=beacon`, and half
of Kiel's `light_minor` carry no light at all: those stay dark, no
guessing), a tower mapped as node and building way is one light, and
the sectors come with their bearings "from seaward" (from the vessel
to the light), elevation and range; a directional light with an
`orientation` is a ±2° sector, a fog sector is left out.
[LighthousesLayer](src/map/LighthousesLayer.ts) sets each light on the
top the clamp pick finds (the highest thing at the position is the
lantern), two picks a tick within 3 km of the camera, with OSM's
elevation over the water as the floor where the mesh lost a thin mast
(a pick 3 m and more under the charted height is the pier, not the
mast), and at that elevation over the fallback water until a pick
answers or for good offline (10 m without one). The colour shown is
the sector the camera stands in ([seamark-lights.ts](src/lib/seamark-lights.ts),
pure, tested) – outside every sector the light is obscured, as at sea –
repainted per frame only where the sector or the night level changed.
Major (light_major, or a range of ten miles and more): 7 px, fading to
half by 40 km; minor: 4 px, the lanterns' fade. Steady, for the same
reason as the buoys – with one deliberate exception: **the towers'
rotating optics turn.** A major light of ten miles'
range and more whose EVERY sector flashes (`Fl`, `LFl`) with one period
from OSM is a rotating optic ([lighthouse-beam.ts](src/lib/lighthouse-beam.ts),
pure, tested in `tests/seamark-lights.test.ts`): one lens per flash of
the group (`3+1` → four, spaced evenly – a simplification of optics
whose panels are not), one turn per period, clockwise – and where the
period is short, more lenses rather than a faster optic: the fewest
that make a turn last `MIN_TURN_S` (12 s; Friedrichsort's `Fl 3s` is
four lenses in twelve seconds, the same flash every three – as one lens
in three it strobed). The range rule keeps
the Havel's red sector lights out – `light_major` on a four-metre pole,
`LFl 4s`, no range: an LED, no optic (Berlin, found in the data) – and
the every-sector rule keeps the leading and sector lights out: an optic
turns one lamp's light through coloured screens and cannot flash to the
west and burn steadily to the east, so Wilhelmshaven's leading light
(`Oc 6s` over the degree of the leading line, `Fl 3s` a degree left,
`Fl(2) 9s` three degrees right, fixed colours elsewhere – the first rule
swept a beam through its degree of arc and strobed)
and Bülk (a white `Fl(2)` over one arc among occulting and fixed
sectors) turn nothing. Four towers turn: Warnemünde and Bastorf,
Friedrichsort, Travemünde; Hamburg's, Bremen's and Wilhelmshaven's
lights are leading and fixed lights, none turns. `seamark:light:period` and `:group` ride in
the sector tuple (elements five and six, absent in an older
file), fetched by `data:lighthouses`, which can be run locally rather
than waiting for the Sunday run. Two things draw a beam
([LighthouseBeams.ts](src/map/LighthouseBeams.ts)): a shaft in the air,
one instanced DrawCommand after the smoke's pattern (a strip along the
beam turning its face to the camera, additive, render pass only, the
azimuth per instance – stateless, any frame right by itself), and the
light on the tiles, a block in `TIME_OF_DAY_SHADER` (`LIGHTHOUSE_BEAM_GLSL`
and `LIGHTHOUSE_BEAM_BLOCK`, up to `MAX_TILE_BEAMS` = 8 lens slots as
vec4 uniforms in one east-north-up frame at the city's lights) that
mixes the *baked daylight colour* back in where the beam falls – so the
sea's photographed turquoise lights up under a white beam, and a red
sector reddens the quay. The shader compiles online only (see "Offline
mode does not compile the tile shader"); checked headed over
Warnemünde: no loop error, the shaft from the
lantern, the sweep on the water. The optic runs on the simulated clock
like the smoke (`BEAM_MAX_RATE` = `PLUME_MAX_RATE`; a pause holds it),
and it is the one animated thing among the seamarks, which is why the
loop is tamed for it: with a lit beam within `BEAM_MAX_DISTANCE_M`
(20 km; the beams fade with the camera's distance to the lantern like
the lanterns' `translucencyByDistance`, full to `BEAM_FULL_DISTANCE_M`
= 10 km and gone at 20, linear – numbers chosen by eye, in place of the
hard edge at 15 km the first version had, where a beam popped in as
the camera came down; `beamDistanceFade` in LighthouseBeams.ts, applied
to the shaft's intensity and the shader slot's colour alike) in the
frustum, `LighthousesLayer.sync` asks for a frame the
fleets' way (`screen-motion.ts`, the far end's sweep since the last
frame) and reports its tick motion capped so the loop's tick comes out
at `BEAM_MIN_FRAME_MS` (`beamInView` in the sync result and
`renderPacing()`; `lastBeamInView` in the app's `fleetMoving`). That
pace is 33 ms, the loop's fastest tick – the rate the beam turns at
anyway while the camera moves, so the two look alike (measured headed
with the tower alone in the frame: 33 ms tick, 29.6 fps). The number was
arrived at the long way: a second cap on the requests
themselves, measured from the last frame's *end*, had halved the rate –
a tick later less than a tick had passed since the frame finished, and
every second tick drew nothing, 15 fps at a 33 ms tick, headed – so the
50 ms first seen was really 15 fps; gone, the tick is the only
cap a request needs. With that fixed the true 20 (50 ms: 18.6–18.8 fps)
and the 30 were compared by eye, each twice, and the 30 chosen;
50 is the number to come back to if the frames ever weigh. The taming
is in the gates, not
the rate: by day, underground, with the tower out of range or out of
the frame, or every lens screened, nothing is asked for, and a city
without a turning tower never notices the feature.
A floodlight or spotlight on a tower is a work
light, not a mark, and is left out of the sectors – Warnemünde's mole
lights carry theirs as the unnumbered set, ahead of the green and the
red, and showed white before the rule. The count per box runs from the Weser's and the Elbe's lights by the
hundred to none in Cologne, Hanover, Schwerin and Stuttgart. Seen over the real tiles at
night: the Warnemünde tower's white on its lantern from the sea, dark
from the town, the mole heads green and red either way.
`__mg3d.lighthouses()` counts them, the turning optics and the beams
drawn, and reads the optics' clock;
`tests/cesium-lighthouses-layer.test.ts` pins the towers, the floor,
the sectors, the night, the beams and their pacing with the buoys' kind
of double, `e2e/app.spec.ts` turns Warnemünde's offline (the shaft's
shader compiles there) and sees the loop paced for it.

The fleet at 08:30 is what each `tests/<slug>.test.ts` pins, from Berlin's
some 700 vehicles down to Wilhelmshaven's under twenty.

Consists are composed from existing meshes wherever possible — see
`VEHICLE_CONSISTS` in [src/map/VehicleLayer.ts](src/map/VehicleLayer.ts).
`tests/cities.test.ts` uses Paris as its "outside every box" point.

**Nothing on a ship's deck may be wider than the hull under it.** The
hull's bow is a quarter-ellipse in plan (`hullStations` in
`scripts/lib/vessel-fleet.mjs`): full beam down to a blunt stem (`bow`,
a fifth to a third of the beam – a tanker's is the fullest) over the
last fifth of the length (`taper`; a seventh on the box ship and the
cruise ship, which carry their beam nearly to the stem). It was a
straight wedge to a stem a tenth of the beam wide, and the tanker and
the box ship read far too pointed – keep the bows full. A rectangular
deck, fo'c'sle or fender strake laid over the
taper stood proud of the bow on either side – the tanker read as an
aircraft carrier, the dredger's suction pipe came out through the
side. The deck plates and the strakes are extrusions through the
hull's own stations now (`deckPlate`), the bow furniture sits back
where the hull is wide enough (`hullHalfWidthAt` says how wide), and
`tests/vessel-models.test.ts` measures every vertex above the keel
against the hull's plan and allows a hand's breadth.

**The pilot boat is orange all over, and the rescue and police boats
are not.** AIS 50 wears `vessel-pilot`, built after
the JASMUND of the Lotsenbetrieb MV: hull, house, mast and rails in
`pilotOrange`, a black fender strake and boot top, a green deck
(`deckGreen`), the wheelhouse front raked forward at the top
(`sideProfileBlock` in `vessel-fleet.mjs`, an extrusion across the beam
from a side elevation), the white-and-red diagonal on the bow as a decal
a finger proud of the topsides. A hull's colours are baked, so 51, 55
and 39 keep the dark boat it replaced as `vessel-patrol` (the old
`vesselPilot` renamed) – an orange police boat would be wrong. The
patrol boat's fender strake ends a hand under its deck plate: at the
deck's own height the two upward faces shared a plane
and the whole deck flickered between grey and black (the ROSENORT, a
type 55 at her berth in Rostock). Two same-facing faces in one plane
are what a flicker on a hull always is; a scan for them over every
model (axis-aligned faces of two materials rasterised per plane) found
that one exposed pair and nothing else exposed. Two helpers grew options for it,
defaulted to what they did: `hull` takes `bootStripe` and `rails`
(material and the `[z0, z1]` spans the sheer rails run over – the pilot
boat rails her working decks only), `railing` a `material`; the other
twelve GLBs came out byte-identical, which is the proof for any change
to them.

**The navy is two hulls, told apart by length.**
AIS 35 (warship or naval auxiliary; the card says "Military vessel")
draws `vessel-frigate` from `WARSHIP_FRIGATE_MIN_LENGTH_M` (80 m: the
Braunschweig corvettes at 89 m and the Elbe tenders at 100 m wear it,
the Frankenthal minehunters at 54 m do not) and `vessel-minehunter`
below, and the minehunter without a length. Both in `navalGrey` with a
`navalDeck` a shade darker and a black boot top, after the SACHSEN
class (F221) and the FRANKENTHAL class (M1098): the frigate with the
gun and the launcher cells on the fo'c'sle, the bridge, the pyramid of
the phased-array mast (`pyramidFrustum`, flat-shaded on purpose) and
the long-range radar's antenna on the aft block, two exhaust stacks –
the forward one carries the plume – and the flight deck aft; the
minehunter with the gun, the drones' spheres before the bridge, the
mast with its yards, the radome on its tripod and the crane on the
working deck. Both hulls rise toward the stem: `bowSheer` on the
stations (`hullStations`, through `hull` and `deckPlate`), a sheer of
1 adding nothing to the station objects, so every merchant GLB came
out byte-identical again. The frigate's triangle budget is the
passenger ship's (18 000): 140 m of rails and a faceted superstructure.

All thirteen AIS hulls and both scheduled ferry models
have smooth rounded bilges, finer bow stations, railings, mooring fittings
and bevelled enclosures. The larger ships carry individual container tiers
and corrugations, passenger-deck windows and lifeboats, round pipes and
working gear. `scripts/lib/model-detail.mjs` supplies the curved
primitives and the crease-angle smoothing; the road/rail mesh helpers
are untouched and the palette only gained entries, so the vehicle GLBs
came out byte-identical – the build is byte-stable, and a change to the
helpers is proved by rebuilding and comparing the files.
Keep fittings within the existing reference bounds and the hull's plan;
funnel anchors, navigation lights and waterline origins remain unchanged.
The geometry tests budget 36,000 triangles for the container ship, 18,000
for the passenger ship, 8,500 for the other AIS craft and 4,500 for a ferry.

The scheduled bus is a detailed 12 m low-floor city bus
inspired by the Mercedes-Benz Citaro (`scripts/lib/bus-model.mjs`). It has
rounded front/rear shells, glazing clipped to their actual triangles,
open wheel arches, rounded tyres and rims, two glazed doors on -X (the
right side with +Z forward), mirrors, wipers, lights, engine grilles and
a roof air-conditioning pod. Keep the rims plain and concentric, without
bolts or ventilation holes that would reveal the unanimated wheels.
The 12 × 2.55 × 3.1 m body reference and
road contact at -height/2 remain; only the mirrors exceed the body width.
Keep it below 4,500 triangles and 300 kB, in one opaque primitive. Only
`glass` may fall below VehicleLayer's 0.075 window-glow luminance cutoff:
tyres, seals, grilles and the red/amber lamps must stay above it. The
body still takes the runtime's line-colour tint. Rebuild twice to check
determinism and compare all other GLBs byte-for-byte when changing it.

**One primitive per part.** A mesh is still built as
one triangle soup per material, but `toGlb` writes every opaque group
of a part into ONE glTF primitive: the material's colour becomes a
vertex colour (`COLOR_0`, bytes), its metalness and roughness a texel
of a palette texture (`paletteTexturePng`, one RGB texel per material,
roughness in green and metalness in blue, sampled NEAREST) that the
vertices point into (`TEXCOORD_0`, unsigned shorts), under the one
`palette` material – so every part keeps exactly the PBR values it had.
A blended material (the rotor discs) stays a primitive of its own. The
reason is draw calls: Cesium draws a primitive per command, a tram of
six materials was six commands a wagon, a ship up to thirteen, and the
fleets were three quarters of a busy view's commands (Hamburg at 1175 m:
1 190 vehicle and up to 2 000 ship commands against 280 for the tiles);
a command costs ~3 µs of JS in Cesium and, in Firefox, its serialisation
to the process that runs WebGL (see "Firefox" under rendering). Measured
at that view: 3 900 → 954 commands, render JS 13 → 8 ms in
Firefox, 10.7 → 7.4 in Chrome. Verified pixel for pixel on a fixed
offline scene of every fleet close up (old GLBs against new): 6.5 % of
the pixels differ, by at most 1/255 in any channel – the 8-bit rounding
of the colours – and none by more. The window glow's luminance rule
(VehicleLayer, VesselLayer) survives it: glass lands at 0.057, the
bellows at 0.090, the cutoff is 0.075. The palette PNG is written by
hand with stored deflate blocks (no zlib – its output could differ
between Node versions; the build stays byte-stable, checked by
rebuilding twice), and the GLBs grew by 8 bytes a vertex, which is why
the aircraft budget is 800 kB and the ships' 70 bytes a triangle.
Since 2026-10-06 the scheduled fleet's wagons are not Models at all but
instances (see "The wagons are instanced" under rendering), and that
one primitive per wagon is what makes it possible: the GLB is read into
one vertex array, the palette into one texture.

### Switching cities at runtime

A city switch is a swap, not a reload. `CesiumMap.clearCity` takes the routes,
stops, lamps, vehicles and bridge decks down, the app's own cleanup stops the
pollers, drops the selections and lets the chase go, and on a flight both
happen halfway through it (`CITY_HANDOVER_FRACTION`, see `setCity`). What
survives is every layer *instance* and everything it still holds — which is
where three bugs of one family were found:

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
on the development machine; readPixels-synced timing has ~7 ms of sync
overhead). Wait for `__mg3d.tilesetStatus() === 'google-3d-tiles'` **and**
`tileset.tilesLoaded && statistics.numberOfTilesWithContentReady > 50` held ~2 s
(`tilesLoaded` is true before the first request), then
`gl.beginQuery(ext.TIME_ELAPSED_EXT)` / `viewer.render()` / `endQuery` per frame.
Runtime toggles: `scene.msaaSamples`,
`scene.shadowMap.size` (4 cascades → the texture is 2×size square!),
`viewer.resolutionScale`, the `mg3d_tilt_shift` stage in
`scene.postProcessStages`. `viewer.shadows` must be overridden via
`defineProperty` — `applyShadowState` re-sets it every tick. City comes from the
path (`/berlin/`). The dev build inflates React (jsxDEV).

Baseline (M5 Pro, 1600×1000 CSS at DPR 2, SSE 6 CSS px, real Google tiles).
MSAA was still 4 then, which is what the "MSAA 4" column costs — it is off now,
so a frame today is that column cheaper than the totals below:

| view | GPU/frame | CPU in `viewer.render()` | of which shadows | MSAA 4 | sky atmosphere |
|---|---|---|---|---|---|
| Rostock home (5.8 km, −40°) | 19 ms | 7.5 ms | 9.5 ms | 11.7 ms | 1.9 ms |
| Rostock chase cam (94 m) | 25 ms | 16 ms | 6.5 ms | 10 ms | 2 ms |
| Berlin home 08:30 | 19 ms | 21.6 ms (CPU-bound) | 10 ms | 12 ms | 2.3 ms |

FXAA is off by default in Cesium (1.144 and 1.146). `Cesium.Model.update`
runs the full scene-graph update even for `show=false` models — only
`submitDrawCommands` checks `show` — so a hidden *parent*
`PrimitiveCollection` is the only way to skip children.

Where Berlin's CPU actually goes, measured the same way: of 22 ms render CPU in
the home view, 16.8 ms are the 3002 wagon `Model` primitives (13.2 ms for the
969 shown bodies, 3.6 ms for the 2033 hidden ones); tiles and everything else
are 5.2 ms. The body range follows the lens the camera wears
(`cameraFramingScale` per tick in `VehicleLayer.sync`, since 45d6257 – it
was pinned to the 25° lens once and drew every body out to 7.7 km through
the 60° lens); what is still pinned is `VEHICLE_LABEL_VISIBLE_RANGE`, the
badges' distance condition, which is baked into the billboards.

### Motion: how a vehicle, a ship and an aircraft get from one fix to the next

Decided together on 2026-10-06, after a review found every one of them
stepping where it should glide; each is pure and pinned by a unit test.

- **A scheduled vehicle accelerates and brakes** between its stops:
  `profileDistance` in [timetable.ts](src/lib/timetable.ts), a trapezoid
  at the rate `config.simulation.accelerationByMode` gives the mode
  (1 m/s² for a tram, 0.8 for a train, 0.25 for a ferry), a triangle
  where the run is too short to cruise – the run's time stays the
  timetable's, the rate only shapes it. A trip without a rate (the
  tests' hand-built ones) runs at constant speed, as everything did.
- **A changed GTFS-RT delay is eased in** over `DELAY_RAMP_MS` (15 s of
  real time – the wall clock on purpose, a time-lapse makes a jump no
  smaller) by `Simulation.setRealtimeDelays`/`delayAt`; the first delays
  after construction apply at once. A delay is a time shift, and a tram
  that gained a minute jumped half a kilometer back along its route.
- **A body's bearing is the chord over its bogies, and a consist's
  wagons stand on their own chords.** `Simulation.snapshotsAt` reads
  the bearing between the points `bogieHalfSpacing` (35 % of the body,
  5 m at least) either side of the centre, not the path segment under
  it – the 0.3 m simplified path turned the body by a corner's whole
  angle in one step (`tests/simulation.test.ts` holds every body under
  30°/s). A consist's wagons each take the chord over their own bogies
  at their own point of the path (`articulatedWagonPose` in VehicleLayer,
  through `host.pathSample` – CesiumMap keeps the network for it), so a
  133 m S-Bahn follows a curve instead of leaving the track with both
  ends; the matrices are composed only while the body is drawn, where
  every wagon's was composed every tick before. Measured headless and
  offline in Berlin at 08:30, `renderPacing().vehicleSyncAvgMs` (the
  reading added for it): the home view 2.76 → 1.83 ms a tick, 1.2 km
  over Alexanderplatz 2.63 → 2.30, 400 m over it 2.65 → 2.35 – the
  hidden bodies' composition was worth more than the sampling costs.
- **A body pitches along its route's gradient** (`VehicleSnapshot.gradient`,
  the per-vertex heights read over the vehicle's own length; capped at
  `MAX_VEHICLE_PITCH_DEG`, 8°, in VehicleLayer), nothing on the flat map
  or offline, where every height is 0 m.
- **Ships and aircraft move along a cubic Hermite curve** between two
  fixes, with the reported course (COG under way, the aircraft's track)
  as the tangent at each and the chord's length as the tangent's
  ([track-curve.ts](src/lib/track-curve.ts): unit speed, no overshoot;
  a course more than a right angle off the chord – a ship going astern,
  a stale track – is not trusted and the chord's direction stands in).
  The fallback bearing is the curve's tangent. A straight chord turned
  every bend into a polygon that the layers' 400 ms ease only rounded.
- **An AIS fix is stamped with its message's own time** (`time_utc`,
  `aisFixTimeMs`, PHP `mg3d_ais_fix_time`) where that lies within
  `AIS_MESSAGE_TIME_BEHIND_MS` (10 min) behind the keeper's clock and
  `AIS_MESSAGE_TIME_AHEAD_MS` (5 s) ahead of it, the receive time
  otherwise; a message older than the fix held is late, not news – its
  position and kinematics are left alone, its static data taken. The
  receive time was the fix's time before, and the seconds a message
  took through aisstream became a change of speed from one fix to the
  next. The parity script runs the fixture twice, once with a clock a
  minute after the capture, so the PHP parser is proved.
- **An aircraft banks as it was banked at the drawn instant:** the
  roll rides in the track point (its tenth element, in TS, PHP and the
  archive's replay) and the sampler eases it; a point too old to carry
  it leaves the record's roll to the layer. The layer read the record's
  roll before, twelve seconds ahead of the body.
- **A late fix after a spell of dead reckoning is eased over longer**
  (`HANDOVER_TAU_MS`, 1.5 s, for `HANDOVER_BLEND_MS` after the handover
  in AircraftLayer) – the reckoned point and the chord the late fix
  draws differ by however far the reckoning went wrong.
- **The chase camera's heading eases by the time gone by**
  (`FOLLOW_CHASE_TAU_MS`, 250 ms, `1 − e^(−dt/τ)` with dt held to
  33–250 ms) where it closed a fixed 0.12 of the gap per call, which was
  a quarter second at the chase's 33 ms tick alone.

Still per tick, not per frame: every pose is written on the simulation
tick (33–100 ms), nothing interpolates in `scene.preUpdate`. That is
Phase 7 of [docs/improvement-phases.md](docs/improvement-phases.md),
held back on purpose – interpolating every frame for every vehicle
would give every frame a reason to render and undo the pacing below.

### Rendering is event-driven and motion-paced

Idle renders happen on `CesiumMap.requestRender()` flags plus a 15 s heartbeat.
**Every new visible scene mutation in `CesiumMap` must call `requestRender()`**,
or it stays invisible for up to 15 seconds. Two related budgets from the same
pass: the stop-height bootstrap samples only ~40 stops (full sampling kept the
tileset loading for minutes), and vehicles count as "in view" only within 12 km.

Frames and sim ticks are paced by on-screen motion:
`VehicleLayer`/`VesselLayer` measure each in-view object's screen motion since
the last *rendered* pose and request a frame only past
`MOTION_RENDER_DEVICE_PX = 0.5` device px
([src/map/screen-motion.ts](src/map/screen-motion.ts)). A camera that moved
since the last frame also earns one. Tick interval =
`clamp(threshold / px-per-second, 33, 100)` ms; 33 ms while interacting,
chasing or with the diagram open; 500 ms paused or with nothing in view. Home
view renders ~5–6 fps instead of 30; Berlin's main thread sits at 18–25 %
instead of 99 %.

**The time-lapse and a playing camera path pace the whole view.** "In
view" is bounded by a render range – 20 km for a
vehicle, 5 km for a ship, at the reference lens – while their labels are
drawn out to 35 km, so a label between the two moves only when
something else earns a frame: at real pace that is the deliberate
economy, under the time-lapse it was stop-motion, and so were the
clouds, whose drift was carried forward in the 250 ms UI block. So the
loop sets `CesiumMap.setPaceWholeView(Math.abs(clock.speed) > 1 ||
cameraPathPlaying)` (the rewind is a time-lapse too), and with it: both layers count a vehicle or ship as
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
  packs the 4 cascades 2×2). It was deliberately raised back from 4096 for
  the shadow edge. **Do not propose lowering it again**; the 256 MB /
  ~2.5 ms it saves are known and were weighed. It lives in the desktop
  profile now (below), which is the only place the number is.
- **Every rendering number above is the desktop profile's.** The
  map draws from a `RenderProfile`
  ([src/lib/render-profile.ts](src/lib/render-profile.ts)) handed in by
  `App.tsx`: two tiers, `desktop` with every number as measured here and
  `mobile` – a touch screen whose shorter side is under 900 CSS px, or
  any device reporting 2 GB or less – with a 2048 cascade (64 MB),
  tiles at 8 CSS px instead of 6, a
  384 + 192 MB tile budget, a 100k tile-tree limit, bodies out to 2 km
  instead of 3.5, a 600-drop rain pool and no ship effects (smoke,
  wakes). `?tier=` forces either;
  `__mg3d.renderProfile()` and `__mg3d.shadowMap().size` show what is in
  force. The mobile numbers are a first cut, chosen for memory (a
  mid-range phone gives a tab well under a gigabyte) rather than
  measured frame by frame – measure on a phone before tuning them, with
  `renderPacing()` and `tileMemory()`, the same way the desktop's were.
  A new rendering knob goes into the profile, not beside it. The
  pixel-ratio cap (`maxPixelRatio`) is 2 on both tiers, a settled
  decision (the phone's was 1.5): a 3× phone still draws at 2×,
  a 2× screen at its own.
- **MSAA is off on both tiers** (`msaaSamples: 1` in both profiles – a settled
  decision for the desktop, which had run at 2× before that, down from Cesium's
  default of 4). At 4× it was the most expensive
  item in a frame — 11.7 of the home view's 19 GPU ms — and the sampling rate is
  spent almost entirely on this map's own strokes: 4× against 1× differs in 17 %
  of the pixels, 4× against 2× in only 14 %, nearly all of it route-polyline
  edges, which alias now. What the second sample cost, measured the
  way the section above describes (headed Chromium, real tiles, timer queries,
  `scene.msaaSamples` toggled 1 → 2 → 1 → 2 on one scene, medians of 40
  frames, 3200×2000 buffer at DPR 2, clock paused, ships and aircraft off):

  | view | GPU 1× | GPU 2× | CPU in `render()` 1× / 2× |
  |---|---|---|---|
  | Rostock home 12:00 | 5.1 · 5.9 ms | 9.7 · 9.3 ms | 4.4 · 4.5 / 4.5 · 4.8 ms |
  | Rostock centre, 300 m, shadows on | 10.0 · 10.1 ms | 14.8 · 14.8 ms | 6.9 · 6.1 / 6.2 · 6.4 ms |
  | Berlin home 08:30 | 5.9 · 7.2 ms | 12.1 · 12.9 ms | 5.1 · 6.7 / 6.2 · 6.4 ms |
  | Rostock home at DPR 1 | 3.8 · 4.3 ms | 7.9 · 6.9 ms | 6.0 · 6.0 / 6.2 · 6.1 ms |

  So the second sample is 4–6 GPU ms a frame at DPR 2 – it doubles the home
  view's GPU time – and nothing on the CPU: the JS side of a frame does not
  know how many samples the framebuffer has, and the ±1 ms between the two
  runs of each setting is the tiles loading behind. There is no `?msaa=` URL knob;
  `__cesiumViewer.scene.msaaSamples = n` plus `__cesiumViewer.render()` changes
  it live (values 1, 2, 4, 8; the setter silently clamps to the driver's
  `gl.MAX_SAMPLES` and the multisample path is gated on `> 1`).

### Animated effects are stateless shaders, not particle systems

(The lighthouses' turning beams follow the same rule – see
the lighthouses paragraph under "Cities and the data pipeline".)

The ships under way trail exhaust
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
it runs at most `PLUME_MAX_RATE` (3×) real time under the time-lapse –
either way: under the rewind it runs back into the funnel at the same
cap, the film played backward (the wake's churn and
the lighthouse optics follow the same rule, see the rewind paragraph
under "Interface and styling").
It asks for frames the way the ships and the clouds do – once its own
motion since the frame last drawn is a visible step at the ship's
distance – and it counts as a moving ship for the tick rate. Which
hulls smoke is `VESSEL_MODELS[…].funnel` (six of sixteen; the
shipyard's `mesh.funnel` is pinned against it in
`tests/vessel-models.test.ts`), from `SMOKE_MIN_SOG_KN` over the ground,
within `SMOKE_MAX_DISTANCE_M`. Offline the shader compiles and draws –
`e2e/ship-effects.spec.ts` puts a ship on the map through
`__mg3d.setAisVessels` and reads the plume off the canvas – and the
primitive draws in the render pass only: no pick, and nothing in the
offscreen passes, or a hull would be clamped onto its own smoke.

The wake ([src/map/Wake.ts](src/map/Wake.ts)) is stateless
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
with rings, cheap-looking, and was rebuilt as ribbons; the
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

The foam itself lies in the water and churns (it was too static before
– the pattern was measured from the stern and rode along with the hull,
painted on). Every ribbon point carries
the moment its foam was made – the ships' clock less the pose's age,
as metres at `WAKE_STREAK_MPS` – so the same water wears the same
streak from tick to tick while the ship runs on, and the bow wave's
foam streams aft along the flank; on top, the noise has a third axis
walked by a churn clock (`u_churn`) that runs on the ships' clock like
the smoke's – held by a pause, capped at `PLUME_MAX_RATE` under the
time-lapse – so a patch breaks up and re-forms where it lies and the
edge frays. Still stateless. The churn earns frames the smoke's way
(`metersSinceRendered` at `WAKE_CHURN_MPS` against the motion
threshold at the ship's distance) and keeps the vessel ticks at the
motion pace while a wake is on screen; the ferries' wake runs on the
simulated clock for it (`syncVehicles` takes `simMs` since), where it
was on `performance.now()` – a pause left the foam streaming past a
standing ferry otherwise. The noise lattice is periodic (4096 cells)
so the sin hash never sees the coordinates a long session grows.

### The wagons are instanced

Phase 5 of [docs/improvement-phases.md](docs/improvement-phases.md),
2026-10-06. A wagon was a Cesium `Model` – Berlin's morning fleet some
2 900 of them, each a scene graph with an update of its own every frame
and a draw command of its own every pass. [InstancedWagons.ts](src/map/InstancedWagons.ts)
draws them with one instanced DrawCommand per wagon model instead
(after StopDiscs' pattern): the GLB's one primitive read from the file
itself (`parseWagonGlb`, with Cesium's glTF axis correction baked into
the vertices – Y up, Z forward in the file; Z up, X forward in a Model –
so an instance matrix is the very modelMatrix the Model took), the
palette PNG decoded with `createImageBitmap` into one NEAREST texture,
and per instance the pose (the rotation's columns, the translation as
high and low floats), the line colour, the opacity and a pick colour.
The slot buffer holds every wagon of the model; what the GPU gets is
the SHOWN ones packed together, opaque first, then the ghosts – with
every slot drawn and the hidden ones collapsed in the vertex shader,
the 2 900 went through the vertex stage of every shadow cascade and
both passes for the 300 in range, and the GPU frame grew where it
should have shrunk. `VehicleLayer` allocates a slot per wagon when the
record is made, writes the composed wagon matrices into it while the
body is drawn (`record.modelMatrices` are the record's own Matrix4s
now) and hides it otherwise.

What the shader reproduces of the Model, each chosen beside a Model
on the same scene (ab-* screenshots, mean colours over the same
patches, offline): the metallic-roughness material from the vertex
colour and the palette texel, `czm_pbrLighting` under the scene's sun,
an ambient share for the Model's image-based sky lighting
(`AMBIENT_DAY` 0.55, `AMBIENT_NIGHT` 0.25 along the night ramp, and the
sky's reflection in smooth surfaces, `SKY_REFLECTION` – the glazing
above all), the window glow by the glazing's darkness, the neutral
tonemapping and the sRGB conversion of the Model's lighting stage, and
the line colour mixed over the LIT body last – the Model's colour stage
runs after its lighting stage, in sRGB, which is why a tint mixed into
the base colour came out a saturated purple. The tunnel ghosts are a
second command in the translucent pass; the command casts shadows and
receives none, the Models' `CAST_ONLY`. What it does not do is the
selection silhouette (Cesium's own stencil pass of a Model): the
selected vehicle alone keeps its Models, loaded on selection
(`attachWagon`) and let go with it (`releaseModels`), each instance
hidden once its wagon's Model is in – hidden at once, the vehicle
vanished for the moment the Models took to load.

**The Models' hidden cost: Cesium's environment maps.** Every `Model`
computes its image-based lighting with a `DynamicEnvironmentMapManager`
– a cube map of the sky, its convolutions, the irradiance, as compute
passes – through a queue all Models share, at most 14 passes a rendered
frame, and a Model re-queues its map whenever it moves a kilometre. With
the wagons as Models that queue stood at 12 000 to 15 000 passes in
Berlin with the clock running (sampled every ten seconds for a minute,
offline): every frame paid its 14 passes, and a ship, an aircraft or a
buoy waited minutes for its sky lighting – in the ship-effects spec it
never arrived. With the wagons instanced the queue is empty, and a hull
gets its lighting a few frames after it loads – which the plume spec
had to learn to wait for (`pictureStill`: its picture of the ship
stopped was taken before her lighting and the one under way after).

Measured headed on the real GPU (timer queries, paused at 08:30; the
CPU over 60 frames, twice each). The two close views ran with Google's
tiles still loading, not offline as this table first said – the
script's `&offline=1` was appended after the pose hash there and went
into the hash, which the app does not read for it (a query switch goes
before the `#`); the home view, with no hash, was offline:

| scene | render CPU | commands |
|---|---|---|
| Berlin 1.2 km over Alexanderplatz, tiles loading | 13.4 · 13.8 → 10.9 · 11.1 ms | 1 570 · 1 610 → 887 · 909 |
| Hamburg 1175 m over the harbour, tiles loading | 12.7 · 13.0 → 11.8 · 11.9 ms | 1 348 → 1 090 · 1 093 |
| Berlin home view, offline | 2.5 · 3.2 → 2.3 · 2.6 ms | 65 → 65 |

With the real tiles, Berlin's close view went from 14.2 · 14.5 to 12.2
· 12.3 ms of render CPU and 1 772 · 1 857 to 1 185 · 1 203 commands.
The GPU needed a careful reading: 60 frames of one scene varied between
runs of the same build by more than the change, the old build most of
all (its environment-map passes, above). Interleaved over eight rounds,
480 frames a variant, in Berlin's close view:

| GPU per frame, offline | old (Models) | new (instances) |
|---|---|---|
| median, as drawn (p25–p75) | 9.69 ms (6.94–12.44) | 6.03 ms (5.59–6.63) |
| the wagons' share (as drawn − wagons off) | 1.13 ms | 1.63 ms |
| of it their shadow casting | 0.45 ms | 1.36 ms |

The frame is cheaper and much steadier. The old build's shares are as
noisy as its frame (a quartile range of five milliseconds), so they are
no measure to set the new ones against; the new shadow share itself
varied from 0.9 to 1.4 ms between sessions of the same build.

**Spatial sub-batches were tried and left out (2026-10-06).** A batch
is one bounding sphere, and Cesium assigns a shadow caster to every
cascade its sphere reaches (`insertShadowCastCommands`), so every
cascade draws every shown wagon of the model – counted in Berlin's close
view, 486 wagons in each of the four. Cells of 1 km (a command, an
instance buffer and a vertex array each, ghosts apart) cut that to 478
in all four together, and the main pass from 922 wagons to 342 – and
the GPU frame at the desktop's 8192 cascade did not move: 5.61–5.78 ms
with one sphere, 5.65–5.78 with cells of 1 or 2 km, interleaved, three
sessions. The pictures were pixel-identical bar the line badges. With
the shadow map at 2048 – the mobile tier's – the same cells took the
wagons' shadow share from 0.88 to 0.25 ms and the frame from 4.4 to
3.6 ms; with one sphere the share was the same at 2048 as at 8192
(0.88 · 0.92 ms), so the one sphere's cost is geometry, but at 8192 the
cells pay about a millisecond of their own that the culling does not
win back – the many small draws into the large cascades, as far as a
timer query can tell (Apple's GPU renders tile by tile). Render CPU
moved +0.1 ms in Berlin and −0.4 ms in Hamburg, the commands doubled.
Nothing to gain on the desktop, so the code went; a phone, with its
2048 cascade and its own GPU, is where to measure it again before
building it back (the backlog keeps the item).

Two things to know before measuring this again: Cesium fits the
cascades to the shadow RECEIVERS in view (`View.js`, `receiveShadows`),
not the casters, so the wagons' spheres never moved the cascade splits;
and set the clock to a whole second through the test API before
comparing two builds' pictures – `?time=12:00` does not start on the
millisecond, the trips departing at 12:00:00 are there in one run and
not in the next, and two builds then differ by eight vehicles.
`__mg3d.wagonBatches()` lists the batches; `tests/instanced-wagons.test.ts`
pins the parser and the packing; `e2e/app.spec.ts` sees the batches
hold wagons offline.

### The city handover is one frame – nothing may pile up in it

The map changes hands halfway through the flight to the next city
(`CITY_HANDOVER_FRACTION`), and everything the new city puts up lands in the
single `scene.render()` after it. Measured in headed Chromium on the
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
a follow left in free orbit — adds that much every frame. Measured:
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
(a settled choice); `?sse=<n>` overrides it live. Dynamic-SSE factor tuning is
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

**A fourth holder sat in Cesium's request queue** (found 2026-10-06, Cesium
1.146 and 1.144 alike). `RequestScheduler` queues a frame's tile requests in a
`Heap` capped at 20, and `Heap.insert` leaves the request it pushes out past
the cap at index 20 of its backing array until the next push-out overwrites
it; a request's `priorityFunction` closes over its tile, a tile holds its
tileset. After Rostock → Berlin at 1600×1000 the destroyed Rostock tileset
stayed alive that way with 255 000 tiles – a heap of ~980 MB against ~470 MB
once released – until a later view queued more than twenty requests at once,
which is why Hamburg after Berlin showed one live tileset and Kiel after
Hamburg two again. Windows of 1400×875 and smaller never filled the queue and
never showed it: measure a leak like this at the desktop's real size.
`heap-trailing-reference.ts` wraps `Heap.insert` to clear the slot, installed
on `Heap.prototype` the way the readback cache is on `Buffer.prototype`; its
test pins Cesium's behaviour on the real `Heap` and fails the day Cesium clears
the slot itself. The way to it, for the next one: a search through the
objects' own properties from `window` and the `CesiumMap` instance (3.5 M
objects) found nothing – the queue is a module variable, reachable only
through a closure's context – and a snapshot of the 1 GB heap made the
renderer give up. Marking the old tileset with an object of a class of its
own, removing the current tileset and cutting the old tiles' child lists
before the snapshot left 580 MB of heap and a 1.7 GB file, read into typed
arrays rather than through `JSON.parse` (a string tops out at ~536 M
characters); the shortest path from the GC roots to the marked tileset named
the queue.

**A city visited again comes from the browser's cache already; keeping
Google's session by hand was tried and dropped** (2026-10-06). Every tileset
asks for Google's root, whose answer writes a session into every URL beneath
it, and Google names the tiles afresh in every subtree JSON it serves – so a
city's tiles come back from the cache only under the same session, through
the cached subtree JSONs (`max-age=14400`). Google hands a new session to
every unconditional root request, but the root is `max-age=0,
must-revalidate` with an ETag that does not change with the session: a
browser holding the root revalidates, gets a 304 and keeps its session.
Measured with a profile on disk, Rostock → Berlin → five minutes → Rostock:
the way back took 1.7 MB from the network and 1 924 tiles from the cache (the
first visit 64 MB); with a module that kept the root's answer in memory and
handed it to every new tileset, 2.2 MB – nothing gained, so it went. Measure
caching with `chromium.launchPersistentContext`: a fresh Playwright context
has a small in-memory cache, and there the way back was 1 923 tiles and
112 MB from the network.

Also: a canvas assigned as a billboard image gets a fresh GUID per billboard and
a `TextureAtlas` never frees regions, so vehicle badges are **data URLs** (keyed
by URL → one region per line+colour+delay). The colour belongs in the badge
cache's own key for the same reason it belongs in the atlas's: `badgeCache`
outlives the city switch, and a line number met in an earlier city otherwise
keeps that city's colour while its card shows the right one (up to 24 of a
city's lines were wrong after one switch).
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
not get them in within a minute, twice in a row
(`e2e/ship-effects.spec.ts`); the same scene looked at steeply from
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

### Firefox: WebGL runs in another process, and every frame waits for it

Firefox's WebGL is out-of-process (`PWebGL::Msg_*` IPC): the calls go
into a command buffer, but at the end of every frame the content thread
waits in `Msg_GetFrontBuffer` until the host has executed the whole
stream, and every synchronous call (`readPixels`, `getBufferSubData`,
the first `getProgramParameter` after a link) is a round trip that
drains it. Chrome overlaps the GPU process with the next frame; Firefox
cannot, so a frame there is JS **plus** the host's execution **plus**
the stalls, in series – over Hamburg it stuttered badly where Chrome did
not, and `?offline=1` was smooth. Firefox also has no persistent shader
cache, so every visit links its ~40 programs and the derived variants
again, 16–25 ms each, blocking. JS per draw command is ~3 µs in both
engines.

So the levers are the number of GL calls a frame and the synchronous
readbacks, and both turned out to be mostly this app's own: ~27 600 GL
calls a frame in the home view, three quarters of the draw commands
the fleets' (six to thirteen primitives a model – "One primitive per
part" under the ships), and hundreds of synchronous readbacks a second
(the surface picks' `readPixels`, `tileset.getHeight`'s
`getBufferSubData` – the rules under "Ships are clamped to the tiles"
and the cache below). With those cut, the commands per frame at 1175 m
over the harbour went from ~3 900 to ~950 and Firefox's hitches are
gone; its median in motion sits at the 2–3 vsync boundary, and what
remains is the serial frame (JS ~10 ms + host ~5 ms + tick), which only
fewer commands or less JS per tick can shorten further. Measured headed
on the real GPU with Playwright driving the stock Firefox
(`channel: 'moz-firefox'`) and Chrome through one scenario (home view →
flight to 1175 m over the harbour → a pan), a Gecko profile naming the
blocked time. Not done, and why: `KHR_parallel_shader_compile` (Cesium
queries the link result at once); pre-warming the shader variants in
the idle seconds after load (one-time 100–450 ms per fly-in in Firefox;
worth it if the first flight into a city is still felt);
`navigator.deviceMemory` is Chrome-only, so Firefox gets the 1 GB tile
cache – no ratchet seen at these views, but a tilted city view is near
it.

**The GPU readback cache** ([buffer-readback-cache.ts](src/map/buffer-readback-cache.ts),
installed on Cesium's `Buffer.prototype` by CesiumMap): `tileset.getHeight`
is a CPU ray through the loaded tiles (`pickModel`), and for every tile
primitive whose bounding sphere the ray hits it read the positions and
the indices back from the GPU (`getBufferSubData`) – Google's tiles keep
no copy in memory – 2.2 ms a read in Chrome (a pipeline sync), nine to
fifteen a frame during a flight because `Cesium3DTileset.enableCollision`
has the scene sample the height under the camera on every frame it
moves, plus the bridge decks, the stops and the webcams: 1.1 s of a
4.2 s flight, the biggest single stall in Chrome. The first read of a
buffer keeps the whole buffer; later reads are served from the copy
(WeakMap on the buffer object, dropped on `copyFromArrayView`, the
whole cache let go past `READBACK_CACHE_LIMIT_BYTES` = 64 MB). Measured
after: `getHeight` 0.3–0.6 ms a call, 1 700 hits to 100 misses over a
flight, ~10 MB held. `__mg3d.tileMemory().readbackCache` shows the
counters. The collision itself was left as it is: at 0.4 ms a frame it
is not worth rationing.

### `window.__mg3d`

The debug/test API ([src/App.tsx](src/App.tsx), `Mg3dTestApi`) is the first stop
for any "the map is doing X" question: `tileMemory()` (incl. `tilesTotal`,
`replacing`, `readbackCache`), `renderPacing()` (incl. `tickIntervalMs`, `motionPxPerSecond`,
`batchesBuilding`),
`renderRate()`, `shadowMap()`, `tilesetStatus()`, `lastLoopError()`,
`wagonBatches()`, `groundOffsets()`,
`cloudState()`, `funnelSmoke()`, `wake()`, `waterClamp()`, `tiltShiftState()`,
`groundHeights()`, `aisReplay()`, `aircraftCount()`, `aircraftReplay()`;
`setAisVessels(list)` and `setAircraft(list)` put a fleet on the map where
no poll runs (offline, the tests); `basemap()`/`setBasemap()` and
`flatMap()` are the flat map's.

---

## AIS (live harbour traffic)

**Operationally critical:** the production cron must call
`/api/ais?listen=45&key=…` every minute (the key: see "Keys, never in the
repo" below). The bare URL gives 12 s windows, which
stutters moving ships and almost never catches the 6-minute `ShipStaticData`
frames, so ferries render as small default hulls. `?listen=` bypasses the TTL
check and queues for the lock (a later fix: before it the browser's own
short windows kept the state fresh and the keeper answered from cache —
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
section draws the layout). For Windy that file is the fallback: the deploy
and the restore job write the `WINDY_KEY` repository secret into
`api/webcams-key.txt` right before the rsync – never into the build
artifact, which anyone who can read the repository can download. Its
binding to the site's domain at Windy does not make it harmless: Windy
checks the Referer alone, and a request without one passes. The keeper
crons carry a key of their own, the `CRON_KEY` secret, written into
`api/cron-key.txt` the same way: with it in place, a `?listen=` or
`?record=` without the matching `&key=` is answered 403 before any work –
the app never sends either, and each call holds a PHP process for up to
a minute. Without the secret anyone may start a keeper, as before. Keys
are never `VITE_`-prefixed.

Which real vessels the map already runs from a timetable — so their AIS twins
are left out of the backdrop — lives per city in `city.json` under
`ais.simulatedByMmsi` (Rostock FG/FW, Kiel F1/F2, Hamburg 18× HADAG).

**A ship is shareable (`#vessel=<mmsi>`) but not reproducible.** The MMSI is as stable an id as a trip id, yet whether she is
still in the harbour is the harbour's business, so the restore is the
vehicle's mechanism with a longer fuse — `SHARED_VESSEL_TIMEOUT_MS` is 90 s
against the vehicle's 20 s, because a trip is in the very first snapshot the
simulation makes while a ship waits for the poller's first answer and then for
her own next fix. It expires silently, and it must stay that way: a link that
opened an empty card would be worse than one that opens the harbour.

**A ship at rest lies along the course she came in on.** Measured in
Hamburg: 253 of 417 moored ships
reported no heading (511 – the inland barges carry no gyro), 159 of
those no COG either, and the rest a COG at 0 kn that is GNSS drift –
so 60 % of the berthed fleet lay north or anywhere, crosswise to the
quay and through each other. The rule is in `playbackSample`
([ais-extract.ts](src/lib/ais-extract.ts)): a heading is always taken; a
COG counts only from `AIS_UNDER_WAY_SOG_KN` (0.5 kn – the lights'
"moving" reads the same number); at rest she lies along
`AisVessel.lastCourseDeg`, the COG of her last fix under way, which the
state keeps (TS and PHP, `mergeAisMessage`) for as long as she transmits
– a barge that came in a week ago still has it, the keeper's state
outlives deploys; failing that her drift course, failing that north.
The archive's static line carries the field so the replay lays a ship
moored since the morning the same way, but a change of it alone writes
no line (`staticSignature` leaves it out; the fixes under way carry the
courses) – a static line per fix would double the recording. What it
cannot do: a ship never heard moving keeps today's guess, and a ship
that turned to moor bow-out lies the wrong way round. The real fix for
both is the quay: the nearest shoreline segment from OSM's water
polygons as a product of the weekly OSM run, with the last course only to
pick which end is the bow – agreed as the second step, not built yet.

**The harbour is recorded, and a clock set back replays it.** Every fix
the keeper hears also goes into an archive – one NDJSON file per city and
UTC hour, a snapshot of every ship alive at the top of each so an hour
reads on its own, five days kept (`AIS_ARCHIVE_KEEP_HOURS`, 120 h), the
writer in
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
live (a settled decision), a pause holds whichever source drew the
picture; where nothing was recorded – before the archive began, an hour
the keeper missed, a day older than the retention – the water is empty,
never today's ships on yesterday's date. The calendar in the panel offers
the four days behind today for exactly this (`DATE_PICKER_DAYS_BACK`), the
timetable being the same service day throughout. Two traps: the archive
directory is **above the docroot** beside the API keys (`ais-archive/`),
because the deploy's `rsync --delete` empties the docroot nightly – never
put it, or anything else written at runtime, under `dist/`; and
`src/lib/archive-fs.ts` is Node-only and excluded from
`tsconfig.app.json`, so a unit test cannot import it – the writer is
tested against an in-memory store, the file store through the parity
script. What the harbour's and the sky's recordings share – the hour
files, the replay edge, the chunk reader, the client that keeps the
hours loaded – lives in `src/lib/archive-hours.ts` since the aircraft
were recorded too (see the ADS-B section); `ais-archive.ts` is the
harbour's lines, writer and replay on top of it. The first hours after a deploy are thin: the archive starts with
the first window after it, and a moment before that is an empty harbour.
`__mg3d.aisReplay()` says whether the replay is on, which hours are held
and how many ships the recording places at the simulated moment.

**Ships are clamped to the tiles, and the clamps are rationed.** Once
every ship sat on sea level plus the calibrated offset, which put
Frankfurt's fleet 87 m and Berlin's 31 m under the tiles (the Main is a
staircase of lock reaches, Berlin sits on two water levels). Two cures were
built and compared: a measured water surface per lock reach in
`city.json` (more data, more logic; shelved) and a `scene.clampToHeight`
pick per hull ([VesselLayer](src/map/VesselLayer.ts)), chosen for being
less code. Measured cost: 1.4 ms per pick, an offscreen render
with a `readPixels` stall, so never clamp per tick — the layer picks only
for ships on screen and only when the ship moved 25 m or the tiles under
her changed (`surfaceGeneration` in `CesiumMap`), capped at three a
tick; a fleet at rest costs nothing. The pick answers with whatever LOD
is loaded (coarse and fine differ by metres, a ship at a quay can land
on a baked-in crane or on Google's own photographed hull), which is why a
new generation re-reads it. The **scheduled ferries** (VehicleLayer, mode
`ferry`) float the same way: the same `clampToSurface`,
3 picks a tick, again after 25 m or a `surfaceGeneration` bump, the route
profile until the first answer; `FERRY_FLOAT_LIFT` stays on top for the
mesh's crests. The rules that keep the picks rare, all measured (the
Firefox investigation under "Rendering and performance" is where they
come from):

- **A generation is a tile that loaded, at most every 2 s.** It followed
  `allTilesLoaded` until then, which Cesium raises on every load-progress
  transition – a single request, a cancelled one – and the picks' own
  offscreen passes are what starts such requests: at a resting camera
  over Hamburg the event fired six times a second, every ship, ferry,
  buoy and lighthouse on screen was picked again each time (217
  readPixels a second in the home view, each a full scene update), and
  the bridge decks and stops re-measured with it. Now `tileLoad` is
  counted and the generation ([surface-generation.ts](src/map/surface-generation.ts),
  pure, tested; asked once per tick) advances only with a tile loaded
  since the last one and `MIN_INTERVAL_MS` (2 s) after it. At rest
  nothing loads, so nothing is asked again.
- **A pick that found no tile waits like an answered one** – for the
  next generation (or the ship's own 25 m). Ships, ferries and aircraft
  retried a failed pick every tick (`clampedHeight === null` counted as
  stale), the bridge decks every 2 s, the stops every 1.5 s, the webcams
  every 30 frames: a long view over the Elbe kept every budget saturated
  for good. The same tiles cannot answer differently.
- **A new generation re-reads an answered ship only within
  `CLAMP_REFINE_RANGE_AT_REFERENCE`** (2 km at the reference lens; the
  ferries' and the aircraft's constants are the same): the tiles that
  refine as the camera moves are the ones near it, and a metre under a
  ship two kilometres off is a fraction of a pixel. With 245 ships on
  screen at 1175 m, every generation had re-clamped them all – three a
  tick for three seconds, 22 % (Chrome) to 30 % (Firefox) of a pan's
  wall time.
- **No pick while the camera moves** (`CesiumMap.cameraAtRest`, the view
  matrix compared per tick; `host.cameraAtRest` on every clamping layer)
  – but for the ship, ferry or aircraft the chase camera follows, which
  never rests; everything else keeps its last answer, or the fallback,
  for the length of a chase. A pick stalls the GPU pipeline and, in
  Firefox, the process that runs WebGL, at the very moment the frame
  rate is watched; the rest catch up the tick the camera stops, a couple
  of seconds for a harbour at the budgets. Measured in Firefox: 14 % of
  a pan's wall time in the picks' `readPixels`, 7 % in their scene
  updates, before. "Still" is `CAMERA_STILL_EPSILON` (1e-6 per matrix
  element), in `noteCameraAtRest` and
  `cameraMovedSinceRender` both: a camera 35 m over Rostock's Neuer
  Markt at a near-level pitch (`height=35&pitch=-9`) had its view
  matrix churn by 2e-9 a frame with nobody touching it – numerical
  noise of Cesium's own camera update – and exact equality never saw
  it rest, so no surface pick ran there and every frame was drawn.
- **A pick sees the tiles alone.** `clampToSurface` hides every top-level
  primitive but the tileset for the pass and restores it after – the
  fleets under their own root collections (`VesselLayer.root`,
  `VehicleLayer.root`, `AircraftLayer.root`; a `Model` merely hidden is
  still updated, a hidden parent collection is what skips it), the
  lights, the buoys, the route lines, the stop names, the webcams. Before,
  every layer kept an exclusion list (hulls, boxes, plates, lights,
  expanded to the points Cesium matches against, `clamp-exclusions.ts`),
  and an excluded hit costs Cesium a second offscreen pass from below it:
  a ship's own hull under her ray made every clamp two passes, six
  readPixels, with 1 200 `Model.update`s each – 7.9 ms a clamp in Chrome,
  10.5 in Firefox; 2.1 and 3.2 ms now.
- **A pick's answer is judged, not taken.** The tiles
  carry the ships Google photographed at their berths and every bridge
  deck, and a hull at such a berth stood on the twin's deck, a tug
  passing under the Köhlbrandbrücke rode over it. The pick answers with
  the highest thing at the position and over water nothing lies under
  the surface, so its error is always upward – which is the lever:
  [water-clamp.ts](src/map/water-clamp.ts) (pure, `tests/water-clamp.test.ts`)
  judges every answer against the references at hand and holds one that
  stands too far over all of them, at the cost of a comparison, never a
  second pick. Three references, any one of which admits a pick: the
  hull's own last level (a rise of at most `riseM`, 3 m, a fall always –
  but only a level read *fine* vouches: within `CLAMP_FINE_RANGE_AT_REFERENCE`,
  1.5 km, with the tiles loaded (`host.tilesLoading`), because a coarse
  tile answers metres under the water and a level read off one would
  hold the true water back as a rise, for good on a hull at rest); the
  water level the city knows (`knownWaterHeight` on the host – NHN 0
  over the ellipsoid, `routes.heightOffset`, where `waterLevelNhn` is
  set; a ferry's route profile in VehicleLayer), as a band of `aboveM`
  (4 m) over it – Hamburg's tide as photographed and the mesh's
  undulation fit, a box ship's deck or any bridge does not – and
  `belowM` (8 m) under it, because the mesh's water sags: the
  Köhlbrand's middle reads five metres under NHN 0 (probed on the real
  tiles); and inland the lowest level accepted for a neighbour
  in the same `cellM` (300 m) cell, read fine (`VesselLayer.neighbourFloor`,
  built once per tick when first asked). A held answer leaves the hull
  on her level, or on the reference it was held against (the lifted
  fallback surface for the known level, the floor itself inland), and
  waits for the next tile generation like an accepted one (`pickedHeight`
  is what the staleness rule reads now). Inland, `confirmPicks` (4)
  moved picks agreeing on a higher level make it hers – a lock lifts her
  into a reach kilometres long, a bridge deck is crossed in one or two
  picks – but a re-read of the same spot confirms nothing, and where the
  level is known nothing is ever confirmed: the coast has no lock that
  lifts a ship out of the band, and a coaster sent along the car
  terminal quay reached three agreeing picks on it before the water took
  her back. A level taken with nothing to judge it by is `provisional`:
  the first hulls picked after a city arrives, before any floor stands,
  may be on a twin, and a floor that appears later drops it. Verified
  over the real tiles: the box ships at the Waltershof
  and Burchardkai berths lie at the water inside their twins instead of
  on them, and a coaster served from a mocked `/api/ais` through the
  bridge's deck (the mesh has it at 53.5195–53.5205 N, 9.9414–9.9434 E;
  over the channel's middle the deck is lost, as at the Humboldthafen)
  kept her 39.2 m through picks of 90.7 and 88.9. Known and open: a lone
  inland ship at rest on her twin – nothing is there to judge her first
  pick by – and a lone one whose fine first pick was still a little low;
  a water-level grid from the terrain model, sampled inside OSM's water
  polygons in the weekly OSM run, would be the reference that closes both
  and the better fallback before the first pick (Frankfurt's fleet rides
  87 m under the Main until then). The buoys and the lighthouses are not
  judged: a buoy never moves and a lighthouse wants the top.
  `__mg3d.waterClamp()` reads the rules, the verdicts counted and every
  hull with an answer. Two lessons from the probe: `__mg3d.setAisVessels`
  is overwritten by the next poll answer online, so a ship put on the
  real tiles has to come through a mocked `/api/ais` route; and a
  height grid probed with `scene.clampToHeight` over the water is the
  quickest way to see what the mesh holds at a place.
The **ferry route lines** drape over the tiles the same way:
`clampToGround` polylines, the per-frame classification
every other route avoids, because NHN 0 plus offset plus a 1.25 m lift
(`FERRY_ROUTE_EXTRA_LIFT`, gone) still dipped into the water or floated
over it. A clamped line does not pulse on "zoom to line" (Cesium's
per-material batch does not re-evaluate colours per frame). Offline the
ferry lines lie on the ellipsoid like every other route. `tileset.getHeight` (CPU, 0.3 ms) was rejected: it answered for
only half the fleet – checked again against the pick for every
ship on screen: 12 of 49 at 1175 m, 47 of 226 in the home view, and from
a low camera the heights it did give were off by 200–680 m. `sampleHeightMostDetailed` was rejected harder: it
loads the finest tiles under every ship (10 000 tiles and 100 MB for one
fleet) and feeds the tile-tree leak.

**Bridge decks are measured on the tiles too, with a CPU ray, not a pick.**
The pipeline's bridge profile is a straight deck between the terrain heights
at both ends of a bridge range (`applyBridgeProfile`); the terrain model is
bare earth, so a viaduct whose ends meet the ground comes out at street
level – Berlin's Stadtbahn (one 6.2 km bridge range, OSM tags it
correctly) had the S-Bahn in its own arches and 10 m under the
Hauptbahnhof's upper level, and every Hochbahn (Berlin U1/U3, Hamburg U3,
Cologne 13) is the same case.
[bridge-decks.ts](src/map/bridge-decks.ts) reads the deck off the tiles per
route vertex inside a bridge range, plus stations every 30 m where a
straight bridge way has none (Frankfurt's Friedensbrücke: one vertex in
289 m; the routes draw through the stations) – on screen only, 6 per 200 ms pass,
nearest first, again after each `surfaceGeneration`, kept for the visit,
one point shared by every line on the same OSM way (Berlin: 1281 points
for 107 directions) – and vehicles and route polylines take it, blending
into the profile at the portals (`heightAt`). It uses `tileset.getHeight`, the tool the ships
rejected, for two reasons that do not apply to ships: a route vertex has
the route's own polyline drawn exactly on it at exactly the wrong height
(a pick has not always seen the tiles alone), and a vertex
that gets no answer is simply asked again – at the next surface
generation, like everything else (see the ships' rules); measured
on real tiles: 1–2 ms a ray near the camera (timed on screen in Phase 6),
and the ray no
longer reads the tile geometry back from the GPU each time (the readback
cache under "Rendering and performance"). A ray
answers with whatever is on top, or – where the mesh lost a thin bridge,
as at the Humboldthafen – with the water underneath, so a sample is
trusted only 2.5 m and more above the profile (`DECK_ABOVE_PROFILE_M`;
between 1 m and that it is weak and sets its own point where no trusted
one encloses it – the Friedensbrücke's deck stands 1.3 m over the
profile – and below that the profile stands, which is right at a portal
and no worse than before over a hole; and more than 80 m over it,
`DECK_ABOVE_PROFILE_MAX_M`, a sample is a roof whatever its neighbours
say: a coarse tile under a camera that had just arrived answered 478 m
over Hamburg's Hauptbahnhof, and seven bus lines stood up into the sky
there, the points off screen under the camera and never read again –
found in Phase 6, the Köhlbrandbrücke's 55 m is the highest real deck),
and among the trusted ones station halls (the
Stadtbahn's stand 12–16 m over the rails, the Hauptbahnhof's 8 m over the
southern tracks) and survey-day trains are pruned as samples no deck
could climb to from their neighbours at the mode's gradient
(`pruneRoofs`, a slope-limited lower envelope; `DECK_MAX_GRADIENT`: 3 %
rail, 5 % tram, 8 % bus – a steeper real ramp is softened to it, and a
hall longer than twice its roof height over it keeps a tent in its
middle). A changed deck is published with every other one, in a tick
that may rewrite the routes – once a second at most, since each rewrite
rebuilds the city's whole polyline batch (see "The routes are rewritten
together"). Stops on a
viaduct are untouched: they already re-measure themselves near the camera
(`StopsLayer.resolveHeights`). `__mg3d.bridgeDecks()` shows the progress,
`__mg3d.bridgeDecks(lineId)` a line's vertices with sample and verdict.
Real fix, if ever wanted: a surface model (DOM1) for bridge ranges in
`data:heights`; it was weighed against this and deferred for needing one
source per state.

For any AIS change, mind the PHP/TS parity: `scripts/test-ais-parity.mjs`,
`scripts/test-ais-state.mjs`, `scripts/test-ais-archive-parity.mjs` and
`scripts/test-php-parser.mjs` run in CI – and for the aircraft
`scripts/test-aircraft-parity.mjs` and
`scripts/test-aircraft-archive-parity.mjs`. If ships appear undersized, check
production for null `lengthM` first — that is a learning/window problem, not a
model bug.

---

## ADS-B (live air traffic)

Built after the AIS pattern: `/api/aircraft?city=<slug>` (the
Vite middleware, `server/api/aircraft.php` in production, the extraction
shared in [src/lib/aircraft-extract.ts](src/lib/aircraft-extract.ts) and
held to the PHP twin by `scripts/test-aircraft-parity.mjs`),
[AircraftLayer](src/map/AircraftLayer.ts) after VesselLayer, an
`AircraftCard`, `#aircraft=<hex>`, `?aircraft=0`, the panel row after the
ships. Decisions that should not be re-litigated:

- **The source is adsb.fi's open data API** (`opendata.adsb.fi/api/v3`),
  a readsb aggregator with second-by-second updates, no key, one request
  a second for personal use, and a link asked for in return (the layer's
  static credit – in the credits dialog only, not on
  screen: the terms name no place, unlike Windy's, whose courtesy line
  has to stand in the corner of the map and does). OpenSky was the alternative and lost on resolution (10 s
  anonymous, 5 s registered, credits per day). Both sides keep the rate
  limit for every city together: a 4 s per-city TTL and upstream calls
  spaced a second apart, in PHP through the lock file's mtime. If adsb.fi
  ever requires a key for non-feeders (adsb.lol has announced it), the
  same shape is spoken by airplanes.live and adsb.lol – only the URL and
  the query helper (`adsbQuery`) would change.
- **No altitude filter.** The traffic at cruise is wanted as much as
  the approach, so every aircraft over the city is drawn, at 12 km up as
  at 400 m. The plates are drawn out to 60 km and the bodies to 40 km for
  that reason. A wide-body at cruise is a few pixels and its plate; that
  is the picture asked for.
- **The sky is a circle, not the box.** The endpoint serves everything
  within the circle it asks adsb.fi for – the box's corner distance plus
  `AIRCRAFT_MARGIN_NM` (6 nm) – while the camera's leash stays the box.
  For the soft end of a follow: where the chase would
  carry the camera out of the box, `FollowCamera` parks it at the edge
  (`clampToLeash` on every layer host, `CesiumMap.clampToLeash`) and
  looks at the subject from there, turning after it until it leaves
  the circle a minute later and the card closes. Before, the aircraft
  vanished at the box's edge and the follow ended with the camera
  snapping back inside. The ships get the same soft end at the box's
  edge, though their data still ends there. `e2e/aircraft.spec.ts`
  flies one out over Rostock's eastern edge.
- **Recorded like the harbour, by a keeper of its own.**
  [src/lib/aircraft-archive.ts](src/lib/aircraft-archive.ts)
  is the AIS archive's pattern on the shared hour files
  (`archive-hours.ts`): a line per fix, a static line when the callsign,
  registration, type, category, squawk or position source change, a
  snapshot per hour, five days, `&hour=`/`&from=` reading, the PHP twin
  in `aircraft.php`, `scripts/test-aircraft-archive-parity.mjs` holding
  the two to the same files. What differs is the source: adsb.fi answers
  polls, one a second for every city together, so the per-city polls
  cannot record for thirteen cities – the recorder is a keeper that
  polls ONE circle covering every city (`adsbCoverQuery`: 220 nm around
  51.25° N 10.20° E today, against adsb.fi's cap of 250; Germany fits
  with thirty miles to spare, and `tests/aircraft-archive.test.ts` fails
  the day a city does not) every `AIRCRAFT_KEEPER_INTERVAL_MS` (10 s –
  the recording's resolution; at cruise a straight two kilometres, on
  final a chord through the turn) and writes what moved into every
  city whose circle holds it. The per-city live polls do not record:
  two writers on one file would double its density while a city is
  watched and leave the rest thin. **Operationally critical, like the
  AIS keeper:** the production cron must call
  `/api/aircraft?record=50&key=…` (the AIS keeper's key) every minute –
  the keeper answers at once, then polls at :00, :10,
  :20, :30 and :40 of the minute (the poll at :50 would not finish
  inside the 52 s wall budget; the twenty-second gap to the next
  minute's first poll is interpolated across in the replay) under a
  lock of its own (`mg3d-aircraft-keeper.lock`, a keeper still running
  skips the next minute's), each poll under the shared spacing lock,
  into `aircraft-archive/<slug>/` above the docroot beside
  `ais-archive/`. Without the cron there is no recording at all (the
  AIS archive fills a little from the browser's own windows; this one
  does not). In dev the middleware runs the keeper from the first
  aircraft request on. Measured: the cover circle answers
  ~460 aircraft at 21:40, 71 kB gzipped; expect the busiest city
  (Frankfurt, ~100 aircraft aloft) to record ~3 MB an hour raw, which
  the `.htaccess` deflate rule for `application/x-ndjson` shrinks to a
  fifth on the way to the browser. If the webspace ever fills, thin the
  writer by dead-reckoning distance rather than by cadence.
- **The live traffic renders on the simulated clock, as far as the
  present.** `aircraftNow = min(simMs, now)` in the render loop, unlike
  the ships, which render live on the real clock: a clock set back a
  little moves the traffic back a little (the live tracks reach three
  minutes back), a pause holds it where it stands, and at the replay
  edge (`aircraftReplayWanted`, the ships' `REPLAY_EDGE_MS`) the
  recording takes over without a jump – both sample the same instant.
  The ships' four-minute delay hides that seam; an airliner's dozen
  seconds would not. The replay's `aircraftAt` hands the layer the
  fixes from the one before the sampled instant to the one AFTER the
  last fix before the moment, because the recording (10 s) is coarser
  than the playback delay (12 s) and the sampler interpolates between
  the fix before its instant and the one after – the AIS replay ends
  its track at the moment, the aircraft one reaches one fix past it.
  Offline, with no archive client, a clock in the past keeps the
  injected list rather than emptying the sky.
- **Heights.** `alt_geom` is a height above the WGS84 ellipsoid and goes
  into Cesium as it is. A pressure altitude – `alt_baro` from an
  aircraft that reports nothing else: multilaterated ones, older
  transponders, a fifth of the sky – is lifted onto that scale by what
  the sky measures (`pressureLift`): the median
  geometric-minus-pressure difference of the five aircraft nearest in
  pressure altitude, within 1500 m of it, that report both. That
  difference is the geoid height plus the day's pressure and grows with
  the height through air off the standard's temperature (Frankfurt on
  one day: 120 m down low, 310 m at cruise; on a high-pressure day of
  about 1032 hPa: 200 m down low); where fewer than three report both
  there, `routes.heightOffset` (the geoid height the routes are
  calibrated against) alone. Before the lift that was the rule
  everywhere and "the pressure error lived with", which drew a
  pressure-only aircraft on Frankfurt's runway 150 m under it one
  morning, and SWR41D up to
  151 m under it for its first seconds after lift-off, until its own
  geometric altitude came in. Which of the two a fix carries rides with
  the fix (the track point's ninth element, `true` for geometric),
  never with the record: the record is twelve seconds
  ahead of the picture, and once it reports the ground it reports no
  altitude at all, so the approach still being played took the geoid
  height on top, and every landing hovered some forty metres over the
  runway until the playback reached the ground and dropped onto it (seen
  in recordings over Fuhlsbüttel and BER). `aircraftPlaybackSample(…,
  pressureLiftM)` puts every fix on the geometric scale before it
  interpolates; a fix without the element (a state written before it,
  three minutes' worth) takes the record's kind, geometric where the
  record reports none. An aircraft on the ground is clamped to the
  tiles like a ship (three picks a tick, again after 25 m or a
  `surfaceGeneration` bump, under the ships' rules – camera at rest,
  refine range, a failed pick waits), and so is one coming down onto
  it: across the segment from the last fix in the air to the first on
  the ground the playback carries the altitude on at the last fix's
  vertical rate and `groundShare` says how far the segment has come,
  and the layer blends toward the clamped apron and never draws the
  aircraft below it (`drawnHeight`) – it touches down where its rate
  meets the runway and rolls there, on it by the first fix on the
  ground at the latest; lifting off is the same backwards, along the
  first climb. It held the last altitude reported until then, and fell
  onto the runway at the first fix on the ground. And so is one the
  reckoning carries down blind (`sinkingBlind`): past its last fix,
  descending, within `GEAR_DOWN_AGL_M` of the city's ground, it is
  picked like one on the ground and stopped on the apron, by a pick no
  more than 250 m back (`CLAMP_FLOOR_RANGE_M`) – offline and on the
  flat map, where no pick answers, on the plane the ground is there
  (`host.flatGround`) – and rolls on there for what is left of the
  reckoning. The feeders lose a Frankfurt landing
  0–35 m over the runway and hear it again on the ground 50–160 s on –
  one landing in six within ten seconds – and the reckoning ran it on
  down 40–50 s up to 77 m under the runway. Two things it does not do:
  a blind descent while the camera moves, unfollowed, still sinks (no
  pick then, as for every clamp), and an aircraft unheard past
  `AIRCRAFT_EXPIRE_MS` still leaves the map, to come back with its
  first fix on the ground. Nothing else is
  clamped – the feed's number is the truth, and a reckoned descent is
  not the feed's number. Measured on one day's Frankfurt answers,
  recorded and replayed through the layer (scratch script,
  not kept), per landing: over the runway after the record's ground
  flag 6–10 s before, 0–0.8 s after; under it 37–50 s (down to 77 m)
  before, 0–2 s (down to 7 m, the feed's own altitude a little low on
  the approach) after. `tests/cesium-aircraft-layer.test.ts` flies a
  landing, a blind descent and a pressure-only aircraft among others
  through the layer (the old code drew 120 m where 80 were reported),
  `tests/aircraft-extract.test.ts` pins the sampler's scale and shares
  and the lift, on the 2026-09-11 Frankfurt answer among others.
- **Playback 12 s behind, reckoned 20 s ahead.** The ships wait at their
  last fix when data dries up; an aircraft flies on from its last speed,
  track and climb rate for `AIRCRAFT_RECKON_MAX_MS`, then freezes –
  hanging in the sky is the lesser wrong, flying into a building the
  greater – and a descent near the ground stops on the runway (see
  Heights). An aircraft unheard for `AIRCRAFT_EXPIRE_MS` (60 s) leaves.
- **The card shows the aircraft as drawn.** The
  record is the last fix, twelve seconds ahead of the body; the card
  read it and said "on the ground" while the body was still twelve
  seconds out on its approach, which read as the body hovering over the
  runway. `AircraftLayer.asDrawn` hands it the record with the drawn
  instant's altitude, ground speed, climb and ground (the layer's
  `grounded`, the blind descent's stop included); the flight level is
  the drawn altitude less the aircraft's own geometric-minus-pressure
  difference, or the sky's lift where its record lacks one. The app
  reads it while rendering, like the clock beside it, so it is as fresh
  as the last render – a second at real pace. The age in the head stays
  the feed's. `e2e/aircraft.spec.ts` opens the card on a record that
  has landed ahead of its body (passed the record through, the card
  read "on the ground" – checked by breaking the wiring once).
- **Pose.** The nose follows `true_heading` where reported, the pitch
  is `atan2(vertical rate, ground speed)` capped at 12°, the bank is the
  reported `roll` or the coordinated turn the track rate implies, capped
  at 35°. Cesium's HPR frame: positive pitch is nose up, positive roll
  is right wing down, which is what readsb's `roll` means too.
  The heading rides in the track point (its eighth element,
  absent on points an older state wrote) and the playback eases it on
  its own arc as `noseDeg`, beside `bearingDeg` for the motion; the
  layer draws the nose and chases along the bearing. It was the motion
  bearing plus the crab of the record's latest heading against its
  latest track, and the aircraft spun 180° on the apron:
  polled at Frankfurt one evening, nearly every aircraft on the ground
  reports a heading and NO track (the surface position message carries
  the one and not the other), so the bearing was the azimuth of a
  parked transponder's wobble where it exceeded 5 m and north where it
  did not – and a taxiing aircraft that still carried a track had the
  stale number of its last velocity message, which the crab measured
  the fresh heading against. Rules now: a segment's azimuth is a
  direction only with real movement (a metre a second); standing, an
  aircraft keeps the last direction known from its track – the heading
  first for the nose, the track first for the bearing – and north is
  only for one that never said either; a pushback moves the aircraft
  tail first with the nose on its heading. `tests/aircraft-extract.test.ts`
  pins the crab, the parked wobble, the pushback and the old point shape.
- **Bodies.** Seven archetypes in `scripts/lib/aircraft-fleet.mjs`,
  stretched per type from the table in
  [src/lib/aircraft-info.ts](src/lib/aircraft-info.ts) (ICAO designator →
  archetype, length, span, height; the emitter category as fallback). A
  helicopter's length there is the fuselage's, nose to tail rotor, not
  the "rotors turning" figure – the model is built that long.
  `tests/aircraft-models.test.ts` pins the GLB bounds against
  `ARCHETYPE_SIZE` and `AIRCRAFT_DIMS`. Surface vehicles (emitter
  category C) are dropped in the extraction: the map has no body for a
  follow-me car. The aircraft have smooth 32-sided
  fuselages and nacelles, profiled wings and fins, recessed engine intakes
  with fans, door outlines and satin PBR materials. `model-detail.mjs`
  holds the shared curved geometry and normal smoothing; keep hard edges
  at caps and thin trailing edges. Glass stays ON the actual shell
  (`shell.pointAt` uses the original sixteen-sector angular coordinates
  independently of the mesh resolution); small portholes remain dots at
  map distance. The four jets use a width-scaled forebody with separate
  crown and belly profiles: a raked cockpit above a blunt, rounded
  radome, not a continuous taper to a point. `jetCockpit` projects six
  pane contours from front/side elevations onto that shell. Mirror the
  triangles and normals as well as the window positions; opposite
  angular bands do not have the same height direction, so repeating one
  side's offsets on the other is not a reflection (the first strip
  cockpit had mismatched heights on each side).
  `tests/aircraft-models.test.ts` checks the six connected panes, the
  centre pillar and the mirrored normals. Rotors and propellers have shaped blades in a faint
  translucent blur; the helicopter's tail rotor has an open shroud.
  Aircraft stay below 12,000
  triangles and 800 kB each (smaller types have a tighter budget; the
  merged primitive's colour and palette coordinate are 8 bytes a vertex,
  see "One primitive per part" under "Cities and the data pipeline").
  The retractable gear remains its own `mesh.parts.gear` / glTF `gear`
  node, which `AircraftLayer` shows only within `GEAR_DOWN_AGL_M` (600 m)
  of the city's ground. The light single's gear and helicopter skids are
  fixed. `e2e/aircraft.spec.ts` checks cruise → approach → climb on the
  actual loaded GLB as well as the navigation lights. Road and rail
  vehicle GLBs must stay byte-identical when changing these helpers.
  The three small bodies were rebuilt against photographs of a Cessna
  172 and an Airbus H140 and ATR's official 72-600 side elevation.
  `shapedShell` lofts independent crown, belly and width
  stations; `shellPanel` clips window and paint contours against the
  actual shell triangles in front, side or top elevation and mirrors
  both geometry and winding. Do not return to angular glazing bands:
  they made small windows into strips and the helicopter's nose into a
  visor. The Cessna has a short full cowling, separate front/door/rear
  panes, a constant-chord inboard wing, tapered outer panels, flat
  sprung gear legs and restrained red stripes. The H140 has a sculpted
  engine cowling, five full main blades, a T-tail and ten blades inside
  an OPEN Fenestron: neither the boom nor a solid fin crosses its hole.
  The ATR has a rounded radome, six cockpit panes, rounded rectangular
  cabin windows, tapered nacelles, six swept propeller blades, integrated
  gear sponsons and a continuous dorsal fillet. Use convex slabs for the
  fillet's sections: a concave quad reverses a triangle and turns black.
  `rotorBlur` is faint around the shaped blades; the jets' original
  helpers and materials are unchanged. Render the actual GLBs from both
  quarters, the side and above when revising a body; the dimensions test
  alone did not catch the old long Cessna cowling or blocked Fenestron.
  Keep all three below the existing 8,500-triangle/800-kB budgets and
  mirror changed light anchors in AircraftLayer. Rebuilding the fleet
  must leave every other GLB byte-identical.
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
  in service keeps them on; `tests/cesium-ferry-float.test.ts` pins it.
  The road and rail vehicles wear two white headlights at the leading
  end and two red tail lights at the trailing one through the same
  pool (`addVehicleLights`, Phase 4 of the backlog, 2026-10-06): at
  night, within the body's range only (a light without its body is a
  stray point), never on a ghosted body, seen from ahead and from
  behind over `HEADLIGHT_ARC_DEG` (100°) either side, on the end
  wagons' own frames where the body is a consist, so a curve does not
  leave them beside the cab, and `VEHICLE_LIGHT_PROUD_M` (0.4 m) proud
  of the end face: a hand inside the shell they were hidden by the shell
  from anywhere near and showed from a distance alone, where the
  point's pixels reached past the outline (seen on the bus and the
  S-Bahn before the margin). The test file pins them beside the ferry's;
  `__mg3d.navLights().ferries` counts the scheduled vehicles' lights,
  the ferries' among them. The screened lights show over
  their real arcs (112.5° sidelights at sea, 110° in the air, the stern
  and tail light the rest) – from the chase camera behind an aircraft
  the tail light and the strobes, never the red and green. A flash that
  changed on an aircraft on screen requests a frame; a ship's lights
  are steady and ask for none. The light positions per archetype are
  the workshop's `mesh.lights` copied into `AIRCRAFT_MODELS[…].lights`
  (glTF x,y,z → layer y,z,x), pinned by the model test; a ship's come
  from her hull's dimensions and funnel. The collections live in the
  layers' root collections, which a surface pick hides, or a beacon over
  an aircraft on the apron would be what the apron pick hits.
  `__mg3d.navLights()` counts them per fleet.
- **Shadows and pacing** join the existing gates: the nearest drawn body
  and its span feed `applyShadowState` like the nearest hull, and an
  aircraft in view paces the ticks like a tram – the render range for
  that is 15 km at the reference lens, three times the ships', because
  an airliner moves on screen from much further out.

Verified with a live answer over Frankfurt: 50 aircraft in a
21 nm circle, 39 with `alt_geom`, 32 with `roll`, 3 on the ground, 2
multilaterated; that answer is the fixture (`tests/fixtures/adsb-aircraft.json`).
`e2e/aircraft.spec.ts` puts two aircraft on the offline map through
`__mg3d.setAircraft` and checks bodies, plates, the hash and a clock
set into the past (offline it keeps the list: no recording to switch
to). Two traps met writing it: a spec that wants aircraft must boot on
the real clock – `?time=12:00`, which every other spec uses, is a clock
hours behind, and the traffic renders on the simulated clock, so an
injected track around the real moment leaves the aircraft standing on
its first fix – and the injected track has to outlast the runner's
slow model loads (ten minutes around the rendered instant), or the
playback reaches the reckoning window and freezes before the pacing
assertion runs. The replay itself is unit-tested against a fake
endpoint (`tests/aircraft-archive.test.ts`), like the harbour's.

---

## Weather (Open-Meteo)

**The sky follows the simulated clock, and nothing is recorded for
it.** Before that the live weather was one `current`
reading, shown only within ten minutes of the real clock
(`maxSimTimeDriftSeconds`, gone) – a clock set back an hour meant a dry,
open sky over a harbour that was replaying its ships. Open-Meteo keeps
its own past: the same forecast endpoint answers `past_days=` on the
quarter-hour grid its models run on (`minutely_15`, the grid `current`
is the newest step of – checked: the two agree to the value),
so [src/lib/weather.ts](src/lib/weather.ts) fetches the last
`WEATHER_PAST_DAYS` days and the rest of today in one request (16 kB
for three days, ~25 kB for five) every ten minutes, and the UI tick in `App.tsx` takes the step of
`min(simMs, now)` out of it (`weatherAt`) for the rain, the overcast
grade, the clouds' wind, the temperature on the weather button and the
visibility that lights the airfield by day (see the airfield paragraph
under "Cities and the data pipeline").
Decisions: five UTC days back, because the calendar's
four Berlin days begin at 22:00 UTC of the evening before
(`DATE_PICKER_DAYS_BACK` carries the reason); a clock set ahead shows the present's sky, never
the forecast the answer also holds – a forecast is not a fact, and the
ships and the aircraft stay in the present too; a moment the series
does not reach is a dry, open sky, never today's weather on another
day; nothing is interpolated between steps, the sky is a grade. A
picked sky and the test API's `setRain`/`setCloudCover` are `forced`
and the tick leaves them alone; switching back to live hands the values
to the tick, which fills them within a quarter second. Offline there is
no series (`liveWeatherAvailable` is false), which is what keeps every
spec deterministic – `e2e/rain-gate.spec.ts` and `e2e/clouds.spec.ts`
force their sky.
