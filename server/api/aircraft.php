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
 * trackDeg, verticalRateMps, headingDeg, geometric], oldest first, the
 * last element true where altM is the geometric altitude): the app
 * renders the traffic a few seconds behind the wall clock and
 * interpolates BETWEEN these – see the playback notes in
 * src/lib/aircraft-extract.ts.
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
 * The sky is recorded as well, the way ais.php records the harbour:
 * five days in one file per city and UTC hour, above the docroot
 * (mg3d_aircraft_archive_dir), replayed by the app when its clock is set
 * into the past – see src/lib/aircraft-archive.ts for the format and the
 * reasons. The recorder is the keeper cron, which calls this script
 * every minute with ?record=50: for that long it polls ONE circle that
 * covers every city (mg3d_aircraft_cover_query – adsb.fi allows one
 * request a second for all of them together) every
 * MG3D_AIRCRAFT_KEEPER_INTERVAL_SECONDS and writes what moved into the
 * files, under a lock of its own so two keepers never overlap. The
 * per-city polls above do not record. ?hour=YYYY-MM-DDTHH (with
 * &from=<byte> for the tail of the hour still being written) serves a
 * recorded hour back.
 *
 * Self-tests (CLI, no network), used by scripts/test-aircraft-parity.mjs
 * and scripts/test-aircraft-archive-parity.mjs:
 *   php aircraft.php --selftest answer.json <now-ms>
 * folds one captured API answer into an empty state at a fixed clock and
 * prints the list;
 *   php aircraft.php --queries
 * prints the circle asked for per city, and --cover the one the keeper
 * polls; and
 *   php aircraft.php --selftest-archive timed-answers.ndjson <archive-dir>
 * records a sequence of {atMs, answer} entries (one per line) into an
 * archive directory as the keeper would.
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
/**
 * The archive: five days in one file per city and UTC hour – see
 * src/lib/aircraft-archive.ts. Mirror of ARCHIVE_KEEP_HOURS and
 * ARCHIVE_SETTLE_MS in archive-hours.ts (the AIS archive's numbers).
 */
const MG3D_AIRCRAFT_ARCHIVE_KEEP_HOURS = 120;
const MG3D_AIRCRAFT_ARCHIVE_SETTLE_SECONDS = 60;
/** How often the keeper polls the cover circle – the recording's resolution. Mirror of AIRCRAFT_KEEPER_INTERVAL_MS. */
const MG3D_AIRCRAFT_KEEPER_INTERVAL_SECONDS = 10;
/**
 * Hard cap for ?record= (the 60 s wall-clock budget needs headroom).
 * With ?record=50 the polls fall at :00, :10, :20, :30 and :40 of the
 * minute – five a minute, twenty seconds to the next minute's first –
 * the one at :50 would not finish inside the reserve below.
 */
const MG3D_AIRCRAFT_RECORD_MAX_SECONDS = 50;
/**
 * Wall-clock budget for a keeper request in seconds: all-inkl caps PHP
 * at 60 s, and FastCGI timeouts count wall time. A poll that could not
 * finish inside it is not started – see the keeper below.
 */
const MG3D_AIRCRAFT_WALL_BUDGET_SECONDS = 52.0;
/** What a poll is allowed to take before the budget is reached – connect, answer, merge, write. */
const MG3D_AIRCRAFT_POLL_RESERVE_SECONDS = 6.0;

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
        $aircraft['headingDeg'],
        $aircraft['altGeomM'] !== null,
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
 * The one circle the keeper polls: centred between the outermost city
 * circles, reaching the far edge of the furthest one – not clamped to
 * what adsb.fi answers for, so a city that would fall outside is noticed
 * (the keeper refuses to run, the parity test fails) rather than left
 * out of the recording. Mirror of adsbCoverQuery in aircraft-archive.ts.
 * @param array<array{lat:float,lon:float,distNm:int}> $queries
 * @return array{lat:float,lon:float,distNm:int}
 */
