/**
 * Extraction and state keeping for the ADS-B feed: folds the aircraft
 * list adsb.fi's open data API answers with (readsb's aircraft.json
 * shape – the same one ADS-B Exchange, airplanes.live and adsb.lol
 * speak) into one record per ICAO address – latest fields for the
 * list, plus a short position TRACK per aircraft.
 *
 * The track is here for the same reason the ships have one (see
 * ais-extract.ts): the app does not render the feed live but plays it
 * back AIRCRAFT_PLAYBACK_DELAY_MS behind the wall clock and interpolates
 * BETWEEN recorded fixes. The delay is short – a transponder reports
 * every second and the endpoint is polled every few seconds, so twelve
 * seconds cover the pipeline several times over – and, unlike a ship,
 * an aircraft is reckoned AHEAD of its last fix for a while when the
 * next one is late: a ship that stalls waits at a quay, an airliner that
 * stalls hangs in the sky, which is the worse picture. The reckoning is
 * bounded (AIRCRAFT_RECKON_MAX_MS), so a transponder that fell silent
 * freezes rather than flying on into the ground.
 *
 * Used by the Vite dev middleware (vite.config.ts) and the unit tests;
 * in production server/api/aircraft.php does the same job in PHP – the
 * parity test (scripts/test-aircraft-parity.mjs) holds both to the same
 * fixture.
 */

/**
 * One recorded fix: [unix ms, lat, lon, altitude m, ground speed kn,
 * track °, vertical rate m/s, true heading °, geometric] – kinematics as
 * of that moment, nulls as in the record. The altitude is the geometric
 * one where the aircraft reports it and the pressure altitude otherwise
 * (see Aircraft.altGeomM for what the layer does about the difference),
 * and the last element says which: true for the geometric one. Null on
 * the ground. The kind rides with the fix because the record cannot
 * tell it: an aircraft that reports the ground reports no altitude of
 * either kind, while the playback, a few seconds behind, is still on
 * its approach – read off the record, those fixes were taken for
 * pressure altitudes and lifted by the geoid height, and every landing
 * hovered some forty metres over the runway until the playback reached
 * the ground. The heading is where the nose points and is
 * played back on its own arc (aircraftPlaybackSample): on the apron it
 * is the only direction most aircraft report – the surface position
 * message carries it and no track – and the one that stands while a
 * pushback moves the aircraft backwards. Both are absent on points a
 * state file wrote before they existed: the heading reads as null, the
 * kind as the record's (see aircraftPlaybackSample).
 */
export type AircraftTrackPoint = [
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  (number | null)?,
  (boolean | null)?,
]

/** One tracked aircraft, as the feed last reported it. */
export interface Aircraft {
  /** ICAO 24-bit address as six lower-case hex digits (a '~' prefix marks a non-ICAO id). */
  hex: string
  /** Trimmed flight identification (the callsign), '' when none is broadcast. */
  callsign: string
  /** Registration ("D-AIMB"), '' unless the feed's database knows it. */
  registration: string
  /** ICAO type designator ("A388"), '' unless known. */
  typeCode: string
  /** The type spelled out ("AIRBUS A-380-800"), '' unless known. */
  description: string
  /** ADS-B emitter category ("A3" large, "A5" heavy, "A7" rotorcraft …), '' unless broadcast. */
  category: string
  lat: number
  lon: number
  /**
   * Geometric altitude in metres above the WGS84 ellipsoid – GNSS
   * height, which is what Cesium wants. null on the ground and for the
   * many aircraft that broadcast only the pressure altitude.
   */
  altGeomM: number | null
  /**
   * Pressure altitude in metres (the 1013.25 hPa reference every
   * transponder reports) – the flight level's own number, and what
   * stands in for the geometric altitude where that is missing: the
   * layer lifts it by what the aircraft reporting both measure at that
   * height (see pressureLift) – the geoid height and the day's pressure,
   * 200 m at Frankfurt's runway at about 1032 hPa – or by the geoid
   * height alone where too few do. null on the ground.
   */
  altBaroM: number | null
  /** The transponder says the aircraft is on the ground (alt_baro "ground"). */
  onGround: boolean
  gsKn: number | null
  /** Track over the ground in degrees – the direction of motion. */
  trackDeg: number | null
  /** True heading in degrees where reported – the nose, which crabs into the wind. */
  headingDeg: number | null
  /** Rate of climb in m/s, negative descending; null unreported. */
  verticalRateMps: number | null
  /** Bank angle in degrees where reported (Mode S EHS), positive right wing down. */
  rollDeg: number | null
  squawk: string
  /** 'adsb' for a transponder's own position, 'mlat' for a multilaterated one, 'other' for the rest (TIS-B, ADS-R). */
  source: 'adsb' | 'mlat' | 'other'
  /** Unix ms of the position last heard. */
  positionAt: number
  /** Recent fixes, oldest first – the playback interpolates these. */
  track: AircraftTrackPoint[]
}

