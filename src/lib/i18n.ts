/**
 * Minimal i18n: English is the default; German is used when the browser's
 * preferred languages rank German first among the supported ones (or when
 * the ?lang= URL override says so). Two locales and a flat message table –
 * no library needed.
 */

import { parseSitePath } from './site-path.ts'
import type { TransitMode } from './transit-mode'

export type Lang = 'en' | 'de'

const en = {
  // Control panel
  'panel.expand': 'Expand panel',
  'panel.collapse': 'Collapse panel',
  'panel.hideAll': 'Hide entire interface with H key',
  'sim.pause': 'Pause simulation',
  'sim.resume': 'Resume simulation',
  'sim.setTime': 'Set simulation time',
  'sim.setDate': 'Set simulation date (today to a week ahead)',
  'sim.now': 'Now',
  'sim.timeLapse': 'Time-lapse',
  'layers.title': 'Layers',
  'layers.routes': 'Routes',
  'layers.stops': 'Stops',
  'layers.labels': 'Vehicle labels',
  'layers.showRoutes': 'Show routes',
  'layers.showStops': 'Show stops',
  'layers.showLabels': 'Show vehicle and ship labels',
  'layers.webcams': 'Webcams',
  'layers.showWebcams': 'Show webcams',
  'webcams.flyTo': 'Fly to {name}',
  // What the city is shown under and through, rather than what is drawn
  // on it: the sky in the weather popover, the lens in the camera block.
  'scene.tiltShift': 'Miniature effect',
  'scene.showTiltShift': 'Show the miniature effect',
  'scene.grid': 'Grid',
  'scene.showGrid': 'Show the framing grid',
  // The photo popover: the camera the city is shot with
  'photo.title': 'Photo mode',
  'photo.reset': 'Reset to defaults',
  'photo.resetKnob': 'Double-click to reset this one',
  'photo.camera': 'Camera',
  'photo.look': 'Look',
  'photo.focalLength': 'Focal length',
  'photo.exposure': 'Exposure',
  'photo.whiteBalance': 'White balance',
  'photo.contrast': 'Contrast',
  'photo.saturation': 'Saturation',
  'photo.vignette': 'Vignette',
  'photo.blur': 'Blur',
  'photo.band': 'Sharp band',
  'photo.feather': 'Feather',
  'photo.focusLine': 'Focus line',
  'photo.bokeh': 'Bokeh',
  'photo.sharpen': 'Sharpening',
  // The camera path in the photo popover (lib/camera-path.ts)
  'path.title': 'Camera path',
  'path.hint': 'Runs on the wall clock: pause and time-lapse leave it alone. H takes the interface away for a clean recording.',
  'path.start': 'Start',
  'path.end': 'End',
  'path.unset': 'not set',
  'path.setStart': 'Set the start to the current view',
  'path.setEnd': 'Set the end to the current view',
  'path.goStart': 'Camera to the start',
  'path.goEnd': 'Camera to the end',
  'path.duration': 'Duration',
  'path.ease': 'Ease in and out',
  'path.play': 'Play the camera path',
  'path.stop': 'Stop the camera path',
  'path.progress': 'Position on the path',
  'path.clear': 'Clear the camera path',
  'weather.title': 'Weather',
  'weather.temperature': '{degrees} °C',
  'weather.live': 'Live weather',
  'weather.clear': 'Sunny',
  'weather.cloudy': 'Cloudy',
  'weather.rain': 'Rain',
  'weather.liveUnavailable': 'No live weather to reach here',
  'weather.clouds': '3D clouds',
  'weather.showClouds': 'Show the 3D clouds',
  // The scrolling section at the bottom of the panel. It holds the
  // scheduled lines AND the AIS ships, which run to no timetable at all –
  // "Traffic" is the word that covers both.
  'traffic.title': 'Traffic',
  'traffic.ais': 'AIS ships',
  'traffic.aisHint': 'Live harbour traffic',
  'traffic.showAis': 'Show the AIS ships',
  'traffic.aisClockLabel': 'What the clock does to the ships',
  'traffic.aisClockNote':
    'The ships sail in real time. Neither the time-lapse nor a simulation time you set moves them – only pausing holds them.',
  'traffic.running': '{count} out now',
  'traffic.aisCount': '{count} ships',
  // City card (the network in numbers, behind the panel head's info button)
  'city.facts': '{name} in numbers',
  'city.factsSubtitle': 'The network in numbers',
  'city.close': 'Close the city card',
  'city.lines': 'Lines',
  'city.linesCount': '{count} lines',
  'city.linesRunning': '{count} running today',
  'city.stops': 'Stops',
  'city.stopPositions': '{count} stop positions',
  'city.route': 'Route',
  'city.lineKm': '{km} of line',
  'city.tunnelShare': '{km} in tunnel ({percent} %)',
  'city.longest': 'Longest',
  'city.flyToLongest': 'Fly to line {name}, the longest at {km}',
  'city.elevation': 'Elevation',
  'city.elevationRange': '{min}–{max} m above sea level',
  'city.highestStop': 'highest: {name}',
  'city.trips': 'Trips',
  'city.tripsPerDay': '{count} a day',
  'city.shortWorkings': '{count} short workings',
  'city.service': 'Service',
  'city.roundTheClock': 'round the clock',
  'city.noSchedule': 'no timetable data',
  'city.running': 'Out now',
  'city.runningCount': '{count} vehicles',
  'city.runningNone': 'none in service',
  'city.liveCovered': '{count} with live data',
  // Line card (the profile behind a line name in the panel)
  'line.close': 'Close line',
  'line.service': 'Service',
  'line.route': 'Route',
  'line.stops': '{count} stops',
  'line.spacing': '{count} m apart',
  'line.everyMin': 'every {count} min',
  'line.peakMin': '{count} min at peak',
  'line.trips': 'Trips',
  'line.tripsPerDay': '{count} a day',
  'line.shortWorkings': '{count} short workings',
  'line.noSchedule': 'no timetable data',
  'line.flyTo': 'Fly to the line',
  'line.running': 'Out now',
  'line.runningCount': '{count} in service',
  'line.runningNone': 'none in service',
  'line.nextOut': 'Next out',
  'line.nextNone': 'nothing more today',
  'line.delayed': '{count} min late on average',
  'line.early': '{count} min early on average',
  'line.punctual': 'running to time',
  'line.showVehicle': 'Show the vehicle {name}, heading for {destination}',
  'line.towards': 'towards {name}',
  'line.atStop': 'at {name}',
  'lines.showAll': 'Show all {mode} lines',
  'lines.flyTo': 'Fly to {name}',
  'lines.show': 'Show {name}',
  'mode.tram': 'Tram',
  'mode.subway': 'Subway',
  'mode.train': 'S-Bahn',
  'mode.bus': 'Bus',
  'mode.ferry': 'Ferry',
  // City picker (the caret beside the panel title)
  'city.title': 'Mini {name} 3D',
  'city.pick': 'Choose a city',
  'city.switchTo': 'Switch to {name}',
  'city.current': 'Shown now',
  'city.loading': 'Loading {name} …',
  // The ship icon in the city lists: ferries and the live AIS fleet alike
  'city.ships': 'Ships',
  // City names: the definitions carry the English name (the slug is
  // English too – src/cities/munich/), the German UI shows the German one.
  // Rostock, Kiel, Hamburg and Berlin read the same in both languages
  // and need no entry; see localizeCityName.
  'city.name.cologne': 'Cologne',
  'city.name.hanover': 'Hanover',
  'city.name.munich': 'Munich',
  // The welcome screen (the city chooser on a plain visit, see lib/welcome.ts)
  'welcome.eyebrow': 'Mini Germany 3D',
  'welcome.title': 'Which city would you like to see?',
  'welcome.lead':
    'Trains weaving between buildings, ferries crossing the harbour, and everyday journeys seen from above. City by city, with the real lines, the real stops and the real timetable, drawn over a photorealistic model of the city.',
  'welcome.invitation': 'Pick a city, follow a train, and take a look around.',
  'welcome.cities': 'Cities',
  'welcome.open': 'Open {name}',
  'welcome.skip': 'Don’t show this welcome screen on your next visit',
  // Vehicle card
  'vehicle.status': 'Status',
  'vehicle.nextStop': 'Next stop',
  'vehicle.stops': 'Stops',
  'vehicle.flyToStop': 'Fly to {name}',
  'vehicle.flyToThisStop': 'Fly to this stop',
  'vehicle.close': 'Close selection',
  'vehicle.moving': 'Moving',
  'vehicle.atStop': 'At stop',
  'vehicle.atPier': 'At pier',
  'vehicle.inTunnel': 'in tunnel',
  'vehicle.onTime': 'on time',
  'vehicle.late': '{count} min late',
  'vehicle.early': '{count} min early',
  'vehicle.onSchedule': 'On schedule',
  'vehicle.arrival': 'Arrival',
  'vehicle.inMinutes': 'in {count} min',
  'vehicle.arriving': 'arriving',
  'vehicle.stopsLeft': '{count} stops to go',
  'vehicle.lastStop': 'final stop',
  'vehicle.vehicle': 'Vehicle',
  'vehicle.interchange': 'Change at {name}',
  // Stop card
  'stop.eyebrow': 'Stop',
  'stop.departures': 'Departures',
  'stop.noDepartures': 'No departures in the next hour',
  'stop.nearby': 'Nearby lines',
  'stop.underground': 'Underground platform',
  'stop.flyTo': 'Fly to stop',
  'stop.close': 'Close selection',
  'stop.now': 'now',
  'stop.flyToVehicle': 'Fly to this vehicle',
  'follow.tram': 'Follow tram',
  'follow.subway': 'Follow train',
  'follow.train': 'Follow train',
  'follow.bus': 'Follow bus',
  'follow.ferry': 'Follow ferry',
  'follow.stop': 'Stop following',
  'follow.vessel': 'Follow vessel',
  // Vessel card (AIS): the fields a ship reports about itself
  'vessel.dimensions': 'Dimensions',
  'vessel.draught': 'Draught',
  'vessel.type': 'Type',
  'vessel.speed': 'Speed',
  'vessel.typeUnknown': 'Type unknown',
  'vessel.statusUnknown': 'Status unknown',
  'vessel.notReported': 'not reported',
  'vessel.mmsi': 'MMSI',
  'vessel.live': 'Live from AIS',
  'vessel.fixAge': 'last update {count} s ago',
  'vessel.fixAgeMin': 'last update {count} min ago',
  // AIS ship type groups (first digit of the type code)
  'vesselType.passenger': 'Passenger ship',
  'vesselType.cargo': 'Cargo ship',
  'vesselType.tanker': 'Tanker',
  'vesselType.tug': 'Tug or service craft',
  'vesselType.highSpeed': 'High-speed craft',
  'vesselType.fishing': 'Fishing vessel',
  'vesselType.sailing': 'Sailing vessel',
  'vesselType.pleasure': 'Pleasure craft',
  'vesselType.towing': 'Towing vessel',
  'vesselType.dredger': 'Dredger',
  'vesselType.diving': 'Diving vessel',
  'vesselType.military': 'Military vessel',
  'vesselType.pilot': 'Pilot vessel',
  'vesselType.searchRescue': 'Search and rescue vessel',
  'vesselType.portTender': 'Port tender',
  'vesselType.antiPollution': 'Anti-pollution vessel',
  'vesselType.lawEnforcement': 'Law enforcement vessel',
  'vesselType.medical': 'Medical transport',
  'vesselType.other': 'Other vessel',
  // Named by ITU-R M.1371-6 (2026); most ships still send the older,
  // coarser codes above
  'vesselType.trawler': 'Trawler',
  'vesselType.patrol': 'Patrol vessel',
  'vesselType.cruise': 'Cruise ship',
  'vesselType.ferry': 'Ferry',
  'vesselType.excursion': 'Excursion boat',
  'vesselType.bulkCarrier': 'Bulk carrier',
  'vesselType.containerShip': 'Container ship',
  'vesselType.roro': 'Roll-on/roll-off ship',
  'vesselType.landingCraft': 'Landing craft',
  'vesselType.tugAndBarge': 'Tug and tank barge',
  'vesselType.specialPurpose': 'Special purpose ship',
  'vesselType.support': 'Support vessel',
  // AIS navigational status
  'navStatus.0': 'Under way using engine',
  'navStatus.1': 'At anchor',
  'navStatus.2': 'Not under command',
  'navStatus.3': 'Restricted manoeuvrability',
  'navStatus.4': 'Constrained by draught',
  'navStatus.5': 'Moored',
  'navStatus.6': 'Aground',
  'navStatus.7': 'Engaged in fishing',
  'navStatus.8': 'Under way sailing',
  'navStatus.11': 'Towing astern',
  'navStatus.12': 'Pushing ahead',
  'navStatus.14': 'AIS-SART active',
  'navStatus.15': 'Not defined',
  // Map controls
  'camera.to2d': 'Switch to 2D view',
  'camera.to3d': 'Switch to 3D view',
  'camera.faceNorth': 'Face north',
  'camera.faceEast': 'Face east',
  'camera.faceSouth': 'Face south',
  'camera.faceWest': 'Face west',
  'camera.reset': 'Reset camera',
  'view.controls': 'View controls',
  'view.fullscreen': 'Full screen',
  'view.exitFullscreen': 'Leave full screen',
  /** The view tabs name what they show, not what pressing them does. */
  'view.readings': 'View',
  'view.surface': 'Surface',
  'view.underground': 'Underground',
  /** What a transit operator calls the strip over the door: one line drawn
      straight with its stops along it, geography left out entirely. */
  'view.diagram': 'Line diagram',
  // About: the personal project story, map details, and keyboard shortcuts.
  // Cesium's "Data attribution", in this interface's own dialog. The
  // names inside it are Cesium's – the sources say how they want to be
  // called – so only the frame around them is translated.
  'credits.eyebrow': 'Sources',
  'credits.title': 'Data attribution',
  'credits.lead': 'What is drawn here, and who it comes from.',
  'credits.close': 'Close the attribution',
  'about.open': 'About this project',
  'about.close': 'Close about dialog',
  'about.title': 'Mini Germany 3D',
  'about.eyebrow': 'A little change of perspective',
  'about.lead': 'Big cities, small journeys. Watch Germany’s public transport make its way through a world in miniature.',
  'about.storyTab': 'The project',
  'about.detailsTab': 'Good to know',
  'about.projectTitle': 'The city, seen from above.',
  'about.project': 'Mini Germany 3D brings a different view of the city to your browser: trains weaving between buildings, ships crossing the harbour, and everyday journeys seen from above. City by city, with the real lines, the real stops and the real timetable, drawn over a photorealistic 3D model.',
  'about.projectRealism': 'Nothing here is made up: what runs on the map runs in reality too, on the same route and at the same time. A line that pauses for the weekend pauses here as well.',
  'about.invitation': 'Pick a city, follow a train, and take a look around. I’m glad you’re here.',
  'about.whoTitle': 'Hello world 👋',
  'about.who': 'Hi, I’m Mario – a product designer and photographer, and the one who keeps this little world running.',
  'about.authorLink': 'More about me',
  'about.rootsTitle': 'Two projects that inspired this one',
  'about.miniTokyo': 'Tokyo’s trains in 3D were the spark for bringing this idea to German cities.',
  'about.legibleCities': 'A fresh way to see a transport network. The inspiration for the straightened lines in the line diagram.',
  'about.notTitle': 'Moving to the timetable',
  'about.notLive': 'The trains and buses follow their timetables, with reported delays taken into account. Their positions are calculated, rather than tracked by GPS. A train running three minutes late appears where it would have been three minutes earlier.',
  'about.shipsTitle': 'The harbour is live',
  'about.notShips': 'Ships are the exception: their positions come from AIS transponders. When a ship sends an update, it moves on the map too.',
  'about.exploreTitle': 'A place to explore',
  'about.notRouting': 'For your next connection, use your transport operator’s app. This map is here to let you look around and discover.',
  'about.notComplete': 'Larger cities show a selection of lines to keep things running smoothly, such as the Metro buses in Berlin and Munich.',
  'about.builtTitle': 'Made possible by open data & 3D',
  'about.built': 'Routes and stops: OpenStreetMap. Timetables: gtfs.de / DELFI. Terrain: the states’ open 1 m elevation models via Mapterhorn. City models: Google Photorealistic 3D Tiles and CesiumJS. Weather: Open-Meteo. Ships: aisstream.io. Webcams: Windy. You’ll find the licences in the credits at the bottom of the map.',
  'about.keyboardLead': 'A few keys to move around your little world. Use them when this dialog is closed.',
  // The keyboard, listed in its own tab. Every entry names what
  // the key does, not the control it stands in for – the reader is
  // looking for a verb here.
  'keys.title': 'Keyboard',
  'keys.open': 'Keyboard shortcuts',
  'keys.close': 'Close the shortcut list',
  'keys.pause': 'Pause and play',
  'keys.readings': 'Surface, underground, line diagram',
  'keys.fullscreen': 'Full screen on and off',
  'keys.home': 'Camera back to the city',
  'keys.hideUi': 'Interface away and back',
  'keys.now': 'Back to the real time',
  'keys.compass': 'Turn to the next quarter',
  'keys.miniature': 'Miniature effect on and off',
  'keys.pitch': 'Look from above, look across',
  'keys.speed': 'Time-lapse faster, slower',
  'keys.dismiss': 'Close the card, stop following',
  'keys.help': 'This dialog',
  // The static pages under the map (lib/site-pages.ts): what a crawler
  // and a reader without WebGL get, one page per city and language.
  'page.description':
    'Public transport in German cities, live on a photorealistic 3D map: the real lines, the real stops and today’s timetable.',
  'page.citySummary': 'The network in {name}: {summary}.',
  'page.cityDescription':
    '{summary} Live on a photorealistic 3D map, with the real stops and today’s timetable.',
  'page.line.tram': 'tram line',
  'page.line.subway': 'subway line',
  'page.line.train': 'S-Bahn line',
  'page.line.bus': 'bus line',
  'page.line.ferry': 'ferry line',
  'page.lines.tram': 'tram lines',
  'page.lines.subway': 'subway lines',
  'page.lines.train': 'S-Bahn lines',
  'page.lines.bus': 'bus lines',
  'page.lines.ferry': 'ferry lines',
  'page.needsWebgl': 'The map itself needs a browser with JavaScript and WebGL.',
  'page.theLines': 'The lines',
  'page.otherCities': 'More cities',
  'page.allCities': 'All cities',
  'page.otherLanguage': 'Diese Seite auf Deutsch',
  'page.failed': 'The map could not start.',
  'page.failedHint':
    'It needs a browser with WebGL and enough graphics memory. Try another browser, or this one with hardware acceleration switched on. What the map would show is written out below.',
  'page.retry': 'Try again',
} as const

