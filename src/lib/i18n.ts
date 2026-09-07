/**
 * Minimal i18n: English is the default; German is used when the browser's
 * preferred languages rank German first among the supported ones (or when
 * the ?lang= URL override says so). Two locales and a flat message table –
 * no library needed.
 */

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
  // City names: the definitions carry the English name (the slug is
  // English too – src/cities/munich/), the German UI shows the German one.
  // Rostock, Kiel, Hamburg and Berlin read the same in both languages
  // and need no entry; see localizeCityName.
  'city.name.cologne': 'Cologne',
  'city.name.hanover': 'Hanover',
  'city.name.munich': 'Munich',
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
  'vessel.unknown': 'unknown',
  'vessel.notReported': 'not reported',
  'vessel.mmsi': 'MMSI',
  'vessel.fixAge': 'last fix {count} s ago',
  'vessel.fixAgeMin': 'last fix {count} min ago',
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
  // The About dialog (press ? or the question mark below the map
  // controls): where this comes from, what it is not, and the keyboard at
  // the end of it.
  'about.open': 'About this project',
  'about.title': 'Mini Germany 3D',
  'about.lead':
    'Thirteen German cities and their public transport, running to the timetable of the day on a photorealistic 3D map.',
  'about.rootsTitle': 'Where it comes from',
  'about.miniTokyo':
    'put Tokyo\u2019s trains on a 3D map and let them run to the timetable. This map is that idea, brought to German cities.',
  'about.legibleCities':
    'draws schematic maps and timetable animations out of open GTFS data. The line diagram here \u2013 every line pulled straight, the geography left out \u2013 is at home in that corner of the world.',
  'about.notTitle': 'What it is not',
  'about.notLive':
    'Not live vehicle tracking. The open feeds carry the timetable and, for many trips, how late they are running \u2013 not where the vehicle is. So every tram here drives its scheduled trip, and a GTFS-Realtime delay shifts it: one running three minutes late is drawn where it should have been three minutes ago.',
  'about.notShips':
    'The ships are the exception. They carry AIS transponders, so the harbour traffic is where it really is, in real time.',
  'about.notRouting':
    'Not a journey planner. Nothing here will tell you how to get from A to B \u2013 the operators\u2019 apps do that far better.',
  'about.notComplete':
    'Not every line. The larger cities show a selection \u2013 Berlin\u2019s and Munich\u2019s Metro buses rather than all of their bus networks \u2013 so the map keeps its frame rate.',
  'about.whoTitle': 'Who made it',
  // The name links to his own page, which is where he introduces himself
  // – "Mario", product designer and photographer – so this says no more
  // about him than he does.
  'about.who': 'is a product designer and photographer, and made this map.',
  'about.builtTitle': 'What it is built from',
  'about.built':
    'Routes and stops from OpenStreetMap, departures from the Germany-wide GTFS feed (gtfs.de / DELFI), terrain from the states\u2019 open 1 m elevation models via Mapterhorn, the city itself from Google Photorealistic 3D Tiles through CesiumJS, weather from Open-Meteo, ships from aisstream.io, webcams from Windy. The licences are named in the credit line at the bottom of the map.',
  // The keyboard, listed at the end of the dialog. Every entry names what
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
  'photo.sharpen': 'Nachschärfen',
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
  'city.name.cologne': 'Köln',
  'city.name.hanover': 'Hannover',
  'city.name.munich': 'München',
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
  'vessel.unknown': 'unbekannt',
  'vessel.notReported': 'nicht gemeldet',
  'vessel.mmsi': 'MMSI',
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
  'about.open': 'Über dieses Projekt',
  'about.title': 'Mini Germany 3D',
  'about.lead':
    'Dreizehn deutsche Städte und ihr Nahverkehr, nach dem Fahrplan des Tages unterwegs auf einer fotorealistischen 3D-Karte.',
  'about.rootsTitle': 'Woher es kommt',
  'about.miniTokyo':
    'hat Tokios Züge auf eine 3D-Karte gesetzt und nach Fahrplan fahren lassen. Diese Karte ist dieselbe Idee, übertragen auf deutsche Städte.',
  'about.legibleCities':
    'zeichnet schematische Netzpläne und Fahrplan-Animationen aus offenen GTFS-Daten. Das Linienband hier – jede Linie geradegezogen, die Geografie weggelassen – ist in dieser Ecke zu Hause.',
  'about.notTitle': 'Was es nicht ist',
  'about.notLive':
    'Kein Echtzeit-Tracking. Die offenen Daten liefern den Fahrplan und für viele Fahrten die Verspätung – nicht die Position des Fahrzeugs. Jede Straßenbahn hier fährt deshalb ihre Fahrplanfahrt, und eine GTFS-Realtime-Verspätung verschiebt sie: drei Minuten zu spät heißt, sie wird dort gezeichnet, wo sie vor drei Minuten hätte sein sollen.',
  'about.notShips':
    'Die Schiffe sind die Ausnahme. Sie tragen AIS-Transponder, der Hafenverkehr steht also wirklich dort, wo er gerade ist.',
  'about.notRouting':
    'Keine Fahrplanauskunft. Von A nach B hilft hier nichts – das können die Apps der Verkehrsbetriebe weit besser.',
  'about.notComplete':
    'Nicht jede Linie. Die großen Städte zeigen eine Auswahl – Berlins und Münchens Metrobusse statt ihrer kompletten Busnetze –, damit die Karte flüssig bleibt.',
  'about.whoTitle': 'Wer es gemacht hat',
  'about.who': 'ist Produktdesigner und Fotograf und hat diese Karte gebaut.',
  'about.builtTitle': 'Woraus es gebaut ist',
  'about.built':
    'Linienwege und Haltestellen aus OpenStreetMap, Abfahrten aus dem deutschlandweiten GTFS-Feed (gtfs.de / DELFI), Gelände aus den offenen 1-m-Höhenmodellen der Länder über Mapterhorn, die Stadt selbst aus Googles fotorealistischen 3D-Kacheln über CesiumJS, Wetter von Open-Meteo, Schiffe von aisstream.io, Webcams von Windy. Die Lizenzen stehen in der Nachweiszeile am unteren Kartenrand.',
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
}

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, de }

/**
 * Picks the UI language: an explicit ?lang= override wins, otherwise the
 * first entry in the browser's preference list that matches a supported
 * language decides (so "fr, de" gives German, "en-US, de" stays English).
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
    : new URLSearchParams(window.location.search).get('lang'),
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

/** Label key per transit mode – shared by the line panel and the vehicle card. */
export const MODE_KEY: Record<TransitMode, MessageKey> = {
  tram: 'mode.tram',
  subway: 'mode.subway',
  train: 'mode.train',
  bus: 'mode.bus',
  ferry: 'mode.ferry',
}