/** Aircraft drop out of the LIST after this long without a position. */
export const AIRCRAFT_EXPIRE_MS = 60_000
/**
 * How long a record survives in the STATE beyond its last position –
 * the track's memory across a short gap in coverage. Nothing static is
 * worth keeping longer: every entry the feed sends carries the type and
 * the registration again.
 */
export const AIRCRAFT_STATE_KEEP_MS = 180_000
/**
 * How far behind the wall clock the app renders the traffic. The
 * endpoint refreshes every few seconds and the app polls it every five,
 * so a fix is at most ten seconds old when it lands; twelve leaves the
 * playback between two known fixes nearly always, and the reckoning
 * below covers the rest.
 */
export const AIRCRAFT_PLAYBACK_DELAY_MS = 12_000
/**
 * How long past its last fix an aircraft is flown on by dead reckoning
 * before it freezes. A transponder that goes quiet for longer has left
 * coverage – behind a hill on approach, or out of the feeders' reach –
 * and an aircraft flown on from stale numbers ends up in a building.
 */
export const AIRCRAFT_RECKON_MAX_MS = 20_000
/** Track points older than this are pruned from the state. */
export const AIRCRAFT_TRACK_KEEP_MS = 180_000
/** Hard cap per aircraft – a runaway backstop. */
export const AIRCRAFT_TRACK_MAX_POINTS = 60

/** The largest radius adsb.fi answers for, in nautical miles. */
export const ADSB_MAX_DIST_NM = 250
/**
 * How far beyond the box's corners the sky is served, in nautical miles.
 * The sky does not end at the city's edge the way the network does: an
 * aircraft followed to the box's edge is watched from there as it flies
 * on (see FollowCamera), and for that it has to stay on the map a while
 * longer – six miles is a minute at cruise. The camera's leash is the
 * box as ever; only the traffic reaches further.
 */
export const AIRCRAFT_MARGIN_NM = 6

const METERS_PER_NM = 1852

/** Great-circle distance in metres between two points, as both twins compute it. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a))
}

/** The circle a city's sky is asked for and served from: its centre and radius in nautical miles. */
export interface AdsbQuery {
  lat: number
  lon: number
  distNm: number
}

/**
 * The circle adsb.fi is asked for, and the one the endpoint serves: the
 * box's centre, and the distance to its corner plus AIRCRAFT_MARGIN_NM
 * in whole nautical miles – the whole box and a margin round it (mirror
 * of mg3d_aircraft_query in server/api/aircraft.php – the parity test
 * compares the two).
 */