export type MessageKey = keyof typeof en

const de: Record<MessageKey, string> = {
  'panel.expand': 'Panel ausklappen',
  'panel.collapse': 'Panel einklappen',
  'panel.hideAll': 'Gesamte Oberfläche mit Taste H ausblenden',
  'sim.pause': 'Simulation pausieren',
  'sim.resume': 'Simulation fortsetzen',
  'sim.setTime': 'Simulationszeit einstellen',
  'sim.setDate': 'Simulationsdatum wählen (heute bis in einer Woche)',
  'sim.now': 'Jetzt',
  'sim.timeLapse': 'Zeitraffer',
  'layers.title': 'Ebenen',
  'layers.routes': 'Routen',
  'layers.stops': 'Haltestellen',
  'layers.labels': 'Fahrzeugbeschriftungen',
  'layers.showRoutes': 'Routen anzeigen',
  'layers.showStops': 'Haltestellen anzeigen',
  'layers.showLabels': 'Fahrzeug- und Schiffsbeschriftungen anzeigen',
  'layers.webcams': 'Webcams',
  'layers.showWebcams': 'Webcams anzeigen',
  'webcams.flyTo': 'Zu {name} fliegen',
  'scene.tiltShift': 'Miniatureffekt',
  'scene.showTiltShift': 'Miniatureffekt anzeigen',
  'scene.grid': 'Raster',
  'scene.showGrid': 'Bildraster anzeigen',
  'photo.title': 'Fotomodus',
  'photo.reset': 'Auf Standardwerte zurücksetzen',
  'photo.resetKnob': 'Doppelklick setzt diesen Regler zurück',
  'photo.camera': 'Kamera',
  'photo.look': 'Look',
  'photo.focalLength': 'Brennweite',
  'photo.exposure': 'Belichtung',
  'photo.whiteBalance': 'Weißabgleich',
  'photo.contrast': 'Kontrast',
  'photo.saturation': 'Sättigung',
  'photo.vignette': 'Vignette',
  'photo.blur': 'Unschärfe',
  'photo.band': 'Schärfeband',
  'photo.feather': 'Verlauf',
  'photo.focusLine': 'Fokuslinie',
  'photo.bokeh': 'Bokeh',
  'photo.sharpen': 'Schärfung',
  'path.title': 'Kamerafahrt',
  'path.hint': 'Läuft nach der Uhr an der Wand: Pause und Zeitraffer berühren sie nicht. H nimmt die Oberfläche für eine saubere Aufnahme weg.',
  'path.start': 'Start',
  'path.end': 'Ziel',
  'path.unset': 'nicht gesetzt',
  'path.setStart': 'Start auf die aktuelle Ansicht setzen',
  'path.setEnd': 'Ziel auf die aktuelle Ansicht setzen',
  'path.goStart': 'Kamera zum Start',
  'path.goEnd': 'Kamera zum Ziel',
  'path.duration': 'Dauer',
  'path.ease': 'Sanft anfahren und abbremsen',
  'path.play': 'Kamerafahrt abspielen',
  'path.stop': 'Kamerafahrt anhalten',
  'path.progress': 'Position auf der Fahrt',
  'path.clear': 'Kamerafahrt löschen',
  'weather.title': 'Wetter',
  'weather.temperature': '{degrees} °C',
  'weather.live': 'Live-Wetter',
  'weather.clear': 'Sonnig',
  'weather.cloudy': 'Bewölkt',
  'weather.rain': 'Regen',
  'weather.liveUnavailable': 'Hier ist kein Live-Wetter erreichbar',
  'weather.clouds': '3D-Wolken',
  'weather.showClouds': '3D-Wolken anzeigen',
  'traffic.title': 'Verkehr',
  'traffic.ais': 'AIS-Schiffe',
  'traffic.aisHint': 'Echter Schiffsverkehr im Hafen',
  'traffic.showAis': 'AIS-Schiffe anzeigen',
  'traffic.aisClockLabel': 'Was die Uhr mit den Schiffen macht',
  'traffic.aisClockNote':
    'Die Schiffe fahren in Echtzeit. Weder der Zeitraffer noch eine eingestellte Uhrzeit bewegt sie – nur die Pause hält sie an.',
  'traffic.running': '{count} unterwegs',
  'traffic.aisCount': '{count} Schiffe',
  // City card (the network in numbers, behind the panel head's info button)
  'city.facts': '{name} in Zahlen',
  'city.factsSubtitle': 'Das Netz in Zahlen',
  'city.close': 'Stadtkarte schließen',
  'city.lines': 'Linien',
  'city.linesCount': '{count} Linien',
  'city.linesRunning': '{count} fahren heute',
  'city.stops': 'Halte',
  'city.stopPositions': '{count} Haltepositionen',
  'city.route': 'Strecke',
  'city.lineKm': '{km} Linienlänge',
  'city.tunnelShare': '{km} im Tunnel ({percent} %)',
  'city.longest': 'Längste',
  'city.flyToLongest': 'Zu Linie {name} fliegen, mit {km} die längste',
  'city.elevation': 'Höhe',
  'city.elevationRange': '{min}–{max} m über NHN',
  'city.highestStop': 'höchste: {name}',
  'city.trips': 'Fahrten',
  'city.tripsPerDay': '{count} am Tag',
  'city.shortWorkings': '{count} Kurzfahrten',
  'city.service': 'Betrieb',
  'city.roundTheClock': 'rund um die Uhr',
  'city.noSchedule': 'keine Fahrplandaten',
  'city.running': 'Unterwegs',
  'city.runningCount': '{count} Fahrzeuge',
  'city.runningNone': 'keins im Einsatz',
  'city.liveCovered': '{count} mit Live-Daten',
  // Line card (the profile behind a line name in the panel)
  'line.close': 'Linie schließen',
  'line.service': 'Betrieb',
  'line.route': 'Strecke',
  'line.stops': '{count} Halte',
  'line.spacing': 'ø {count} m',
  'line.everyMin': 'alle {count} min',
  'line.peakMin': 'HVZ {count} min',
  'line.trips': 'Fahrten',
  'line.tripsPerDay': '{count} am Tag',
  'line.shortWorkings': '{count} Kurzläufe',
  'line.noSchedule': 'keine Fahrplandaten',
  'line.flyTo': 'Zur Linie fliegen',
  'line.running': 'Unterwegs',
  'line.runningCount': '{count} im Einsatz',
  'line.runningNone': 'keine im Einsatz',
  'line.nextOut': 'Nächste Abfahrt',
  'line.nextNone': 'heute nichts mehr',
  'line.delayed': 'ø {count} min Verspätung',
  'line.early': 'ø {count} min zu früh',
  'line.punctual': 'nach Fahrplan',
  'line.showVehicle': 'Fahrzeug {name} anzeigen, Richtung {destination}',
  'line.towards': 'Richtung {name}',
  'line.atStop': 'an {name}',
  'lines.showAll': 'Alle {mode}-Linien anzeigen',
  'lines.flyTo': 'Zu {name} fliegen',
  'lines.show': '{name} anzeigen',
  'mode.tram': 'Straßenbahn',
  'mode.subway': 'U-Bahn',
  'mode.train': 'S-Bahn',
  'mode.bus': 'Bus',
  'mode.ferry': 'Fähre',
  'city.title': 'Mini {name} 3D',
  'city.pick': 'Stadt wählen',
  'city.switchTo': 'Nach {name} wechseln',
  'city.current': 'Gerade zu sehen',
  'city.loading': '{name} wird geladen …',
  'city.ships': 'Schiffe',
  'city.name.cologne': 'Köln',
  'city.name.hanover': 'Hannover',
  'city.name.munich': 'München',
  'welcome.eyebrow': 'Mini Germany 3D',
  'welcome.title': 'Welche Stadt möchtest du sehen?',
  'welcome.lead':
    'Bahnen zwischen Häusern, Schiffe im Hafen und alltägliche Wege aus der Vogelperspektive. Stadt für Stadt, mit den echten Linien, den echten Haltestellen und dem echten Fahrplan, gezeichnet über ein fotorealistisches Modell der Stadt.',
  'welcome.invitation': 'Such dir eine Stadt aus, folge einer Bahn und schau dich um.',
  'welcome.cities': 'Städte',
  'welcome.open': '{name} öffnen',
  'welcome.skip': 'Diese Willkommensansicht bei deinem nächsten Besuch nicht mehr anzeigen',
  'vehicle.status': 'Status',
  'vehicle.nextStop': 'Nächster Halt',
  'vehicle.stops': 'Haltestellen',
  'vehicle.flyToStop': 'Zu {name} fliegen',
  'vehicle.flyToThisStop': 'Zu dieser Haltestelle fliegen',
  'vehicle.close': 'Auswahl schließen',
  'vehicle.moving': 'In Fahrt',
  'vehicle.atStop': 'An Haltestelle',
  'vehicle.atPier': 'Am Anleger',
  'vehicle.inTunnel': 'im Tunnel',
  'vehicle.onTime': 'pünktlich',
  'vehicle.late': '{count} min Verspätung',
  'vehicle.early': '{count} min zu früh',
  'vehicle.onSchedule': 'Nach Fahrplan',
  'vehicle.arrival': 'Ankunft',
  'vehicle.inMinutes': 'in {count} Min',
  'vehicle.arriving': 'gleich',
  'vehicle.stopsLeft': 'noch {count} Halte',
  'vehicle.lastStop': 'Endhalt',
  'vehicle.vehicle': 'Fahrzeug',
  'vehicle.interchange': 'Umstieg {name}',
  'stop.eyebrow': 'Haltestelle',
  'stop.departures': 'Abfahrten',
  'stop.noDepartures': 'Keine Abfahrten in der nächsten Stunde',
  'stop.nearby': 'Linien in der Nähe',
  'stop.underground': 'Unterirdischer Bahnsteig',
  'stop.flyTo': 'Zur Haltestelle fliegen',
  'stop.close': 'Auswahl schließen',
  'stop.now': 'jetzt',
  'stop.flyToVehicle': 'Zu diesem Fahrzeug fliegen',
  'follow.tram': 'Straßenbahn folgen',
  'follow.subway': 'U-Bahn folgen',
  'follow.train': 'S-Bahn folgen',
  'follow.bus': 'Bus folgen',
  'follow.ferry': 'Fähre folgen',
  'follow.stop': 'Nicht mehr folgen',
  'follow.vessel': 'Schiff folgen',
  // Vessel card (AIS): the fields a ship reports about itself
  'vessel.dimensions': 'Maße',
  'vessel.draught': 'Tiefgang',
  'vessel.type': 'Typ',
  'vessel.speed': 'Geschwindigkeit',
  'vessel.typeUnknown': 'Typ unbekannt',
  'vessel.statusUnknown': 'Status unbekannt',
  'vessel.notReported': 'nicht gemeldet',
  'vessel.mmsi': 'MMSI',
  'vessel.live': 'Live per AIS',
  'vessel.fixAge': 'letzte Meldung vor {count} s',
  'vessel.fixAgeMin': 'letzte Meldung vor {count} min',
  // AIS ship type groups (first digit of the type code)
  'vesselType.passenger': 'Fahrgastschiff',
  'vesselType.cargo': 'Frachtschiff',
  'vesselType.tanker': 'Tanker',
  'vesselType.tug': 'Schlepper oder Arbeitsschiff',
  'vesselType.highSpeed': 'Schnellboot',
  'vesselType.fishing': 'Fischereifahrzeug',
  'vesselType.sailing': 'Segelschiff',
  'vesselType.pleasure': 'Sportboot',
  'vesselType.towing': 'Schleppverband',
  'vesselType.dredger': 'Baggerschiff',
  'vesselType.diving': 'Taucherfahrzeug',
  'vesselType.military': 'Militärschiff',
  'vesselType.pilot': 'Lotsenboot',
  'vesselType.searchRescue': 'Seenotrettungsboot',
  'vesselType.portTender': 'Hafenboot',
  'vesselType.antiPollution': 'Ölbekämpfungsschiff',
  'vesselType.lawEnforcement': 'Behördenfahrzeug',
  'vesselType.medical': 'Lazarettschiff',
  'vesselType.other': 'Sonstiges Schiff',
  'vesselType.trawler': 'Trawler',
  'vesselType.patrol': 'Patrouillenboot',
  'vesselType.cruise': 'Kreuzfahrtschiff',
  'vesselType.ferry': 'Fähre',
  'vesselType.excursion': 'Ausflugsschiff',
  'vesselType.bulkCarrier': 'Massengutfrachter',
  'vesselType.containerShip': 'Containerschiff',
  'vesselType.roro': 'Roll-on-Roll-off-Schiff',
  'vesselType.landingCraft': 'Landungsboot',
  'vesselType.tugAndBarge': 'Schubverband mit Tankleichter',
  'vesselType.specialPurpose': 'Spezialschiff',
  'vesselType.support': 'Versorgungsschiff',
  // AIS navigational status
  'navStatus.0': 'In Fahrt mit Maschine',
  'navStatus.1': 'Vor Anker',
  'navStatus.2': 'Manövrierunfähig',
  'navStatus.3': 'Eingeschränkt manövrierfähig',
  'navStatus.4': 'Durch Tiefgang beschränkt',
  'navStatus.5': 'Festgemacht',
  'navStatus.6': 'Auf Grund',
  'navStatus.7': 'Beim Fischfang',
  'navStatus.8': 'In Fahrt unter Segel',
  'navStatus.11': 'Schleppt achteraus',
  'navStatus.12': 'Schiebt voraus',
  'navStatus.14': 'AIS-SART aktiv',
  'navStatus.15': 'Nicht definiert',
  'camera.to2d': 'Zur 2D-Ansicht wechseln',
  'camera.to3d': 'Zur 3D-Ansicht wechseln',
  'camera.faceNorth': 'Nach Norden ausrichten',
  'camera.faceEast': 'Nach Osten ausrichten',
  'camera.faceSouth': 'Nach Süden ausrichten',
  'camera.faceWest': 'Nach Westen ausrichten',
  'camera.reset': 'Kamera zurücksetzen',
  'view.controls': 'Ansichtssteuerung',
  'view.fullscreen': 'Vollbild',
  'view.exitFullscreen': 'Vollbild verlassen',
  'view.readings': 'Ansicht',
  'view.surface': 'Oberfläche',
  'view.underground': 'Untergrund',
  'view.diagram': 'Linienband',
  'credits.eyebrow': 'Quellen',
  'credits.title': 'Datenquellen',
  'credits.lead': 'Was hier gezeichnet wird, und von wem es stammt.',
  'credits.close': 'Datenquellen schließen',
  'about.open': 'Über dieses Projekt',
  'about.close': 'Über dieses Projekt schließen',
  'about.title': 'Mini Germany 3D',
  'about.eyebrow': 'Ein kleiner Perspektivwechsel',
  'about.lead': 'Große Städte, kleine Wege. Schau dem Nahverkehr dabei zu, wie er Deutschland im Miniaturformat bewegt.',
  'about.storyTab': 'Das Projekt',
  'about.detailsTab': 'Gut zu wissen',
  'about.projectTitle': 'Die Stadt, von oben gesehen.',
  'about.project': 'Mini Germany 3D holt einen anderen Blick auf die Stadt in deinen Browser: Bahnen zwischen Häusern, Schiffe im Hafen und alltägliche Wege aus der Vogelperspektive. Stadt für Stadt, mit den echten Linien, den echten Haltestellen und dem echten Fahrplan, gezeichnet über ein fotorealistisches 3D-Modell.',
  'about.projectRealism': 'Nichts davon ist ausgedacht: Was auf der Karte fährt, fährt auch in Wirklichkeit, auf derselben Strecke und zur selben Zeit. Eine Linie, die am Wochenende pausiert, pausiert auch hier.',
  'about.invitation': 'Such dir eine Stadt aus, folge einer Bahn und schau dich um. Schön, dass du da bist.',
  'about.whoTitle': 'Hallo Welt 👋',
  'about.who': 'Hi, ich bin Mario – Produktdesigner und Fotograf, und derjenige, der diese kleine Welt am Laufen hält.',
  'about.authorLink': 'Mehr über mich',
  'about.rootsTitle': 'Zwei Projekte, die mich inspiriert haben',
  'about.miniTokyo': 'Tokios Züge in 3D waren der Anstoß, diese Idee auch in deutsche Städte zu bringen.',
  'about.legibleCities': 'Ein neuer Blick auf Liniennetze. Die Inspiration für die geradegezogenen Strecken im Linienband.',
  'about.notTitle': 'Unterwegs nach Fahrplan',
  'about.notLive': 'Bahnen und Busse folgen ihrem Fahrplan, gemeldete Verspätungen werden eingerechnet. Ihre Positionen sind berechnet, nicht per GPS gemessen. Eine Bahn mit drei Minuten Verspätung erscheint dort, wo sie drei Minuten früher gewesen wäre.',
  'about.shipsTitle': 'Im Hafen wird’s live',
  'about.notShips': 'Schiffe sind die Ausnahme: Ihre Positionen stammen von AIS-Transpondern. Wenn ein Schiff ein Update sendet, bewegt es sich auch auf der Karte weiter.',
  'about.exploreTitle': 'Platz zum Entdecken',
  'about.notRouting': 'Für deine nächste Verbindung nimm am besten die App deines Verkehrsbetriebs. Hier kannst du dich umschauen und auf Entdeckungstour gehen.',
  'about.notComplete': 'Damit alles flüssig läuft, zeigen größere Städte eine Auswahl an Linien, etwa die Metrobusse in Berlin und München.',
  'about.builtTitle': 'Dank offener Daten & 3D',
  'about.built': 'Wege und Haltestellen: OpenStreetMap. Fahrpläne: gtfs.de / DELFI. Gelände: offene 1-m-Höhenmodelle der Länder über Mapterhorn. Stadtmodelle: Google Photorealistic 3D Tiles und CesiumJS. Wetter: Open-Meteo. Schiffe: aisstream.io. Webcams: Windy. Die Lizenzen findest du am unteren Kartenrand.',
  'about.keyboardLead': 'Mit ein paar Tasten durch deine kleine Welt. Die Kürzel funktionieren, sobald du diesen Dialog schließt.',
  'keys.title': 'Tastatur',
  'keys.open': 'Tastaturkürzel',
  'keys.close': 'Kürzelliste schließen',
  'keys.pause': 'Pause und weiter',
  'keys.readings': 'Oberfläche, Untergrund, Linienband',
  'keys.fullscreen': 'Vollbild an und aus',
  'keys.home': 'Kamera zurück auf die Stadt',
  'keys.hideUi': 'Oberfläche weg und zurück',
  'keys.now': 'Zurück zur echten Zeit',
  'keys.compass': 'Zur nächsten Himmelsrichtung drehen',
  'keys.miniature': 'Miniatureffekt an und aus',
  'keys.pitch': 'Von oben schauen, quer schauen',
  'keys.speed': 'Zeitraffer schneller, langsamer',
  'keys.dismiss': 'Karte schließen, Verfolgung beenden',
  'keys.help': 'Dieses Fenster',
  'page.description':
    'Der Nahverkehr deutscher Städte live auf einer fotorealistischen 3D-Karte: die echten Linien, die echten Haltestellen und der Fahrplan von heute.',
  'page.citySummary': 'Das Netz in {name}: {summary}.',
  'page.cityDescription':
    '{summary} Live auf einer fotorealistischen 3D-Karte, mit den echten Haltestellen und dem Fahrplan von heute.',
  'page.line.tram': 'Straßenbahnlinie',
  'page.line.subway': 'U-Bahn-Linie',
  'page.line.train': 'S-Bahn-Linie',
  'page.line.bus': 'Buslinie',
  'page.line.ferry': 'Fährlinie',
  'page.lines.tram': 'Straßenbahnlinien',
  'page.lines.subway': 'U-Bahn-Linien',
  'page.lines.train': 'S-Bahn-Linien',
  'page.lines.bus': 'Buslinien',
  'page.lines.ferry': 'Fährlinien',
  'page.needsWebgl': 'Die Karte selbst braucht einen Browser mit JavaScript und WebGL.',
  'page.theLines': 'Die Linien',
  'page.otherCities': 'Weitere Städte',
  'page.allCities': 'Alle Städte',
  'page.otherLanguage': 'This page in English',
  'page.failed': 'Die Karte konnte nicht starten.',
  'page.failedHint':
    'Sie braucht einen Browser mit WebGL und genug Grafikspeicher. Versuch es mit einem anderen Browser oder mit eingeschalteter Hardwarebeschleunigung. Was die Karte zeigen würde, steht darunter.',
  'page.retry': 'Noch einmal versuchen',
}

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, de }

