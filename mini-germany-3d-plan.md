# Mini Germany 3D – Plan zur Generalisierung

Stand: 2026-09-03. Ausgangspunkt ist `main` (352b5c2), eine Ein-Stadt-App für
Rostock.

> **Umsetzungsstand 2026-09-04:** Phasen 0–6 sind auf dem Branch
> `mini-germany-3d-plan` umgesetzt – Stadt als `city.json`, Viewer- und
> City-Session-Effekt, Stadtwechsel mit Flug, `?city=` auf beiden
> Endpunkten, Pipeline mit `--city` und `add-city`, Hamburg mit U-Bahn,
> S-Bahn, Metrobus 1–27 und HADAG-Fähren, mit Höhen aus dem Hamburger DGM10
> (Adapter `xyz-zip`, Transparenzportal-Download) und OSM-Lampen. Routen
> werden am Grenzpolygon (`limits.json`) gekappt, nicht am Rechteck. Offen
> aus Abschnitt 10: die Stadtbusse (brauchen die Aktiv-Trip-Indizierung),
> Städte on the fly (Abschnitt 9). Das Secret `KAS_TARGET_DIR` muss vor dem
> ersten Deploy auf den neuen Ordner zeigen. Ziel ist eine Mehr-Städte-App, in der Städte zunächst händisch im Code
angelegt werden (Bounding Box weiterhin aus OSM), Hamburg als zweite Stadt, und
später Städte on the fly.

## 0. Kurzfassung

- **Rostock steckt an drei Stellen strukturell drin:** (1) in *einem* Rechteck
  (`src/data/rostock-bounding-box.json`), das Kamera-Leine, Pipeline,
  AIS-Abo, Wetterpunkt und Home-View teilen; (2) in *statisch gebündelten*
  Datendateien (`src/data/network.json`, `schedule.json`, `street-lamps.json`),
  die per `import` in die App kommen; (3) in der Datenpipeline, die
  Rostock-Wissen als Konstanten trägt (RSAG-Operator, Rostock Hbf als
  S-Bahn-Schnitt, Warnow-Fähren-Relationen, MV-Geländemodell in UTM 33,
  Rostock-Namensnormalisierung im GTFS-Import). Alles andere sind Zahlen, die
  für Rostock kalibriert wurden, oder Kosmetik (Titel, Log-Tags, Kommentare).
- **Die Generalisierung ist ein "City-Objekt":** eine Stadt wird eine
  Definition (`src/cities/<slug>/city.json`) plus generierte Daten im selben
  Ordner. App, Pipeline, Vite-Middleware, PHP-Proxies und CI lesen dieselbe
  Definition. Zur Laufzeit gibt es genau *eine* aktive Stadt.
- **Stadtwechsel:** ein Viewer, ein Google-Tileset bleiben stehen; alle
  stadtgebundenen Layer werden abgebaut, die Simulation neu gebaut, die
  Kamera fliegt mit ausgesetzter Leine, dann greift die neue Leine
  (Begründung in Abschnitt 5).
- **Hamburg braucht drei Dinge, die Rostock nie brauchte:** eine
  Bounding Box, die *nicht* `out bb` der OSM-Relation ist (die Relation 62782
  enthält Neuwerk und reicht bis 8,1° Ost), ein Verkehrsmittel `subway` durch
  die ganze Kette, und eine Höhenquelle außerhalb von MV (Hamburg hat DGM1 als
  Open Data, aber keinen WCS; der bundesweite BKG-WCS ist kostenpflichtig).
- **Reihenfolge:** erst die App stadtfähig machen, während Rostock die
  einzige Stadt bleibt (kein sichtbares Verhalten ändert sich), dann die
  Pipeline, dann Hamburg. Sieben Phasen in Abschnitt 7.

## 1. Ziel und Leitplanken

- Städte werden händisch angelegt: ein Ordner, eine `city.json`, ein
  Pipeline-Lauf. Kein UI-Eingabefeld für beliebige Städte in dieser Runde.
- Die Bounding Box kommt weiter aus OSM (Relation der Stadtgrenze plus
  Polster), aber aus dem *größten Außenring* der Relation statt aus `out bb`
  (siehe 6.1).
- Die App zeigt genau eine Stadt zur Zeit. Ein Caret neben dem Titel öffnet
  die Stadtliste; Klick fliegt hin.
- Realtime, AIS und Wetter arbeiten für die gewählte Stadt.
- Bestehende Prinzipien bleiben: keine erfundenen Verkehre (Linien ohne
  GTFS-Daten bleiben aus), ereignisgesteuertes Rendern, 30 fps-Deckel,
  Routen auf absoluten DGM-Höhen wo es eine Höhenquelle gibt.

## 2. Bestandsaufnahme: Wo steckt Rostock im Code?

Drei Klassen: **hart** (funktionale Kopplung, muss weg), **Parameter**
(für Rostock kalibrierte Zahl, muss pro Stadt kommen oder generisch werden),
**Kosmetik** (Name, Log, Kommentar, Doku).

### 2.1 Das eine Rechteck und die Home-View

