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
  'layers.showRoutes': 'Show routes',
  'layers.showStops': 'Show stops',
  'lines.title': 'Lines',
  'lines.showAll': 'Show all {mode} lines',
  'lines.zoomTo': 'Zoom to {name}',
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
  'vehicle.trip': 'Trip',
  'vehicle.close': 'Close selection',
  'vehicle.moving': 'Moving',
  'vehicle.atStop': 'At stop',
  'vehicle.atPier': 'At pier',
  'vehicle.inTunnel': 'in tunnel',
  'vehicle.onTime': 'on time',
  'vehicle.onSchedule': 'On schedule',
  'follow.tram': 'Follow tram',
  'follow.train': 'Follow train',
  'follow.bus': 'Follow bus',
  'follow.ferry': 'Follow ferry',
  'follow.stop': 'Stop following',
  // Map controls
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
  'layers.showRoutes': 'Routen anzeigen',
  'layers.showStops': 'Haltestellen anzeigen',
  'lines.title': 'Linien',
  'lines.showAll': 'Alle {mode}-Linien anzeigen',
  'lines.zoomTo': 'Auf {name} zoomen',
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
  'vehicle.trip': 'Fahrt',
  'vehicle.close': 'Auswahl schließen',
  'vehicle.moving': 'In Fahrt',
  'vehicle.atStop': 'An Haltestelle',
  'vehicle.atPier': 'Am Anleger',
  'vehicle.inTunnel': 'im Tunnel',
  'vehicle.onTime': 'pünktlich',
  'vehicle.onSchedule': 'Nach Fahrplan',
  'follow.tram': 'Straßenbahn folgen',
  'follow.train': 'S-Bahn folgen',
  'follow.bus': 'Bus folgen',
  'follow.ferry': 'Fähre folgen',
  'follow.stop': 'Nicht mehr folgen',
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
