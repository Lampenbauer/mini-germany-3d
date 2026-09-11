<?php
/**
 * Live air traffic for the map, from adsb.fi's open data API
 * (https://github.com/adsbfi/opendata): asks for the aircraft in the
 * circle that covers the box of the city named in ?city=<slug> and a
 * margin round it, folds every answer into a per-city state – latest
 * fields per ICAO address plus a short position track, the shape
 * src/lib/aircraft-extract.ts produces for the dev middleware
 * (vite.config.ts) – and answers the aircraft inside that circle: the
 * sky reaches past the city's edge, so an aircraft followed to it can
 * be watched flying on. The browser sees one endpoint in both worlds.
 *
 * Response:
 *   { "timestamp": <unix ms of the state>, "servedAt": <unix ms>,
 *     "aircraft": [ { hex, callsign, registration, typeCode, description,
 *     category, lat, lon, altGeomM, altBaroM, onGround, gsKn, trackDeg,
 *     headingDeg, verticalRateMps, rollDeg, squawk, source, positionAt,
 *     track }, ... ] }
 * track is the aircraft's recent fixes ([unix ms, lat, lon, altM, gsKn,
 * trackDeg, verticalRateMps], oldest first): the app renders the traffic
 * a few seconds behind the wall clock and interpolates BETWEEN these –
 * see the playback notes in src/lib/aircraft-extract.ts.
 *
 * No API key: the public endpoints are open, for personal use, at one
 * request a second – for every city together, which the lock file's
 * modification time enforces across requests – and they ask to be cited
 * with a link, which the map's credit line does (AircraftLayer). The
 * state is cached per city for MG3D_AIRCRAFT_TTL_SECONDS; a request that
 * finds it older fetches, waits for the answer (a few hundred
 * milliseconds) and answers fresh. A failed call serves the stale state.
 *
 * Cities: every city's cities/<slug>/city.json next to this script (the
 * deploy copies them, like for ais.php) – or, in a repository checkout,
 * the src/cities folders two levels up.
 *
 * Self-tests (CLI, no network), used by scripts/test-aircraft-parity.mjs:
 *   php aircraft.php --selftest answer.json <now-ms>
 * folds one captured API answer into an empty state at a fixed clock and
 * prints the list; and
 *   php aircraft.php --queries
 * prints the circle asked for per city.
 */

declare(strict_types=1);

// Shortest round-trip floats – hosts pinning serialize_precision high
// would otherwise inflate every coordinate to 48 digits.
ini_set('serialize_precision', '-1');

const MG3D_AIRCRAFT_URL = 'https://opendata.adsb.fi/api/v3';
const MG3D_AIRCRAFT_CITY_DIRS = [
    __DIR__ . '/cities',
    __DIR__ . '/../../src/cities',
];
const MG3D_AIRCRAFT_DEFAULT_CITY = 'rostock';
/** How long one answer serves every browser looking at the city. Mirror of AIRCRAFT_TTL_MS in vite.config.ts. */
const MG3D_AIRCRAFT_TTL_SECONDS = 4;
/** adsb.fi's public rate limit: one request a second, for every city together. */
const MG3D_AIRCRAFT_MIN_SPACING_SECONDS = 1.0;
/** The largest radius adsb.fi answers for. Mirror of ADSB_MAX_DIST_NM. */
const MG3D_AIRCRAFT_MAX_DIST_NM = 250;
/** How far beyond the box's corners the sky is served. Mirror of AIRCRAFT_MARGIN_NM. */
const MG3D_AIRCRAFT_MARGIN_NM = 6;
/** Aircraft drop out of the LIST after this long without a position. Mirror of AIRCRAFT_EXPIRE_MS. */
const MG3D_AIRCRAFT_EXPIRE_MS = 60_000;
/** Records survive in the STATE this long. Mirror of AIRCRAFT_STATE_KEEP_MS. */
const MG3D_AIRCRAFT_STATE_KEEP_MS = 180_000;
/** Track points older than this are pruned. Mirror of AIRCRAFT_TRACK_KEEP_MS. */
const MG3D_AIRCRAFT_TRACK_KEEP_MS = 180_000;
/** Hard cap per aircraft. Mirror of AIRCRAFT_TRACK_MAX_POINTS. */
const MG3D_AIRCRAFT_TRACK_MAX_POINTS = 60;
const MG3D_METERS_PER_FOOT = 0.3048;

