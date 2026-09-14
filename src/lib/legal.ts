/**
 * The two pages the law asks a German website for: the legal notice
 * (§ 5 DDG, § 18 (2) MStV) and the privacy notice (Art. 13 GDPR). They
 * are read in two places from one text – the LegalDialog inside the app
 * and the static page under it (lib/site-pages.ts), which is what a
 * crawler and a browser without WebGL get – so the text lives here, in
 * both languages, as plain sections rather than as JSX or HTML.
 *
 * What the privacy notice says has to stay true to what the app does:
 * which hosts the browser talks to itself (Google's tiles through Cesium
 * ion, Open-Meteo, Windy's pictures), which it reaches only through this
 * site's own API (aisstream, adsb.fi, gtfs.de), what it keeps in
 * localStorage, and that there are no cookies and no tracking. A new
 * third-party request from the browser, a cookie or an analytics script
 * is a change to this file as much as to the code.
 *
 * The German text is the binding one; the English one says so. The
 * provider's details are one record at the top, used by both notices.
 */

import type { Lang } from './i18n'
import type { LegalKind } from './site-path'

/** Who runs the site – the one place these details are written. */
export const OPERATOR = {
  name: 'Mario Meyer',
  street: 'August-Bebel-Str. 36',
  place: '18055 Rostock, Germany',
  email: 'mail [@] lampenbauer [Punkt] com',
} as const

/** A heading and the paragraphs under it; a paragraph may hold line breaks (an address). */
export interface LegalSection {
  heading: string
  paragraphs: readonly string[]
}

export interface LegalText {
  title: string
  /** One sentence under the title – the dialog's description, the page's lead. */
  lead: string
  sections: readonly LegalSection[]
}

/** The provider as an address block, one line each. */
const ADDRESS = `${OPERATOR.name}\n${OPERATOR.street}\n${OPERATOR.place}`

const IMPRINT: Record<Lang, LegalText> = {
  de: {
    title: 'Impressum',
    lead: 'Angaben gemäß § 5 DDG und § 18 Abs. 2 MStV.',
    sections: [
      { heading: 'Anbieter', paragraphs: [ADDRESS] },
      { heading: 'Kontakt', paragraphs: [`E-Mail: ${OPERATOR.email}`] },
      { heading: 'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV', paragraphs: [ADDRESS] },
      {
        heading: 'Haftung für Inhalte und Links',
        paragraphs: [
          'Die Inhalte dieser Seite wurden mit Sorgfalt erstellt. Was die Karte zeigt, stammt aus den am unteren Kartenrand genannten Quellen – für Richtigkeit, Vollständigkeit und Aktualität dieser Daten übernehme ich keine Gewähr. Diese Seite ist kein Fahrplan: Für deine nächste Verbindung nutze bitte die App deines Verkehrsbetriebs.',
          'Für die Inhalte verlinkter Seiten sind deren Betreiber verantwortlich. Zum Zeitpunkt der Verlinkung waren dort keine Rechtsverstöße erkennbar; werden mir welche bekannt, entferne ich den Link.',
        ],
      },
    ],
  },
  en: {
    title: 'Legal notice',
    lead: 'Provider details as German law requires them (§ 5 DDG, § 18 (2) MStV).',
    sections: [
      { heading: 'Provider', paragraphs: [ADDRESS] },
      { heading: 'Contact', paragraphs: [`Email: ${OPERATOR.email}`] },
      { heading: 'Responsible for the content under § 18 (2) MStV', paragraphs: [ADDRESS] },
      {
        heading: 'Liability for content and links',
        paragraphs: [
          'The content of this site was put together with care. What the map shows comes from the sources credited at the bottom of the map – I make no guarantee that these data are correct, complete or current. This site is not a timetable: for your next connection, please use your transport operator’s app.',
          'The operators of linked sites are responsible for their content. No infringements were apparent there when the links were set; should I learn of any, I will remove the link.',
        ],
      },
      {
        heading: 'Language',
        paragraphs: ['This is a translation for convenience. The German version is the binding one.'],
      },
    ],
  },
}

