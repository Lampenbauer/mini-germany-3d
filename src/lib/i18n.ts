/**
 * Minimal i18n: English is the default; German is used when the browser's
 * preferred languages rank German first among the supported ones (or when
 * the ?lang= URL override says so). Two locales and a flat message table –
 * no library needed.
 */

export type Lang = 'en' | 'de'

const en = {
  // Control panel
  'panel.expand': 'Expand panel',
  'panel.collapse': 'Collapse panel',
  'sim.pause': 'Pause simulation',
  'sim.resume': 'Resume simulation',
  'sim.setTime': 'Set simulation time',
  'sim.now': 'Now',
  'sim.timeLapse': 'Time-lapse',
  'layers.title': 'Layers',
  'layers.routes': 'Routes',
  'layers.stops': 'Stops',
  'layers.labels': 'Vehicle labels',
  'layers.showRoutes': 'Show routes',
  'layers.showStops': 'Show stops',
  'layers.showLabels': 'Show vehicle and ship labels',
  'lines.title': 'Lines',
  'lines.showAll': 'Show all {mode} lines',
  'lines.flyTo': 'Fly to {name}',
  'lines.show': 'Show {name}',
  'mode.tram': 'Tram',
  'mode.train': 'S-Bahn',
  'mode.bus': 'Bus',
  'mode.ferry': 'Ferry',
  'status.loadingTiles': 'Loading 3D tiles…',
  'status.offline': 'Offline mode',
  'status.tilesFailed': '3D tiles unavailable',
  'status.demoData': 'Demo data (approximated)',
  'count.vehicles': '{count} vehicles in service',
  'count.vehicle': '{count} vehicle in service',
  'count.trams': '{count} trams in service',
  'count.tram': '{count} tram in service',
  'rt.live': 'GTFS-RT · {count} live',
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
  'camera.toUnderground': 'Show underground view',
  'camera.toSurface': 'Back to the surface view',
  'camera.to2d': 'Switch to 2D view',
  'camera.to3d': 'Switch to 3D view',
  'camera.faceNorth': 'Face north',
  'camera.reset': 'Reset camera',
} as const

export type MessageKey = keyof typeof en

const de: Record<MessageKey, string> = {
  'panel.expand': 'Panel ausklappen',
  'panel.collapse': 'Panel einklappen',
  'sim.pause': 'Simulation pausieren',
  'sim.resume': 'Simulation fortsetzen',
  'sim.setTime': 'Simulationszeit einstellen',
  'sim.now': 'Jetzt',
  'sim.timeLapse': 'Zeitraffer',
  'layers.title': 'Ebenen',
  'layers.routes': 'Routen',
  'layers.stops': 'Haltestellen',
  'layers.labels': 'Fahrzeugbeschriftungen',
  'layers.showRoutes': 'Routen anzeigen',
  'layers.showStops': 'Haltestellen anzeigen',
  'layers.showLabels': 'Fahrzeug- und Schiffsbeschriftungen anzeigen',
  'lines.title': 'Linien',
  'lines.showAll': 'Alle {mode}-Linien anzeigen',
  'lines.flyTo': 'Zu {name} fliegen',
  'lines.show': '{name} anzeigen',
  'mode.tram': 'Straßenbahn',
  'mode.train': 'S-Bahn',
  'mode.bus': 'Bus',
  'mode.ferry': 'Fähre',
  'status.loadingTiles': '3D-Kacheln laden…',
  'status.offline': 'Offline-Modus',
  'status.tilesFailed': '3D-Kacheln nicht verfügbar',
  'status.demoData': 'Demo-Daten (approximiert)',
  'count.vehicles': '{count} Fahrzeuge im Einsatz',
  'count.vehicle': '{count} Fahrzeug im Einsatz',
  'count.trams': '{count} Straßenbahnen im Einsatz',
  'count.tram': '{count} Straßenbahn im Einsatz',
  'rt.live': 'GTFS-RT · {count} live',
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
  'camera.toUnderground': 'Untergrund-Ansicht zeigen',
  'camera.toSurface': 'Zurück zur normalen Ansicht',
  'camera.to2d': 'Zur 2D-Ansicht wechseln',
  'camera.to3d': 'Zur 3D-Ansicht wechseln',
  'camera.faceNorth': 'Nach Norden ausrichten',
  'camera.reset': 'Kamera zurücksetzen',
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
 * "Ferry Kabutzenhof – Gehlsdorf") – German swaps the generic prefix.
 * "Bus 22" and "S-Bahn S1" read the same in both languages.
 */
export function localizeLineName(name: string): string {
  if (lang !== 'de') return name
  return name.replace(/^Line /, 'Linie ').replace(/^Ferry /, 'Fähre ')
}

/** Label key per transit mode – shared by the line panel and the vehicle card. */
export const MODE_KEY: Record<'tram' | 'train' | 'bus' | 'ferry', MessageKey> = {
  tram: 'mode.tram',
  train: 'mode.train',
  bus: 'mode.bus',
  ferry: 'mode.ferry',
}
