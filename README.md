# 🚋 Mini Germany 3D

**The public transport of German cities, live on a photorealistic 3D map** –
inspired by [mini-tokyo-3d](https://github.com/nagix/mini-tokyo-3d), built with
[CesiumJS](https://cesium.com/platform/cesiumjs/) and
[Google Photorealistic 3D Tiles](https://cesium.com/learn/cesiumjs-learn/cesiumjs-photorealistic-3d-tiles/).

One city at a time – the caret beside the panel title lists the others and
flies you there. Trams, subways, S-Bahn trains, buses and ferries run
schedule-based along their real routes through the city – with time-lapse,
line filters, a stops layer, a chase camera that follows vehicles, shareable
view and vehicle links, day/night lighting that follows the simulated time
(including a night-time cabin glow under the vehicles), and a UI styled after
[shadcn/ui](https://ui.shadcn.com/).

It started as **Mini Rostock 3D** and Rostock is still the city it opens on.
Twelve more cities are a caret away – Kiel, Lübeck, Wilhelmshaven, Bremen,
Schwerin, Berlin, Hanover, Hamburg, Cologne, Frankfurt, Stuttgart and
Munich; adding one is a folder, a `city.json` and a run of the data
pipeline (see [Cities](#cities)).

![Morning rush hour over the city center](docs/screenshots/city-day.jpg)

![The same view at night – the lighting follows the simulated time](docs/screenshots/city-night.jpg)

---

## Features

| Feature | Details |
|---------|---------|
| Several cities, one map | Every city is a definition (`src/cities/<slug>/city.json`) plus generated data next to it. The caret beside the panel title switches; the old city's routes, stops, lamps and vehicles are taken down, the camera flies to the next city's home view with the leash lifted, and the new city's data comes in as a lazy chunk of its own. `/<slug>/` is the city's own address – a link opens on the city its path names |
| A page per city | Every city has an address of its own – `/berlin/`, `/en/berlin/` in English, `/` and `/en/` for the front door (`src/lib/site-path.ts`) – and the build writes an `index.html` into each: the app, and under its root the city as plain HTML – its facts as the city card states them, its lines, the links to the other cities – with title, description, canonical URL, language alternates and link preview in the head (`src/lib/site-pages.ts`, the prerender plugin in `vite.config.ts`, the pictures in `public/og/`). For a crawler, for the preview of a shared link, and for a browser without WebGL: the app hides the page as it starts and the error boundary shows it again with a notice when the viewer cannot be built (`src/components/ErrorBoundary.tsx`). `public/robots.txt` and the built `sitemap.xml` point the crawlers at the pages |
| Legal notice and privacy notice | What German law asks a website for (§ 5 DDG, § 18 MStV, Art. 13 GDPR), written once in both languages in `src/lib/legal.ts` – the provider's details at its top – and read in two places: a dialog in the app (`src/components/LegalDialog.tsx`, opened from the foot of the welcome screen and of the About dialog, not a tab of it) and a page of its own under the map, `/impressum/` and `/datenschutz/`, `/en/imprint/` and `/en/privacy/`, linked from the foot of every page – for a crawler and a browser without WebGL. Opening one of those addresses with the app opens the dialog over the door. The pages carry `noindex, follow` and stay out of the sitemap; the app's links to them are real links, so a middle click gets the page |
| Camera path | A dolly shot, composed in a bar of its own over the foot of the map (`src/components/CameraPathBar.tsx`, opened by the last button of the photo popover; the readings beside it fold into a column of icons while it is up, and the bar fades to half once it has been read and the pointer is elsewhere): save the current view as the start and end, preview either saved view, enter a duration (1–600 seconds), choose smooth or constant motion, then press play – the camera eases from one to the other (or moves at a constant pace) while the city goes on underneath, and a timeline scrubs along the way in tenths of a second (Home/End jump to its endpoints). Playback always starts from the beginning; settings are locked while it runs, while preview and scrubbing can interrupt it. It runs on the wall clock, so pause and time-lapse leave it alone; H takes the interface away for a clean recording. The path rides in the URL (`#path=…&dur=…`) and `?play=1` flies it once the city is up, so a shot is a link (`src/lib/camera-path.ts`). It belongs to its city: a switch drops the keyframes – poses over the city that is leaving – and keeps the seconds and the pace for the next shot |
| A phone's interface | Under 640 px the panel and the cards are one sheet at the foot of the screen – the panel opens folded to its clock, a card takes the sheet's place while it is up and the panel leaves – the weather, the readings and the rail stand at the top, and what has no place on a phone is not offered: the line diagram, the photo mode, full screen (`src/lib/viewport.ts`, the `max-sm:` variants in `App.tsx`). The map draws from the mobile render profile there – a smaller shadow map, coarser tiles in a smaller budget (`src/lib/render-profile.ts`, `?tier=` below) |
| Welcome screen | The front door on a plain visit: a full-screen chooser in the map's green with a card per city (its name, its modes, a ship where ships sail – a ferry line or the live AIS harbour), while Cesium and the world load behind it and nothing of any city does – no data, no vehicles, no stops, no pollers, no URL written. The pick puts the camera straight on the city's home view, a jump rather than a flight, and starts its session at once, while the screen stands two seconds longer with a spinner on the card – longer if the data takes longer – so what it uncovers is a city already drawn, not one filling up. A checkbox turns the screen off for good in that browser; the app then opens on Rostock. A link that says where to go – a city, a camera pose, a vehicle, a ship or a stop in the hash – walks past the door; `?welcome=1` opens it regardless and `?welcome=0` skips it for one visit (`src/lib/welcome.ts`) |
| Cesium map with Google 3D Tiles | `createGooglePhotorealistic3DTileset` via Cesium ion, falls back to a wireframe globe when unreachable (the tests run on that offline mode, `?offline=1`) |
| Vehicles as low-poly consists on real routes | Procedural glTF models after the real fleets, picked per city and line – Rostock's five-section Vossloh 6N2 tram (32 m), three-car Talent 2 S-Bahn (57 m), 12 m buses and its two Warnow ferries as their real double-enders, with smooth hulls, fender tubes, railings and deck fittings; Kiel's Förde ferries sail as the same double-enders, sized per line; Berlin's U-Bahn (BR H) and S-Bahn (BR 481) run as six-section third-rail consists – each with glazing, grey roofs, pantographs or bridges. Muted livery with a hint of the line color, schedule-based simulation (see [Data](#data--gtfs--gtfs-realtime--osm)) |
| Routes/lines on the map | Polylines at absolute terrain heights in line colors (clamped onto the tiles only for the ferry lines, which drape over the tiles' own water, and for a dataset without heights); on a bridge the deck is measured on the tiles instead – a bare-earth terrain model knows no viaduct, and Berlin's Stadtbahn ran through its own arches until it was (see [Data](#data--gtfs--gtfs-realtime--osm)); zooming to a line pulses its route while everything else on the map briefly steps aside – the other routes, their vehicle badges, every stop the line does not call at, the ship names over the water and the callsign plates in the sky; tunnel sections at reduced opacity |
| Lines pulled straight | A switch turns the map into a diagram: every line becomes a row of its own, its stops sitting along it at the distance they really are, and the city fades out underneath. The camera climbs straight above the middle of the drawn network first and only then do the lines straighten – a plan is the reading closest to the diagram, and it puts every line on screen for the transition. It frames what is switched on, not the city: with two lines showing, the plan is of those two. Leaving runs backwards: the lines fold onto the map and only then does the camera fly, home by default or to whatever the press was aiming at – flying to a stop, following a vehicle or zooming to a line all bring the map back and then go there. It is a morph, not a cut – each line leaves the screen position the map has it at and is drawn straight from there, because the map and the diagram read the same number, the distance along the route. Only one of the two ever draws the network: the map lets go of its routes, stops, vehicles and names the frame the morph starts and takes them back the frame it ends, and since the two lie exactly on top of each other at rest, neither handover has anything to show. The vehicles travel over with it and keep running on the rows. One shared scale for every row, so a 50 km line stays five times the length of a 10 km one; the panel's line filter is the diagram's filter too. The three readings – surface, underground, line diagram – are a segmented control at the foot of the map, exactly one lit, each reachable from each. `#…&view=linear` and `#…&view=underground` open straight into a reading; the surface needs no word |
| Stops layer | One disc + name per stop position. The disc lies flat on the ground and foreshortens with the view rather than turning to face the camera – every disc in the city is one instanced draw command with its own shader and pick colours (`src/map/StopDiscs.ts`), since nothing Cesium ships draws a flat mark that moves and keeps its screen size. The name is bare light slate text with a thin dark halo, no plate, so the names settle into the photograph instead of competing with the vehicle badges – the serving lines in parentheses ("Kröpeliner Tor (1, 4, 5, 6)"), screen-space label decluttering (nearest wins – the ship names run through the same pass), stops disappear with their lines |
| Miniature look (tilt-shift) | A screen-space band of focus with the frame blurred above and below it – the blur disc grows with the distance from the band like a real circle of confusion, highlights spread into bright bokeh instead of averaging away, the band itself is crisped – plus a toy-plastic grade and a vignette: the shallow depth of field a tilted lens gives a model. Three post-process passes (the blur runs on a quarter-size frame), ramped down by the camera pose and off at street level or looking straight down. Off when the app opens (`config.camera.miniatureDefault`); the switch in the photo popover (the aperture button in the camera block) and `tiltshift=1` turn it on, and the popover's knobs set its blur radius, sharp band, feather, focus line, bokeh weighting and sharpening – it is a lens on the map rather than a command to it, which is why it sits with the camera |
| Photo mode | The aperture button in the camera block opens the camera the city is shot with: focal length (31–81 mm in 35 mm terms, a dolly zoom – see Field of view), exposure in EV stops, white balance in kelvin, contrast, saturation and a vignette – one post-process pass, skipped outright at the neutral settings – plus a rule-of-thirds framing grid and the miniature effect's switch and its own knobs. The grid is the one switch here that changes nothing about the picture: it is drawn by the interface over the map, so `H` takes it away a moment before the shutter and a screenshot never catches it. A reset button puts every knob back, and the button lights up while any of them stands off its default. Every knob off its default travels in the URL under a short key of its own (`fov`, `ev`, `wb`, `con`, `sat`, `vig`, `grid`, `blur`, `band`, `fthr`, `foc`, `bok`, `shp` beside `tiltshift`), the value in full, so a link opens on the picture it was copied from |
| Volumetric clouds | A slab of cloud at cumulus height over the whole city, ray-marched through two tiled noise fields – coverage cut at a threshold calibrated to the live cloud cover (60 % cover leaves 60 % of the sky under cloud), detail eroding it into puffs – and lit by a short second march towards the sun, graded with the time of day like the tiles. Not Cesium's CloudCollection: those are flat sprites that cast nothing. The shadow is the tile shader's: it follows the sun's ray from each street up to the layer and dims the street by what the column there lets through, so the same field that draws a cloud darkens the ground under it. The clouds drift with the wind Open-Meteo reports (about twice the surface wind, as at cloud level), on the simulated clock, and ask for frames only as the drift shows on screen. Off at 0 % cover and underground, where they cost nothing. Off when the app opens (`config.weather.clouds3dDefault`): the switch in the weather popover turns them on and `clouds=1` carries that in the URL, while the cover keeps grading the tiles either way. Rain falls from their base – no drop above it, and a camera above the clouds sees no rain at all; WebGL 2 only |
| Day/night lighting | Sun-elevation-based grading of the photo tiles plus a dynamic sky (stars at night), driven by the simulated clock – at night every vehicle casts a warm cabin-light pool onto the road |
| Street lighting at night | A warm light pool under every OSM street lamp along the routes – in Rostock ~7000 of them from the city's open-data import, in Kiel ~1800 community-mapped ones; fades in with the sun ramp and out as the camera climbs |
| Airfield lighting at night | The runway and taxiway lights of the city's airfield, one point per light OpenStreetMap maps (`aeroway=navigationaid`) – runway edge, centre line, threshold and touchdown zone, the approach system, the PAPIs, taxiway edge and centre line, stop bars and guard lights – in the colours ICAO gives them: white, green thresholds and red ends, blue taxiway edges, green taxiway centre lines; and under the apron's floodlight masts (`tower:type=lighting` inside the aerodrome) a wide cool-white pool of lit concrete, the street lamps' effect at six times the width. Frankfurt's ten thousand, Berlin's six thousand, Hamburg's four, Rostock-Laage's twenty-one, as far as each is mapped. Lit from dusk, and by day when the weather's visibility drops under a few kilometres, as the tower switches it on in fog and heavy rain; readable as the lit runway from the home view, out underground |
| Buoys on the water | The fairways' marks as OpenStreetMap has them (`seamark:type=buoy_*`): the red and green lateral buoys and the yellow special marks, each a generic 3D model of its shape – can, cone, spar, pillar, sphere or barrel, with IALA region A's topmark on the towers and poles – in its colour, set down on the tiles' own water like the ships (a clamp pick per buoy, rationed and made again as finer tiles come in) and lit at night where the mark has a lantern: one point in the light's colour, on from dusk or in poor visibility by day, full from the quay and fading with the camera's distance so a fairway seen from high up is a trace of lights rather than a string of them, steady for now – the light's character and period ride in the data for a flashing rule one day. The models come as the camera comes down to the water (per grid cell within 4 km, hidden again as it leaves), so a session over the city centre loads none; the lanterns are one draw call for the whole city and mark the channel from the home view at night. The banded marks – cardinal, isolated danger, safe water, preferred channel – and the beacons stay out for now. `?seamarks=0` leaves them off with the lighthouses (the specs over the water boot so) |
| Lighthouses and pier lights | The harbour's light towers, mole and pier heads, leading and sector lights as OpenStreetMap has them (`man_made=lighthouse`, `seamark:type=light_major`/`light_minor` – only where a lit sector is tagged; a bare `light_minor` stays dark rather than guessed). No model of their own: Google's tiles carry the towers, and each light is set on the top of its tower as the mesh has it – a clamp pick at the light's position, within 3 km of the camera – with OSM's elevation of the light over the water (`seamark:light:height`) as the floor where the mesh lost a thin mast. Most are sector lights: the colour shown depends on the bearing from the camera to the light, as on the chart, and outside every sector the light is obscured – from the land side of Bülk there is nothing to see. Lit from dusk or in poor visibility, steady, a tower's light bigger and carrying further than a pier head's, both fading with the camera's distance. Refreshed with the OSM data on Sunday nights (`data:lighthouses`); `?seamarks=0` leaves them off with the buoys |
| Stop departure board | Clicking a stop opens its card: serving lines, the next departures with live countdowns and GTFS-RT delays, nearby lines a short walk away – every line on the card a link that zooms to it and opens its card – and a departure whose vehicle is already on the map links straight to it |
| Interchange at a stop | The lines reachable from the stop the vehicle stands at (or heads for), collected across every platform within 100 m |
| The city in numbers | The info button in the panel's head opens the city card: lines per mode and how many of them run today (Munich's U8 is Saturday-only), stop positions, line kilometres and the share of them in tunnel (Frankfurt 23 %, Kiel none), the longest line as a link to it, the network's lowest and highest stop (Stuttgart climbs 300 m), trips a day with the short workings among them, and the service day – "round the clock" where the longest pause between departures is under an hour, which with hourly night buses is most cities. Everything on it is stated by the data (`src/lib/city-profile.ts`), like the line card's facts; only the last row is the simulation's – how many vehicles are out, how many carry live data and their median delay. The same live counts stand in the panel itself: beside the Traffic heading, in brackets after each mode's group header and after the AIS heading – the numbers that swell with the rush hour under the time-lapse |
| Follow & camera | Follow mode flies in behind the vehicle and chases it facing the direction of travel until you rotate (zooming keeps the chase); a live compass, 2D/3D, and camera-reset buttons sit at the lower right |
| Live delays | GTFS-Realtime TripUpdates overlaid on the schedule simulation, filtered per city (see [GTFS-Realtime](#gtfs-realtime-implemented-filtered-server-side)) |
| Weather | Open-Meteo precipitation, cloud cover, temperature, wind and visibility for one point per city in one request: falling rain plus an overcast grade on the photo tiles, so a grey day stays grey without rain, and the reading in °C on the weather button. The sky follows the simulated clock: the request brings the last days on the feed's quarter-hour grid (`src/lib/weather.ts`, refreshed every ten minutes), the map takes the step of the simulated moment, so a clock set back shows that quarter hour's sky and a day under the time-lapse clouds over and clears as the day did – no recording of our own, the feed keeps its past. A clock set ahead wears the present's sky: a forecast is not a fact. `?rain=0` opts out; the weather popover swaps the live sky for a sunny, overcast or rainy one, which holds whatever the clock says, while the temperature beside the icon stays the real one for the moment shown |
| Live harbour traffic | AIS positions from aisstream.io as a backdrop fleet, one subscription for every city's box and served per city (`/api/ais?city=…`); the city ferries' AIS twins are left out so no crossing carries two boats. Thirteen detailed procedural archetypes carry it – container ship, coaster, tanker, inland barge, hopper dredger, passenger ship, harbour launch, pilot boat, tug, fishing boat, yacht, motorboat, workboat – each stretched to the ship's reported size, with smooth rounded hulls, bevelled deckhouses, fine rails, bollards and deck equipment fitted inside the hull's plan. Tankers carry round pipelines, dredgers a round suction pipe, passenger ships individual window rows and lifeboats, and yachts their rigging and deck fittings; the box ship's load is individual containers in six muted liveries, with tier seams, corrugated outer sides and door bars, stepping down toward the bow. AIS has no code for a container ship and one bucket for every dry cargo ship there is, so where the code says nothing the size does: a 400 m box on the Elbe gets the boxship, an 85 × 9.5 m one the inland barge (see `archetypeFor` in `src/map/VesselLayer.ts`). Each ship floats on the tiles' own water: its hull is clamped to Google's mesh with an offscreen pick, so inland – where the Main falls 15 m through Frankfurt in four lock steps and Berlin's Havel lies two metres under its Spree – a barge sits on the water rather than thirty metres beneath it. The picks are made only for ships on screen and only when the ship moved or the tiles under it refined; a fleet at rest costs nothing. Each ship carries her name on a dark slate plate – where the stops wear bare haloed text, so the fleet and the network are told apart at a glance – decluttered against each other and against the stops' own rule: in a crowded harbour the nearest ship keeps her name and the rest step aside. Clicking a hull or her name opens her card and lights her up – her hull washed toward white and rimmed in it, exactly as a picked vehicle is – and puts her MMSI in the URL, so a reload picks her up again and chases her. The harbour has a memory: every fix heard is kept for five days (`src/lib/ais-archive.ts`, written by the same endpoint that serves the live fleet), and a clock set into the past – a time this morning, one of the four days the calendar offers behind today – replays the ships as they were then, interpolated between their recorded fixes exactly as the live fleet is; her card then says "Recorded from AIS" and measures the fix age on the simulated clock. A clock set ahead leaves the ships live, and where nothing was recorded – before the archive began, an hour the keeper did not hear – the water stays empty rather than showing today's ships on yesterday's date. A ship under way trails a thin exhaust plume from her funnel – the five hulls that have one, from a knot and a half over the ground, within 2.5 km of the camera – leaning into the weather's wind and trailing aft with her speed (`src/map/FunnelSmoke.ts`): not Cesium's particle system, which simulates from frame to frame and falls apart under this map's event-driven rendering, but one instanced draw command whose shader places every puff by the clock alone, so any frame is right whatever the last one was; lit like the clouds, held by the pause, and left out of the mobile profile. And she leaves a wake (`src/map/Wake.ts`) – the ferries the map runs from a timetable too: the propeller's wash as a streaky ribbon from her stern, widening and fading over forty seconds, the bow wave along her forward flanks, the two Kelvin arms at their 19.47°. Laid from where she has been rather than animated – her AIS track, or the timetable for a ferry – so a turning ship leaves a curved wake, a stopped one leaves hers to fade, and a ship going astern washes at the bow. At night, while she moves, she shows her navigation lights (`src/map/NavLights.ts`): red to port and green to starboard at the bridge, white at the masthead and the stern, each screened to its own arc as at sea – from her starboard quarter the green and the masthead light, from astern the stern light alone; at anchor the one anchor light, at her berth none, by day none at all. Whether she moves is read off her track, not off the status she broadcasts, which is set by hand and stale both ways – a ro-ro doing twelve knots as "moored", the tugs at their station as "under way". The ferries the map runs from a timetable wear the same lights, on at the pier between crossings as a ferry in service keeps them |
| Live air traffic | ADS-B positions from [adsb.fi](https://adsb.fi)'s open data as the sky over the city, served per city (`/api/aircraft?city=…`, `server/api/aircraft.php` in production): every aircraft over the city and a margin beyond its box (the circle that reaches the box's corners plus six nautical miles – the sky does not end at the city's edge) at every altitude – the airliner on final, the club aircraft circling the airfield, the police helicopter, and the traffic crossing at cruise ten kilometres up – polled every five seconds from a feed that hears each transponder every second, so the playback runs only a dozen seconds behind the wall clock and interpolates between recorded fixes like the ships', flown on by dead reckoning for a few seconds when a fix is late. Seven bodies carry it – a narrow-body and a wide-body twin-jet, the four-engined double-decker, a jet with its engines on the tail, a high-wing turboprop, a light single, a helicopter – with smooth 32-sided fuselages, profiled wings and fins, recessed jet intakes with fans and metallic lips, rounded jet radomes with a distinct windscreen rake and six mirrored cockpit panes, small cabin windows and door outlines, and detailed struts and wheels. Coated aluminium, satin wing panels and glossy glass distinguish their surfaces; rotors and propellers remain see-through discs, with an open shroud around the helicopter's tail rotor, picked by ICAO type designator from a table of the types met over German cities (`src/lib/aircraft-info.ts`) and stretched to the type's length, span and height; the emitter category stands in for a type the table does not know. The landing gear is a glTF node of its own and is out only within 600 m of the city's ground – on final and after take-off – and folded away above. Each flies in three dimensions: the nose on its true heading, crabbed into the wind off the track it moves along, the pitch from the climb rate and the speed, the bank from the reported roll or from the turn the track rate implies. Its height is the geometric altitude the transponder sends, a height above the WGS84 ellipsoid that Cesium places directly; where only the pressure altitude comes, the geoid height is added. An aircraft on the ground is clamped to Google's apron the way the ships are clamped to the water. Each carries its callsign on a blue plate – the fourth kind of name on the map, after the line badges, the stops' bare text and the ships' slate – decluttered by the same pass. And each wears its lights (`src/map/NavLights.ts`, the rules in `src/lib/nav-lights.ts`): the red and green position lights at the wing tips and the white tail light, steady; the red anti-collision beacons on top of and under the fuselage flashing about once a second; the white wing-tip strobes flashing brighter and less often in flight – every flash timed from the clock alone, so a pause holds it and any frame is right. Screened as the real ones are, each over its own arc: the camera chasing from behind sees the tail light and the strobes, one ahead red and green together. Taxiing an aircraft shows no strobes, parked nothing; by day the lights are dim, at night full. Clicking a body or its plate opens its card (type, registration, altitude with the flight level, ground speed, climb) and lights it up like every picked thing, puts its ICAO address in the URL and chases it on reload. A chase ends softly at the city's edge: where it would carry the camera out of the box, the camera stops at the edge and watches the aircraft fly on from there, turning after it until it leaves the served circle (`src/map/FollowCamera.ts`) – the same for a ship leaving the harbour. The sky has the harbour's memory: a keeper polls one circle over all the cities every ten seconds and keeps five days of fixes per city (`src/lib/aircraft-archive.ts`), and a clock set into the past replays the aircraft as they were then, interpolated between the recorded fixes exactly as the live traffic is; the card then says "Recorded from ADS-B". The live traffic is rendered on the simulated clock as far as the present, so a clock set back a little moves it back a little and the recording takes over at the edge without a jump. Where nothing was recorded the sky is empty, never today's aircraft on yesterday's date |
| Live webcams | Windy's webcams as pictures floating over the spot they look from: a world-sized billboard per camera, its longest side 150 m at the picture's own aspect ratio, its bottom edge 180 m above the ground, facing the viewer. Polled every ten minutes through a proxy that keeps the API key (`/api/webcams?city=…`); a click opens the camera's windy.com page and the credit line carries Windy's courtesy text. Stop names, vehicle badges, ship names and callsign plates that would sit on a picture step aside for it. The layers popover has a Webcams switch with the city's cameras listed under it – a click flies to the picture. `?webcams=0` leaves the layer out entirely |
| Map controls on a dial | The rail at the lower right is a dial: a round globe in the middle switches the ground under everything – Google's tiles or the flat street map – and shows the one a click brings: the city on the map from above, as Mapbox's light map while the tiles are up (the dark map coming over it with the night), as the satellite picture on the flat map, and a city switch crossfades to the next city's picture (`src/components/GlobeIllustration.tsx`; three stills per city from Mapbox's Static Images API in `public/globe/`, drawn once by `scripts/build-globe-images.mjs` and committed, so nothing is fetched at run time – a new city needs a run of it). The other buttons stand round on an arc around it: About at the lower left, layers, the photo mode, the compass and 2D/3D over the top, the camera reset and full screen on the right (`src/lib/rail-orbit.ts`). A phone gets the same buttons as a column at the upper right; the diagram keeps full screen and About |
| Flat map | A street map instead of the 3D city, switched with the globe on the dial and carried in the hash as `basemap=flat`: Google's tiles go, the bare globe comes up with Mapbox raster tiles on it – two styles, one drawn by day and one at night, the night one laid over the day's along the sun's ramp (`src/map/FlatBasemap.ts`, the styles in `src/config.ts`) – and, there being no terrain, everything the city carries is flattened to 0 m: the routes' profile, the stops, the lamps, the water the ships ride, the apron the aircraft stand on; the air traffic comes down by the city's ground height so an approach 300 m over the airport is 300 m over the map. The camera comes down with the ground and back up with it, so the picture stands; a follow needs neither. The switch is a swap, not a reload (`CesiumMap.setBasemap`): the layers keep their records and forget every height they measured on the tiles. Nothing is asked of Mapbox until the switch is thrown, and nothing without a token (`VITE_MAPBOX_TOKEN`) – the flat map is then the bare dark globe |
| shadcn(-style) interface | Tailwind v4 + Radix primitives, shadcn component styling (Card, Button, Badge, Switch, Slider, Popover, Tabs, a segmented control on ToggleGroup, Sonner for the notices) |
| About the map | The question mark at the foot of the dial (or `?`) opens a dialog that says what this is: where it comes from – [mini-tokyo-3d](https://minitokyo3d.com) put Tokyo's trains on a 3D map, [legible-cities](https://github.com/richc117/legible-cities) draws timetable animations out of open GTFS – and, above all, what it is not: not live vehicle tracking. The feeds carry the timetable and the delay, not the position, so every vehicle drives its scheduled trip with the GTFS-RT delay shifting it; only the AIS ships and the ADS-B aircraft are where they really are. The dialog opens with Mario’s project story and inspirations; map details and keyboard shortcuts have their own tabs |
| Keyboard | Bare keys, no modifiers: `Space` pauses and plays, `+`/`−` step the time-lapse, `N` returns to the real time, `S`/`U`/`L` pick the surface, the underground and the line diagram, `R` puts the camera on the city's home view, `C` turns it to the next quarter, `2`/`3` flatten and tip it, `M` is the miniature lens, `F` is full screen, `H` hides the interface, `Esc` closes whichever card is open, and `?` opens the About dialog, which lists them in its Keyboard tab. Space gives way to the control the keyboard stands on – there it is the click – and every key stays out of the time field |
| Interface out of the way | `H` hides the whole interface – panel, cards, map controls – and brings it back, for a clean look at the city; a dialog does it on its own while it is open. What the map itself draws (stop names, vehicle numbers, ship names, callsigns, routes) is untouched; the layers popover's switches are what turn those off, and Cesium's credit line stays either way; its "Data attribution" opens in the app's own dialog rather than in Cesium's lightbox. Not shared in the URL: a reload always brings the interface back. The rail at the lower right – layers, the camera's block, the About button – also steps aside on its own: ten seconds without a pointer movement and it fades out, the first movement (or press, wheel, key) brings it back at once; never on a phone, where a finger between touches is always at rest (`src/lib/pointer-idle.ts`) |
| Full screen | A button on the dial's right puts the page full screen and takes it back out; it follows Escape and F11 too, and is left out where the browser has no Fullscreen API (iOS Safari) |
| Automated tests | Unit tests (Vitest) and functional E2E tests (Playwright), fully offline and deterministic |

## Quick start

```bash
npm install        # also copies the Cesium assets to public/cesium (postinstall)
npm run dev        # → http://localhost:5173
```

**Cesium ion token:** No token lives in the source. A local checkout takes it
from `.env` (see `.env.example`); without one the map falls back to the
wireframe globe:

```bash
VITE_CESIUM_ION_TOKEN=your-token
```

> Ion tokens are client-side, publishable tokens – they inevitably end up in the
> browser bundle. That is exactly why the deployed site is built with a token
> restricted to `minigermany3d.com` in the
> [Cesium ion dashboard](https://ion.cesium.com/tokens), which makes it useless
> anywhere else; it sits in `.github/workflows/ci.yml` and every CI build uses it,
> so that two builds of the same source tree are byte-equal and interchangeable
> (see [Deployment](#deployment-all-inkl-webhosting)). For the
> Google 3D Tiles, access to *Google Photorealistic 3D Tiles* (asset 2275207) must
> be enabled in the ion account.

**Mapbox token (optional):** the flat map (the layers popover's "Flat map"
switch) draws Mapbox raster tiles and takes its public token the same way –
`VITE_MAPBOX_TOKEN` in `.env` locally, the token locked to
`minigermany3d.com` in `.github/workflows/ci.yml` for the deployed site.
Without one the flat map is the bare dark globe and nothing is requested
from Mapbox. The two styles it draws are named in `src/config.ts`; they have
to be classic styles (built from layers, like Mapbox's own `light-v11` and
`dark-v11`), because a style built on Mapbox Standard comes out of the
Static Tiles API as empty tiles.

### Usage

- **Cities:** The caret beside the panel title lists every city this build
  knows; picking one takes the current city off the map, flies the camera to
  the new city's home view and puts that city's lines up. The URL follows
  (`/kiel/`, or `/en/kiel/` when the interface speaks English), and the last
  city visited is remembered by the browser for the next session.
- **About the map:** `?`, or the question mark at the foot of the dial,
  opens the About dialog – where the map comes from, what it is not (no
  live vehicle tracking: the vehicles run the timetable, GTFS-Realtime
  only shifts them by their delay), what it is built from, and the
  keyboard shortcuts in a separate tab.
- **Keyboard:** the same dialog lists the keys; it reads
  `Space` pause and play, `+`/`−` time-lapse a step faster or slower, `N`
  back to the real time, `S`/`U`/`L` the three readings of the network
  (surface, underground, line diagram), `R` the camera back on the city,
  `C` a quarter turn of the view, `2`/`3` flat and tilted, `M` the
  miniature lens, `F` full screen, `H` the interface away and back, `Esc`
  closes whichever card is open and stops a chase. All of them bare,
  unmodified keys; each is the keyboard's way to a control that is on
  screen anyway. Space is the exception that steps aside: on a focused
  button, switch or tab it stays the click, so the interface can still be
  worked without a mouse.
- **Simulation time:** The panel's time field opens the native picker (e.g. jump to
  rush hour); "Now" restores the real time. The date button beside it opens a
  calendar from four days back to a week ahead – the day changes the sun, and a
  day in the past replays the recorded ships and aircraft under the weather of
  that day (see "Live harbour traffic", "Live air traffic" and "Weather"); the
  timetable is the same service day throughout. Time-lapse 1–120× and pause work at any
  time – play carries on from the simulated moment, a time set by hand survives
  a pause – and the collapsed panel keeps showing the clock and the pause button.
  A clock moved past the present – by the time field, the calendar or a
  time-lapse that runs on – leaves the ships and the aircraft in real time,
  and a notice at the top of the map says so the first time it happens, then
  not again within a quarter of an hour (`src/lib/future-notice.ts`).
  The scene lighting follows the simulated clock, so the time input doubles as a
  day/night switch – and the ×120 time-lapse shows a full day/night cycle.
- **Zoom to a line:** Clicking a line's name in the panel flies the camera so the
  whole route fits into view (the compass heading is kept); the route pulses for
  three seconds while everything that would cover it steps aside for the same
  span – the other lines fade out, their vehicle badges go, so do the discs and
  names of every stop the line does not call at and the names of the AIS ships.
  Hulls and vehicle bodies stay where they are. Clicking a hidden line switches
  it back on first.
- **The city in numbers:** The ⓘ beside the panel's fold button opens the city card
  – the network's size in lines, stops, kilometres and tunnel share, its longest
  line, its height span, its trips a day and its service day, plus how much of the
  fleet is out right now. Stops are counted as stop positions (one per platform
  node, so a junction counts several times) and kilometres as line kilometres (a
  shared corridor once per line), because that is what the data holds; the card
  says so in its words.
- **Selecting a vehicle:** Clicking a box opens the info card (line, destination,
  next stop) at the top right. Its interchange row lists the lines a passenger can
  change to – while the vehicle stands at a stop those are that stop's connections,
  and only once it pulls away do they become the next stop's. A junction is several
  stops in the data (one per platform, at Doberaner Platz eight of them up to 91 m
  apart), so the lines are collected by walking distance rather than by stop id.
  "Follow" flies the camera in behind the vehicle and
  chases it facing the direction of travel; rotating the camera hands control back
  to free orbit (zooming keeps the chase). Clicking empty map, "Stop following", or
  a camera reset ends the follow mode.
- **Pulling the lines straight:** The Line diagram reading at the foot of the map
  swaps the city for a diagram of it – every line straightened into a row, the stops along
  it where their distance puts them, the vehicles running on the rows. The camera
  climbs straight above the middle of whatever is switched on, keeping its compass
  heading, and the lines only begin to straighten once it is there – switch most
  of the network off and the plan is of the handful of lines that are left. Every
  reading is reachable from every other: picking the underground while the diagram is
  up brings the lines down onto the map first and takes the camera under the city
  afterwards. The way back is the
  same order backwards: the lines fold onto the map, and only once they are down
  does the camera move – to the city's home view, or, when the press was aiming
  at something (a stop to fly to, a vehicle to follow, a line to zoom to), to
  that instead. The lines
  travel there from where the map has them, so it stays readable which line went
  where. Only the lines switched on in the panel are drawn, clicking a dot or a
  stop opens the same cards as on the map, and the button turns the city back on.
  The diagram scrolls when the network is taller than the window.
- **The readings:** a segmented control centred at the foot of the map, exactly one of them lit –
  Surface, Underground, and Line diagram: the city as it stands, the same city
  from underneath, and the network with the city taken away. ("Line diagram" is
  what an operator calls the strip over the door, `Linienband` in German – one
  line drawn straight with its stops along it.) They stand apart from the
  controls at the right because they are the only ones that do not aim the
  camera – they replace what the camera looks at. The words appear from 1120px
  up, where the group still clears the panel; below that the icons carry it
  alone. Arrow keys move between them, Enter picks. A radio group by role, not
  tabs: a tab controls a panel, and these replace what the whole map shows
  (`src/components/ui/segmented-control.tsx`).
- **Map controls:** at the lower right edge of the map, three boxes of the same
  width, one under the other. The layers popover on top – routes, stops, the
  names, and the city's webcams listed under their switch – then the camera's
  own block: compass, 2D/3D pitch toggle, camera reset, the photo mode (the
  miniature look and the framing grid live in its popover), and full screen
  last. The camera's block and the layers belong to the map, so the diagram
  keeps only full screen; the layer switches themselves outlive the reading,
  and the map comes back as it was left. Under it all, on its own, the
  question mark that opens the About
  dialog. Each tooltip names its shortcut in parentheses where the button has
  one – compass `(C)`, 2D `(2)` / 3D `(3)`, camera reset `(R)`, full screen
  `(F)`.
- **Weather popover:** upper right, the opposite corner from the camera controls
  – it dresses the map rather than commanding it. A card opens in that corner
  at the button's height, and the button steps left beside it rather than
  hiding underneath, so the sky can be picked with a card up.
- **Compass:** its needle points where the camera looks, on a north-up dial, and
  turns with it. Pressing it brings the view onto the nearest quarter – north,
  east, south or west – and on to the next one when it already stands on one, so
  pressing on walks the map round the dial and past north. The button says which
  quarter it will turn to before you press it.
- **Weather popover:** the sky the city is shown under. Four skies – the live weather
  and a sunny, an overcast and a rainy one – of which exactly one is in force;
  a picked one is set rather than polled, so it works offline and survives a
  time-traveled clock, and the button wears its icon and lights up while it is
  not the sky the session opened on. Beside the icon it carries the temperature
  over the city as of the moment the map shows, which stays the real reading
  under a picked sky – that sky is a way to look at the city, not a claim about
  the weather. Where there is no live
  weather to reach (offline, `?rain=0`, no endpoint) the session opens on the
  clear sky, the live tile is greyed out and the button shows its icon alone.
- **Field of view:** 25° horizontal while the miniature look is on, Cesium's
  60° default while it is off (`config.camera.fovDeg` / `fovOffDeg`), or any
  angle between the two from the focal-length knob of the photo popover – eased
  whenever it changes, and the camera walks along the view axis as it goes, so
  the same ground stays in frame and only the perspective flattens or steepens.
  A dolly zoom, in other words: the switch shows the lens change the effect is
  built on instead of jumping somewhere else, and the knob turns it into a
  slow one. The miniature switch brings its lens along; a focal length set by
  hand is given up in the process. The miniature look lives on the long-lens end: a
  narrower angle keeps the foreground from looming and towers from leaning out of
  the frame, and it makes the tilt-shift band a better stand-in for a plane of
  focus – at 60° the blurred edges span 1.5× the depth of the sharp band, at 25°
  well under half of that. Every distance measured at 60° follows the angle: the home view, the
  chase cam and the stop flight read it off the camera and keep their framing
  through either lens. The ranges that decide what is still worth drawing (stop
  discs and labels, vehicle bodies, badges and ships) stay pinned to the narrow
  one – they live in DistanceDisplayConditions on thousands of billboards, too
  many to rebuild on a toggle, so through the plain lens they simply reach a
  little further than that angle needs. The line flight needs none of it – Cesium
  derives that distance from the frustum itself.
- **Map bounds:** The camera stays inside the city's bounding box – the city
  limits (an OSM boundary relation) widened by 20 km on every side, the one
  rectangle the data pipeline, the AIS subscription, the PHP proxy and the
  camera share (`boundingBox` in the city's `city.json`, typed by
  `src/lib/city.ts`) – and does not zoom out beyond 30 km altitude: there is
  nothing outside that this map could show, and every place the camera visits
  pulls its own 3D tiles. A shared link pointing further away opens at the
  border (see `config.cameraLimits`). Only the flight from one city to the
  next lifts the leash, and the next city's takes over on arrival.
- **Night lighting:** From dusk the streets along the routes light up – one
  light pool per OSM street lamp, the same effect the vehicles' cabin glow
  uses – in cities whose definition enables it, and so does the airfield:
  the runway and taxiway lights OSM maps, one point each in its own colour,
  which also burn by day once the weather's visibility drops under a few
  kilometres. Nothing is built until it would actually show, so a daytime
  session pays nothing for either; the underground view puts them out, and
  `?lamps=0` leaves both out entirely.
- **Selecting a stop:** Clicking a stop disc or name opens its departure
  board: the lines calling there, the next departures within the hour (soonest
  first, GTFS-RT delays applied, after-midnight service handled), and the lines
  boarding a short walk away. A departure whose vehicle is already on the map is
  a link – clicking it jumps to that vehicle's card. Underground platforms are
  marked, and "Fly to stop" brings the camera in.
- **Sharing links:** The URL hash always mirrors the current view, written
  event-driven when the camera settles (no polling). Without a selection it carries
  the camera pose; while something is selected it is just that selection –
  `#vehicle=<trip-id>`, `#vessel=<mmsi>` or `#stop=<id>`. Opening such a link
  re-selects it: a vehicle and a ship are picked up and followed, a stop opens
  its board. The ship is the one whose link can go stale – her MMSI is as stable
  as any id, but whether she is still in the harbour an hour later is not; the
  restore waits a minute and a half for her and then gives up quietly. The
  Routes/Stops layer toggles, the miniature look and the pause state ride along
  as `routes=0`, `stops=0`, `tiltshift=1`, `paused=1` whenever they deviate from
  the defaults (layers on, miniature look off, clock running), and so do the
  traffic categories switched off as a whole in the panel – a mode's every
  line, the AIS ships, the aircraft, as `hide=tram,bus,ais,aircraft`; a single
  line switched off is not in the URL – the photo mode knob by knob
  (`con=1.2&bok=4`, see the feature table), and the
  clock as it was set in the panel – the day picked in the calendar and the
  time typed into the field, as `date=2026-09-14&time=08:30` – as entered,
  never as the clock runs: the link opens on the moment that was set and the
  address bar does not tick with the simulation. The city is the
  path's (`/kiel/`), where a crawler and a link preview can see it.

### Useful URL parameters

| Parameter | Effect |
|-----------|--------|
| `?offline=1` | No ion/Google access, wireframe globe (basis of the tests) |
| `?speed=60` | Initial time-lapse factor (1–600) |
| `?time=08:30` | Set the simulation time at start (Europe/Berlin) – a boot flag, kept in the search string; what is typed into the panel goes into the hash instead (`time=` below) and wins over it |
| `?paused=1` | Start with the simulation frozen |
| `?rt=1` / `?rt=0` | Force GTFS-Realtime on/off (default: on, except in offline mode) |
| `?lang=de` / `?lang=en` | Force the UI language (default: English, or German when the browser prefers it; a path under `/en/` counts as English) |
| `?lamps=0` | Disable the night-time street and airfield lighting |
| `?seamarks=0` | Leave the seamarks – buoys and lighthouses – off (the specs over the water boot so, to keep their frames comparable) |
| `?webcams=0` | Leave the live webcam pictures out |
| `?drops=40` | Cap the rain drop pool (debug/E2E – visible rain pins the render loop at animation rate) |
| `?tier=mobile` / `?tier=desktop` | Force the device tier the map draws with (`src/lib/render-profile.ts`): a phone gets a 2048 shadow cascade instead of 8192, coarser tiles and a smaller tile budget, vehicle bodies out to 2 km instead of 3.5, and neither exhaust nor wakes on the ships. Read from the touch screen, its size and the device memory otherwise; the override measures one profile on the other's hardware |
| `?rain=0` | Disable the live-weather overlays (real Open-Meteo precipitation and cloud cover, following the simulated clock over the calendar's days) |
| `?ais=0` | Open with the live AIS ships switched off – the "AIS ships" switch at the end of the traffic list turns them back on |
| `?aircraft=0` | Open with the live air traffic switched off – the "Aircraft" switch after the ships turns it back on |
| `?welcome=0` / `?welcome=1` | Skip the welcome screen for this visit (the tests boot this way), or open it even though the browser was asked not to show it again – which is also how the choice is taken back, by unticking the box |
| `/kiel/` | The city to open on – its own address (`/` is the front door; an unknown slug falls back to the default city) |
| `/en/kiel/` | The same in English: the path carries the language the interface speaks, and the app keeps it there – a shared link opens the way it was seen (`?lang=` still wins for one visit) |
| `#lat=…&lon=…&height=…` | Saved camera pose (maintained automatically) |
| `#vehicle=…` | Shared vehicle selection – opens with the vehicle selected and followed |
| `#vessel=…` | Shared ship selection by MMSI – opens with the ship selected and followed, if she is still reported |
| `#aircraft=…` | Shared aircraft selection by ICAO address – opens with the aircraft selected and followed, if it is still over the city |
| `#stop=…` | Shared stop selection – opens the stop's departure board and flies to it |
| `#path=lat,lon,height,heading,pitch;…&dur=20&ease=linear` | The camera path (see the feature table): two or more keyframes and the seconds from the first to the last; it eases in and out unless `ease=linear` asks for a constant pace – maintained by the camera path bar |
| `?play=1` | Fly the camera path the hash carries once the city is up (once, for the city the link opened on) |
| `#…&view=linear` / `#…&view=underground` | Which reading of the network to open on – the lines pulled straight, or the city from underneath. The surface is the map itself and needs no word |
| `#…&date=2026-09-14&time=08:30` | The clock as set in the panel: the day picked in the calendar and the time typed into the field, either on its own. Written as entered – the hash keeps the entry, not the running clock, so it does not tick with the simulation – and a link opens the clock on that moment with the panel showing it; "Now" takes both out again |
| `#…&hide=tram,bus,ais,aircraft` | The traffic categories switched off as a whole in the panel – a mode (`tram`, `subway`, `train`, `bus`, `ferry`: every line of it, by the group switch or one line at a time), the AIS ships (`ais`), the aircraft (`aircraft`) – in this order, absent while everything is on. A single line switched off is not in the URL. The categories outlive a city switch the way the layer switches do, so a city arriving finds them off too; `?ais=0` and `?aircraft=0` remain the boot flags and show up here once the session writes |
| `#…&fov=40&ev=0.5&wb=5600&con=1.2&sat=0.8&vig=0.3&grid=1&blur=0.034&band=0.2&fthr=0.5&foc=0.45&bok=4&shp=0.6` | The photo mode, knob by knob, only where a knob stands off its default: focal length as the field of view in degrees, exposure in EV, white balance in kelvin, contrast, saturation and vignette, the framing grid, and the miniature effect's blur, sharp band, feather, focus line, bokeh and sharpening (fractions and factors as the sliders hold them). Short keys, the values in full; a value past its slider is held at the end. `tiltshift=1` alone opens on the long lens, `fov=` names one set by hand. `src/lib/photo-settings.ts` is the one place that spells them |
| `…&routes=0&stops=0&labels=0&webcams=0&clouds=1&tiltshift=1&paused=1` | Layer toggles, the 3D clouds, the miniature look and the pause state (only present when they deviate from the defaults: layers off, clouds on, miniature look on, paused) |
| `#…&basemap=flat` | The flat map instead of Google's tiles (see the feature table); the tiles are what an absent `basemap=` means, and are never written out |

## Tests

```bash
npm test               # Unit tests (Vitest): geodesy, timetable engine, clock, city definitions, network validation, UI
npm run test:e2e       # Functional E2E tests (Playwright, fully offline & deterministic)
```

The unit tests run in Node; a test that renders a component or touches
`window`/`document` declares `// @vitest-environment jsdom` in its first line
(jsdom costs about half a second per file, so it is not the default). On the
CI runner Vitest is pinned to two workers – see the `test` block in
[vite.config.ts](vite.config.ts) for why.

The E2E tests start the real app in offline mode with a frozen simulation time
(08:30) and render Cesium headless via SwiftShader. Everything runs automatically
in CI (GitHub Actions), see `.github/workflows/ci.yml`.

## Cities

A city is a folder under `src/cities/` with a hand-written definition and
the files the pipeline generates for it:

```
src/cities/kiel/
├── city.json          # the definition (below)
├── limits.json        # the city limits polygon – written by add-city, read by the pipeline only
├── network.json       # lines, routes, stops – generated (data:update, data:simplify, data:heights)
├── schedule.json      # real departure times – generated (data:gtfs)
├── street-lamps.json  # OSM lamps along the routes – generated (data:lamps), optional
├── airfield-lights.json # OSM runway and taxiway lights in the box – generated (data:airfield-lights), optional
├── buoys.json           # OSM buoys in the box – generated (data:buoys), optional
├── lighthouses.json     # OSM lighthouses and pier lights in the box – generated (data:lighthouses), optional
└── terrain/           # terrain tiles of the city's own, over Mapterhorn's – optional (build-terrain-patch)
```

`city.json` says everything the rest of the project needs to know about the
place (typed and validated by `src/lib/city.ts`):

- **`cityBounds`, `paddingMeters`, `boundingBox`** – the city limits from OSM
  (`osmRelation`) and the padded rectangle everything works with (`add-city`
  pads 20 km unless `--padding` says otherwise). The limits
  are those of the relation's *largest outer ring*, not the relation's own
  bounding box: an administrative boundary can include an exclave far away
  (an island 100 km out at sea), and `out bb` would stretch the box across
  the water.
- **`home`** – the ground point the home view looks at, from `height` m up with
  `heading` and `pitch`. **`weather`** – where the live weather is queried.
- **`network`** – which modes the pipeline fetches (`modes`), how each mode's
  route relations are narrowed in OSM (`overpass`: operator, ref, service,
  network as regexes; a mode without an entry is served by fixed lines alone;
  `osmRoutes` names the OSM `route=*` values a mode takes where the default
  map is wrong for the city – Stuttgart's Stadtbahn is tagged `light_rail`
  and is that city's U-Bahn),
  lines addressed by relation id (`fixedLines` – ferries mostly), and where a
  route leaving the city is cut (`clip`: `city` at the last stop inside the
  limits, `box` inside the padded box, `none`). "Inside the limits" is the
  polygon in `limits.json` where the city has one (a rectangle around a city
  reaches the neighbouring towns, and a route is meant to end where the
  city does), and `cityBounds` otherwise; the GTFS import anchors departures at the same
  test, so a trip leaves the map where its route really ends.
- **`gtfs`** – the prefix the feed puts in front of stop names (`nameStrip`),
  for feeds that lump an S-Bahn's legs into one route the branch stations
  that tell them apart (`trainBranches`), and the GTFS `route_type` values a
  mode is looked up under where the feed disagrees with the city
  (`routeTypes`: Hanover's Stadtbahn is a tram on the map and an underground
  to the feed).
- **`fleet`** – per mode the vehicle dimensions and the glTF consist the map
  draws (`model`, see `VEHICLE_CONSISTS` in `src/map/VehicleLayer.ts`; without
  one the mode is a colored box).
- **`terrain`** – the heights come from [Mapterhorn](https://mapterhorn.com)
  (see [Data](#data--gtfs--gtfs-realtime--osm)); per city the tile `zoom`
  the pipeline samples at (15 ≈ 1.4 m per pixel), the geoid offset the
  height bootstrap starts from, the water level ferries ride at (`null`
  where the terrain model carries the lakes' levels itself, as Berlin's
  does), and the attribution line the state's license asks for. A
  `terrain/{z}/{x}/{y}.webp` in the city folder is read before Mapterhorn
  is asked for that tile – the way around a hole in Mapterhorn's import
  (Hamburg, see [Data](#data--gtfs--gtfs-realtime--osm)).
- **`ais`** – whether the AIS backdrop is on, and which real vessels this map
  already runs from a timetable (`simulatedByMmsi`), so their AIS twins are
  left out of the backdrop fleet.
- **`webcams`** – Windy webcam ids left off the map (`exclude`): a camera
  that shows something other than the city, or one whose picture never
  changes.

Adding a city:

```bash
node scripts/add-city.mjs kiel 27021        # bounds from OSM → src/cities/kiel/city.json
# edit city.json: home view, modes/operators, fleet, terrain, ferries' AIS twins
npm run data:update -- --city kiel
npm run data:simplify -- --city kiel
npm run data:heights -- --city kiel
npm run data:lamps -- --city kiel
npm run data:airfield-lights -- --city kiel
npm run data:buoys -- --city kiel
npm run data:lighthouses -- --city kiel
npm run data:gtfs -- --city kiel
node scripts/build-og-images.mjs             # the link-preview picture → public/og/kiel.png (committed)
```

…then list it in `src/cities/definitions.ts`. Without `--city` every script
runs for every city. The unit tests validate every city's definition (the box
is recomputed from the limits and the padding) and every network.

**Rostock** (the default city): the six RSAG tram lines, some 25 RSAG bus
lines, the three S-Bahn lines on the Warnemünde–Rostock Hbf corridor (S2/S3
are cut at the city limits – they really continue to Güstrow, far outside the
map) and the two Warnow ferries, with terrain heights from the state's open
DGM1 (via Mapterhorn) and ~7000 street lamps.

**Kiel**: some 40 KVG bus lines (day, night and express) and the two SFK
ferry lines on the Förde – the F1 from the station to Laboe and the F2 up
the Schwentine to Wellingdorf – with terrain heights from the state's open
DGM1 (via Mapterhorn) and the OSM street lamps along the routes – some
1800, community-mapped rather than an official import, so the lighting is
far sparser than Rostock's (two lamps per kilometer of line against
sixteen). Two things Kiel taught the pipeline: its OSM relations mostly list
platforms instead of stop positions, so a platform without a stop
position within 50 m now stands in for the stop; and its ferry relations
run on past the piers the map shows (the F1 relation continues to the
summer piers and back), so a fixed line's `from`/`to` also cut the
relation to that stretch. Routes are clipped to the padded box rather than
the city limits (`clip: "box"`) – Laboe, Strande and Heikendorf are part of
the Förde even though they lie outside the city.

**Hamburg**: the four U-Bahn lines, the five S-Bahn lines (cut at the
city limits – they really run on to Wedel, Stade and Aumühle), the 26
Metrobus lines of Hochbahn and VHH and the eight HADAG harbour ferries,
with terrain heights from the city's open DGM1 (via Mapterhorn) and
~5200 OSM street lamps along the routes. Mapterhorn's Hamburg import
lacks 20 of the DGM1's 2 km squares – the centre, Ottensen, Hammerbrook,
Rothenburgsort, Wilhelmsburg – so the city folder carries its own tiles
for them (`terrain/`, built once by `scripts/build-terrain-patch.mjs` from
the same DGM1, see [Data](#data--gtfs--gtfs-realtime--osm)). The HADAG
boats are in the AIS backdrop too, so the city lists their MMSIs as twins
of the scheduled ferries – by operator, not by line: a harbour ferry runs
whatever line the roster gives her that day.

**Cologne** (Köln): the twelve KVB Stadtbahn lines (drawn as trams – they run
as coupled pairs of 28 m cars, in tunnels under the centre and over the
Rhine bridges), the four S-Bahn lines that stop in the city (S6, S11,
S12, S19 – cut at the city limits), the KVB bus network (some 60
lines; the 181 is left out until its OSM relation is whole again – it
came back as a four-stop stub that placed 18 of its 216 trips) and no
ferries, with terrain heights from the state's open DGM1 via Mapterhorn
(Geobasis NRW) and ~7000 OSM street lamps along the routes. The Rhine is
busy, so the AIS backdrop is on; nothing the map runs from a timetable
sails, so it lists no twins. Some 370 vehicles at 08:30.

**Munich** (München): the eight U-Bahn lines (the U8 stays idle on weekdays – it
runs on Saturdays only, and so does the map's), the nine S-Bahn lines
(S1–S8 and the S20, cut at the city limits – they really run to the
airport, Freising, Erding or Herrsching), the twelve day and four night
tram lines, and of the buses the MetroBus (50–68) and ExpressBus (X30,
X35, X36) lines alone – the 80 StadtBus lines would double the fleet –
with terrain heights from Bavaria's open DGM1 via Mapterhorn and ~2300
community-mapped OSM street lamps along the routes. The U-Bahn runs as a
115 m six-car train (C2), the S-Bahn as a pair of ET 423 units, the trams
as 37 m Avenio-sized cars; all three are composed from the sections the
other cities' fleets already had. No navigable water, so no AIS. Some
370 vehicles at 08:30, Rostock's size.

**Bremen**: the whole BSAG network – the eight tram lines and their
three night trams, some 40 bus lines including the night buses – and
the Regio-S-Bahn (RS1–RS4, NordWestBahn; selected by their `RS` refs
and cut at the city limits, which the RS3 and RS4 leave one stop after
the station), with terrain heights from the state's open DGM1 via
Mapterhorn (Landesamt GeoInformation Bremen) and ~1900 community-mapped
OSM street lamps along the routes. The Weser ferries are not on the map:
OSM has no relations for the Vegesack, Blumenthal and Farge crossings
and the feed has no timetable for them – the AIS backdrop shows the real
boats instead. Some 220 vehicles at 08:30.

**Lübeck**: the 28 city bus lines of Stadtwerke Lübeck Mobil, from the
old town on its island out to Travemünde on the Baltic – eighteen
kilometers down the Trave and still inside the city limits, which is what
makes the longest bus runs on this map. No trams (the last one went in
1959) and no S-Bahn; the Priwall ferry runs every fifteen minutes in
reality but no feed carries a timetable for it, so it is left off rather
than drawn standing still. AIS is on instead: Travemünde is a ferry port,
and the Baltic traffic is what there is to see. Terrain heights from the
state's open DGM1 via Mapterhorn and ~4200 OSM street lamps along the
routes. Some 90 vehicles at 08:30.

**Wilhelmshaven**: the fourteen bus lines of the Stadtwerke – the
smallest network here, on the flattest ground: the whole city lies
between 0 and 7 m NHN. Its point is the water. The Jade carries
Germany's only deep-water container port, so the AIS backdrop is what
this city is really about, and the map shows the real ships beside a bus
every twenty minutes. Terrain heights from Lower Saxony's open DGM1 via
Mapterhorn; the OSM lamps are sparse here (127 along the routes), so the
night is dark outside the centre. Some 17 vehicles at 08:30.

**Schwerin**: the four NVS tram lines and fifteen bus lines between the
lakes – the smallest fleet on the map, and right for a city of 100 000.
Terrain heights from Mecklenburg's open DGM1 via Mapterhorn (the model
carries the lake surfaces: the Schweriner See at 37.5 m) and ~930 OSM
street lamps. The Pfaffenteich ferry is a real NVS line with a line
number of its own, but no feed carries its timetable, so it is left off.
Some 38 vehicles at 08:30.

**Hanover**: the fifteen ÜSTRA Stadtbahn lines, the S-Bahn (cut at the
city limits, which most lines leave within a stop or two) and the 24
ÜSTRA bus lines, with terrain heights from Lower Saxony's open DGM1 via
Mapterhorn and ~1600 OSM street lamps. Hanover taught the pipeline one
thing: its Stadtbahn is a tram to OSM and to this map, and an underground
(`route_type` 1) to the GTFS feed – so a city can now name the route
types its modes are looked up under (`gtfs.routeTypes`). Without that its
fifteen lines would have stood still. Some 185 vehicles at 08:30, half of
them Stadtbahn.

**Frankfurt**: the nine U-Bahn lines, the ten trams, the S-Bahn on its
trunk line under the centre and the MetroBus lines – the 60 ordinary city
bus lines are left out for load, as Berlin's and Munich's are, and the
Express buses because they are regional lines that only touch the city
(the X95 has 450 m of route inside it). The trams are taken by network
and line number rather than by operator, because line 11 carries no
operator tag at all.
Terrain heights from Hesse's open DGM1 via Mapterhorn and ~1700 OSM
street lamps. Some 220 vehicles at 08:30. Frankfurt taught the importer
one thing: a line number is only unique inside its own network. The RMV
tags the Rhein-Neckar S5 (Wiesbaden–Bensheim) with the same `ref` as
Frankfurt's own, and both reach into the box – so relations that never
run inside the city are now dropped before the two directions are picked
by length, instead of the 100 km stranger winning and the line ending up
skipped for having no stop in the city.

**Stuttgart**: the sixteen Stadtbahn lines, the S-Bahn and the 48 SSB
bus lines including the night buses, with terrain heights from
Baden-Württemberg's open DGM1 via Mapterhorn and ~1850 OSM street lamps.
Two things make it the odd one out. Its Stadtbahn is tagged `light_rail`
in OSM, which every other city's definition reads as an S-Bahn – so
Stuttgart names the OSM route values of both modes itself
(`network.overpass.<mode>.osmRoutes`), the U-lines as its subway and the
S-lines as its S-Bahn. And its terrain is the steepest here: the
Talkessel lies at 210 m, Degerloch on the ridge at 470, so the routes
climb 300 m inside the city. Some 260 vehicles at 08:30, 100 of them
Stadtbahn.

**Berlin**: the nine U-Bahn lines, the S-Bahn (all lines, cut at the city
limits), all 22 BVG tram lines, the Metrobus lines plus the 100, 200 and
300, and the six BVG ferries, with terrain heights from the Senate's open
DGM1 (via Mapterhorn) and the ~18 000 OSM street lamps along the routes
(the city's lighting is an official import there too). The Ringbahn taught
the importers two things: a ring relation's ways can be chained either
way round, so the stops decide the path's orientation; and its trips are
rounds that end where they began, classified by a stop a quarter of the
way in rather than by their ends. Berlin's water sits at two levels (Havel
29 m, Spree 32 m), so its ferries read their height off the terrain model
(`waterLevelNhn: null`) instead of one figure per city. The other 150 BVG
bus lines are left out on purpose – the map runs some 700 vehicles here at
rush hour already, twice Rostock's, and every one of them is simulated
stop by stop.

## Data – GTFS / GTFS-Realtime / OSM

### What the app uses per city

- **Routes & stops:** `network.json` contains the **real OSM track geometries**
  of every line, including direction-specific paths and the line colors from
  OSM. Each line carries its mode of transport (`mode`: `tram`/`subway`/`train`/
  `bus`/`ferry`) and the glTF consist it is drawn with (`model`); ferries carry
  their real vessel dimensions. The line panel groups by mode of transport
  (with per-group toggles) as soon as more than one is present.
  For Rostock, an approximated demo dataset can be restored at any time
  with `node scripts/build-approx-network.mjs` – the app then shows a
  "Demo data (approximated)" warning badge (real OSM geometry needs no callout).
- **Tunnels & underground sections:** `data:update` derives per-direction
  tunnel ranges from the OSM tags of each route's member ways (`tunnel=*`,
  `location=underground`, or a negative `layer` – e.g. the tram tunnel under
  Rostock Hauptbahnhof, or a tunnel under a station) and stores them as meter ranges
  (`tunnels`) in `network.json`. The map renders those route sections at
  **20 % opacity**, and while a vehicle travels through one, its 3D box and
  label fade to 20 % as well; the info card of a selected vehicle then shows
  "in tunnel".
- **Timetable:** `schedule.json` contains real GTFS departure times per
  line/direction (typical weekday). Lines/directions without GTFS data stay off
  the map – if the feed does not serve a line that day (e.g. suspended due to
  construction work), the app does not run it either. Only when a city has no
  `schedule.json` at all (development without data) does a synthetic headway
  from `src/lib/timetable.ts` kick in for the whole network.
  Travel time between stops is derived from the real track distance; like
  mini-tokyo-3d, the vehicles run **schedule-based**, not on real-time
  positions.

### Importing real data (recommended, requires unrestricted internet access)

```bash
npm run data:update    # Real track geometries + stops from OpenStreetMap (Overpass API)
npm run data:simplify  # Simplify the path geometry (visually lossless)
npm run data:heights   # Terrain heights per route vertex from Mapterhorn's terrain tiles
npm run data:lamps     # OSM street lamps along the routes → street-lamps.json
npm run data:airfield-lights  # OSM airfield lighting in the box → airfield-lights.json
npm run data:buoys     # OSM buoys in the box → buoys.json
npm run data:lighthouses  # OSM lighthouses and pier lights in the box → lighthouses.json
npm run data:gtfs      # Real departure times from a GTFS feed → schedule.json
npm test               # validates the new datasets
```

Every script takes `-- --city <slug>` and runs for every city without it.

- `data:update` overwrites `network.json` with the real OSM relations the
  city's definition asks for
  (© OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)),
  including tunnel and bridge sections as meter ranges along each path.
  Stop-position nodes without a `name` tag are resolved via their OSM
  `stop_area` relation, then via the nearest named stop within 60 m; only
  after that does the "Stop" placeholder remain. The Overpass queries (here,
  in `data:lamps` and in `data:airfield-lights`) are limited to the city's
  bounding box.
- `data:heights` samples the terrain at every route vertex and stop from
  [Mapterhorn](https://mapterhorn.com): Terrarium-encoded terrain tiles built
  from open terrain models – in Germany the 1 m DGM1 of every state
  (Mecklenburg-Vorpommern: GeoBasis-DE/M-V, CC BY 4.0; Schleswig-Holstein:
  GeoBasis-DE/LVermGeo SH, CC BY 4.0; Bremen: Landesamt GeoInformation
  Bremen, CC BY 4.0; Niedersachsen: LGLN, CC BY 4.0; Nordrhein-Westfalen:
  Geobasis NRW, dl-de/zero-2.0; Hessen: HMUKLV, dl-de/zero-2.0;
  Baden-Württemberg: LGL, dl-de/by-2-0; Bayern: Bayerische
  Vermessungsverwaltung, CC BY 4.0). The
  tiles are fetched one by one at the city's `terrain.zoom` (15 ≈ 1.4 m per
  pixel; a city's routes touch a few hundred tiles, some 20–35 MB per
  city), nothing is downloaded up front or kept on disk, and no key or fee
  is involved. Not every Mapterhorn import is complete – its Hamburg
  import lacks 19 of the DGM1's 2 km squares (the city centre, Ottensen,
  Hammerbrook, Rothenburgsort, Wilhelmsburg), where its tiles come from
  a 30 m surface model, 3–20 m above the ground
  ([mapterhorn/mapterhorn#131](https://github.com/mapterhorn/mapterhorn/issues/131))
  – so a new city is worth a look at a few known heights before it goes
  live. For such a hole a city folder can carry tiles of its own,
  `terrain/{z}/{x}/{y}.webp` in Mapterhorn's format, which the sampler
  reads before it asks the server; `scripts/build-terrain-patch.mjs`
  builds them once from the state's DGM (Hamburg: the LGV's DGM1 zip,
  compared square by square with Mapterhorn, every tile touching a
  missing square rebuilt) and they are committed like any other city
  data. Bridge sections get a
  straight deck interpolated between their end points – right for a river
  bridge whose ends stand on the banks, wrong for a viaduct whose ends
  meet the ground: the terrain model is bare earth and knows no
  structure, so Berlin's six-kilometre Stadtbahn came out at street
  level. Inside a bridge range the app therefore measures the deck on the
  Google tiles at run time (`src/map/bridge-decks.ts`): a CPU ray per
  route vertex – and per station every 30 m where a straight bridge way
  has no vertex – against the loaded tiles, only for points on screen, a
  few per pass, nearest to the camera first, read again after every load
  cycle and kept for the rest of the visit; vehicles and route polylines
  take the measured deck, the polylines through the stations too, and
  blend into the profile at the portals. A ray answers with whatever is
  on top – or, where the mesh lost a thin bridge, with the water
  underneath – so a sample counts fully only where it stands clear above
  the profile (a little above it, a low bridge's deck sets its own point
  and nothing else), and a station hall's roof among those, samples no
  deck could climb to from their neighbours at the mode's gradient, is
  pruned and interpolated across, while the hump of a real bridge
  stays. With
  these heights the app draws the route polylines at
  absolute heights instead of clamping them onto the 3D tiles per frame –
  that classification pass costs measurable GPU time on every rendered
  frame. The NHN→ellipsoid offset is calibrated at runtime against sampled
  Google-tile heights.
- `data:lamps` collects the `highway=street_lamp` nodes standing within 25 m
  of a route (© OpenStreetMap contributors, ODbL – in Rostock these come from
  the city's own open-data import, `source=OpenData.HRO`) and gives each one a
  terrain height, the same way the routes get theirs. Lamps beside a bridge
  or tunnel section are skipped: there the route's height profile is the deck
  or the surface above the tube, not the ground the lamp stands on.
- `data:buoys` collects the `seamark:type=buoy_*` nodes in the box that
  the map has a buoy for – the red, green and yellow ones (a single colour;
  the banded cardinal, isolated-danger, safe-water and preferred-channel
  marks stay out for now, as do the beacons) – with their shape
  (`seamark:<type>:shape`; a shape without a model is drawn as the pillar
  buoy when lit, the spar buoy otherwise) and their light where they have
  one (`seamark:light:colour`, `:character`, `:period`). No heights: the map
  clamps every buoy to the tiles' water at runtime, so the file carries
  nothing the terrain could date.
- `data:lighthouses` collects the `man_made=lighthouse` and
  `seamark:type=light_major`/`light_minor` nodes and ways of the box that
  name a lit sector (`seamark:light:colour` or the numbered
  `seamark:light:N:*` sets, with their bearings from seaward, elevation
  and range; a directional light with an `orientation` becomes a narrow
  sector, a sector exhibited only in fog is left out), one light per spot
  – a tower mapped as a node and a building way is one light. No heights
  either: the map sets each light on the top of its tower as the tiles
  have it.
- `data:airfield-lights` collects the `aeroway=navigationaid` nodes in the
  box that the map has a light for – the `navigationaid=*` kinds `rwe`,
  `rwc`, `rwt`, `tdz`, `als`, `papi`, `vasi`, `txe`, `txc`, `sbl`, `cbl`
  and `rgl` (radio aids are left out) – with the colour ICAO gives the kind
  unless the node's `light:colour` says otherwise, plus the apron's
  floodlight masts (`man_made=mast`/`tower` with `tower:type=lighting`,
  inside the `aeroway=aerodrome` polygons only – a stadium's masts burn on
  match nights, an airport's every night) as the kind `flood`, and gives
  each one a terrain height the same way. Every city gets the file; a box without an
  airfield gets an empty list. Closed airfields are not a concern of the
  script: OSM's mappers take the lights down with the airport (Tegel and
  Tempelhof have none).
- `data:gtfs` downloads the free Germany-wide public transport feed from
  [gtfs.de](https://gtfs.de) (DELFI-based) by default – once per run, however
  many cities follow. With `GTFS_URL`/`GTFS_FILE` a transport association's
  own feed can be used instead. The script looks up timetables for all lines
  in `network.json` (tram `route_type` 0, subway 1, S-Bahn 2/106/109, bus 3,
  ferry 4; ferries are matched via the pier names in `route_long_name` or the
  pier coordinates). Departure times and direction detection use each trip's
  first/last stop **within the city limits** (`cityBounds`, without the
  padding – with the 20 km the first stop of a Rostock S2/S3 would be Schwaan
  or Laage), so trips cut at the limits depart the network at their real
  local times. City relevance is established via the stop coordinates; a
  per-line agency overview in the log reveals route-number collisions. Lines
  without a GTFS match stay off the map (they are considered not running that
  day). **Important:** re-run `data:gtfs` after every `data:update` so new
  lines get timetables.
- The unit tests adapt to the data source: the strict RSAG checks only run
  against the Rostock demo dataset, while structural checks (monotonicity, city
  bounds, lengths) run against every city's dataset.

**Data pipeline troubleshooting**

| Problem | Solution |
|---------|----------|
| Overpass responds with 403/406/429/504 | The script sends a User-Agent, tries several mirrors (overpass-api.de → kumi.systems) and, when every mirror failed, waits a minute and walks them once more – a 429 or a 504 is usually load, not the query. Set your own endpoint via `OVERPASS_URL=… npm run data:update` or feed in a saved response via `OVERPASS_FILE=response.json`. |
| GTFS download takes long | The feed (~280 MB) is cached at `scripts/.cache/gtfs.zip`; delete the file for a fresh download. Reuse an existing zip via `GTFS_FILE=path.zip`. |
| CI/sandbox without unrestricted internet access | Overpass/gtfs.de are unreachable there – the committed datasets stay active. |

### GTFS-Realtime (implemented, filtered server-side)

The app connects to the **free GTFS-Realtime feed from gtfs.de**
(`https://realtime.gtfs.de/realtime-free.pb`, DELFI-based):

- The feed provides **TripUpdates (delays)** – not vehicle positions. The app
  overlays them on the schedule simulation: a vehicle running +3 min is drawn where it
  would have been on schedule 3 minutes ago. A vehicle's info card shows its delay.
- **Server-side filtering, per city:** The Germany-wide feed is >10 MB. The
  browser therefore does NOT download it itself but polls
  **`/api/realtime?city=<slug>`** (a few KB of JSON, every 2 minutes). Behind
  it sits a Vite middleware in the dev/preview server (Node, `vite.config.ts`)
  and, in production, **`api/realtime.php`** (shared-hosting friendly, with
  its own minimal protobuf parser and no dependencies). Both fetch the feed at
  most once per minute – one fetch for every city – filter it down to the
  city's `trip_ids` from its `schedule.json`, and cache the result per city.
  A parity test (`node scripts/test-php-parser.mjs`, also run in CI) ensures
  the PHP and Node implementations extract identical data.
- **Matching:** The feed's GTFS `trip_id`s match the static gtfs.de feed.
  `npm run data:gtfs` stores them in `schedule.json` (`tripIds` alongside
  `departures`) – without them nothing is matched.
- **Configuration:** `VITE_GTFS_RT_URL` overrides the endpoint URL, an empty string
  disables realtime; the URL parameters `?rt=1`/`?rt=0` take precedence (default:
  on, except in offline mode).
- **Limits of the free variant:** reduced coverage, only trip_ids matching the
  gtfs.de static feed, attribution required.

### AIS (live harbour traffic)

`/api/ais?city=<slug>` serves the vessels inside the city's box. The dev
middleware holds one aisstream.io WebSocket subscribed to **every** city's box
(aisstream allows three connections per account, so one per city would not
scale); `api/ais.php` does the same in short listen windows on shared hosting
and keeps one state file for all cities. `scripts/test-ais-parity.mjs` checks
that both subscribe with exactly the boxes the city definitions carry.

Both also **record** what they hear: one NDJSON file per city and UTC hour
(`<slug>/2026-09-11T09.ndjson`), a line per fix `[mmsi, ms, lat, lon, sog,
cog, heading, navStatus]` plus a line of static data whenever a ship's name,
type, dimensions or draught change, and a snapshot of every ship alive at the
top of each file so an hour can be read on its own. Five days are kept
(`AIS_ARCHIVE_KEEP_HOURS`); older files go when a new hour opens.
`/api/ais?city=<slug>&hour=2026-09-11T09` serves an hour back – `&from=<byte>`
the tail of the one still being written, which the app polls every 20 s –
with a closed hour marked cacheable and 404 where nothing was recorded. The
writer is `src/lib/ais-archive.ts` (the dev middleware puts the files under
the OS temp directory), the PHP twin lives in `api/ais.php` and writes above
the docroot, and `scripts/test-ais-archive-parity.mjs` holds the two to the
same output. Measured 2026-09-11 across the nine harbours: ~455 fixes a
minute, ~36 MB a day raw, ~8 MB gzipped; the keeper's extra work per fix is
an append. The app replays the recording whenever the simulated clock is
more than a minute behind the real one (`aisReplayWanted`), asking for the
hour of the moment and the hour ahead, and renders it the way it renders the
live fleet – four minutes behind the clock it is on, so the two sources hand
over without a jump at the edge.

The ships take their height from the tiles: `scene.clampToHeight` under
each hull, with everything but the tiles hidden for the pick so a hull
does not pick itself, a buoy or a route line (`VesselLayer`,
`CesiumMap.clampToSurface`). Sea level would do at the coast, but inland
the water is a staircase of lock reaches at levels only Google's mesh
knows. Each pick is an offscreen render, so it is made only for ships on
screen, only while the camera rests (a followed ship excepted), and only
when its answer could have changed – the ship moved 25 m, or the tiles
under it changed (a tile that loaded, at most every two seconds) and the
ship is near enough for that to matter – with a cap of three picks a
tick; until a ship is first seen it rides the calibrated sea-level surface.

### ADS-B (live air traffic)

`/api/aircraft?city=<slug>` serves the aircraft inside the city's circle:
the one that reaches the box's corners plus `AIRCRAFT_MARGIN_NM` (six
nautical miles), so the sky reaches past the city's edge and an aircraft
followed to it can be watched flying on. Both the dev middleware and
`api/aircraft.php` ask adsb.fi's open data API
(`https://opendata.adsb.fi/api/v3/lat/…/lon/…/dist/…`) for exactly that
circle (`adsbQuery`), fold every answer into a per-city state with a short
track per aircraft (`src/lib/aircraft-extract.ts`, the PHP twin in
`aircraft.php`), and answer the aircraft inside it (`withinQuery`). No key: the endpoints are open, for
personal use, at one request a second for every city together, which both
sides keep – the answers are cached per city for four seconds and the
upstream calls spaced a second apart (the PHP through the lock file's
modification time). `scripts/test-aircraft-parity.mjs` holds the two
extractions to the same captured answer and the circles to the city
definitions.

What the feed reports (readsb's `aircraft.json` shape, the one ADS-B
Exchange, airplanes.live and adsb.lol speak too) becomes one record per
ICAO address: callsign, registration, type designator and description,
emitter category, position, geometric and pressure altitude in metres,
ground speed, track, true heading, vertical rate, roll, squawk, and whether
the position is the transponder's own or multilaterated. Surface vehicles
(category C) are left out. The app polls every five seconds
(`config.aircraft.pollIntervalMs`) and renders `AIRCRAFT_PLAYBACK_DELAY_MS`
(12 s) behind the clock – the simulated one as far as the present –
interpolating between fixes and reckoning on from the last one for at most
`AIRCRAFT_RECKON_MAX_MS` (20 s) before the aircraft freezes; an aircraft
unheard for a minute leaves the list.

The sky is **recorded** like the harbour (see the AIS section above): one
NDJSON file per city and UTC hour, a line per fix `[hex, ms, lat, lon,
altGeomM, altBaroM, gsKn, trackDeg, headingDeg, verticalRateMps, rollDeg,
onGround]` plus a line of static data whenever the callsign, registration,
type, category, squawk or position source change, a snapshot of every
aircraft alive at the top of each file, five days kept, the same
`&hour=…`/`&from=…` reading. What differs is the source: adsb.fi answers
polls, one a second for every city together, so the recorder is a
**keeper** that polls ONE circle covering every city (`adsbCoverQuery`,
220 nm around the middle of Germany, checked against adsb.fi's 250 nm
cap by `tests/aircraft-archive.test.ts`) every `AIRCRAFT_KEEPER_INTERVAL_MS`
(10 s – the recording's resolution) and writes what moved into every city
whose circle holds it. In dev the middleware runs the keeper from the
first aircraft request on; in production it is a cron calling
`/api/aircraft?record=50` every minute, which polls for that long under a
lock of its own (`aircraft-archive/<slug>/` above the docroot, beside the
AIS archive). The per-city live polls do not record. The writer is
`src/lib/aircraft-archive.ts`, the PHP twin lives in `aircraft.php`, and
`scripts/test-aircraft-archive-parity.mjs` holds the two to the same
files and the cover circle to the city definitions. The app replays the
recording whenever the simulated clock is more than a minute behind the
real one – the same edge as the ships' – and hands the layer the aircraft
as of the simulated moment with the fixes around the instant it samples,
one past the moment, because the recording is coarser than the playback
delay.

## Deployment (all-inkl webhosting)

`.github/workflows/ci.yml` tests and builds the app and then uploads it via
rsync/SSH to the all-inkl webhosting (Apache + PHP) at
`https://minigermany3d.com`:

1. **One-time setup:** Create four secrets in the repository settings
   (Settings → Secrets and variables → Actions): **`KAS_SSH_PASSWORD`** (the SSH
   password), **`KAS_SSH_HOST`** (the SSH host), **`KAS_SSH_USER`** (the SSH
   user), and **`KAS_TARGET_DIR`** (the document root on the webspace, with a
   trailing slash, as rsync sees it over SSH: relative to the SSH login
   directory – `websites/mini-germany-3d/website/` – or absolute from the
   server's root – `/www/htdocs/<account>/websites/mini-germany-3d/website/`.
   Not with the leading slash KAS writes paths with: over SSH that is the
   server's root, and the deploy fails with `mkdir "/websites/…" failed`.
   rsync creates only the last folder of the path, so the ones above it
   must exist). The Ion token is not among them – it is domain-restricted and
   sits in the workflow in the clear. The webspace is laid out as one folder
   per site with the document root one level down, and everything the site
   reads or writes outside the deploy sits beside that root, never in it:

   ```
   websites/mini-germany-3d/            ← KAS_TARGET_DIR's parent
   ├── aisstream.io-api-key.txt         # read by api/ais.php
   ├── windy-api-key.txt                # fallback for api/webcams.php (the deploy
   │                                    #   writes api/webcams-key.txt from WINDY_KEY)
   ├── ais-archive/<slug>/*.ndjson      # written by api/ais.php, five days kept
   ├── aircraft-archive/<slug>/*.ndjson # written by api/aircraft.php?record=…, five days kept
   └── website/                         ← KAS_TARGET_DIR, the domain points here
       ├── index.html, assets/, …       # the build
       └── api/                         # the PHP scripts and their city.json copies
   ```

   The PHP scripts find the folder above the root relative to themselves
   (`api/../../`), so the layout is the only thing they assume: moving the
   site means moving that folder as a whole and pointing `KAS_TARGET_DIR` and
   the domain at the new `website/`.
2. After a push to `main` – in particular after a PR merge – the deploy job waits
   for the CI job to succeed completely: typecheck, unit tests, PHP parity test,
   build, and E2E tests. Only then are `dist/` (an `index.html` per city and
   language plus the sitemap, see "A page per city" above), `api/realtime.php`,
   `api/ais.php`, `api/aircraft.php`, `api/webcams.php` (with its key written from the
   `WINDY_KEY` repository secret, kept from the web by `.htaccess`) and
   every city's `api/cities/<slug>/city.json` and
   `schedule.json` rsynced to the document root from the `KAS_TARGET_DIR`
   secret. PR checks, feature-branch pushes, and failed tests do not deploy. A
   manual run of the CI workflow on `main` also goes through all tests first,
   which makes it suitable as a recovery deploy. The rsync deletes what it
   does not carry, which is why nothing the site writes at runtime lives
   under the document root: the API keys sit in the folder above it, and so
   do the AIS archive `api/ais.php` records (`ais-archive/<slug>/`) and the
   aircraft archive `api/aircraft.php` records (`aircraft-archive/<slug>/`),
   both created on first use; the temp directory stands in when that cannot
   be written. Two crons keep the recordings going, each every minute:
   `/api/ais?listen=45` and `/api/aircraft?record=50`.
3. **Trying a branch out on the real hosting:** Actions → CI → `Run workflow`,
   pick the branch, tick **`deploy_preview`**. It passes the same full test suite
   and then goes to the same place – there is only one document root, so the
   branch *replaces the live site for every visitor* until production is put
   back. The run summary of a preview deploy says as much, and the deploy
   concurrency group keeps a preview and a production deploy from interleaving.
   Without the tick, a manual run on a branch only builds and tests, as before.
   To put production back, tick **`restore_production`** instead: that skips the
   test job entirely and rsyncs the artifact of the last successful `main`
   deploy, so the site is back in a minute or two rather than the ~18 the full
   suite takes (15 of them E2E). Nothing untested goes up – it is byte for byte
   the build that passed on the commit it was made from. Deploying `main` the
   normal way (step 2) remains the option that rebuilds and re-tests.
4. **Builds are reused across runs.** Every successful run keeps its build as an
   artifact named after the *source tree* it was made from (`git write-tree`, so
   two runs of identical sources share a name). A preview deploy first looks for
   an artifact of its own tree: if the branch push already built and tested this
   exact code, the preview skips build, tests and E2E and just ships it, which is
   what keeps previewing a pushed branch from costing a second full run. When
   there is none, it builds and tests normally. `main`'s artifacts are kept 30
   days as the rollback target for `restore_production`, everything else 3.
5. The deployed `.htaccess` maps `/api/realtime` to the PHP script, sets cache
   headers (hashed assets one year, `index.html` no-cache, Cesium static files
   one day) and deflates what compresses – the text types, the archives'
   NDJSON and the models' GLB, which it also types as `model/gltf-binary`
   (Apache does not know the extension by itself): the fleet's 7.9 MB travel
   as 1.7 MB.
6. **Nightly data refresh:** A scheduled run (02:30 UTC) additionally executes
   `npm run data:gtfs` for every city before the test steps, so the schedule
   – one service day, the busiest of the next three weeks – follows the
   feed and the calendar (a holiday timetable ending, a construction
   timetable starting). The feed itself changes about weekly and is kept in
   the Actions cache under its `Last-Modified`, so a night with the same
   feed downloads nothing; and the schedules carry no date, so a night that
   changed no departure is byte-identical and skips tests, build and
   deploy – the service day each city was cut from goes into the data
   commit's message instead. The rarely changing OSM geometry (`data:update` + `data:simplify` +
   `data:heights` + `data:lamps` + `data:airfield-lights` + `data:buoys` + `data:lighthouses`, city by city) is
   only refreshed once a week (Sunday night). Route directions whose geometry
   is unchanged reuse the committed terrain heights (`PREV_NETWORK`), and
   lamps and airfield lights that did not move reuse theirs (`PREV_LAMPS`,
   `PREV_AIRFIELD_LIGHTS`), so tiles are only fetched for actual changes
   – unless the terrain attribution in `city.json` changed, which samples the
   whole city afresh once.
   The same refresh can be started by hand from the Actions tab (`Run
   workflow` → `refresh_data` for the schedules, `refresh_osm` for the weekly
   OSM/height/lamp part). One city's failed fetch (overloaded mirrors, no
   trips in the feed) keeps that city's previous data with a workflow warning
   and does not block the others. Only if the full test suite passes on the
   refreshed datasets is the result deployed and the new `src/cities/*/*.json`
   committed back to `main`; a failing test leaves both the site and the
   repository untouched.

> Note: After a data update (`npm run data:gtfs`), commit the new
> `schedule.json` files – they are rolled out as `api/cities/<slug>/schedule.json`
> during deploy so that browser matching and the server filter use the same trip_ids.

## Architecture

```
src/
├── config.ts               # Token, camera, simulation parameters – the same for every city
├── cities/
│   ├── definitions.ts      # The cities this build knows (hand-maintained list of city.json imports)
│   ├── index.ts            # Lazy loading of a city's generated data (one chunk per city)
│   ├── rostock/            # city.json + network.json + schedule.json + street-lamps.json
│   ├── kiel/               # city.json + network.json + schedule.json + street-lamps.json
│   └── berlin/             # city.json + network.json + schedule.json + street-lamps.json + airfield-lights.json + buoys.json + lighthouses.json
├── data/
│   ├── network.ts          # Preparation of a network (distances, direction mirroring, fleet)
│   ├── network-types.ts    # network.json types
│   ├── street-lamps.ts     # street-lamps.json types
│   ├── airfield-lights.ts  # airfield-lights.json types
│   ├── buoys.ts            # buoys.json types
│   └── lighthouses.ts      # lighthouses.json types
├── lib/
│   ├── city.ts             # The City type, city.json validation, bounding-box helpers
│   ├── city-api.ts         # ?city= on the per-city endpoints
│   ├── transit-mode.ts     # tram | subway | train | bus | ferry
│   ├── linear-layout.ts    # The diagram's geometry: a line → a row, stops by distance
│   ├── geo.ts              # Haversine, bearing, polyline interpolation/projection
│   ├── clock.ts            # Simulation clock (time-lapse, pause, Europe/Berlin)
│   ├── future-notice.ts    # When to say that a clock set ahead leaves the ships and aircraft live
│   ├── timetable.ts        # Headway timetable synthesis + trip states (dwell/moving)
│   ├── tunnels.ts          # Tunnel meter-ranges → path pieces / mirroring
│   ├── camera-hash.ts      # Camera pose, selection, switches and the clock as set ↔ URL hash
│   ├── rail-orbit.ts       # The control rail's dial: where the globe and each button stand
│   ├── basemap.ts          # The ground the map draws from: Google's tiles or the flat map,
│   │                       # and how the flat map's two styles share the night
│   ├── site-path.ts        # Where a page stands: /<slug>/ per city, /en/ for English,
│   │                       # /impressum/ and /datenschutz/ for the legal pages
│   ├── site-pages.ts       # What a page shows without the map: the city as plain HTML,
│   │                       # the legal pages, the head's tags, the sitemap (rendered by
│   │                       # the prerender plugin)
│   ├── legal.ts            # The legal notice and the privacy notice, both languages,
│   │                       # the provider's details – read by the dialog and the pages
│   ├── static-page.ts      # The static page's id; hidden as the app starts, shown when it fails
│   ├── welcome.ts          # Whether the welcome screen opens, and the wish not to see it again
│   ├── pointer-idle.ts     # The pointer at rest for a while – what fades the rail out
│   ├── realtime.ts         # GTFS-RT client (polls /api/realtime?city=…)
│   ├── rt-extract.ts       # Shared realtime feed → delay-map extraction
│   ├── ais.ts              # AIS client (polls /api/ais?city=…)
│   ├── ais-extract.ts      # Shared aisstream message → vessel state extraction, the playback sampler
│   ├── archive-hours.ts    # What both recordings share: hour files, the replay edge, the chunk reader, the client
│   ├── archive-fs.ts       # …on disk, for the dev middleware and the parity scripts (Node only)
│   ├── ais-archive.ts      # The AIS recording: its lines, the writer, the replay
│   ├── aircraft.ts         # ADS-B client (polls /api/aircraft?city=…)
│   ├── aircraft-extract.ts # Shared adsb.fi answer → aircraft state extraction, the playback sampler
│   ├── aircraft-archive.ts # The ADS-B recording: the keeper's cover circle, its lines, the writer, the replay
│   ├── aircraft-info.ts    # Which body an ICAO type gets and how big it is; the card's words
│   ├── nav-lights.ts       # Which navigation lights are on when, from the clock alone
│   └── seamark-lights.ts   # Which colour a sector light shows towards a viewer
├── engine/simulation.ts    # Clock + timetable → vehicle snapshots per frame
├── map/CesiumMap.ts        # Viewer, Google 3D Tiles, the city's leash and home view,
│                           # the flight between cities, follow/chase cam, day/night
│                           # lighting + cabin glow, event-driven render requests,
│                           # the switch to the flat map (setBasemap)
├── map/FlatBasemap.ts      # The flat map's pictures: Mapbox raster tiles on the bare globe,
│                           # a day and a night style crossfaded along the sun's ramp
├── map/LinearView.ts       # The lines pulled straight, in SVG over the map, and the
│                           # morph between the two readings
├── map/*Layer.ts           # Routes, stops, street lamps, airfield lights, buoys, lighthouses,
│                           # vehicles, AIS vessels, ADS-B aircraft – each with clear() for the next city
├── map/FunnelSmoke.ts      # Exhaust over the funnels of the ships under way: one instanced
│                           # draw command, the puffs placed by the clock alone (stateless)
├── map/Wake.ts             # The ships' wakes – wash, bow wave, Kelvin arms – as ribbons laid
│                           # from where each ship has been (her track, or the timetable)
├── map/NavLights.ts        # The aircraft's and the ships' navigation lights: pooled points
├── map/StopDiscs.ts        # The stop discs flat on the ground: one instanced draw
│                           # command with its own shader and pick colours
├── map/bridge-decks.ts     # Bridge decks read off the tiles per route vertex, for
│                           # the routes and the vehicles on them
├── map/buffer-readback-cache.ts  # Keeps what a height ray reads back from the GPU, so the
│                           # next ray through the same tile reads nothing (a sync stall each)
├── map/surface-generation.ts  # When the layers read their heights off the tiles again:
│                           # a tile loaded, two seconds apart, never at rest
├── components/GlobeIllustration.tsx  # The globe on the rail: the city from above, in the look
│                           # of the ground a click brings (the stills in public/globe/),
│                           # crossfading to the next city
├── components/             # shadcn-style UI (WelcomeScreen, ControlPanel with the city
│                           # picker, the layers/photo/weather popovers of the map's
│                           # control rail, the camera path bar over the readings, cards,
│                           # the About, Credits and Legal dialogs, ui/*, the
│                           # ErrorBoundary for a viewer that cannot start)
└── App.tsx                 # Viewer effect (once) + city session effect (per city),
                            # render loop pacing, test API (window.__mg3d)

scripts/
├── add-city.mjs              # new city: bounds from OSM → city.json skeleton
├── lib/city.mjs              # --city handling for every script
├── lib/model-detail.mjs      # smooth surfaces, pipes and bevelled fittings for ships and aircraft
├── build-approx-network.mjs  # generates the Rostock demo dataset
├── fetch-osm-network.mjs     # real geometry from OSM/Overpass   (npm run data:update)
├── simplify-network.mjs      # thins out route geometries        (npm run data:simplify)
├── fetch-gtfs-schedule.mjs   # real departure times from GTFS    (npm run data:gtfs)
├── fetch-route-heights.mjs   # terrain heights from Mapterhorn   (npm run data:heights)
├── build-terrain-patch.mjs   # a city's own terrain tiles where Mapterhorn has holes (one-off, by hand)
├── fetch-street-lamps.mjs    # OSM street lamps + terrain heights (npm run data:lamps)
├── fetch-airfield-lights.mjs # OSM airfield lighting + terrain heights (npm run data:airfield-lights)
├── fetch-buoys.mjs           # OSM buoys of the box (npm run data:buoys)
├── fetch-lighthouses.mjs     # OSM lighthouses and pier lights of the box (npm run data:lighthouses)
├── build-vehicle-models.mjs  # procedural vehicle, detailed vessel, aircraft and buoy GLBs (npm run models:build)
├── build-og-images.mjs       # link-preview pictures → public/og (by hand, committed)
├── build-globe-images.mjs    # the rail globe's three stills per city → public/globe (by hand, committed)
├── test-php-parser.mjs       # parity test Node vs. api/realtime.php (runs in CI)
├── test-ais-parity.mjs       # parity test Node vs. api/ais.php, incl. the city boxes
├── test-ais-state.mjs        # api/ais.php completes a state file from before a field existed
├── test-ais-archive-parity.mjs # parity test Node vs. api/ais.php for the AIS archive files
├── test-aircraft-parity.mjs  # parity test Node vs. api/aircraft.php, incl. the city circles
├── test-aircraft-archive-parity.mjs # parity test Node vs. api/aircraft.php for the aircraft archive files and the cover circle
└── copy-cesium-assets.mjs    # Cesium static files → public/cesium (postinstall)
```

**How the simulation works:** Departure times come from the city's schedule.json
(real GTFS departures, including short workings that only serve part of a route –
trips carry a span and start/end mid-route); lines without GTFS data do not run.
Only a missing schedule.json activates the synthetic headway for the whole
network, whose return direction departs offset by half the headway so shuttle
services like the Warnow ferries run as the single vessel they are. The travel time
between two stops follows from the real track distance with mode-specific cruise
speeds (tram ~30, subway ~36, S-Bahn ~40, bus ~25 km/h, ferries ~6 kn) plus 25 s
dwell time. Every frame, the distance along the route is
interpolated for each active trip and translated into a position + travel direction
(heading of the 3D model). Vehicles and stops do not use Cesium's `HeightReference`
clamping (unreliable on 3D tiles); their height is set explicitly. Vehicles ride the
route's terrain profile (see [Data](#data--gtfs--gtfs-realtime--osm)) and, on a
bridge, the deck measured on the tiles; the ferries float on the tiles' own water,
clamped like the AIS fleet (see [AIS](#ais-live-harbour-traffic)); stops – and
vehicles of a dataset without heights – take tile heights measured by ray casts. Since those heights depend on
the tile LOD currently loaded, they are re-measured as the camera approaches –
otherwise a stop measured from the overview would keep floating several meters
above the roofs up close.

**How the two readings of the network work:** The map and the diagram draw the
same data on different axes. Everything either of them needs comes from one
number, the distance along the route: route vertices carry it, stops carry it,
and the simulation computes it for every vehicle on every tick. So the diagram
is not a second dataset – `lib/linear-layout.ts` turns a line into a row and a
distance into an x, and `map/LinearView.ts` draws it. That shared parameter is
also what makes the switch a morph: every row is sampled at the same equal steps
in both readings, the map is asked once where those points are on screen
(`CesiumMap.projectToScreen`), and the transition is a lerp between the two.
It runs in SVG rather than in Cesium because a polyline whose positions change is
rebuilt asynchronously, and a network is tens of thousands of vertices – screen
space costs one projection when the button is pressed and nothing after. The
diagram's lines are drawn at full strength throughout; only the ground behind
them changes hands, the city fading out and the diagram's own background in.
That is what lets the map take its network off for the length of the morph
instead of cross-fading two copies of it, which reads as a smear. That
projection is also why the camera climbs to the plan view first
(`CesiumMap.flyToCityPlan`, framing `RoutesLayer.linesExtent` over the switched-on
lines) and why nothing may move it while a morph runs: a line the camera does not
have on screen has no position to leave from, and one whose ground moves under it
lands beside its route. While the diagram covers the map entirely, the map is
neither rendered nor synced – except for the first seconds after a city is raised
behind an already open diagram, which it needs to compile its route polylines.

**How a city switch works:** The viewer, the Google tileset and the render loop
live for the whole session; a city is a *session* on top of them (see the two
effects in `App.tsx`). Switching ends the session – pollers stopped, simulation
dropped, every layer cleared – and starts the next: the camera flies to the new
home view with the leash lifted (the new leash takes over on arrival, and the
tiles of the old city are trimmed from the cache), the new city's data chunk
loads, its layers go up and its pollers start. A city is never loaded next to
another: stop billboards, lamp sprites and trips cost per tick whether or not
they are in view.

## Roadmap

- GTFS-RT with VehiclePositions (full gtfs.de or transport association feeds)
  instead of TripUpdates only
- The remaining bus lines of big cities, which needs an active-trip index in the
  simulation instead of a full scan per tick
- Cities on demand: a workflow run that adds a city from its OSM relation

## Attribution

- Map rendering: [CesiumJS](https://cesium.com) (Apache-2.0), tiles © Google –
  use of the Photorealistic 3D Tiles is subject to the Google Maps Platform terms;
  the attribution is displayed automatically by Cesium.
- Network data (after `npm run data:update`): © OpenStreetMap contributors, ODbL 1.0
- Street lamps (after `npm run data:lamps`), airfield lighting (after `npm run data:airfield-lights`), buoys and lighthouses (after `npm run data:buoys` / `data:lighthouses`): © OpenStreetMap contributors, ODbL 1.0
- Flat map: © [Mapbox](https://www.mapbox.com/about/maps/) © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors – Mapbox's Static Tiles API, its attribution and "Improve this map" link in the corner of the map while the flat map is up, as Mapbox's terms ask
- The globe on the control rail: three stills per city from [Mapbox](https://www.mapbox.com/about/maps/)'s Static Images API – the light and the dark map © Mapbox © OpenStreetMap, the satellite picture © Mapbox © Maxar – credited in the credits dialog, where an 84 px disc cannot carry the line
- Webcam pictures: [Windy.com](https://www.windy.com/webcams) Webcams API – shown as delivered, each linked to its windy.com page, with the courtesy line in the credit display, as Windy's terms ask
- Air traffic: [adsb.fi](https://adsb.fi) open data – for personal, non-commercial use, cited with a link in the credits dialog while aircraft are on the map, as its terms ask (its terms name no place for the citation, so it stays off the map's edge; Windy's courtesy line is the one that has to stand in the corner)
- Terrain heights (after `npm run data:heights` / `data:lamps` / `data:airfield-lights`):
  © [Mapterhorn](https://mapterhorn.com/attribution), built from
  © GeoBasis-DE/M-V (DGM1, CC BY 4.0) for Rostock, from
  © GeoBasis-DE/LVermGeo SH (DGM1, CC BY 4.0) for Kiel, from © Freie und
  Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (DGM1,
  dl-de/by-2-0) for Hamburg (`src/cities/hamburg/terrain/`, the same
  model Mapterhorn's Hamburg tiles are built from), from © Landesamt
  GeoInformation Bremen (ATKIS DGM1, CC BY 4.0) for Bremen, from Geoportal
  Berlin / ATKIS DGM (Senatsverwaltung für Stadtentwicklung, Bauen und
  Wohnen, dl-de/zero-2.0) for Berlin, from Geobasis NRW – DGM1 (Land
  Nordrhein-Westfalen, dl-de/zero-2.0) for Cologne, from © Bayerische
  Vermessungsverwaltung (DGM1, CC BY 4.0) for Munich, from © GeoBasis-DE/
  LVermGeo SH (DGM1, CC BY 4.0) for Lübeck, from © Landesamt für
  Geoinformation und Landesvermessung Niedersachsen (DGM1, CC BY 4.0) for
  Hanover and Wilhelmshaven, from © GeoBasis-DE/M-V (DGM1, CC BY 4.0) for
  Schwerin, from © Hessisches Ministerium für Umwelt, Klimaschutz,
  Landwirtschaft und Verbraucherschutz (ATKIS-DGM1, dl-de/zero-2.0) for
  Frankfurt and from © LGL, www.lgl-bw.de (DGM1, dl-de/by-2-0) for
  Stuttgart – shown in the app inside Cesium's "Data attribution" credits
- Timetable data (after `npm run data:gtfs`): gtfs.de / DELFI or the transport
  association's feed – observe the source's license terms