| Stelle | Was | Klasse | Auflösung |
|---|---|---|---|
| `src/data/rostock-bounding-box.json`, `src/lib/rostock-bounding-box.ts` | `cityBounds`, `paddingMeters`, `boundingBox`, `rostockCityBounds`, `rostockBoundingBox` | hart | Wird zu `city.json` + `src/lib/city.ts` (Typ `City`, `padBoundingBox`, `containsLonLat`, `boundingBoxCenter` bleiben als generische Helfer) |
| `src/config.ts:14` `HOME_VIEW_OFFSET_METERS`, `:151` `home` | Home-View = Box-Mitte minus 2 km/7 km, für Rostocks Warnow-Lage getunt | Parameter | `city.home` explizit (lon, lat, height, heading, pitch); kein Offset mehr |
| `src/config.ts:56` `weather` | Wetterpunkt = Box-Mitte | Parameter | `city.weather ?? boundingBoxCenter(city.boundingBox)` |
| `src/config.ts:97` `ais.ferryLineByMmsi` | MMSI der Warnow-Fähren, damit ihre AIS-Zwillinge nicht doppelt fahren | hart | `city.ais.ferryLineByMmsi` |
| `src/config.ts:169` `cameraLimits`, `src/map/CesiumMap.ts:37,563` | Leine aus `rostockBoundingBox` im Konstruktor, einmalig | hart | `CesiumMap.setCityLimits(box)`; während eines Stadtflugs `null` |
| `src/map/CesiumMap.ts:791` `homePosition` | liest `config.home` | hart | liest die aktive Stadt |
| `vite.config.ts:126`, `server/api/ais.php:67,309-331`, `server/api/ais-test.php:23-43` | AIS-Abo mit dem einen Rechteck; PHP liest `rostock-bounding-box.json` neben sich | hart | Ein Abo mit *allen* Stadt-Boxen (aisstream erlaubt mehrere `BoundingBoxes` pro Verbindung; 3 Verbindungen pro Account, also nicht eine pro Stadt); Antwort per `?city=` auf die Box gefiltert |
| `scripts/lib/overpass.mjs:8,29-37` `BBOX` | Overpass-Bbox aus `rostockBoundingBox` | hart | `overpassBbox(city)` |
| `scripts/fetch-gtfs-schedule.mjs:29,50` `BBOX = rostockCityBounds` | Stadtgrenze ohne Polster als "welche Stops gehören zur Stadt" | hart | `city.cityBounds` |
| `.github/workflows/ci.yml:288-290`, `scripts/test-ais-parity.mjs:22,62-92` | Kopie des Rechtecks ins Deploy, Paritätstest PHP ↔ TS | hart | Kopie aller `city.json`; Paritätstest über alle Städte |
| `e2e/camera-limits.spec.ts:2,10`, `tests/camera-limits.test.ts:4,18-23`, `tests/rostock-bounding-box.test.ts` | Tests gegen das Rostock-Rechteck | hart | gegen `cities.rostock` (Default-Stadt) bzw. `describe.each(cities)` |

### 2.2 Statisch gebündelte Daten

| Stelle | Was | Klasse | Auflösung |
|---|---|---|---|
| `src/data/network.ts:124` `loadBundledNetwork`, `src/data/street-lamps.ts`, `src/App.tsx:15` `import schedule` | `network.json` (2,0 MB), `schedule.json` (247 kB), `street-lamps.json` (203 kB) als statische Imports in *einem* `data`-Chunk (`vite.config.ts:205`) | hart | Pro Stadt ein Ordner `src/cities/<slug>/`; Laden per `import.meta.glob(..., { eager: false })`, damit Vite pro Stadt einen gehashten, lazy geladenen Chunk baut. Kein `public/`-Fetch nötig, keine `.htaccess`-Änderung, funktioniert in Vitest und offline |
| `src/App.tsx:357` `network` als Ref, `:364` `stopInfoById`, `:1445` `interchangeByStop`, `:1484` `lineInfos` | Alles hängt an *einem* synchron geladenen Netz | hart | `CityData { city, network, schedule, lamps }` als State; die `useMemo`s hängen daran |
| `src/App.tsx:519` `new Simulation(network, clock, schedule)` im Init-Effekt (`[]`-Deps) | Simulation, Realtime-, AIS-, Wetter-Client, Layer-Aufbau alles in *einem* einmaligen Effekt (Zeilen ~475–1000) | hart | Effekt zerlegen: Viewer-Effekt (einmal) und **City-Session-Effekt** (`[citySlug]`) mit Cleanup, siehe 3.2 |
| `vite.config.ts:18` `loadTripIds`, `server/api/realtime.php:218,308` | Trip-ID-Filter aus *der* `schedule.json` neben dem Skript; ein Cache-File | hart | `?city=<slug>` → `cities/<slug>/schedule.json`; ein Upstream-Fetch (Rohfeed 60 s gecacht), pro Stadt ein gefilterter Cache |

### 2.3 Datenpipeline

| Stelle | Was | Klasse | Auflösung |
|---|---|---|---|
| `scripts/fetch-osm-network.mjs:104-120` `QUERY` | `operator~"Rostocker Straßenbahn\|RSAG"`, `ref~"^S[0-9]+$"`, feste Fähren-Relationen | hart | Query aus `city.network` bauen (Modi, Operator-Regex pro Modus, feste Relationen) |
| `:49` `TRAIN_TERMINAL_NAME`, `:476-500` | S-Bahn wird an "Rostock Hbf" geschnitten, Warnemünde-Seite behalten | hart | Generische Regel: Richtung am letzten Stop *innerhalb* `cityBounds` kappen (`city.network.clip: 'city' \| 'box' \| 'none'`). Für Rostock ergibt das denselben Schnitt (nach dem Hbf liegt der nächste Halt von S2/S3 außerhalb der Stadt) |
| `:79-96` `FERRIES` | Relationen 56291/56296, Namen, Maße, Farben | hart | `city.network.fixedLines[]` (Relation → id, name, vehicle, color, model) |
| `:53-55` `TRAIN_VEHICLE`, `:57-66` `FALLBACK_COLORS` | Talent 2, RSAG-Palette | Parameter | `city.fleet` bzw. generische Palette |
| `:579-583` | "F1–F4 sind RSAG-Buslinien" → Fähren heißen FG/FW | Parameter | ID-Kollisionsregel bleibt generisch; feste IDs kommen aus `fixedLines` |
| `:553-563` | Zug-`from`/`to` aus den überlebenden Endstops | ok | bleibt, gilt für jedes Clipping |
| `scripts/fetch-gtfs-schedule.mjs:53-60` `ROUTE_TYPES` | tram/train/bus/ferry; kein `subway` (1, 400–402) | hart für Hamburg | Modus `subway` ergänzen |
| `:62-66` `FERRY_PENDING`, `:69-80` `TRAIN_BRANCH_PROBES` | Warnow-Fähren "FÄ1/FÄ2" ohne Namen; S2/S3-Trennung über Schwaan/Laage | hart | Fähren-Zuordnung über Terminal-Koordinaten ist schon generisch; die Branch-Probes werden `city.gtfs.trainBranches` (Rostock behält seine, Hamburg braucht keine: die Feeds führen S1–S7 getrennt) |
| `:185-190` `normalizeName` | strippt "rostock" aus Stopnamen | hart | `city.gtfs.nameStrip` (Hamburg: "hamburg") |
| Variablennamen `rostockStopCoords`, `tripTouchesRostock` … | | Kosmetik | umbenennen (`cityStop…`) |
| `scripts/lib/dgm.mjs:18,161,165`, `scripts/fetch-route-heights.mjs`, `scripts/fetch-street-lamps.mjs` | MV-WCS (`geodaten-mv.de`, `mv_dgm5`), **UTM 33 (EPSG:25833) hart codiert**, Attribution GeoBasis-DE/M-V, Fähren auf 0 m NHN ("Unterwarnow") | hart | `TerrainProvider`-Schnittstelle (`heightAt(lon, lat)`) mit Adaptern: `wcs-geotiff` (Endpoint, Coverage, EPSG/proj4-String aus `city.terrain`), `xyz-tiles` (Hamburg, siehe 6.3), `none`. Attribution aus dem Provider ins `meta` |
| `scripts/fetch-street-lamps.mjs:86` `MIN_PLAUSIBLE_LAMPS = 1000` | Plausibilität für den HRO-Import | Parameter | `city.lamps.minPlausible`, `city.lamps.enabled` |
| `scripts/lib/vehicle-fleet.mjs:296,354,435-437` | Fähren Gehlsdorf/Breitling, 6N2, Talent 2 als *die* Flotte | hart | Modelle bekommen IDs (`tram-6n2`, `sbahn-talent2`, `ferry-warnow-fg`, …); `city.fleet` bildet Modus → Modell ab, `fixedLines` können pro Linie überschreiben |
| `scripts/build-approx-network.mjs` | Rostock-Demo-Netz | Kosmetik | nach `src/cities/rostock/` als Demo-Fallback, oder streichen (der `approximated`-Pfad hat nur noch Testwert) |
| `scripts/test-php-parser.mjs` (`rostock-a` …) | Fixture-Namen | Kosmetik | egal |
| User-Agents `overpass.mjs:25`, `dgm.mjs:165`, `realtime.php:298`, `vehicle-mesh.mjs:2,366` | `mini-rostock-3d-…` | Kosmetik | umbenennen |