// ---------------------------------------------------------------------------
// Extraction – the PHP twin of src/lib/aircraft-extract.ts
// ---------------------------------------------------------------------------

/** Tenths, rounded as Math.floor(x * 10 + 0.5) / 10 does in TypeScript. */
function mg3d_aircraft_tenths(float $value): float
{
    return floor($value * 10 + 0.5) / 10;
}

/** A finite number from the feed, or null. */
function mg3d_aircraft_num($value): ?float
{
    return (is_int($value) || is_float($value)) && is_finite($value) ? (float) $value : null;
}

function mg3d_aircraft_str($value): string
{
    return is_string($value) ? trim($value) : '';
}

/** The shape of a record, in one place – see mg3d_ais_default_vessel for why. */
function mg3d_aircraft_default(string $hex): array
{
    return [
        'hex' => $hex,
        'callsign' => '',
        'registration' => '',
        'typeCode' => '',
        'description' => '',
        'category' => '',
        'lat' => null,
        'lon' => null,
        'altGeomM' => null,
        'altBaroM' => null,
        'onGround' => false,
        'gsKn' => null,
        'trackDeg' => null,
        'headingDeg' => null,
        'verticalRateMps' => null,
        'rollDeg' => null,
        'squawk' => '',
        'source' => 'other',
        'positionAt' => 0,
        'track' => [],
    ];
}

/**
 * Folds one raw aircraft entry into the state. Field-for-field port of
 * mergeAdsbAircraft in src/lib/aircraft-extract.ts – any behavioural
 * change must land in both, the parity test insists.
 */
function mg3d_aircraft_merge(array &$state, array $raw, int $positionAt): void
{
    $hex = strtolower(mg3d_aircraft_str($raw['hex'] ?? null));
    if (!preg_match('/^~?[0-9a-f]{6}$/', $hex)) return;
    $lat = mg3d_aircraft_num($raw['lat'] ?? null);
    $lon = mg3d_aircraft_num($raw['lon'] ?? null);
    if ($lat === null || $lon === null || abs($lat) > 90 || abs($lon) > 180) return;
    $category = strtoupper(mg3d_aircraft_str($raw['category'] ?? null));
    if ($category !== '' && $category[0] === 'C') return;

    $aircraft = $state[$hex] ?? mg3d_aircraft_default($hex);

    $aircraft['callsign'] = mg3d_aircraft_str($raw['flight'] ?? null) ?: $aircraft['callsign'];
    $aircraft['registration'] = mg3d_aircraft_str($raw['r'] ?? null) ?: $aircraft['registration'];
    $aircraft['typeCode'] = strtoupper(mg3d_aircraft_str($raw['t'] ?? null)) ?: $aircraft['typeCode'];
    $aircraft['description'] = mg3d_aircraft_str($raw['desc'] ?? null) ?: $aircraft['description'];
    $aircraft['category'] = $category ?: $aircraft['category'];
    $aircraft['squawk'] = mg3d_aircraft_str($raw['squawk'] ?? null) ?: $aircraft['squawk'];
    $source = mg3d_aircraft_str($raw['type'] ?? null);
    $aircraft['source'] = str_starts_with($source, 'adsb') ? 'adsb'
        : (str_starts_with($source, 'mlat') ? 'mlat' : 'other');

    if ($positionAt <= $aircraft['positionAt']) {
        if ($aircraft['lat'] !== null) $state[$hex] = $aircraft;
        return;
    }

    $aircraft['lat'] = $lat;
    $aircraft['lon'] = $lon;
    $aircraft['positionAt'] = $positionAt;
    $aircraft['onGround'] = ($raw['alt_baro'] ?? null) === 'ground';
    $altBaro = $aircraft['onGround'] ? null : mg3d_aircraft_num($raw['alt_baro'] ?? null);
    $altGeom = $aircraft['onGround'] ? null : mg3d_aircraft_num($raw['alt_geom'] ?? null);
    $aircraft['altBaroM'] = $altBaro === null ? null : mg3d_aircraft_tenths($altBaro * MG3D_METERS_PER_FOOT);
    $aircraft['altGeomM'] = $altGeom === null ? null : mg3d_aircraft_tenths($altGeom * MG3D_METERS_PER_FOOT);
    $aircraft['gsKn'] = mg3d_aircraft_num($raw['gs'] ?? null);
    $aircraft['trackDeg'] = mg3d_aircraft_num($raw['track'] ?? null);
    $aircraft['headingDeg'] = mg3d_aircraft_num($raw['true_heading'] ?? null);
    $rate = mg3d_aircraft_num($raw['geom_rate'] ?? null) ?? mg3d_aircraft_num($raw['baro_rate'] ?? null);
    $aircraft['verticalRateMps'] = $rate === null ? null : mg3d_aircraft_tenths($rate * MG3D_METERS_PER_FOOT / 60);
    $aircraft['rollDeg'] = mg3d_aircraft_num($raw['roll'] ?? null);

    $aircraft['track'][] = [
        $positionAt,
        $lat,
        $lon,
        $aircraft['altGeomM'] ?? $aircraft['altBaroM'],
        $aircraft['gsKn'],
        $aircraft['trackDeg'],
        $aircraft['verticalRateMps'],
    ];
    $track = [];
    foreach ($aircraft['track'] as $point) {
        if ($positionAt - $point[0] <= MG3D_AIRCRAFT_TRACK_KEEP_MS) $track[] = $point;
    }
    $aircraft['track'] = array_slice($track, -MG3D_AIRCRAFT_TRACK_MAX_POINTS);
    $state[$hex] = $aircraft;
}