function mg3d_aircraft_cover_query(array $queries): array
{
    if ($queries === []) return ['lat' => 0.0, 'lon' => 0.0, 'distNm' => 0];
    $south = INF; $north = -INF; $west = INF; $east = -INF;
    foreach ($queries as $query) {
        $south = min($south, $query['lat']);
        $north = max($north, $query['lat']);
        $west = min($west, $query['lon']);
        $east = max($east, $query['lon']);
    }
    $lat = floor(($south + $north) / 2 * 10000 + 0.5) / 10000;
    $lon = floor(($west + $east) / 2 * 10000 + 0.5) / 10000;
    $distNm = 0.0;
    foreach ($queries as $query) {
        $distNm = max($distNm, mg3d_aircraft_haversine($lat, $lon, $query['lat'], $query['lon']) / 1852 + $query['distNm']);
    }
    return ['lat' => $lat, 'lon' => $lon, 'distNm' => (int) ceil($distNm)];
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
// The archive – the PHP twin of the writer in src/lib/aircraft-archive.ts
// ---------------------------------------------------------------------------

/**
 * Where the archive lives: beside the AIS archive two levels up, above
 * the docroot – the deploy's rsync --delete never reaches there, and
 * neither does the web – or, when that cannot be written, the temp
 * directory the state files are in. Null when neither can be.
 */
function mg3d_aircraft_archive_dir(): ?string
{
    foreach ([__DIR__ . '/../../aircraft-archive', sys_get_temp_dir() . '/mg3d-aircraft-archive'] as $dir) {
        if (is_dir($dir) ? is_writable($dir) : @mkdir($dir, 0755, true)) return $dir;
    }
    error_log('aircraft.php: no writable directory for the aircraft archive');
    return null;
}

/** The hour file a moment belongs to, as its name: UTC "YYYY-MM-DDTHH". */
function mg3d_aircraft_archive_hour_key(int $ms): string
{
    return gmdate('Y-m-d\TH', intdiv($ms, 1000));
}

/** The start of a named hour in unix seconds, null for anything else. */
function mg3d_aircraft_archive_hour_start(string $key): ?int
{
    if (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}$/', $key)) return null;
    // The '!' resets what the format does not name to zero – without it
    // the missing minutes and seconds would be the current ones.
    $at = DateTimeImmutable::createFromFormat('!Y-m-d\TH', $key, new DateTimeZone('UTC'));
    return $at === false ? null : $at->getTimestamp();
}

function mg3d_aircraft_archive_file(string $dir, string $slug, string $hourKey): string
{
    return $dir . '/' . $slug . '/' . $hourKey . '.ndjson';
}

/** An aircraft's static data as the archive keeps it – the fields no fix carries. */
function mg3d_aircraft_archive_static(array $aircraft): array
{
    return [
        'hex' => $aircraft['hex'],
        'callsign' => $aircraft['callsign'],
        'registration' => $aircraft['registration'],
        'typeCode' => $aircraft['typeCode'],
        'description' => $aircraft['description'],
        'category' => $aircraft['category'],
        'squawk' => $aircraft['squawk'],
        'source' => $aircraft['source'],
    ];
}

/**
 * The aircraft's last fix as a line: [hex, ms, lat, lon, altGeomM,
 * altBaroM, gsKn, trackDeg, headingDeg, verticalRateMps, rollDeg,
 * onGround] – the record's own fields are that fix.
 */
function mg3d_aircraft_archive_fix(array $aircraft): array
{
    return [
        $aircraft['hex'], $aircraft['positionAt'], $aircraft['lat'], $aircraft['lon'],
        $aircraft['altGeomM'], $aircraft['altBaroM'], $aircraft['gsKn'], $aircraft['trackDeg'],
        $aircraft['headingDeg'], $aircraft['verticalRateMps'], $aircraft['rollDeg'], $aircraft['onGround'],
    ];
}

/**
 * The lines an hour file opens with: every aircraft with a fresh position
 * inside the city's circle, sorted by address, its static data and its
 * last fix.
 */
function mg3d_aircraft_archive_snapshot(array &$state, int $nowMs, array $query): string
{
    $text = '';
    foreach (mg3d_aircraft_list($state, $nowMs) as $aircraft) {
        if (!mg3d_aircraft_within($query, $aircraft['lat'], $aircraft['lon'])) continue;
        $text .= json_encode(mg3d_aircraft_archive_static($aircraft)) . "\n"
            . json_encode(mg3d_aircraft_archive_fix($aircraft)) . "\n";
    }
    return $text;
}

/** Deletes a city's hour files named before $oldestKept. */
function mg3d_aircraft_archive_prune(string $cityDir, string $oldestKept): void
{
    foreach (glob($cityDir . '/*.ndjson') ?: [] as $file) {
        if (basename($file, '.ndjson') < $oldestKept) @unlink($file);
    }
}

/**
 * Folds one poll's answer into the state (mg3d_aircraft_merge per entry,
 * stamped as mg3d_aircraft_merge_response stamps it) and records what it
 * changed: per aircraft the fix it carried when that is newer than the
 * last, and the static data when that is new – into every city whose
 * circle holds the aircraft. A city whose hour file does not exist yet
 * gets the snapshot instead – taken after the whole answer is merged,
 * so it already holds every aircraft's newest fix, and the answer's own
 * lines are not written twice – and its files older than the retention
 * go. Line for line the twin of AircraftArchiveWriter.record.
 * @param array<string, array{lat:float,lon:float,distNm:int}> $cities slug → circle
 */
function mg3d_aircraft_archive_record(array &$state, array $raw, int $nowMs, array $cities, string $dir): void
{
    $changed = [];
    foreach (is_array($raw['ac'] ?? null) ? $raw['ac'] : [] as $entry) {
        if (!is_array($entry)) continue;
        $hex = strtolower(mg3d_aircraft_str($entry['hex'] ?? null));
        if (!preg_match('/^~?[0-9a-f]{6}$/', $hex)) continue;
        $before = $state[$hex] ?? null;
        $beforePositionAt = $before['positionAt'] ?? 0;
        $beforeStatic = $before === null ? null : json_encode(mg3d_aircraft_archive_static($before));
        $seenPos = mg3d_aircraft_num($entry['seen_pos'] ?? null) ?? 0.0;
        mg3d_aircraft_merge($state, $entry, $nowMs - (int) floor($seenPos * 1000 + 0.5));
        $aircraft = $state[$hex] ?? null;
        if ($aircraft === null) continue;
        $lines = '';
        if (json_encode(mg3d_aircraft_archive_static($aircraft)) !== $beforeStatic) {
            $lines .= json_encode(mg3d_aircraft_archive_static($aircraft)) . "\n";
        }
        if ($aircraft['positionAt'] !== $beforePositionAt) {
            $lines .= json_encode(mg3d_aircraft_archive_fix($aircraft)) . "\n";
        }
        if ($lines !== '') $changed[] = [$aircraft['lat'], $aircraft['lon'], $lines];
    }
    if ($changed === []) return;

    $hourKey = mg3d_aircraft_archive_hour_key($nowMs);
    foreach ($cities as $slug => $query) {
        $text = '';
        foreach ($changed as [$lat, $lon, $lines]) {
            if (mg3d_aircraft_within($query, $lat, $lon)) $text .= $lines;
        }
        if ($text === '') continue;
        $file = mg3d_aircraft_archive_file($dir, $slug, $hourKey);
        if (is_file($file)) {
            @file_put_contents($file, $text, FILE_APPEND | LOCK_EX);
            continue;
        }
        $cityDir = dirname($file);
        if (!is_dir($cityDir) && !@mkdir($cityDir, 0755, true)) continue;
        mg3d_aircraft_archive_prune(
            $cityDir,
            mg3d_aircraft_archive_hour_key($nowMs - MG3D_AIRCRAFT_ARCHIVE_KEEP_HOURS * 3600_000)
        );
        @file_put_contents($file, mg3d_aircraft_archive_snapshot($state, $nowMs, $query), FILE_APPEND | LOCK_EX);
    }
}

/**
 * Serves one hour file of one city (?hour=YYYY-MM-DDTHH), from the byte
 * ?from= on – the app fetches the hour still being written for its tail
 * every few seconds and would not want the whole file each time. A
 * closed hour is complete and cacheable; an open one, and any tail,
 * must not be cached. 404 where nothing was recorded, 416 for a start
 * beyond the end (nothing new). Twin of mg3d_ais_archive_serve.
 */
function mg3d_aircraft_archive_serve(?string $dir, string $slug, string $hourKey, int $from): void
{
    $hourStart = mg3d_aircraft_archive_hour_start($hourKey);
    $file = $dir === null || $hourStart === null ? null : mg3d_aircraft_archive_file($dir, $slug, $hourKey);
    if ($file === null || !is_file($file)) {
        http_response_code(404);
        echo json_encode(['error' => 'No recording for this hour']);
        return;
    }
    $size = (int) filesize($file);
    if ($from < 0 || $from > $size) {
        http_response_code(416);
        header('Content-Range: bytes */' . $size);
        return;
    }
    $closed = ($hourStart + 3600 + MG3D_AIRCRAFT_ARCHIVE_SETTLE_SECONDS) * 1000 < mg3d_aircraft_now_ms();
    header('Content-Type: application/x-ndjson');
    header('Cache-Control: ' . ($closed && $from === 0 ? 'public, max-age=86400' : 'no-store'));
    header('Content-Length: ' . ($size - $from));
    // Exactly the bytes announced – the file may grow while they go out
    $in = fopen($file, 'rb');
    $out = fopen('php://output', 'wb');
    if ($in !== false && $out !== false && $size > $from) {
        stream_copy_to_stream($in, $out, $size - $from, $from);
    }
    if ($in !== false) fclose($in);
    if ($out !== false) fclose($out);
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
    // No curl_close: a no-op since PHP 8.0 and deprecated in 8.5
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

// --- CLI: the circle the keeper polls ---------------------------------------
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--cover') {
    echo json_encode(mg3d_aircraft_cover_query(array_map('mg3d_aircraft_query', mg3d_aircraft_cities()))), "\n";
    exit(0);
}

// --- CLI self-test: the archive --------------------------------------------
// Records a captured sequence of answers – one {atMs, answer} entry per
// line, in order – into an archive directory, as the keeper's polls
// would. The parity script scripts/test-aircraft-archive-parity.mjs runs
// the TypeScript writer over the same entries and compares the files
// line by line. Read line by line: a whole sequence decoded at once is
// hundreds of megabytes of PHP arrays.
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--selftest-archive') {
    $file = $argv[2] ?? '';
    $dir = $argv[3] ?? '';
    $in = is_readable($file) ? fopen($file, 'rb') : false;
    if ($in === false || $dir === '' || !is_dir($dir)) {
        fwrite(STDERR, "usage: php aircraft.php --selftest-archive timed-answers.ndjson <archive-dir>\n");
        exit(2);
    }
    $state = [];
    $queries = array_map('mg3d_aircraft_query', mg3d_aircraft_cities());
    while (($line = fgets($in)) !== false) {
        $entry = json_decode($line, true);
        if (!is_array($entry) || !is_array($entry['answer'] ?? null) || !is_int($entry['atMs'] ?? null)) continue;
        mg3d_aircraft_archive_record($state, $entry['answer'], $entry['atMs'], $queries, $dir);
        mg3d_aircraft_list($state, $entry['atMs']); // expiry prunes in place, as the keeper does
    }
    fclose($in);
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

// A recorded hour is served from the archive and needs no poll – see
// mg3d_aircraft_archive_serve; the browser reads it when its clock is in
// the past.
if (isset($_GET['hour'])) {
    mg3d_aircraft_archive_serve(
        mg3d_aircraft_archive_dir(),
        $citySlug,
        is_string($_GET['hour']) ? $_GET['hour'] : '',
        (int) ($_GET['from'] ?? 0)
    );
    exit;
}

$stateFile = sys_get_temp_dir() . '/mg3d-aircraft-' . $citySlug . '.json';
$lockFile = sys_get_temp_dir() . '/mg3d-aircraft.lock';

// The keeper cron (?record=50): answers at once, then polls the cover
// circle for that long with the response gone and records the sky. One
// keeper at a time – the last minute's may still be running when this
// one starts – and every poll under the same lock and spacing the
// per-city polls keep, so adsb.fi still sees one request a second.
if (isset($_GET['record'])) {
    $recordSeconds = max(5, min(MG3D_AIRCRAFT_RECORD_MAX_SECONDS, (int) $_GET['record']));
    echo json_encode(['recording' => $recordSeconds]);
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    } else {
        flush();
    }
    set_time_limit(60);
    $keeperLock = fopen(sys_get_temp_dir() . '/mg3d-aircraft-keeper.lock', 'c');
    if ($keeperLock === false || !flock($keeperLock, LOCK_EX | LOCK_NB)) exit;
    $archiveDir = mg3d_aircraft_archive_dir();
    if ($archiveDir === null) exit;
    $queries = array_map('mg3d_aircraft_query', $cities);
    $cover = mg3d_aircraft_cover_query($queries);
    if ($cover['distNm'] > MG3D_AIRCRAFT_MAX_DIST_NM) {
        error_log('aircraft.php: the cover circle (' . $cover['distNm'] . ' nm) is more than adsb.fi answers for - the sky is not recorded');
        exit;
    }
    $skyFile = sys_get_temp_dir() . '/mg3d-aircraft-sky.json';
    $sky = mg3d_aircraft_load($skyFile);
    $state = $sky['state'];
    $requestStart = (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
    $end = min($requestStart + MG3D_AIRCRAFT_WALL_BUDGET_SECONDS, $requestStart + $recordSeconds);
    $next = microtime(true);
    while (true) {
        // A poll that could not finish inside the budget is not started –
        // and not waited for: the request ends after the last one that fits
        if ($next + MG3D_AIRCRAFT_POLL_RESERVE_SECONDS > $end) break;
        $wait = $next - microtime(true);
        if ($wait > 0) usleep((int) ($wait * 1_000_000));
        $next += MG3D_AIRCRAFT_KEEPER_INTERVAL_SECONDS;
        $lock = fopen($lockFile, 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) continue;
        try {
            clearstatcache(true, $lockFile);
            $sinceLast = microtime(true) - (float) (filemtime($lockFile) ?: 0);
            if ($sinceLast < MG3D_AIRCRAFT_MIN_SPACING_SECONDS) {
                usleep((int) ((MG3D_AIRCRAFT_MIN_SPACING_SECONDS - $sinceLast) * 1_000_000));
            }
            touch($lockFile);
            $answer = mg3d_aircraft_fetch($cover);
        } catch (Throwable $e) {
            error_log('aircraft.php keeper: ' . $e->getMessage());
            continue;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        $nowMs = mg3d_aircraft_now_ms();
        mg3d_aircraft_archive_record($state, $answer, $nowMs, $queries, $archiveDir);
        mg3d_aircraft_list($state, $nowMs); // expiry prunes in place
        mg3d_aircraft_save($skyFile, $state, $nowMs);
    }
    flock($keeperLock, LOCK_UN);
    fclose($keeperLock);
    exit;
}

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