### 2.4 App-Laufzeit, für Rostock kalibrierte Zahlen

| Stelle | Wert | Problem | Auflösung |
|---|---|---|---|
| `src/map/CesiumMap.ts:114` `FALLBACK_GROUND_HEIGHT = 45` | ellipsoidische Straßenhöhe Rostock | Hamburg ≈ 50 m, München ≈ 570 m | Aus dem Netz ableiten: Median der Stop-`nhn` + `ROUTE_HEIGHT_OFFSET_FALLBACK`, beim Laden der Stadt gesetzt |
| `src/map/RoutesLayer.ts:46` `ROUTE_HEIGHT_OFFSET_FALLBACK = 36.5` | Geoid-Undulation Rostock | Deutschland 36–50 m | `city.terrain.geoidOffsetFallback` oder Tabelle nach Breite/Länge; Kalibrierfenster `CesiumMap.ts:1257` (20–60 m) passt für ganz Deutschland |
| `CesiumMap.ts:1215,1284`, `src/App.tsx:198` | Plausibilität `-100 < h < 500` | Alpenvorland fällt raus (München ellipsoidisch > 550 m) | Fenster relativ zur Stadt: `groundHeight ± 300 m`, oder absolut `-100 … 3000` |
| `src/config.ts:191` `cruiseSpeedByMode`, `:211` `vehicles` | 6N2, Talent 2 | Maße sind Rostock-Flotte | Defaults bleiben als Fallback, `city.fleet` liefert Maße + Modell |
| `src/map/VehicleLayer.ts:217` `VEHICLE_MODELS`, `:270` `FERRY_MODELS` | Modell per Modus; Fähre per Schiffslänge (≥ 30 m = Breitling) | hart Rostock | Modell-ID pro Linie im `network.json` (`line.model`, von der Pipeline aus `city.fleet` gesetzt); der Layer hat eine Tabelle Modell-ID → Consist-Spec |
| `src/lib/timetable.ts:48-70` `DEFAULT_SERVICE*` | RSAG-artige synthetische Takte | nur ohne `schedule.json` aktiv | Bleibt als generischer Notfall-Fallback; Kommentar anpassen |
| `src/config.ts:169` `maxHeightMeters = 25_000` | Rostock-Box ≈ 50 × 52 km | Hamburg-Box ≈ 70 × 68 km, ähnlich | Bleibt global, optional `city.camera.maxHeight` |
| `src/map/StreetLampsLayer.ts:82` `LAMP_CELL_DEGREES` | "bei Rostocks Breite" | 47–55° N nahezu gleich | bleibt |

### 2.5 Verkehrsmittel

`TransitMode = 'tram' | 'train' | 'bus' | 'ferry'` (`src/data/network-types.ts:5`)
zieht sich durch: `ControlPanel.tsx:68` `MODE_ORDER`, `mode-icon.ts`,
`i18n.ts` `MODE_KEY` + Texte, `config.ts:191,211`, `timetable.ts:64`,
`fetch-osm-network.mjs:396`, `fetch-gtfs-schedule.mjs:53`. Hamburg braucht
`subway` (U-Bahn). Eine Erweiterung ist mechanisch, aber sieben Stellen.

### 2.6 Kosmetik und Identität

- `package.json` (name, description), `index.html:16-18`, `public/.htaccess:1`,
  `README.md`, `src/config.ts:2`.
- `src/components/ControlPanel.tsx:167` "Mini Rostock 3D" (wird ohnehin zum
  Stadt-Trigger, siehe 4).
- Log-Tag `[MiniRostock3D]`: `src/main.tsx:10`, `CesiumMap.ts` (7×),
  `VehicleLayer.ts:1052`, `VesselLayer.ts:567`.
- Kommentare mit Rostock-Bezug (harmlos): `weather.ts`, `realtime.ts`,
  `rt-extract.ts`, `interchange.ts`, `line-profile.ts:197`, `ScenePopover.tsx`,
  `StreetLampsLayer.ts`, `RoutesLayer.ts:41`, `i18n.ts:386`.
- CI: Domain `minirostock3d.lampenbauer.com` (`ci.yml:46,386,397,407,483,495`).
  **Achtung:** der Ion-Token in `ci.yml` ist auf diese Domain beschränkt. Eine
  neue Domain (z. B. `minigermany3d.lampenbauer.com`) braucht im Ion-Dashboard
  eine angepasste Token-Restriktion, sonst zeigt die Seite den Drahtgitter-Globus.