export function adsbQuery(box: { west: number; south: number; east: number; north: number }): AdsbQuery {
  const lat = (box.south + box.north) / 2
  const lon = (box.west + box.east) / 2
  const meters = haversineMeters(lat, lon, box.north, box.east)
  // Ten-thousandths, rounded the way PHP rounds them (floor(x * 1e4 + 0.5)
  // there too): toFixed and round() disagree on the halves.
  const tenThousandths = (value: number) => Math.floor(value * 10_000 + 0.5) / 10_000
  return {
    lat: tenThousandths(lat),
    lon: tenThousandths(lon),
    distNm: Math.min(ADSB_MAX_DIST_NM, Math.ceil(meters / METERS_PER_NM) + AIRCRAFT_MARGIN_NM),
  }
}

/** Whether a position lies inside the circle a city's sky is served from (mirror of mg3d_aircraft_within). */
export function withinQuery(lat: number, lon: number, query: AdsbQuery): boolean {
  return haversineMeters(query.lat, query.lon, lat, lon) <= query.distNm * METERS_PER_NM
}

/** Feet to metres, and feet per minute to metres per second. */
const METERS_PER_FOOT = 0.3048
const MPS_PER_FPM = METERS_PER_FOOT / 60
const METERS_PER_DEGREE_LATITUDE = 111_320
const KNOT_MPS = 0.514444

/** The subset of a readsb aircraft entry the extraction reads. */
export interface AdsbRawAircraft {
  hex?: string
  type?: string
  flight?: string
  r?: string
  t?: string
  desc?: string
  category?: string
  alt_baro?: number | 'ground'
  alt_geom?: number
  gs?: number
  track?: number
  true_heading?: number
  baro_rate?: number
  geom_rate?: number
  roll?: number
  squawk?: string
  lat?: number
  lon?: number
  /** Seconds since the position was last heard. */
  seen_pos?: number
}

/** The subset of the API answer the extraction reads. */
export interface AdsbRawResponse {
  ac?: AdsbRawAircraft[]
}

export type AircraftState = Map<string, Aircraft>

/**
 * Tenths, rounded the same way in PHP (floor(x * 10 + 0.5) / 10 there
 * too): Math.round and PHP's round() disagree on negative halves, and a
 * descent rate is negative.
 */
function tenths(value: number): number {
  return Math.floor(value * 10 + 0.5) / 10
}

/** A finite number from the feed, or null – the feed leaves fields out rather than nulling them. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Folds one raw aircraft entry into the state, its position stamped
 * `positionAt` (the poll's own clock minus the entry's seen_pos – the
 * feed's clock is not trusted against ours). Entries without an address
 * or a position contribute nothing, and so do the surface vehicles and
 * obstacles of category C: a follow-me car is not an aircraft, and the
 * map has no body for it. A fix no newer than the last one recorded
 * refreshes the static fields and nothing else – a poll that answers
 * with the same fix twice must not add a second track point.
 */