const PRIVACY: Record<Lang, LegalText> = {
  de: {
    title: 'Datenschutz',
    lead: 'Was beim Besuch dieser Seite verarbeitet wird, und wohin es geht.',
    sections: [
      { heading: 'Verantwortlicher', paragraphs: [`${ADDRESS}\nE-Mail: ${OPERATOR.email}`] },
      {
        heading: 'Kurz gesagt',
        paragraphs: [
          'Diese Seite setzt keine Cookies, hat kein Tracking, keine Analyse-Skripte, keine Werbung und kein Konto. Was sie verarbeitet, ergibt sich aus dem, was eine Karte im Browser braucht: Der Server, der sie ausliefert, sieht deine IP-Adresse und behält sie nur gekürzt – und die Dienste, von denen die Karte ihre Stadtmodelle, das Wetter und die Webcam-Bilder holt, sehen sie ebenfalls. Alles Weitere steht unten.',
        ],
      },
      {
        heading: 'Hosting und Server-Logfiles',
        paragraphs: [
          'Die Seite wird bei ALL-INKL.COM – Neue Medien Münnich, Hauptstraße 68, 02742 Friedersdorf, gehostet. Bei jedem Aufruf schreibt der Server in seine Logfiles die IP-Adresse deines Geräts – gekürzt um ihre letzten beiden Stellen, aus 11.22.33.44 wird 11.22.0.0, sodass sie sich keinem Anschluss mehr zuordnen lässt –, Datum und Uhrzeit, die aufgerufene Adresse, die übertragene Datenmenge, die zuvor besuchte Seite (Referrer) und den verwendeten Browser (User-Agent). Die Logfiles braucht es, um den Betrieb abzusichern und Fehler zu finden; sie werden nach 90 Tagen gelöscht und mit keinen anderen Daten zusammengeführt.',
          'Aus den Logfiles erstellt der Hoster eine zusammengefasste Zugriffsstatistik – Seitenaufrufe je Tag, Browser, Herkunftsseiten –, die nur die gekürzten Adressen kennt und niemanden einzeln ausweist.',
          'Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO – mein berechtigtes Interesse an einem sicheren und funktionierenden Betrieb. Mit dem Hoster besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO.',
        ],
      },
      {
        heading: 'Stadtmodelle von Google und Cesium',
        paragraphs: [
          'Das 3D-Stadtmodell sind Googles Photorealistic 3D Tiles. Dein Browser lädt sie unmittelbar von Google (Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland, und Google LLC, USA); dabei erhält Google deine IP-Adresse und die Adressen der angefragten Kacheln – also welchen Ausschnitt der Stadt du gerade ansiehst. Vermittelt werden die Kacheln über Cesium ion (Bentley Systems, Inc., 685 Stockton Drive, Exton, PA 19341, USA), das Werkzeug, mit dem die Karte gezeichnet wird; auch Cesium sieht dabei deine IP-Adresse.',
          'Ohne diese Daten gibt es keine Karte – sie sind der Dienst selbst, nicht eine Zutat zu ihm. Rechtsgrundlage ist deshalb Art. 6 Abs. 1 lit. f DSGVO, das berechtigte Interesse, die Karte zu zeigen, um die du diese Seite aufgerufen hast. Beide Anbieter übertragen Daten in die USA; Google LLC ist unter dem EU-US Data Privacy Framework zertifiziert (Art. 45 DSGVO), im Übrigen sichern Standardvertragsklauseln (Art. 46 DSGVO) die Übermittlung ab. Mehr dazu unter policies.google.com/privacy und cesium.com/legal/privacy-policy.',
        ],
      },
      {
        heading: 'Wetter',
        paragraphs: [
          'Das Wetter über der Stadt – Regen, Bewölkung, Wind, Sicht – kommt von Open-Meteo (open-meteo.com, Schweiz). Dein Browser fragt es alle zehn Minuten unmittelbar dort ab; übertragen werden dabei deine IP-Adresse und die Koordinaten der Stadt, nicht deine eigenen. Die Schweiz gilt nach Art. 45 DSGVO als sicheres Drittland. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO.',
        ],
      },
      {
        heading: 'Webcams',
        paragraphs: [
          'Die Webcam-Bilder auf der Karte stammen von Windy (Windyty, SE, Prag, Tschechien). Welche Kameras es in einer Stadt gibt, fragt mein Server für dich ab; das Vorschaubild jeder Kamera lädt dein Browser aber unmittelbar von Windys Servern, die dabei deine IP-Adresse sehen. Die Webcams lassen sich in den Ebenen der Karte abschalten – dann wird kein Bild geladen. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO.',
        ],
      },
      {
        heading: 'Schiffe, Flugzeuge, Fahrpläne',
        paragraphs: [
          'Die Positionen der Schiffe (AIS) und der Flugzeuge (ADS-B) sowie die Fahrpläne und Verspätungen holt mein eigener Server bei aisstream.io, adsb.fi und gtfs.de – dein Browser spricht dafür nur mit minigermany3d.com. An diese Dienste geht nichts über dich; deine IP-Adresse erscheint dort nicht.',
        ],
      },
      {
        heading: 'Was dein Browser sich merkt',
        paragraphs: [
          'Die Seite legt keine Cookies an. Sie merkt sich im Speicher deines Browsers (localStorage) zwei Dinge: die zuletzt gewählte Stadt und ob du die Willkommensansicht beim nächsten Besuch wieder sehen möchtest. Diese Werte bleiben auf deinem Gerät, werden an niemanden übertragen und lassen sich über die Einstellungen deines Browsers löschen. Gespeichert wird nur, was du an der Seite selbst eingestellt hast (§ 25 Abs. 2 Nr. 2 TDDDG).',
        ],
      },
      {
        heading: 'Links zu anderen Seiten',
        paragraphs: [
          'Die Links zu anderen Seiten – zu den Datenquellen, den Webcam-Seiten, meinen eigenen – sind gewöhnliche Links: Es wird nichts von dort geladen, bevor du einen davon anklickst. Für die Verarbeitung dort gelten die Datenschutzhinweise der jeweiligen Seite.',
        ],
      },
      {
        heading: 'Deine Rechte',
        paragraphs: [
          'Du hast nach der DSGVO das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18) und Datenübertragbarkeit (Art. 20) sowie das Recht, einer Verarbeitung auf Grundlage berechtigter Interessen zu widersprechen (Art. 21). Schreib mir dafür an die oben genannte Adresse. Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77), etwa bei der für deinen Wohnort zuständigen.',
          'Nichts auf dieser Seite wird zu Profilen zusammengeführt oder automatisiert entschieden.',
        ],
      },
    ],
  },
  en: {
    title: 'Privacy',
    lead: 'What is processed when you visit this site, and where it goes.',
    sections: [
      { heading: 'Controller', paragraphs: [`${ADDRESS}\nEmail: ${OPERATOR.email}`] },
      {
        heading: 'In short',
        paragraphs: [
          'This site sets no cookies and has no tracking, no analytics scripts, no advertising and no accounts. What it processes follows from what a map in a browser needs: the server that delivers it sees your IP address and keeps it only shortened – and the services the map fetches its city models, the weather and the webcam pictures from see it too. Everything else is below.',
        ],
      },
      {
        heading: 'Hosting and server logs',
        paragraphs: [
          'The site is hosted by ALL-INKL.COM – Neue Medien Münnich, Hauptstraße 68, 02742 Friedersdorf, Germany. On every request the server writes to its log files the IP address of your device – shortened by its last two parts, 11.22.33.44 becomes 11.22.0.0, so that it can no longer be traced to a connection –, the date and time, the address requested, the amount of data transferred, the page you came from (referrer) and the browser you use (user agent). The log files are needed to keep the site secure and to find faults; they are deleted after 90 days and never combined with other data.',
          'From the log files the host builds an aggregated access statistic – page views per day, browsers, referring sites – which knows only the shortened addresses and singles out nobody.',
          'The legal basis is Art. 6 (1) (f) GDPR – my legitimate interest in a secure and working site. A data processing agreement under Art. 28 GDPR is in place with the host.',
        ],
      },
      {
        heading: 'City models from Google and Cesium',
        paragraphs: [
          'The 3D city model is Google’s Photorealistic 3D Tiles. Your browser loads them directly from Google (Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland, and Google LLC, USA); Google receives your IP address and the addresses of the tiles requested – that is, which part of the city you are looking at. The tiles are brokered by Cesium ion (Bentley Systems, Inc., 685 Stockton Drive, Exton, PA 19341, USA), the tool the map is drawn with; Cesium sees your IP address too.',
          'Without these data there is no map – they are the service itself, not an ingredient of it. The legal basis is therefore Art. 6 (1) (f) GDPR, the legitimate interest in showing the map you opened this site for. Both providers transfer data to the USA; Google LLC is certified under the EU-US Data Privacy Framework (Art. 45 GDPR), and standard contractual clauses (Art. 46 GDPR) cover the rest. More at policies.google.com/privacy and cesium.com/legal/privacy-policy.',
        ],
      },
      {
        heading: 'Weather',
        paragraphs: [
          'The weather over the city – rain, cloud cover, wind, visibility – comes from Open-Meteo (open-meteo.com, Switzerland). Your browser asks it directly every ten minutes; what is transferred is your IP address and the coordinates of the city, not your own. Switzerland is recognised as a safe third country under Art. 45 GDPR. Legal basis: Art. 6 (1) (f) GDPR.',
        ],
      },
      {
        heading: 'Webcams',
        paragraphs: [
          'The webcam pictures on the map come from Windy (Windyty, SE, Prague, Czechia). Which cameras a city has, my server asks on your behalf; each camera’s preview picture, though, your browser loads directly from Windy’s servers, which see your IP address as it does. The webcams can be switched off in the map’s layers – no picture is loaded then. Legal basis: Art. 6 (1) (f) GDPR.',
        ],
      },
      {
        heading: 'Ships, aircraft, timetables',
        paragraphs: [
          'The positions of the ships (AIS) and the aircraft (ADS-B), the timetables and the delays are fetched by my own server from aisstream.io, adsb.fi and gtfs.de – your browser talks only to minigermany3d.com for them. Nothing about you goes to these services; your IP address does not appear there.',
        ],
      },
      {
        heading: 'What your browser remembers',
        paragraphs: [
          'The site sets no cookies. It keeps two things in your browser’s storage (localStorage): the city you chose last, and whether you want to see the welcome screen again on your next visit. These values stay on your device, are sent to nobody and can be removed through your browser’s settings. Only what you set on the site yourself is stored (§ 25 (2) no. 2 TDDDG).',
        ],
      },
      {
        heading: 'Links to other sites',
        paragraphs: [
          'The links to other sites – to the data sources, the webcam pages, my own – are ordinary links: nothing is loaded from there before you click one. The privacy notice of the respective site applies to what happens there.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          'Under the GDPR you have the right of access (Art. 15), to rectification (Art. 16), to erasure (Art. 17), to restriction of processing (Art. 18) and to data portability (Art. 20), and the right to object to processing based on legitimate interests (Art. 21). Write to me at the address above for any of them. You can also lodge a complaint with a data protection supervisory authority (Art. 77), for instance the one responsible for where you live.',
          'Nothing on this site is combined into profiles or decided automatically.',
        ],
      },
      {
        heading: 'Language',
        paragraphs: ['This is a translation for convenience. The German version is the binding one.'],
      },
    ],
  },
}

/** The text of a legal page in a language. */
export function legalText(kind: LegalKind, lang: Lang): LegalText {
  return (kind === 'imprint' ? IMPRINT : PRIVACY)[lang]
}