/**
 * Picks the UI language: an explicit ?lang= override wins, then the path
 * – a page under /en/ is the English one (see lib/site-path.ts) –
 * otherwise the first entry in the browser's preference list that
 * matches a supported language decides (so "fr, de" gives German,
 * "en-US, de" stays English). A bare path says nothing: the German
 * pages have no prefix, but a reader whose browser prefers English
 * gets the English interface on them, and the URL the app then writes
 * carries /en/ so a link they share opens the way they saw it.
 */
export function detectLanguage(
  urlLang: string | null,
  preferred: readonly string[],
): Lang {
  if (urlLang === 'de' || urlLang === 'en') return urlLang
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0]
    if (base === 'de') return 'de'
    if (base === 'en') return 'en'
  }
  return 'en'
}

let lang: Lang = detectLanguage(
  typeof window === 'undefined'
    ? null
    : (new URLSearchParams(window.location.search).get('lang') ??
        parseSitePath(window.location.pathname).lang),
  typeof navigator === 'undefined'
    ? []
    : navigator.languages?.length
      ? navigator.languages
      : [navigator.language],
)

export function getLanguage(): Lang {
  return lang
}

/** Overrides the detected language (tests; a future manual toggle). */
export function setLanguage(next: Lang): void {
  lang = next
}