export function mergeAdsbAircraft(state: AircraftState, raw: AdsbRawAircraft, positionAt: number): void {
  const hex = str(raw.hex).toLowerCase()
  if (!/^~?[0-9a-f]{6}$/.test(hex)) return
  const lat = num(raw.lat)
  const lon = num(raw.lon)
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return
  const category = str(raw.category).toUpperCase()
  if (category.startsWith('C')) return

  const aircraft: Aircraft = state.get(hex) ?? {
    hex,
    callsign: '',
    registration: '',
    typeCode: '',
    description: '',
    category: '',
    lat: NaN,
    lon: NaN,
    altGeomM: null,
    altBaroM: null,
    onGround: false,
    gsKn: null,
    trackDeg: null,
    headingDeg: null,
    verticalRateMps: null,
    rollDeg: null,
    squawk: '',
    source: 'other',
    positionAt: 0,
    track: [],
  }

  // Static data: whatever the entry carries; an entry that dropped a
  // field (a callsign between flights) keeps what the record had.
  aircraft.callsign = str(raw.flight) || aircraft.callsign
  aircraft.registration = str(raw.r) || aircraft.registration
  aircraft.typeCode = str(raw.t).toUpperCase() || aircraft.typeCode
  aircraft.description = str(raw.desc) || aircraft.description
  aircraft.category = category || aircraft.category
  aircraft.squawk = str(raw.squawk) || aircraft.squawk
  const source = str(raw.type)
  aircraft.source = source.startsWith('adsb') ? 'adsb' : source.startsWith('mlat') ? 'mlat' : 'other'

  if (positionAt <= aircraft.positionAt) {
    if (Number.isFinite(aircraft.lat)) state.set(hex, aircraft)
    return
  }

  aircraft.lat = lat
  aircraft.lon = lon
  aircraft.positionAt = positionAt
  aircraft.onGround = raw.alt_baro === 'ground'
  const altBaro = aircraft.onGround ? null : num(raw.alt_baro)
  const altGeom = aircraft.onGround ? null : num(raw.alt_geom)
  aircraft.altBaroM = altBaro === null ? null : tenths(altBaro * METERS_PER_FOOT)
  aircraft.altGeomM = altGeom === null ? null : tenths(altGeom * METERS_PER_FOOT)
  aircraft.gsKn = num(raw.gs)
  aircraft.trackDeg = num(raw.track)
  aircraft.headingDeg = num(raw.true_heading)
  const rate = num(raw.geom_rate) ?? num(raw.baro_rate)
  aircraft.verticalRateMps = rate === null ? null : tenths(rate * MPS_PER_FPM)
  aircraft.rollDeg = num(raw.roll)

  aircraft.track.push([
    positionAt,
    lat,
    lon,
    aircraft.altGeomM ?? aircraft.altBaroM,
    aircraft.gsKn,
    aircraft.trackDeg,
    aircraft.verticalRateMps,
    aircraft.headingDeg,
    aircraft.altGeomM !== null,
  ])
  aircraft.track = aircraft.track
    .filter((p) => positionAt - p[0] <= AIRCRAFT_TRACK_KEEP_MS)
    .slice(-AIRCRAFT_TRACK_MAX_POINTS)
  state.set(hex, aircraft)
}

/**
 * Folds one poll's answer into the state. Every entry's position is as
 * old as its seen_pos says, measured from `nowMs` – the moment the
 * answer arrived – so a fix heard a second before the poll is stamped a
 * second before it, whatever clock the feed keeps.
 */
export function mergeAdsbResponse(state: AircraftState, raw: AdsbRawResponse, nowMs: number): void {
  for (const entry of Array.isArray(raw.ac) ? raw.ac : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const seenPos = num(entry.seen_pos) ?? 0
    mergeAdsbAircraft(state, entry, nowMs - Math.floor(seenPos * 1000 + 0.5))
  }
}

/**
 * The state as a serializable list: only aircraft with a fresh position,
 * sorted by address so the dev middleware, the PHP twin and the fixtures
 * agree byte for byte. Records whose position merely went stale stay in
 * the state as memory – their track survives a short gap in coverage –
 * until AIRCRAFT_STATE_KEEP_MS closes the book.
 */
export function aircraftStateList(state: AircraftState, nowMs: number): Aircraft[] {
  const list: Aircraft[] = []
  for (const [hex, aircraft] of state) {
    const age = nowMs - aircraft.positionAt
    if (age > AIRCRAFT_STATE_KEEP_MS) {
      state.delete(hex)
      continue
    }
    if (age > AIRCRAFT_EXPIRE_MS) continue
    list.push(aircraft)
  }
  return list.sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0))
}