### 2.7 Was bereits generisch ist (nicht anfassen)

`lib/geo.ts`, `lib/clock.ts` (Europe/Berlin gilt bundesweit), `lib/tunnels.ts`,
`lib/camera-hash.ts` (bekommt nur `city=`), `map/camera-limits.ts`,
`map/camera-fov.ts`, `map/CameraLens.ts`, `map/TiltShiftEffect.ts`,
`map/WeatherOverlay.ts`, `map/FollowCamera.ts`, `lib/ais-extract.ts`,
`lib/vessel-info.ts`, `scripts/lib/vessel-fleet.mjs`, `lib/interchange.ts`
(Logik), `lib/line-profile.ts`, `engine/simulation.ts` (nimmt ein Netz
entgegen), `data/network.ts` `prepareNetwork` (nimmt JSON entgegen), das
GTFS-RT-Protobuf-Parsing in PHP und Node, die Stop-IDs (`osm-<node>` sind
weltweit eindeutig).

## 3. Zielarchitektur

### 3.1 Die Stadt als Datenobjekt

```
src/cities/
  index.ts                 # Registry: Slugs, Default, lazy Loader (import.meta.glob)
  rostock/
    city.json              # Definition (händisch + add-city-Skript)
    network.json           # generiert (data:update --city rostock …)
    schedule.json          # generiert
    street-lamps.json      # generiert, optional
  hamburg/
    city.json
    …
```

`city.json` (Vorschlag, alles außer den ersten sechs Feldern optional):

```jsonc
{
  "slug": "hamburg",
  "name": "Hamburg",
  "osmRelation": 62782,
  "cityBoundsQueriedOn": "2026-09-03",
  "cityBounds":  { "west": 9.7301, "south": 53.3951, "east": 10.3253, "north": 53.7394 },
  "paddingMeters": 15000,
  "boundingBox": { "west": 9.5012, "south": 53.2601, "east": 10.5542, "north": 53.8744 },
  "home": { "longitude": 9.99, "latitude": 53.545, "height": 5800, "heading": 0, "pitch": -40 },
  "weather": { "longitude": 9.99, "latitude": 53.55 },
  "network": {
    "modes": ["subway", "train", "bus", "ferry"],
    "overpass": {
      "subway": {},
      "train": { "service": "commuter", "ref": "^S[0-9]+$" },
      "bus":   { "operator": "Hamburger Hochbahn|VHH", "ref": "^[0-9]{1,2}$" },
      "ferry": { "operator": "HADAG" }
    },
    "fixedLines": [],
    "clip": "city"
  },
  "gtfs": { "nameStrip": "hamburg", "trainBranches": [] },
  "fleet": {
    "subway": { "model": "ubahn-dt5",   "length": 39.6, "width": 2.6,  "height": 3.4 },
    "train":  { "model": "sbahn-et490", "length": 66,   "width": 3.0,  "height": 4.1 },
    "bus":    { "model": "bus-12m",     "length": 12,   "width": 2.55, "height": 3.1 },
    "ferry":  { "model": "ferry-hadag", "length": 30,   "width": 8.2,  "height": 5 }
  },
  "terrain": { "provider": "xyz-tiles", "crs": "EPSG:25832", "geoidOffsetFallback": 40, "attribution": "…" },
  "lamps": { "enabled": false },
  "ais": { "enabled": true, "ferryLineByMmsi": {} }
}
```

`src/lib/city.ts` typisiert das (Typ `City`), übernimmt `padBoundingBox`,
`containsLonLat`, `boundingBoxCenter` aus `rostock-bounding-box.ts` und bleibt
wie heute frei von Pfad-Aliassen, damit Node-Skripte es direkt importieren.
`tests/city-bounds.test.ts` rechnet `boundingBox` für jede Stadt aus
`cityBounds` + `paddingMeters` nach (wie heute für Rostock).

### 3.2 Laufzeit: Registry und City-Session

- `src/cities/index.ts`: `CITY_SLUGS`, `DEFAULT_CITY = 'rostock'`,
  `loadCity(slug): Promise<CityData>` (lädt `city.json` und die drei
  Datendateien lazy, ruft `prepareNetwork`).
- `App.tsx` wird in zwei Effekte geschnitten:
  1. **Viewer-Effekt** (`[]`): `CesiumMap`, Render-Loop, rAF-Watchdog,
     Hash-Writer, Tastatur, Fullscreen, das `__mrt`-API. Alles, was heute
     schon stadtunabhängig ist.
  2. **City-Session-Effekt** (`[citySlug]`): `await loadCity(slug)`,
     `new Simulation(...)`, `map.setCity(city)` (Leine, Home, Ground-Fallback),
     `map.addRoutes/addStops/addStreetLamps`, `RealtimeClient(url?city=)`,
     `AisClient(url?city=)` mit `city.ais.ferryLineByMmsi`, `WeatherClient`
     mit `city.weather`. Das **Cleanup** stoppt die Clients, ruft
     `map.clearCity()` und setzt Auswahl/Follow zurück. Ein Stadtwechsel ist
     dann "Cleanup + neuer Lauf", und React Strict Mode testet genau das.
- Der Render-Loop liest Simulation und Netz über Refs, die die Session
  setzt; solange keine Session aktiv ist (Laden), liefert `snapshots()` leer.
- `MrtTestApi` bekommt `city()`, `setCity(slug)`, `cityReady` für E2E.

### 3.3 Karte: Stadtwechsel ohne Viewer-Neubau

`CesiumMap` bekommt:

- `setCity({ boundingBox, home, groundHeightFallback, geoidOffsetFallback })`
- `clearCity()`: `RoutesLayer.clear()` (Entities entfernen, Credit abmelden),
  `StopsLayer.clear()` (`BillboardCollection.removeAll`, Records leeren),
  `StreetLampsLayer.clear()` (Primitives zerstören, `data = null`),
  `VehicleLayer.sync([])` + Follow/Selection zurücksetzen,
  `VesselLayer.sync([])`. Der Höhen-Bootstrap wird für die neue Stadt neu
  angestoßen, sobald die Kamera angekommen ist (er lädt sich seine Tiles selbst).