/** Folds one poll's answer into the state. Mirror of mergeAdsbResponse. */
function mg3d_aircraft_merge_response(array &$state, array $raw, int $nowMs): void
{
    foreach (is_array($raw['ac'] ?? null) ? $raw['ac'] : [] as $entry) {
        if (!is_array($entry)) continue;
        $seenPos = mg3d_aircraft_num($entry['seen_pos'] ?? null) ?? 0.0;
        mg3d_aircraft_merge($state, $entry, $nowMs - (int) floor($seenPos * 1000 + 0.5));
    }
}

/** Lists the aircraft with a fresh position, sorted by address. Mirror of aircraftStateList. */
function mg3d_aircraft_list(array &$state, int $nowMs): array
{
    $fresh = [];
    foreach ($state as $hex => $aircraft) {
        $age = $nowMs - $aircraft['positionAt'];
        if ($age > MG3D_AIRCRAFT_STATE_KEEP_MS) {
            unset($state[$hex]);
        } elseif ($age <= MG3D_AIRCRAFT_EXPIRE_MS) {
            $fresh[$hex] = $aircraft;
        }
    }
    ksort($fresh, SORT_STRING);
    return array_values($fresh);
}

/** Great-circle distance in metres, as aircraft-extract.ts computes it. */
function mg3d_aircraft_haversine(float $lat1, float $lon1, float $lat2, float $lon2): float
{
    $toRad = fn(float $deg): float => $deg * M_PI / 180;
    $dLat = $toRad($lat2 - $lat1);
    $dLon = $toRad($lon2 - $lon1);
    $a = sin($dLat / 2) ** 2 + cos($toRad($lat1)) * cos($toRad($lat2)) * sin($dLon / 2) ** 2;
    return 2 * 6371000 * asin(sqrt($a));
}

/**
 * The circle asked for and served: the box's centre and the distance to
 * its corner plus the margin, in whole nautical miles. Mirror of
 * adsbQuery in aircraft-extract.ts.
 * @param array{west:float,south:float,east:float,north:float} $box
 * @return array{lat:float,lon:float,distNm:int}
 */
function mg3d_aircraft_query(array $box): array
{
    $lat = ($box['south'] + $box['north']) / 2;
    $lon = ($box['west'] + $box['east']) / 2;
    $meters = mg3d_aircraft_haversine($lat, $lon, $box['north'], $box['east']);
    return [
        'lat' => floor($lat * 10000 + 0.5) / 10000,
        'lon' => floor($lon * 10000 + 0.5) / 10000,
        'distNm' => (int) min(MG3D_AIRCRAFT_MAX_DIST_NM, ceil($meters / 1852) + MG3D_AIRCRAFT_MARGIN_NM),
    ];
}

/** Whether a position lies inside the circle a city's sky is served from. Mirror of withinQuery. */
function mg3d_aircraft_within(array $query, $lat, $lon): bool
{
    return is_numeric($lat) && is_numeric($lon)
        && mg3d_aircraft_haversine($query['lat'], $query['lon'], (float) $lat, (float) $lon) <= $query['distNm'] * 1852;
}