/** What the playback knows about an aircraft at one rendered instant. */
export interface AircraftPlaybackSample {
  lon: number
  lat: number
  /**
   * Altitude on the geometric altitude's scale: a fix's geometric
   * altitude as it is, a pressure altitude lifted by what the caller
   * gives (see aircraftPlaybackSample); null on the ground. Between the
   * last fix in the air and the first on the ground it is the airborne
   * fix's, carried on down at its vertical rate – and back from the
   * first fix in the air at its rate, lifting off – which may well reach
   * below the ground: see groundShare for where it stops.
   */
  altM: number | null
  /**
   * Whether altM comes from fixes that report the geometric altitude –
   * the nearer of the two where their kinds differ, the airborne one
   * between the air and the ground; false on the ground. The card shows
   * the altitude as the transponder reports it, and needs to know which.
   */
  altGeometric: boolean
  /**
   * How much of the ground is in the height drawn: 0 in the air, 1 on
   * the ground, and across the segment from the last fix in the air to
   * the first on the ground the share of it played (lifting off, the
   * share still to come). The layer blends from altM toward the apron
   * by this share and never draws the aircraft below the apron, so a
   * landing comes down onto the runway at its own rate and rolls there,
   * and arrives on it by the first fix on the ground at the latest –
   * where before it held the last altitude reported in the
   * air and dropped onto the runway at the first fix on the ground, the
   * length of the segment later (seconds live, a minute where the
   * feeders lose an aircraft at the runway's height).
   */
  groundShare: number
  /** Direction of motion in degrees – what the chase camera looks along. */
  bearingDeg: number
  /**
   * Where the nose points, in degrees – the pose drawn: the true heading
   * where the aircraft reports one (crabbed off the track in the air,
   * standing while a pushback moves it backwards on the ground), the
   * direction of motion otherwise.
   */
  noseDeg: number
  gsKn: number | null
  verticalRateMps: number | null
  /** How fast the track is turning, degrees per second (0 where it cannot be told). */
  turnRateDegPerS: number
  /**
   * True while the sample sits inside a segment with real movement or
   * inside the reckoning window of a moving aircraft – the layer's render
   * pacing keys on this, stable across ticks.
   */
  moving: boolean
  /** The sample is reckoned past the last fix rather than interpolated between two. */
  reckoned: boolean
}

/**
 * The last value a field had at or before index `i` of the track – the
 * direction an aircraft that reports none at the moment (a parked one,
 * whose transponder sends no track, or none at all) was last known to
 * have. Null where the track never carried one.
 */
function lastKnown(track: readonly AircraftTrackPoint[], i: number, field: 5 | 7): number | null {
  for (let j = i; j >= 0; j--) {
    const value = track[j][field] ?? null
    if (value !== null) return value
  }
  return null
}

/**
 * The directions of a fix that reports none itself: the direction of
 * motion is the last track known, failing that the last heading; the
 * nose is the last heading known, failing that the direction of motion.
 * North – a guess and nothing else – only for a track that never said
 * either. Standing still an aircraft keeps pointing where it did: no
 * direction is ever made up from the wobble of a parked transponder's
 * fixes, which spun the aircraft on the apron before this.
 */
function knownDirections(track: readonly AircraftTrackPoint[], i: number): { bearingDeg: number; noseDeg: number } {
  const trackDeg = lastKnown(track, i, 5)
  const headingDeg = lastKnown(track, i, 7)
  const bearingDeg = trackDeg ?? headingDeg ?? 0
  return { bearingDeg, noseDeg: headingDeg ?? bearingDeg }
}

/** How the fixes' altitudes are read (see aircraftPlaybackSample). */
interface AltitudeScale {
  /** A fix's altitude on the geometric scale, null on the ground. */
  of(p: AircraftTrackPoint): number | null
  /** Whether a fix reports its altitude as the geometric one. */
  geometric(p: AircraftTrackPoint): boolean
}

function pointSample(
  track: readonly AircraftTrackPoint[],
  i: number,
  scale: AltitudeScale,
  moving: boolean,
  reckoned: boolean,
): AircraftPlaybackSample {
  const p = track[i]
  const altM = scale.of(p)
  return {
    lon: p[2],
    lat: p[1],
    altM,
    altGeometric: altM !== null && scale.geometric(p),
    groundShare: altM === null ? 1 : 0,
    ...knownDirections(track, i),
    gsKn: p[4],
    verticalRateMps: p[6],
    turnRateDegPerS: 0,
    moving,
    reckoned,
  }
}