/** Message for the current language, with {placeholder} interpolation. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text: string = MESSAGES[lang][key]
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(`{${name}}`, String(value))
    }
  }
  return text
}

/**
 * Line names come from the data pipeline in English ("Line 1",
 * "Subway U3", "Ferry Kabutzenhof – Gehlsdorf") – German swaps the
 * generic prefix. "Bus 22" and "S-Bahn S1" read the same in both languages.
 */
export function localizeLineName(name: string): string {
  if (lang !== 'de') return name
  return name
    .replace(/^Line /, 'Linie ')
    .replace(/^Subway /, 'U-Bahn ')
    .replace(/^Ferry /, 'Fähre ')
}

/**
 * A city's name in the current language. The definition's `name` is the
 * English one; a city whose German name differs (Cologne/Köln,
 * Munich/München) has a `city.name.<slug>` message, everything else is
 * shown as the definition spells it.
 */
export function localizeCityName(slug: string, name: string): string {
  const key = `city.name.${slug}`
  return key in en ? t(key as MessageKey) : name
}

/**
 * Cities by name in the language the interface speaks: Köln sorts under
 * K and Cologne under C, München under M and Munich under M as well, so
 * the order is computed here rather than written into
 * src/cities/definitions.ts. A collator, not <, because sorting umlauts
 * by code point puts Lübeck behind Wilhelmshaven. The panel's picker and
 * the welcome screen list the same order.
 */
export function sortCitiesByName<T extends { slug: string; name: string }>(
  cities: readonly T[],
): { city: T; name: string }[] {
  const collator = new Intl.Collator(lang === 'de' ? 'de-DE' : 'en-GB')
  return cities
    .map((city) => ({ city, name: localizeCityName(city.slug, city.name) }))
    .sort((a, b) => collator.compare(a.name, b.name))
}

/** Label key per transit mode – shared by the line panel and the vehicle card. */
export const MODE_KEY: Record<TransitMode, MessageKey> = {
  tram: 'mode.tram',
  subway: 'mode.subway',
  train: 'mode.train',
  bus: 'mode.bus',
  ferry: 'mode.ferry',
}