- `flyToCity(home, durationMs)`: Leine aussetzen (`cameraLimits = null` in
  `enforceCameraLimits`), `camera.flyTo` mit hohem Bogen (`maximumHeight`
  deutlich über 25 km, ca. 4–6 s für Rostock → Hamburg, 180 km), im
  `complete` die neue Leine setzen und `tileset.trimLoadedTiles()` rufen.
  `maximumZoomDistance` bleibt; sie greift nur auf Nutzergesten.

### 3.4 URL und Hash

- `city=<slug>` wandert in `HashUiState` (`src/lib/camera-hash.ts:95`) und
  wird wie die anderen Abweichungen nur geschrieben, wenn sie vom Default
  abweicht. Ein `#vehicle=`- oder `#stop=`-Link ohne `city=` meint Rostock.
- `applyHash` (`App.tsx:716`) vergleicht zuerst die Stadt: weicht sie ab,
  wird die Session gewechselt und der Rest des Hashes erst *nach* dem Laden
  angewandt (Fahrzeug-/Stop-IDs sind pro Stadt).
- Letzte Stadt in `localStorage` merken; Reihenfolge: Hash > localStorage >
  Default.

### 3.5 Server

- **`/api/realtime?city=<slug>`**: Vite-Middleware und `realtime.php` cachen
  den Rohfeed *einmal* (60 s) und filtern pro Stadt mit
  `cities/<slug>/schedule.json`; ein Cache-File pro Stadt
  (`mrt-realtime-<slug>.json`). Unbekannter Slug → 404. Ohne `city` → Default.
- **`/api/ais?city=<slug>`**: ein Abo mit allen `boundingBox`es aus
  `cities/*/city.json` (aisstream nimmt ein Array). Der State bleibt *ein*
  File; die Antwort filtert die Schiffe auf die Box der angefragten Stadt.
  Der Keeper-Cron (`?listen=45`) bleibt unverändert. Hamburgs Hafen bringt
  hunderte AIS-Ziele mehr in den State; das ist Text im Kilobyte-Bereich und
  unkritisch, aber `MRT_AIS_STATIC_KEEP_MS` und die Trackspeicherung sollten
  einmal unter Last geprüft werden.
- Deploy kopiert `src/cities/*/{city,schedule}.json` nach
  `dist/api/cities/<slug>/`; `.htaccess` braucht keine neue Regel.

### 3.6 Pipeline

- Alle Skripte nehmen `--city <slug>` (oder `CITY=`) und lesen
  `src/cities/<slug>/city.json`; Ausgaben landen im selben Ordner.
  `npm run data:update -- --city hamburg` usw. Ohne Angabe: alle Städte.
- **`scripts/add-city.mjs <slug> <osmRelationId>`**: holt `rel(id); out geom;`,
  fügt die Außenringe zusammen, nimmt die Bbox des flächengrößten Rings als
  `cityBounds`, rechnet `boundingBox`, schreibt eine `city.json` mit
  Defaults (Home = Box-Mitte, alle Modi, kein Operator-Filter) und druckt, was
  von Hand zu prüfen ist. Das ist die "Bounding Box aus OSM"-Regel des Projekts,
  nur exklavenfest (siehe 6.1).
- `fetch-osm-network.mjs`: Query-Builder aus `city.network`; Clipping
  generisch (letzter Stop in `cityBounds`); `fixedLines`; Modell-ID pro Linie
  aus `city.fleet` ins `network.json` (`line.model`, `line.vehicle`).
- `fetch-gtfs-schedule.mjs`: `city.cityBounds`, `nameStrip`, `trainBranches`,
  `ROUTE_TYPES.subway = {1, 400, 401, 402}`. Der gtfs.de-Feed wird einmal
  entpackt und für alle Städte in einem Lauf gescannt (die `stop_times`-Passage
  ist der teure Teil; ein Pass mit N Stadt-Boxen statt N Pässe).
- `fetch-route-heights.mjs` / `fetch-street-lamps.mjs`: `TerrainProvider` aus
  `city.terrain`; `provider: 'none'` lässt `heights` weg, die App klemmt dann
  auf die Tiles (bestehender Fallback, ca. 15 % GPU – für eine Stadt ohne
  offene Höhenquelle akzeptabel, aber nicht das Ziel).
- `build-vehicle-models.mjs`: Flotte nach Modell-ID; neue Modelle für
  Hamburg (6.4).

### 3.7 Neues Verkehrsmittel `subway`

Sieben Stellen aus 2.5 plus Icon (`lucide` hat `TrainFrontTunnel`, heute für
den Untergrund-Button benutzt; Alternative `RailSymbol`), i18n `mode.subway`
("U-Bahn"/"Subway"), Fahrgeschwindigkeit (~10 m/s), synthetischer Fallback-Takt.
Eventuell gleich `light_rail` mitnehmen (Stadtbahnen in Stuttgart, Köln,
Hannover), das kostet dieselben sieben Stellen nur einmal.

## 4. UI: Stadtwahl im ControlPanel

- Titelzeile: `Mini <Stadt> 3D` mit dem Stadtnamen als Button plus
  `ChevronDown` (`lucide`), dahinter ein Radix-`Popover` (schon im Projekt;
  ein DropdownMenu wäre eine neue Abhängigkeit). Die Liste zeigt pro Stadt
  Name und die Verkehrsmittel als kleine Icons; die aktive Stadt ist markiert.
- `document.title` folgt: "Mini Hamburg 3D". Marke in README/Meta:
  "Mini Germany 3D".
- Klick: Popover zu, `setCitySlug(slug)`, Session wechselt, Kamera fliegt;
  während des Ladens ist der Trigger disabled und die Linienliste leer.
- Props: `city: { slug, name }`, `cities: { slug, name, modes }[]`,
  `onSelectCity(slug)`. i18n: `city.pick`, `city.current`, `city.switchTo`.
- Tests: `tests/app.test.tsx:72,188` und `e2e/app.spec.ts:65-66` suchen
  "Mini Rostock 3D" – bleibt für die Default-Stadt wahr; ein neuer Unit-Test
  für das Popover, ein E2E für den Wechsel (Abschnitt 8).

## 5. Performance beim Stadtwechsel (Entscheidung)

**Entscheidung: alte Stadt vollständig abbauen, Viewer und Google-Tileset
behalten.**