/** Shortest signed arc from one bearing to another, in degrees. */
function bearingDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180
}

/** The arc from `a` to `b` at `u`, the short way round; null unless both are known. */
function easeArc(a: number | null, b: number | null, u: number): number | null {
  return a !== null && b !== null ? (a + bearingDelta(a, b) * u + 360) % 360 : null
}

/**
 * The aircraft as the playback shows it at `renderMs` (wall clock minus
 * AIRCRAFT_PLAYBACK_DELAY_MS): linear interpolation between the two
 * recorded fixes around that instant – position, altitude and the
 * kinematics alike, the track eased along the shortest arc. Before the
 * first fix the aircraft stands on it. Past the last fix it is flown on
 * from that fix's speed, track and climb rate for at most
 * AIRCRAFT_RECKON_MAX_MS, then held where the reckoning ended.
 *
 * Every altitude is put on one scale before it is interpolated, fix by
 * fix: a geometric altitude is a height above the ellipsoid, a pressure
 * altitude is lifted by `pressureLiftM` to stand on it – the geoid
 * height plus the day's pressure, as the sky around measures it (see
 * pressureLift); 0 leaves every altitude as reported. Between the air
 * and the ground the altitude is carried on at the airborne fix's
 * vertical rate and groundShare says how far the segment has come.
 */