/**
 * Every city, from the first directory that holds any city.json: slug →
 * box in degrees. Every city has a sky, so there is no per-city switch.
 * @return array<string, array{west:float,south:float,east:float,north:float}>
 */
function mg3d_aircraft_cities(): array
{
    foreach (MG3D_AIRCRAFT_CITY_DIRS as $dir) {
        $files = glob($dir . '/*/city.json');
        if (!is_array($files) || $files === []) continue;
        sort($files);
        $cities = [];
        foreach ($files as $file) {
            $data = json_decode((string) file_get_contents($file), true);
            if (!is_array($data)) continue;
            $slug = $data['slug'] ?? basename(dirname($file));
            $box = $data['boundingBox'] ?? null;
            if (!is_string($slug) || !is_array($box)
                || !isset($box['west'], $box['south'], $box['east'], $box['north'])) {
                error_log('aircraft.php: ' . $file . ' carries no usable boundingBox');
                continue;
            }
            $cities[$slug] = [
                'west' => (float) $box['west'],
                'south' => (float) $box['south'],
                'east' => (float) $box['east'],
                'north' => (float) $box['north'],
            ];
        }
        return $cities;
    }
    error_log('aircraft.php: no cities/<slug>/city.json found (' . implode(', ', MG3D_AIRCRAFT_CITY_DIRS) . ')');
    return [];
}

// ---------------------------------------------------------------------------
// Upstream, state file, serving
// ---------------------------------------------------------------------------

function mg3d_aircraft_now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

/** One API call for the circle; throws on anything but a JSON answer. */
function mg3d_aircraft_fetch(array $query): array
{
    $url = MG3D_AIRCRAFT_URL . '/lat/' . $query['lat'] . '/lon/' . $query['lon'] . '/dist/' . $query['distNm'];
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_ENCODING => '',
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: mini-germany-3d (https://minigermany3d.com)'],
    ]);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if (!is_string($body) || $status !== 200) {
        throw new RuntimeException('adsb.fi answered HTTP ' . $status);
    }
    $data = json_decode($body, true);
    if (!is_array($data)) throw new RuntimeException('adsb.fi answered no JSON');
    return $data;
}

/** @return array{fetchedAt:int, state:array<string,array>} */
function mg3d_aircraft_load(string $stateFile): array
{
    $raw = @file_get_contents($stateFile);
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($data) || !is_array($data['state'] ?? null)) {
        return ['fetchedAt' => 0, 'state' => []];
    }
    $state = [];
    foreach ($data['state'] as $hex => $aircraft) {
        if (!is_array($aircraft) || !is_string($hex)) continue;
        // A state file written by an earlier deploy is missing whatever
        // fields were added since – completed from the defaults, so a
        // record that predates a field arrives as null rather than absent
        $aircraft = $aircraft + mg3d_aircraft_default($hex);
        if (!is_array($aircraft['track'])) $aircraft['track'] = [];
        $state[$hex] = $aircraft;
    }
    return ['fetchedAt' => (int) ($data['fetchedAt'] ?? 0), 'state' => $state];
}

function mg3d_aircraft_save(string $stateFile, array $state, int $fetchedAt): void
{
    $tmp = $stateFile . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode(['fetchedAt' => $fetchedAt, 'state' => $state]));
    rename($tmp, $stateFile);
}

/** Answers with the aircraft inside the city's circle. */
function mg3d_aircraft_respond(array $state, int $fetchedAt, array $query): void
{
    $nowMs = mg3d_aircraft_now_ms();
    $aircraft = array_values(array_filter(
        mg3d_aircraft_list($state, $nowMs),
        fn(array $a) => mg3d_aircraft_within($query, $a['lat'], $a['lon'])
    ));
    // servedAt is the clock-skew anchor (see ais.php)
    echo json_encode(['timestamp' => $fetchedAt, 'servedAt' => $nowMs, 'aircraft' => $aircraft]);
}

// --- CLI: the circles this script asks for ---------------------------------
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--queries') {
    $queries = [];
    foreach (mg3d_aircraft_cities() as $slug => $box) $queries[$slug] = mg3d_aircraft_query($box);
    echo json_encode($queries), "\n";
    exit(0);
}