- Was pro Stadt im Speicher und *pro Tick* kostet, hängt an der geladenen
  Menge, nicht an dem, was im Bild ist: 612 Stop-Billboards plus Namensschilder
  mit Screen-Space-Declutter, ~7000 Lampen-Sprites in Primitives, 36 Linien
  als Polyline-Stücke, bis zu ~350 Fahrzeug-Consists, und `snapshots()`
  läuft über *alle* Trips des Netzes. Zwei Städte gleichzeitig würden das
  verdoppeln, auch wenn eine davon 180 km entfernt liegt. Also: abbauen.
- Der Viewer bleibt: ein Neubau kostet den WebGL-Kontext, den Root-Fetch
  des Google-Tilesets, den Höhen-Bootstrap, und ein Kameraflug über einen
  neu gebauten Viewer ist unmöglich. Cesium wirft Rostocks Tiles selbst aus
  dem Cache, sobald die Kamera weg ist (`cacheBytes`); ein
  `trimLoadedTiles()` nach der Landung räumt sofort. Nach dem Wechsel einmal
  `__mrt.tileMemory()` prüfen: Hamburgs Zentrum ist dichter, bei gleichem
  SSE kann die Speicher-Ratsche früher greifen (Memory-Notiz "Tile LOD memory
  ratchet"); dann `city.camera.sse` als Stellschraube.
- Die Simulation neu zu bauen ist billig (Rostock: `buildAllTrips` im
  zweistelligen ms-Bereich); das Laden des Stadt-Chunks (~2 MB) dominiert und
  überlappt mit dem Flug.
- Für Städte deutlich über Rostock-Größe (Hamburg mit *allen* Bussen) wird
  nicht der Wechsel, sondern der Normalbetrieb das Problem; siehe 6.5.

## 6. Hamburg konkret

Alle Angaben in diesem Abschnitt wurden am 2026-09-03 nachgeprüft.

### 6.1 Bounding Box: `out bb` ist für Hamburg falsch

OSM-Relation **62782** (Freie und Hansestadt Hamburg, `admin_level=4`) hat
drei Außenringe. `out bb` liefert **8,1045–10,3253° O / 53,3951–54,0277° N**,
weil Neuwerk und Scharhörn in der Nordsee dazugehören (Ring von 234 km² bei
8,10–8,58° O). Damit läge Cuxhaven im Rechteck, das AIS-Abo deckte die halbe
Elbmündung ab, und die Kamera dürfte aufs offene Meer.

Der flächengrößte Ring (Festland, 742 km²) ergibt
**9,7301–10,3253° O / 53,3951–53,7394° N**; mit 15 km Polster
9,5012–10,5542 / 53,2601–53,8744 (≈ 70 × 68 km, Rostock: 50 × 52 km). Der
Hafen und alle HVV-Schnellbahnäste bis Wedel, Pinneberg, Ahrensburg, Aumühle
liegen darin. Deshalb `add-city` mit "größter Außenring" statt `out bb`;
für Rostock (ein Ring) ändert sich nichts. Bremen hätte dasselbe Problem
gelöst (Bremerhaven ist im Land, nicht in der Stadtrelation).

### 6.2 Umfang im gtfs.de-Feed (Cache vom 2026-08-24)

| Agentur | route_type | Linien |
|---|---|---|
| 425 Hamburger Verkehrsverbund | 3 (Bus) | **810** verschiedene Kurzbezeichnungen, verbundweit |
| 425 | 1 (U-Bahn) | U1, U2, U3, U4 |
| 425 | 4 (Fähre) | 61, 62, 64, 65, 66, 68, 72, 73, 75 (HADAG) |
| 286 S-Bahn Hamburg | 2 | S1, S2, S3, S5, S7 (plus Ersatzverkehre) |

Route-Type 1 ist neu für den Import; S-Bahn kommt wie in Rostock als Typ 2.
Zum Vergleich Rostock: 36 Linien, 612 Stops, ~350 gleichzeitige Fahrzeuge
um 08:30.

### 6.3 Höhenquelle

- Der MV-WCS deckt nur MV. `scripts/lib/dgm.mjs` ist außerdem auf
  EPSG:25833 festgenagelt; Hamburg liegt in UTM 32 (EPSG:25832).
- **BKG `wcs_dgm1`** (bundesweit, `sg.geodatenzentrum.de/wcs_dgm1`) ist
  *nicht* offen: Lizenzvereinbarung, ab 8 000 €. Fällt aus.
- **Hamburg LGV** stellt das DGM1 als Open Data bereit (dl-de/by-2-0,
  ETRS89/UTM32, NHN/DHHN2016, ±15 cm auf Straßen). Es gibt einen WMS
  (`HH_WMS_DGM1`), aber kein WCS (`HH_WCS_DGM1` antwortet 404). Der Datensatz
  "Digitales Höhenmodell Hamburg DGM 1" im Transparenzportal liegt als
  Kachel-Download vor; dafür der `xyz-tiles`-Adapter: Kacheln je nach Bedarf
  laden, cachen, bilinear samplen, genau wie heute die WCS-Kacheln. Vor der
  Umsetzung Format und URL-Schema der Kacheln prüfen (nicht in dieser Runde
  verifiziert).
- Fallback, falls das zu lange dauert: `provider: 'none'` und Klemmen auf die
  Tiles; Hamburg wäre dann zunächst die Stadt mit dem 15-%-GPU-Aufschlag.
- Fähren: heute 0 m NHN ("Unterwarnow ist Ostsee"). Die Elbe in Hamburg ist
  Tidegewässer um 0 m NHN, passt; generisch als `city.terrain.waterLevelNhn`.

### 6.4 Flotte

Neue prozedurale Modelle in `vehicle-fleet.mjs`: **DT5** (U-Bahn, 39,6 m,
dreiteilig), **ET 490** (S-Bahn, 3 Wagen, ~66 m, mit Stromschiene statt
Pantograph), **HADAG Typ 2000 / "Bügeleisen"** (~30 × 8 m, Doppelender),
Bus 12 m wiederverwenden; Gelenkbusse später. `VEHICLE_MODELS` und
`FERRY_MODELS` in `VehicleLayer.ts` werden zu einer Tabelle nach Modell-ID.

### 6.5 Welche Linien: Allowlist statt alles

810 Buslinien sind verbundweit; innerhalb der Stadtgrenze bleiben grob
250–300. Alle zu laden hieße ein `network.json` von 15–20 MB und 2000+
gleichzeitige Fahrzeuge; `snapshots()` und die Label-Menge sind dafür nicht
gebaut. Vorschlag für Hamburg Phase 1: U1–U4, S1–S7, HADAG 61–75,
Metrobus 1–27 (Hochbahn/VHH, `ref ^[0-9]{1,2}$`), optional XpressBus X-Linien.
Das sind ~50 Linien mit hoher Taktdichte, geschätzt 400–600 Fahrzeuge, also
etwa das Doppelte von Rostock. Stadtbusse mit dreistelligen Nummern kommen
später, sinnvoll erst mit einer Aktiv-Trip-Indizierung in `Simulation`
(sortierte Abfahrten statt Vollscan pro Tick) und Lazy-Loading pro Linie.

### 6.6 Sonstiges

- OSM-Operatoren zum Filtern: "Hamburger Hochbahn", "VHH", "S-Bahn Hamburg",
  "HADAG". Overpass-Mengenabschätzung war heute nicht möglich (Hauptmirror
  im Timeout, `osm.ch` ist ein Schweiz-Extrakt); die Query ist mit ~750 km²
  und Relationen-only trotzdem klein.
- Clipping: `clip: 'city'` kappt S1 in Rissen, S3 in Neugraben/Pinneberg-Seite
  an der Landesgrenze; das entspricht der Rostock-Regel. Wer die Äste bis
  Wedel/Pinneberg sehen will, nimmt `clip: 'box'` (alles im gepolsterten
  Rechteck), dann anchoren die GTFS-Abfahrten aber an Stops außerhalb der Stadt –
  dieselbe Falle, die Rostock mit Schwaan/Laage hatte. Empfehlung: `'city'`.
- Lampen: ob Hamburgs Straßenbeleuchtung in OSM flächig ist, ist nicht
  geprüft; `lamps.enabled: false` zum Start, Plausibilitätsgrenze relativ.
- Wetter: Punkt Rathaus/Alster statt Box-Mitte (die Box-Mitte liegt in
  Wandsbek).
- AIS: Hamburgs Box enthält den gesamten Hafen; `ferryLineByMmsi` für die
  HADAG-Fähren erst füllen, wenn die Fähren als Fahrplanfahrzeuge laufen
  (sonst fahren sie doppelt, wie in Rostock beobachtet).

## 7. Umsetzungsphasen

Jede Phase ist ein eigener Commit-Strang auf `main` und lässt die App
lauffähig; Rostock bleibt bis Phase 6 die einzige Stadt und verhält sich
unverändert.

### Phase 0 – Identität (jederzeit, klein)

- [ ] `package.json` name/description, `index.html`, `.htaccess`-Kommentar,
      Log-Tag `[MiniGermany3D]`, User-Agents, README-Kopf.
- [ ] Domain-Entscheidung und Ion-Token-Restriktion (2.6).

### Phase 1 – Stadt als Datenobjekt, Rostock einzige Stadt

- [ ] `src/cities/rostock/city.json` aus `rostock-bounding-box.json` plus
      `home`, `weather`, `fleet`, `terrain`, `ais` (Werte aus `config.ts`).
- [ ] `src/lib/city.ts` (Typ, Helfer), `src/cities/index.ts` (Registry, Loader).
- [ ] `config.ts` verliert `home`, `weather.longitude/latitude`,
      `ais.ferryLineByMmsi`; Aufrufer lesen die Stadt.
- [ ] `rostock-bounding-box.*` löschen; Importe in `vite.config.ts`,
      `overpass.mjs`, `fetch-gtfs-schedule.mjs`, `test-ais-parity.mjs`,
      `camera-limits.spec.ts`, Tests umhängen.
- [ ] Daten nach `src/cities/rostock/` verschieben; `manualChunks` pro Stadt.
- [ ] `npm run typecheck`, `npm test`, E2E grün; Verhalten identisch.

### Phase 2 – App-Init zerlegen, Laden asynchron

- [ ] Viewer-Effekt und City-Session-Effekt (3.2); `CityData` als State;
      Ladezustand im Panel.
- [ ] `CesiumMap.setCity`, `clearCity`; `clear()` in Routes-, Stops-,
      StreetLamps-Layer; Credit-Abmeldung.
- [ ] Ground-Fallback und Geoid-Offset aus der Stadt (2.4); Plausibilitäts-
      fenster relativ.
- [ ] Strict-Mode-Doppellauf ist der erste Stadtwechsel-Test.

### Phase 3 – Stadtwechsel, Hash, Panel

- [ ] `flyToCity` mit ausgesetzter Leine (3.3).
- [ ] `city=` im Hash, `applyHash`-Reihenfolge, localStorage.
- [ ] Panel-Caret mit Popover (4), i18n, `__mrt.setCity`.
- [ ] Unit-Test Popover; E2E "Wechsel" (mit nur Rostock: Wechsel auf
      dieselbe Stadt ist ein No-op, der echte Test kommt in Phase 6).

### Phase 4 – Server, CI, Deploy

- [ ] `?city=` in Vite-Middleware und `realtime.php` (3.5); Rohfeed-Cache.
- [ ] AIS: Mehrfach-Box-Abo in Vite und PHP; Filter per `?city=`;
      `test-ais-parity.mjs` über alle Städte.
- [ ] `ci.yml`: Nightly-Refresh als Schleife über `CITY_SLUGS`
      (Overpass-Fehler pro Stadt isolieren, wie heute für das eine Netz),
      `datacheck`/`git add` auf `src/cities/**`, Artefakt mit
      `dist/api/cities/<slug>/`.
- [ ] README-Abschnitte Data/Deployment anpassen.

### Phase 5 – Pipeline generalisieren (parallel zu 2–4 möglich)

- [ ] `--city`-Parsing, Ausgabepfade, `add-city.mjs` mit größtem Außenring.
- [ ] Overpass-Query-Builder, `fixedLines`, generisches Clipping,
      Modell-ID pro Linie; `tests/tunnel-pipeline.test.ts` für `clipPathAt`
      bleibt.
- [ ] GTFS: `cityBounds`, `nameStrip`, `trainBranches`, `subway`;
      Ein-Pass-Scan für alle Städte.
- [ ] `TerrainProvider` mit `wcs-geotiff` (MV, parametrisierte EPSG) und
      `none`; `tests/route-heights.test.ts:15` auf den Provider umstellen.
- [ ] Lampen optional pro Stadt.
- [ ] `TransitMode` + `subway` (3.7), Modelle nach ID.
- [ ] Rostock mit der neuen Pipeline regenerieren; Diff gegen die alten
      Dateien muss leer oder erklärbar sein (`schedule-data.test.ts` verlangt
      byte-stabile Ausgaben).

### Phase 6 – Hamburg

- [ ] `add-city hamburg 62782`, Box prüfen (6.1), Home/Wetter setzen.
- [ ] Allowlist (6.5), Operatoren, `clip: 'city'`.
- [ ] DT5/ET490/HADAG-Modelle (6.4).
- [ ] `xyz-tiles`-Adapter für das Hamburger DGM1 (6.3) oder vorerst `none`.
- [ ] Pipeline-Lauf, `tests/cities/hamburg.test.ts` (U-Bahn-Tunnel vorhanden,
      Fähre 62 vorhanden, alle Koordinaten in der Box), E2E-Wechsel
      Rostock → Hamburg (Leine wechselt, Fahrzeuge > 0, Titel "Mini Hamburg 3D").
- [ ] `__mrt.tileMemory()` und Render-Rate in Hamburg prüfen; ggf. `sse`.
- [ ] Attribution pro Stadt in `network.meta.attribution` (LGV Hamburg,
      dl-de/by-2-0) – der Credit-Mechanismus in `RoutesLayer.add` trägt sie schon.

### Phase 7 – Ausblick: Städte on the fly (Abschnitt 9)

## 8. Tests und CI

- **Strukturelle Datentests** (`network.test.ts`, `street-lamps.test.ts`,
  Teile von `schedule-data.test.ts`, `simulation.test.ts`) laufen als
  `describe.each(CITY_SLUGS)`: Koordinaten in der Box, monotone Stops,
  Tunnel sortiert, Abfahrten byte-stabil.
- **Stadtwissen** wandert in `tests/cities/<slug>.test.ts`: Rostock behält
  Doberaner Platz (`interchange.test.ts:90-113`), die eine Gehlsdorf-Fähre
  (`schedule-data.test.ts:31-46`), den Hbf-Tunnel (`network.test.ts:77-88`);
  Hamburg bekommt seine eigenen.
- **E2E** bleibt auf Rostock offline (deterministisch, SwiftShader-Budget).
  Ein Spec für den Wechsel; `app.spec.ts:219-231` (Nachtlinien F1–F4) ist
  Rostock-Wissen und bleibt dort.
- **Paritätstests** (`test-php-parser.mjs`, `test-ais-parity.mjs`,
  `test-ais-state.mjs`) prüfen pro Stadt bzw. das Mehrfach-Box-Abo.
- CI-Laufzeit: Nightly wächst linear mit den Städten; Overpass ist der
  Wackelkandidat (heute drei Timeouts in einer Stunde), daher pro Stadt
  isoliert und mit Wochenrhythmus wie bisher.

## 9. Ausblick: Städte on the fly

Was das heute kostet, gemessen an der bestehenden Pipeline:

- **OSM:** Overpass 20–120 s pro Stadt, Mirrors überlastet, Fair-Use.
  Vom Browser aus möglich (CORS offen), aber nicht verlässlich.
- **GTFS:** der gtfs.de-Feed ist 276 MB gepackt, `stop_times.txt` mehrere GB;
  der Import streamt das in Minuten. Das geht nicht zur Anfragezeit. Es
  braucht einen *nächtlich vorindizierten* Stand (z. B. SQLite mit Stops nach
  Bbox, Trips nach Route), aus dem ein Stadt-Extrakt in Sekunden fällt.
- **Realtime pro Stadt** ist dann kein Problem: die Trip-ID-Menge entsteht mit
  dem Extrakt, `realtime.php?city=` liest sie wie jede angelegte Stadt.
- **Höhen:** pro Bundesland eine andere Quelle oder keine; `none` als
  Default für generierte Städte.
- **Hosting:** all-inkl (PHP) kann keine Node-Jobs laufen lassen. Erster
  Schritt ohne neue Infrastruktur: ein `workflow_dispatch` in `ci.yml` mit
  Eingabe `city` + OSM-Relation, der `add-city` und die Pipeline fährt und das
  Ergebnis committet/deployt (10–20 min). Die UI kann dafür einen "Stadt
  anfragen"-Link anbieten. Echtes On-the-fly braucht einen kleinen
  Node-Worker mit Queue und Cache; die Skripte sind dafür bereits Bibliotheken
  (`scripts/lib/*`), nur `fetch-*.mjs` sind CLI-Hüllen.
- **Rechtliches** bleibt pro Stadt: ODbL, gtfs.de-Bedingungen, Landes-DGM-
  Lizenzen; die Attribution steht in `network.meta` und wird angezeigt.

## 10. Offene Entscheidungen und Risiken

1. **Default-Stadt:** Rostock (Herkunft) oder letzte besuchte Stadt? Vorschlag:
   Rostock, localStorage merkt sich die letzte.
2. **Titel-Muster:** "Mini Hamburg 3D ▾" (Stadt ist Teil des Namens) oder
   "Mini Germany 3D · Hamburg ▾". Vorschlag: ersteres im Panel, "Mini Germany
   3D" als Marke in README/Meta.
3. **Hamburg-Höhen:** `xyz-tiles`-Adapter (Kachelformat noch zu prüfen) vs.
   `none` zum Start. Vorschlag: `none` in Phase 6, Adapter als Folgearbeit.
4. **Hamburg-Linienumfang:** Allowlist (6.5) vs. alles. Alles ist ohne
   Simulations-Indizierung nicht tragbar.
5. **Domain/Ion-Token** (2.6) muss vor dem ersten Deploy unter neuem Namen
   geklärt sein.
6. **Hash-Kompatibilität:** alte Rostock-Links ohne `city=` bleiben gültig,
   solange Rostock Default ist.
7. **Tile-Speicher in dichten Städten** (5): Ratsche beobachten, `sse` pro
   Stadt als Ventil.
8. **AIS-State** wächst mit dem Hamburger Hafen; einmal unter Last messen.