export function aircraftPlaybackSample(
  aircraft: Aircraft,
  renderMs: number,
  pressureLiftM = 0,
): AircraftPlaybackSample {
  const track: AircraftTrackPoint[] =
    aircraft.track.length > 0
      ? aircraft.track
      : [
          [
            aircraft.positionAt,
            aircraft.lat,
            aircraft.lon,
            aircraft.altGeomM ?? aircraft.altBaroM,
            aircraft.gsKn,
            aircraft.trackDeg,
            aircraft.verticalRateMps,
            aircraft.headingDeg,
            aircraft.altGeomM !== null,
          ],
        ]
  // A fix written before the kind existed takes the record's: geometric
  // where the record reports a geometric altitude – and where it reports
  // none at all, on the ground, because nearly every aircraft that
  // reports the ground reported a geometric altitude in the air
  const recordGeometric = aircraft.altGeomM !== null || aircraft.altBaroM === null
  const geometric = (p: AircraftTrackPoint) => p[8] ?? recordGeometric
  const scale: AltitudeScale = {
    of: (p) => (p[3] === null ? null : geometric(p) ? p[3] : p[3] + pressureLiftM),
    geometric,
  }
  const last = track[track.length - 1]
  if (renderMs <= track[0][0]) return pointSample(track, 0, scale, false, false)
  if (renderMs >= last[0]) {
    return reckon(track, scale, Math.min(renderMs - last[0], AIRCRAFT_RECKON_MAX_MS))
  }

  let i = 0
  while (i + 1 < track.length && track[i + 1][0] <= renderMs) i++
  const p0 = track[i]
  const p1 = track[i + 1]
  const dtMs = p1[0] - p0[0]
  const u = dtMs > 0 ? (renderMs - p0[0]) / dtMs : 1
  const lat = p0[1] + (p1[1] - p0[1]) * u
  const lon = p0[2] + (p1[2] - p0[2]) * u
  const a0 = scale.of(p0)
  const a1 = scale.of(p1)
  let altM: number | null = null
  let altGeometric = false
  let groundShare = 1
  if (a0 !== null && a1 !== null) {
    altM = a0 + (a1 - a0) * u
    altGeometric = geometric(u < 0.5 ? p0 : p1)
    groundShare = 0
  } else if (a0 !== null) {
    // Touching down: on down from the last fix in the air at its rate
    // (a climb is no descent – held), onto the ground by the next fix
    altM = a0 + Math.min(0, p0[6] ?? 0) * ((renderMs - p0[0]) / 1000)
    altGeometric = geometric(p0)
    groundShare = u
  } else if (a1 !== null) {
    // Lifting off: the first fix in the air, its climb run backwards
    altM = a1 - Math.max(0, p1[6] ?? 0) * ((p1[0] - renderMs) / 1000)
    altGeometric = geometric(p1)
    groundShare = 1 - u
  }

  const northM = (p1[1] - p0[1]) * METERS_PER_DEGREE_LATITUDE
  const eastM = (p1[2] - p0[2]) * METERS_PER_DEGREE_LATITUDE * Math.cos((p0[1] * Math.PI) / 180)
  const meters = Math.hypot(northM, eastM)
  // A metre a second over the segment – below is a parked aircraft's GNSS wobble
  const moving = dtMs > 0 && meters / (dtMs / 1000) >= 1

  // Bearing: ease the reported track along the shortest arc; without
  // one on either end, a segment with real movement gives its own
  // azimuth; standing, the last direction known (never the azimuth of
  // a parked transponder's wobble). The turn rate is the same arc over
  // the segment's time.
  const h0 = p0[5]
  const h1 = p1[5]
  let bearingDeg: number
  let turnRateDegPerS = 0
  if (h0 !== null && h1 !== null) {
    const dh = bearingDelta(h0, h1)
    bearingDeg = (h0 + dh * u + 360) % 360
    turnRateDegPerS = dtMs > 0 ? dh / (dtMs / 1000) : 0
  } else if (moving && meters > 5) {
    bearingDeg = ((Math.atan2(eastM, northM) * 180) / Math.PI + 360) % 360
  } else {
    bearingDeg = knownDirections(track, i + 1).bearingDeg
  }
  // The nose: the heading eased on its own arc where both fixes report
  // one – a taxiing aircraft's track, where it reports one at all, is a
  // stale number from its last velocity message, so the heading is
  // never derived from it – else the last heading known, else the bearing
  const heading = easeArc(p0[7] ?? null, p1[7] ?? null, u)
  const noseDeg = heading ?? lastKnown(track, i + 1, 7) ?? bearingDeg
  const lerpNullable = (a: number | null, b: number | null): number | null =>
    a !== null && b !== null ? a + (b - a) * u : (b ?? a)
  return {
    lon,
    lat,
    altM,
    altGeometric,
    groundShare,
    bearingDeg,
    noseDeg,
    gsKn: lerpNullable(p0[4], p1[4]),
    verticalRateMps: lerpNullable(p0[6], p1[6]),
    turnRateDegPerS,
    moving,
    reckoned: false,
  }
}

/**
 * Dead reckoning from the last fix: straight on along the track at the
 * ground speed, climbing or descending at the vertical rate, for `aheadMs`.
 * Without a speed or a track there is nothing to fly on with, and the
 * aircraft stands on the fix.
 */
function reckon(
  track: readonly AircraftTrackPoint[],
  scale: AltitudeScale,
  aheadMs: number,
): AircraftPlaybackSample {
  const last = track[track.length - 1]
  const gsKn = last[4]
  const trackDeg = last[5]
  if (gsKn === null || trackDeg === null || gsKn < 1 || aheadMs <= 0) {
    return pointSample(track, track.length - 1, scale, false, aheadMs > 0)
  }
  const seconds = aheadMs / 1000
  const meters = gsKn * KNOT_MPS * seconds
  const rad = (trackDeg * Math.PI) / 180
  const lat = last[1] + (Math.cos(rad) * meters) / METERS_PER_DEGREE_LATITUDE
  const lon =
    last[2] +
    (Math.sin(rad) * meters) / (METERS_PER_DEGREE_LATITUDE * Math.cos((last[1] * Math.PI) / 180))
  const lastAltM = scale.of(last)
  const altM = lastAltM === null ? null : lastAltM + (last[6] ?? 0) * seconds
  return {
    lon,
    lat,
    altM,
    altGeometric: altM !== null && scale.geometric(last),
    groundShare: altM === null ? 1 : 0,
    bearingDeg: trackDeg,
    noseDeg: lastKnown(track, track.length - 1, 7) ?? trackDeg,
    gsKn,
    verticalRateMps: last[6],
    turnRateDegPerS: 0,
    // Frozen at the end of the reckoning window: nothing moves any more
    moving: aheadMs < AIRCRAFT_RECKON_MAX_MS,
    reckoned: true,
  }
}