// --- CLI self-test: one captured answer at a fixed clock -------------------
// With a city slug as the fourth argument the list is cut to that city's
// circle, as the HTTP entry cuts it.
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--selftest') {
    $file = $argv[2] ?? '';
    $nowMs = (int) ($argv[3] ?? 0);
    $slug = $argv[4] ?? null;
    if (!is_readable($file) || $nowMs <= 0) {
        fwrite(STDERR, "usage: php aircraft.php --selftest answer.json <now-ms> [city]\n");
        exit(2);
    }
    $state = [];
    $answer = json_decode((string) file_get_contents($file), true);
    if (is_array($answer)) mg3d_aircraft_merge_response($state, $answer, $nowMs);
    $list = mg3d_aircraft_list($state, $nowMs);
    if ($slug !== null) {
        $cities = mg3d_aircraft_cities();
        if (!isset($cities[$slug])) {
            fwrite(STDERR, "unknown city: $slug\n");
            exit(2);
        }
        $query = mg3d_aircraft_query($cities[$slug]);
        $list = array_values(array_filter($list, fn(array $a) => mg3d_aircraft_within($query, $a['lat'], $a['lon'])));
    }
    echo json_encode(['timestamp' => $nowMs, 'aircraft' => $list]), "\n";
    exit(0);
}

// --- HTTP entry ------------------------------------------------------------
header('Content-Type: application/json');
header('Cache-Control: no-store');

$citySlug = $_GET['city'] ?? MG3D_AIRCRAFT_DEFAULT_CITY;
$cities = mg3d_aircraft_cities();
if (!is_string($citySlug) || !isset($cities[$citySlug])) {
    http_response_code(404);
    echo json_encode(['error' => 'Unknown city']);
    exit;
}
$cityQuery = mg3d_aircraft_query($cities[$citySlug]);

$stateFile = sys_get_temp_dir() . '/mg3d-aircraft-' . $citySlug . '.json';
$lockFile = sys_get_temp_dir() . '/mg3d-aircraft.lock';

$data = mg3d_aircraft_load($stateFile);
$ageSeconds = (mg3d_aircraft_now_ms() - $data['fetchedAt']) / 1000;
if ($ageSeconds <= MG3D_AIRCRAFT_TTL_SECONDS) {
    mg3d_aircraft_respond($data['state'], $data['fetchedAt'], $cityQuery);
    exit;
}

// Stale: fetch under the one lock every city shares. A request that finds
// the lock taken answers from the state it has – whoever holds it is
// refreshing some city right now, and this one's turn comes on the next
// poll. The lock file's modification time is when the last request went
// out, which is how the second between requests is kept across processes.
set_time_limit(30);
$lock = fopen($lockFile, 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    if ($lock !== false) fclose($lock);
    mg3d_aircraft_respond($data['state'], $data['fetchedAt'], $cityQuery);
    exit;
}
try {
    clearstatcache(true, $lockFile);
    $sinceLast = microtime(true) - (float) (filemtime($lockFile) ?: 0);
    if ($sinceLast < MG3D_AIRCRAFT_MIN_SPACING_SECONDS) {
        usleep((int) ((MG3D_AIRCRAFT_MIN_SPACING_SECONDS - $sinceLast) * 1_000_000));
    }
    touch($lockFile);
    // Re-read under the lock: another request may have refreshed meanwhile
    $data = mg3d_aircraft_load($stateFile);
    if ((mg3d_aircraft_now_ms() - $data['fetchedAt']) / 1000 > MG3D_AIRCRAFT_TTL_SECONDS) {
        $answer = mg3d_aircraft_fetch($cityQuery);
        $nowMs = mg3d_aircraft_now_ms();
        mg3d_aircraft_merge_response($data['state'], $answer, $nowMs);
        mg3d_aircraft_list($data['state'], $nowMs); // expiry prunes in place
        $data['fetchedAt'] = $nowMs;
        mg3d_aircraft_save($stateFile, $data['state'], $nowMs);
    }
} catch (Throwable $e) {
    error_log('aircraft.php: ' . $e->getMessage());
} finally {
    flock($lock, LOCK_UN);
    fclose($lock);
}
mg3d_aircraft_respond($data['state'], $data['fetchedAt'], $cityQuery);