/**
 * The pressure lift is the median over this many aircraft reporting both
 * altitudes – the nearest in pressure altitude, no further from it than
 * AIRCRAFT_LIFT_BAND_M – and wants this many at the least.
 */
export const AIRCRAFT_LIFT_NEIGHBOURS = 5
export const AIRCRAFT_LIFT_MIN_AIRCRAFT = 3
export const AIRCRAFT_LIFT_BAND_M = 1500

/**
 * What lifts a pressure altitude onto the geometric scale, measured on
 * the sky itself: the geometric minus the pressure altitude of the
 * aircraft that report both. That is the geoid height plus the day's
 * pressure – at Frankfurt 120 m near the ground on one day and 200 m on
 * another, at about 1032 hPa, against a geoid height of 47 – and it
 * grows with the height through air warmer than the standard (the first
 * of those days: 300 m at cruise), so the lift is the median of the
 * AIRCRAFT_LIFT_NEIGHBOURS aircraft nearest in pressure altitude to the
 * one asked about, within AIRCRAFT_LIFT_BAND_M of it – a transponder
 * that reports something odd outvoted. Where fewer than
 * AIRCRAFT_LIFT_MIN_AIRCRAFT report both there – a quiet sky, an
 * altitude nobody else flies – and for an aircraft with no pressure
 * altitude to lift, `fallbackM`: the geoid height, and the pressure
 * error with it, which was the rule for every pressure altitude before
 * and drew a pressure-only aircraft on Frankfurt's runway 150 m under
 * it.
 */
export function pressureLift(
  list: readonly Aircraft[],
  fallbackM: number,
): (pressureAltM: number | null) => number {
  const pairs: [number, number][] = []
  for (const aircraft of list) {
    if (aircraft.onGround || aircraft.altGeomM === null || aircraft.altBaroM === null) continue
    pairs.push([aircraft.altBaroM, aircraft.altGeomM - aircraft.altBaroM])
  }
  return (pressureAltM) => {
    if (pressureAltM === null || pairs.length < AIRCRAFT_LIFT_MIN_AIRCRAFT) return fallbackM
    const lifts = pairs
      .filter(([altM]) => Math.abs(altM - pressureAltM) <= AIRCRAFT_LIFT_BAND_M)
      .sort((a, b) => Math.abs(a[0] - pressureAltM) - Math.abs(b[0] - pressureAltM))
      .slice(0, AIRCRAFT_LIFT_NEIGHBOURS)
      .map(([, liftM]) => liftM)
      .sort((a, b) => a - b)
    if (lifts.length < AIRCRAFT_LIFT_MIN_AIRCRAFT) return fallbackM
    const mid = lifts.length >> 1
    return lifts.length % 2 === 1 ? lifts[mid] : (lifts[mid - 1] + lifts[mid]) / 2
  }
}

/**
 * The pressure altitude an aircraft's lift is taken at: its own where it
 * reports one, else that of the last fix in its track that carries one
 * – an aircraft that has just reported the ground is still played on its
 * approach – and null where no fix does, which leaves nothing to lift.
 */
export function pressureReference(aircraft: Aircraft): number | null {
  if (aircraft.altBaroM !== null) return aircraft.altBaroM
  for (let i = aircraft.track.length - 1; i >= 0; i--) {
    const p = aircraft.track[i]
    if (p[3] !== null && p[8] === false) return p[3]
  }
  return null
}
