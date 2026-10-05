<?php
/**
 * AIS vessel positions for the map, from aisstream.io – on shared
 * hosting, which cannot hold a WebSocket open permanently. Every refresh
 * therefore opens the stream for a short listen window, merges what it
 * heard into a persistent state file, and closes again. What that costs
 * is set by the source, not by AIS on-air: aisstream aggregates, and a
 * ship under way arrives on a 30 s grid, mostly every 60 s (measured
 * on a permanently open socket – a 15 kn ship therefore jumps
 * ~450 m between fixes no matter what we do). Every window we are NOT
 * listening multiplies that interval, so the duty cycle is the one knob
 * that matters. Moored ships trickle in over the first windows –
 * harmless, their last position is still exactly where they are.
 *
 * Response (also served while a refresh is still pending):
 *   { "timestamp": <unix ms of the state>, "vessels": [ { mmsi, name,
 *     lat, lon, sogKn, cogDeg, headingDeg, lastCourseDeg, navStatus,
 *     typeCode, lengthM, widthM, draughtM, positionAt, track }, ... ] }
 * track is the vessel's recent fixes ([unix ms, lat, lon, sogKn, cogDeg,
 * headingDeg], oldest first): the app renders the fleet 4 minutes behind
 * the wall clock and interpolates BETWEEN these – see the playback notes
 * in src/lib/ais-extract.ts.
 *
 * The browser is always answered from the state file. When it has gone
 * stale, the request that noticed responds first (stale beats waiting
 * 12 s) and runs the listen window after fastcgi_finish_request. A lock
 * keeps concurrent listeners to one – which also respects aisstream's
 * 3-connections-per-account limit.
 *
 * The keeper cron calls this endpoint every minute with ?listen=45
 * (capped) and is treated differently in two ways: its window runs no
 * matter how fresh the state looks, and it queues for the lock instead
 * of giving up. Both exist because the browser's short windows would
 * otherwise crowd it out – see the TTL constant below.
 *
 * API key (never in the repo): first hit of
 *   - environment variable AISSTREAM_KEY
 *   - ais-key.txt next to this script (local tests)
 *   - aisstream.io-api-key.txt two levels up – above the docroot, where the
 *     rsync --delete deploy (ci.yml) can never touch it
 *
 * Bounding boxes: every city's cities/<slug>/city.json next to this
 * script – the definitions the whole project shares (src/cities/, see
 * src/lib/city.ts), copied here by the deploy – or, in a repository
 * checkout, the src/cities folders two levels up. ONE subscription
 * carries every city's box (aisstream allows three connections per
 * account); a request answers for the city it names (?city=<slug>,
 * default rostock) with the vessels inside that city's box.
 *   php ais.php --bbox
 * prints the boxes the script subscribes with; scripts/test-ais-parity.mjs
 * compares them against the TypeScript side.
 *
 * Self-test (CLI, no network):
 *   php ais.php --selftest messages.json <now-ms>
 * replays a captured message file (JSON array) at a fixed clock and
 * prints the state JSON. scripts/test-ais-parity.mjs compares this
 * against ais-extract.ts – both implementations must agree on every
 * vessel.
 */

declare(strict_types=1);

// Shortest round-trip floats – hosts pinning serialize_precision high
// would otherwise inflate every coordinate to 48 digits.
ini_set('serialize_precision', '-1');

const MG3D_AIS_HOST = 'stream.aisstream.io';
const MG3D_AIS_PATH = '/v0/stream';
/** Where cities/<slug>/city.json is looked for, in order (see the header). */
const MG3D_AIS_CITY_DIRS = [
    __DIR__ . '/cities',
    __DIR__ . '/../../src/cities',
];
const MG3D_AIS_DEFAULT_CITY = 'rostock';
/**
 * State age at which a BROWSER request triggers the next listen window –
 * it bounds the blind gap the browser-driven path leaves when no keeper
 * cron runs. The keeper ignores it: with the TTL at 40 s the short
 * windows kept the state fresh almost continuously, the keeper answered
 * from the cache instead of listening, and the endpoint spent 27 % of
 * the time on the stream where the minutely cron alone buys 75 %.
 */
const MG3D_AIS_TTL_SECONDS = 15;
/** How long the keeper queues for the lock before skipping its minute. */
const MG3D_AIS_LOCK_WAIT_SECONDS = 15;
/** Default listen window; ?listen= raises it up to the cap below. */
const MG3D_AIS_LISTEN_SECONDS = 12;
/** Hard cap for ?listen= (the 60 s wall-clock budget needs headroom). */
const MG3D_AIS_LISTEN_MAX_SECONDS = 45;
/**
 * Wall-clock budget for the whole request in seconds: all-inkl caps PHP
 * at 60 s, and FastCGI timeouts count wall time. The window is bounded
 * by an absolute deadline derived from this, so a slow connect shrinks
 * the listen instead of the process being killed mid-window with the
 * state write still pending.
 */
const MG3D_AIS_WALL_BUDGET_SECONDS = 52.0;
/** During a window the state is flushed this often – polls arriving
 *  mid-window pick up near-live fixes instead of waiting for its end. */
const MG3D_AIS_FLUSH_SECONDS = 8;
/** Vessels drop out of the LIST after this long without a position. */
const MG3D_AIS_EXPIRE_MS = 30 * 60_000;
/** Records survive in the STATE this long – static data (name, type,
 *  dimensions, learned only every 6 minutes) must outlive a ferry's
 *  round trip to Gedser. Mirror of ais-extract.ts. */
const MG3D_AIS_STATIC_KEEP_MS = 48 * 3600_000;
/** Track points older than this are pruned. Mirror of ais-extract.ts. */
const MG3D_AIS_TRACK_KEEP_MS = 10 * 60_000;
/** Hard cap per vessel – a runaway-transmitter backstop. */
const MG3D_AIS_TRACK_MAX_POINTS = 40;
/** From this speed a fix's COG is a course, not GNSS drift. Mirror of ais-extract.ts. */
const MG3D_AIS_UNDER_WAY_SOG_KN = 0.5;
// A message's own time counts as the fix's time within this window of
// the keeper's clock (see AIS_MESSAGE_TIME_* in ais-extract.ts).
const MG3D_AIS_MESSAGE_TIME_BEHIND_MS = 10 * 60_000;
const MG3D_AIS_MESSAGE_TIME_AHEAD_MS = 5_000;
/**
 * The archive: every fix, kept for five days in one file per city and
 * UTC hour, so the app can replay the harbour when its clock is set into
 * the past – see src/lib/ais-archive.ts for the format and the reasons,
 * and mg3d_ais_archive_dir for where it lives. Mirror of
 * AIS_ARCHIVE_KEEP_HOURS and AIS_ARCHIVE_SETTLE_MS there.
 */
const MG3D_AIS_ARCHIVE_KEEP_HOURS = 120;
const MG3D_AIS_ARCHIVE_SETTLE_SECONDS = 60;

// ---------------------------------------------------------------------------
// Extraction – the PHP twin of src/lib/ais-extract.ts
// ---------------------------------------------------------------------------

/** AIS "not available" sentinels → null (Sog 102.3, Cog 360, heading 511). */
function mg3d_ais_sog($value): ?float
{
    return !is_numeric($value) || $value >= 102.3 ? null : (float) $value;
}

function mg3d_ais_cog($value): ?float
{
    return !is_numeric($value) || $value >= 360 ? null : (float) $value;
}

function mg3d_ais_heading($value): ?float
{
    return !is_numeric($value) || $value >= 511 ? null : (float) $value;
}

/** Dimension halves A+B / C+D → length/width, null when unreported. */
function mg3d_ais_dimensions(?array $dim): array
{
    $length = (float) ($dim['A'] ?? 0) + (float) ($dim['B'] ?? 0);
    $width = (float) ($dim['C'] ?? 0) + (float) ($dim['D'] ?? 0);
    return [$length > 0 ? $length : null, $width > 0 ? $width : null];
}

/**
 * The shape of a vessel record, in one place. Also what an older state
 * file is completed to when it is read back (see mg3d_ais_load): the state
 * outlives deploys, so a record written before a field existed would
 * otherwise reach the browser without that key at all – which is not the
 * same as null, and crashed the vessel card when draughtM arrived.
 */
function mg3d_ais_default_vessel(int $mmsi): array
{
    return [
        'mmsi' => $mmsi,
        'name' => '',
        'lat' => null,
        'lon' => null,
        'sogKn' => null,
        'cogDeg' => null,
        'headingDeg' => null,
        'lastCourseDeg' => null,
        'navStatus' => null,
        'typeCode' => 0,
        'lengthM' => null,
        'widthM' => null,
        'draughtM' => null,
        'positionAt' => 0,
        'track' => [],
    ];
}

/**
 * Folds one raw aisstream message into the state (mmsi → vessel record).
 * Field-for-field port of mergeAisMessage in src/lib/ais-extract.ts – any
 * behavioral change must land in both, the parity test insists.
 */
/**
 * The time aisstream stamps a message with ("2026-08-27 11:15:39.673431615
 * +0000 UTC"), as unix ms; null for anything else. Mirror of
 * aisMessageTimeMs in src/lib/ais-extract.ts.
 */
function mg3d_ais_message_time($timeUtc): ?int
{
    if (!is_string($timeUtc)) return null;
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? \+0000 UTC$/', $timeUtc, $m)) {
        return null;
    }
    $seconds = gmmktime((int) $m[4], (int) $m[5], (int) $m[6], (int) $m[2], (int) $m[3], (int) $m[1]);
    $ms = isset($m[7]) ? (int) substr($m[7] . '00', 0, 3) : 0;
    return $seconds * 1000 + $ms;
}

/**
 * When a fix was made: the message's own time within the window of the
 * keeper's clock, the keeper's clock otherwise (mirror of aisFixTimeMs).
 */
function mg3d_ais_fix_time(array $raw, int $nowMs): int
{
    $stamped = mg3d_ais_message_time($raw['MetaData']['time_utc'] ?? null);
    if ($stamped === null) return $nowMs;
    if ($stamped > $nowMs + MG3D_AIS_MESSAGE_TIME_AHEAD_MS) return $nowMs;
    if ($stamped < $nowMs - MG3D_AIS_MESSAGE_TIME_BEHIND_MS) return $nowMs;
    return $stamped;
}

function mg3d_ais_merge(array &$state, array $raw, int $nowMs): void
{
    $meta = $raw['MetaData'] ?? null;
    $mmsi = $meta['MMSI'] ?? null;
    if (!is_int($mmsi) || $mmsi <= 0) return;
    $fixMs = mg3d_ais_fix_time($raw, $nowMs);

    $vessel = $state[$mmsi] ?? mg3d_ais_default_vessel($mmsi);

    // Position: the message payload is authoritative (full precision), the
    // MetaData copy fills in for static reports.
    $report = $raw['Message']['PositionReport']
        ?? $raw['Message']['StandardClassBPositionReport']
        ?? null;
    $lat = $report['Latitude'] ?? $meta['latitude'] ?? null;
    $lon = $report['Longitude'] ?? $meta['longitude'] ?? null;
    // A message older than the fix already held is late, not news
    $hasFix = is_numeric($lat) && is_numeric($lon) && abs((float) $lat) <= 90
        && $fixMs >= $vessel['positionAt'];
    if ($hasFix) {
        $vessel['lat'] = (float) $lat;
        $vessel['lon'] = (float) $lon;
        $vessel['positionAt'] = $fixMs;
    }
    if ($report !== null && $fixMs >= $vessel['positionAt']) {
        $vessel['sogKn'] = mg3d_ais_sog($report['Sog'] ?? null);
        $vessel['cogDeg'] = mg3d_ais_cog($report['Cog'] ?? null);
        $vessel['headingDeg'] = mg3d_ais_heading($report['TrueHeading'] ?? null);
        // The course she last held under way survives her lying still –
        // a moored ship's own COG is drift (see AIS_UNDER_WAY_SOG_KN).
        if ($vessel['cogDeg'] !== null && ($vessel['sogKn'] === null || $vessel['sogKn'] >= MG3D_AIS_UNDER_WAY_SOG_KN)) {
            $vessel['lastCourseDeg'] = $vessel['cogDeg'];
        }
        if (array_key_exists('NavigationalStatus', $report)) {
            $vessel['navStatus'] = $report['NavigationalStatus'] ?? $vessel['navStatus'];
        }
    }
    if ($hasFix) {
        // Record AFTER the kinematics update, so a MetaData-only fix
        // (static report) carries the last known speed and course.
        $vessel['track'][] = [$fixMs, $vessel['lat'], $vessel['lon'],
            $vessel['sogKn'], $vessel['cogDeg'], $vessel['headingDeg']];
        $track = [];
        foreach ($vessel['track'] as $point) {
            if ($nowMs - $point[0] <= MG3D_AIS_TRACK_KEEP_MS) $track[] = $point;
        }
        $vessel['track'] = array_slice($track, -MG3D_AIS_TRACK_MAX_POINTS);
    }

    // Static data: name, type, dimensions – whichever report carries them.
    $staticData = $raw['Message']['ShipStaticData'] ?? null;
    $partReport = $raw['Message']['StaticDataReport'] ?? null;
    $reportA = ($partReport['ReportA']['Valid'] ?? false) ? $partReport['ReportA'] : null;
    $reportB = ($partReport['ReportB']['Valid'] ?? false) ? $partReport['ReportB'] : null;
    $staticName = trim((string) ($staticData['Name'] ?? $reportA['Name'] ?? ''));
    $metaName = trim((string) ($meta['ShipName'] ?? ''));
    $vessel['name'] = $staticName !== '' ? $staticName : ($vessel['name'] !== '' ? $vessel['name'] : $metaName);
    $typeCode = $staticData['Type'] ?? $reportB['ShipType'] ?? 0;
    if ($typeCode) $vessel['typeCode'] = (int) $typeCode;
    [$length, $width] = mg3d_ais_dimensions($staticData['Dimension'] ?? $reportB['Dimension'] ?? null);
    if ($length !== null) $vessel['lengthM'] = $length;
    if ($width !== null) $vessel['widthM'] = $width;
    // Draught rides with the name and dimensions – only the full static
    // report carries it, and 0 is AIS for "not reported", not a value.
    $draught = $staticData['MaximumStaticDraught'] ?? null;
    if (is_numeric($draught) && $draught > 0) $vessel['draughtM'] = (float) $draught;

    if ($vessel['lat'] !== null) $state[$mmsi] = $vessel;
}

/**
 * Lists vessels with a fresh position, sorted by MMSI. Stale records
 * stay in the state as memory until MG3D_AIS_STATIC_KEEP_MS – see the
 * constant above.
 */
function mg3d_ais_vessels(array &$state, int $nowMs): array
{
    $fresh = [];
    foreach ($state as $mmsi => $vessel) {
        $age = $nowMs - $vessel['positionAt'];
        if ($age > MG3D_AIS_STATIC_KEEP_MS) {
            unset($state[$mmsi]);
        } elseif ($age <= MG3D_AIS_EXPIRE_MS) {
            $fresh[$mmsi] = $vessel;
        }
    }
    ksort($fresh);
    return array_values($fresh);
}

// ---------------------------------------------------------------------------
// WebSocket client (proven by ais-test.php on this hosting)
// ---------------------------------------------------------------------------

/** Sends one masked client frame (RFC 6455: client frames MUST be masked). */
function mg3d_ws_send($fp, int $opcode, string $payload): void
{
    $len = strlen($payload);
    $header = chr(0x80 | $opcode);
    if ($len < 126) {
        $header .= chr(0x80 | $len);
    } elseif ($len < 65536) {
        $header .= chr(0x80 | 126) . pack('n', $len);
    } else {
        $header .= chr(0x80 | 127) . pack('N', 0) . pack('N', $len);
    }
    $mask = random_bytes(4);
    for ($i = 0; $i < $len; $i++) {
        $payload[$i] = $payload[$i] ^ $mask[$i % 4];
    }
    fwrite($fp, $header . $mask . $payload);
}

/** Extracts one complete frame from the buffer front, null while partial. */
function mg3d_ws_parse(string &$buffer): ?array
{
    $available = strlen($buffer);
    if ($available < 2) return null;
    $b0 = ord($buffer[0]);
    $b1 = ord($buffer[1]);
    $fin = ($b0 & 0x80) !== 0;
    $opcode = $b0 & 0x0F;
    $masked = ($b1 & 0x80) !== 0;
    $len = $b1 & 0x7F;
    $offset = 2;
    if ($len === 126) {
        if ($available < 4) return null;
        $len = unpack('n', substr($buffer, 2, 2))[1];
        $offset = 4;
    } elseif ($len === 127) {
        if ($available < 10) return null;
        $parts = unpack('N2', substr($buffer, 2, 8));
        $len = ($parts[1] << 32) | $parts[2];
        $offset = 10;
    }
    $maskLen = $masked ? 4 : 0;
    if ($available < $offset + $maskLen + $len) return null;
    $payload = substr($buffer, $offset + $maskLen, $len);
    if ($masked) {
        $mask = substr($buffer, $offset, 4);
        for ($i = 0; $i < $len; $i++) {
            $payload[$i] = $payload[$i] ^ $mask[$i % 4];
        }
    }
    $buffer = substr($buffer, $offset + $maskLen + $len);
    return ['fin' => $fin, 'opcode' => $opcode, 'payload' => $payload];
}

/**
 * The cities with AIS, from the first directory that holds any city.json:
 * slug → box in degrees (west/south/east/north). Definitions with
 * ais.enabled false are left out. Empty when nothing is found, which is
 * a deployment error and gets a log line, unlike the transient failures
 * around it.
 *
 * @return array<string, array{west:float,south:float,east:float,north:float}>
 */
function mg3d_ais_cities(): array
{
    foreach (MG3D_AIS_CITY_DIRS as $dir) {
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
                error_log('ais.php: ' . $file . ' carries no usable boundingBox');
                continue;
            }
            $ais = $data['ais'] ?? [];
            if (is_array($ais) && array_key_exists('enabled', $ais) && $ais['enabled'] === false) continue;
            $cities[$slug] = [
                'west' => (float) $box['west'],
                'south' => (float) $box['south'],
                'east' => (float) $box['east'],
                'north' => (float) $box['north'],
            ];
        }
        return $cities;
    }
    error_log('ais.php: no cities/<slug>/city.json found (' . implode(', ', MG3D_AIS_CITY_DIRS) . ')');
    return [];
}

/**
 * Every city's box as aisstream wants it ([[lat, lon] SW, [lat, lon] NE]
 * each), in city order – null when there is none to subscribe with.
 */
function mg3d_ais_bboxes(): ?array
{
    $boxes = [];
    foreach (mg3d_ais_cities() as $box) {
        $boxes[] = [
            [$box['south'], $box['west']],
            [$box['north'], $box['east']],
        ];
    }
    return $boxes === [] ? null : $boxes;
}

/** Whether a position lies inside a city's box (edges included). */
function mg3d_ais_inside(array $box, $lat, $lon): bool
{
    return is_numeric($lat) && is_numeric($lon)
        && $lon >= $box['west'] && $lon <= $box['east']
        && $lat >= $box['south'] && $lat <= $box['north'];
}

// ---------------------------------------------------------------------------
// The archive – the PHP twin of the writer in src/lib/ais-archive.ts
// ---------------------------------------------------------------------------

/**
 * Where the archive lives: beside the API key two levels up, above the
 * docroot – the deploy's rsync --delete never reaches there, and neither
 * does the web – or, when that cannot be written, the temp directory the
 * state file is in. Null when neither can be, which is logged once per
 * request rather than failing the request: the live fleet does not
 * depend on the recording.
 */
function mg3d_ais_archive_dir(): ?string
{
    foreach ([__DIR__ . '/../../ais-archive', sys_get_temp_dir() . '/mg3d-ais-archive'] as $dir) {
        if (is_dir($dir) ? is_writable($dir) : @mkdir($dir, 0755, true)) return $dir;
    }
    error_log('ais.php: no writable directory for the AIS archive');
    return null;
}

/** The hour file a moment belongs to, as its name: UTC "YYYY-MM-DDTHH". */
function mg3d_ais_archive_hour_key(int $ms): string
{
    return gmdate('Y-m-d\TH', intdiv($ms, 1000));
}

/** The start of a named hour in unix seconds, null for anything else. */
function mg3d_ais_archive_hour_start(string $key): ?int
{
    if (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}$/', $key)) return null;
    // The '!' resets what the format does not name to zero – without it
    // the missing minutes and seconds would be the current ones.
    $at = DateTimeImmutable::createFromFormat('!Y-m-d\TH', $key, new DateTimeZone('UTC'));
    return $at === false ? null : $at->getTimestamp();
}

function mg3d_ais_archive_file(string $dir, string $slug, string $hourKey): string
{
    return $dir . '/' . $slug . '/' . $hourKey . '.ndjson';
}

/**
 * A vessel's static data as the archive keeps it – the fields no fix
 * carries, and the course she last held under way, which a snapshot's
 * fix (her last, at rest) cannot say.
 */
function mg3d_ais_archive_static(array $vessel): array
{
    return [
        'mmsi' => $vessel['mmsi'],
        'name' => $vessel['name'],
        'typeCode' => $vessel['typeCode'],
        'lengthM' => $vessel['lengthM'],
        'widthM' => $vessel['widthM'],
        'draughtM' => $vessel['draughtM'],
        'lastCourseDeg' => $vessel['lastCourseDeg'],
    ];
}

/**
 * What a change of static data is judged by: the line without the
 * course, which changes with every fix under way and is carried by the
 * fixes themselves. Mirror of staticSignature in ais-archive.ts.
 */
function mg3d_ais_archive_static_signature(array $vessel): string
{
    $static = mg3d_ais_archive_static($vessel);
    unset($static['lastCourseDeg']);
    return json_encode($static);
}

/**
 * The vessel's last fix as a line: [mmsi, ms, lat, lon, sog, cog,
 * heading, navStatus]. The track's last point is that fix as it was
 * heard; the record's own fields stand in for a record without a track.
 */
function mg3d_ais_archive_fix(array $vessel): array
{
    $track = $vessel['track'];
    $last = $track === [] ? null : $track[count($track) - 1];
    if ($last !== null && $last[0] === $vessel['positionAt']) {
        return [$vessel['mmsi'], $last[0], $last[1], $last[2], $last[3], $last[4], $last[5], $vessel['navStatus']];
    }
    return [$vessel['mmsi'], $vessel['positionAt'], $vessel['lat'], $vessel['lon'],
        $vessel['sogKn'], $vessel['cogDeg'], $vessel['headingDeg'], $vessel['navStatus']];
}

/**
 * The lines an hour file opens with: every ship with a fresh position
 * inside the box, sorted by MMSI, her static data and her last fix.
 */
function mg3d_ais_archive_snapshot(array &$state, int $nowMs, array $box): string
{
    $text = '';
    foreach (mg3d_ais_vessels($state, $nowMs) as $vessel) {
        if (!mg3d_ais_inside($box, $vessel['lat'], $vessel['lon'])) continue;
        $text .= json_encode(mg3d_ais_archive_static($vessel)) . "\n"
            . json_encode(mg3d_ais_archive_fix($vessel)) . "\n";
    }
    return $text;
}

/** Deletes a city's hour files named before $oldestKept. */
function mg3d_ais_archive_prune(string $cityDir, string $oldestKept): void
{
    foreach (glob($cityDir . '/*.ndjson') ?: [] as $file) {
        if (basename($file, '.ndjson') < $oldestKept) @unlink($file);
    }
}

/**
 * Folds one message into the state (mg3d_ais_merge) and records what it
 * changed: the fix it carried, and the static data when that is new. A
 * city whose hour file does not exist yet gets the snapshot instead –
 * taken after the merge, so it already holds this ship and this fix –
 * and its files older than the retention go. Line for line the twin of
 * AisArchiveWriter.record in src/lib/ais-archive.ts.
 */
function mg3d_ais_archive_record(array &$state, array $raw, int $nowMs, array $cities, string $dir): void
{
    $mmsi = $raw['MetaData']['MMSI'] ?? null;
    if (!is_int($mmsi) || $mmsi <= 0) return;
    $before = $state[$mmsi] ?? null;
    $beforePositionAt = $before['positionAt'] ?? 0;
    $beforeStatic = $before === null ? null : mg3d_ais_archive_static_signature($before);
    mg3d_ais_merge($state, $raw, $nowMs);
    $vessel = $state[$mmsi] ?? null;
    if ($vessel === null) return;

    $lines = '';
    if (mg3d_ais_archive_static_signature($vessel) !== $beforeStatic) {
        $lines .= json_encode(mg3d_ais_archive_static($vessel)) . "\n";
    }
    if ($vessel['positionAt'] !== $beforePositionAt) {
        $lines .= json_encode(mg3d_ais_archive_fix($vessel)) . "\n";
    }
    if ($lines === '') return;

    $hourKey = mg3d_ais_archive_hour_key($nowMs);
    foreach ($cities as $slug => $box) {
        if (!mg3d_ais_inside($box, $vessel['lat'], $vessel['lon'])) continue;
        $file = mg3d_ais_archive_file($dir, $slug, $hourKey);
        if (is_file($file)) {
            @file_put_contents($file, $lines, FILE_APPEND | LOCK_EX);
            continue;
        }
        $cityDir = dirname($file);
        if (!is_dir($cityDir) && !@mkdir($cityDir, 0755, true)) continue;
        mg3d_ais_archive_prune(
            $cityDir,
            mg3d_ais_archive_hour_key($nowMs - MG3D_AIS_ARCHIVE_KEEP_HOURS * 3600_000)
        );
        @file_put_contents($file, mg3d_ais_archive_snapshot($state, $nowMs, $box), FILE_APPEND | LOCK_EX);
    }
}

/**
 * Serves one hour file of one city (?hour=YYYY-MM-DDTHH), from the byte
 * ?from= on – the app fetches the hour still being written for its tail
 * every few seconds and would not want the whole file each time. A
 * closed hour is complete and cacheable; an open one, and any tail,
 * must not be cached. 404 where nothing was recorded, 416 for a start
 * beyond the end (nothing new).
 */
function mg3d_ais_archive_serve(?string $dir, string $slug, string $hourKey, int $from): void
{
    $hourStart = mg3d_ais_archive_hour_start($hourKey);
    $file = $dir === null || $hourStart === null ? null : mg3d_ais_archive_file($dir, $slug, $hourKey);
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
    $closed = ($hourStart + 3600 + MG3D_AIS_ARCHIVE_SETTLE_SECONDS) * 1000 < mg3d_now_ms();
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

/**
 * One listen window: connect, subscribe, merge everything heard into
 * $state – through $record where given, which is how the archive is
 * written. Failures are silent by design – the previous state stays.
 */
function mg3d_ais_listen(
    array &$state,
    string $apiKey,
    int $listenSeconds,
    ?callable $onFlush = null,
    ?float $hardDeadline = null,
    ?callable $record = null
): bool {
    $bboxes = mg3d_ais_bboxes();
    if ($bboxes === null) return false;
    $context = stream_context_create(['ssl' => ['peer_name' => MG3D_AIS_HOST]]);
    $fp = @stream_socket_client(
        'ssl://' . MG3D_AIS_HOST . ':443', $errno, $errstr, 10, STREAM_CLIENT_CONNECT, $context
    );
    if ($fp === false) return false;

    $wsKey = base64_encode(random_bytes(16));
    fwrite($fp,
        'GET ' . MG3D_AIS_PATH . " HTTP/1.1\r\n" .
        'Host: ' . MG3D_AIS_HOST . "\r\n" .
        "Upgrade: websocket\r\n" .
        "Connection: Upgrade\r\n" .
        'Sec-WebSocket-Key: ' . $wsKey . "\r\n" .
        "Sec-WebSocket-Version: 13\r\n\r\n");
    stream_set_timeout($fp, 5);
    $buffer = '';
    while (strpos($buffer, "\r\n\r\n") === false && strlen($buffer) < 65536) {
        $chunk = fread($fp, 4096);
        if ($chunk === false || $chunk === '') {
            if (feof($fp) || stream_get_meta_data($fp)['timed_out']) break;
            continue;
        }
        $buffer .= $chunk;
    }
    $headerEnd = strpos($buffer, "\r\n\r\n");
    if ($headerEnd === false || !preg_match('#^HTTP/1\.[01] 101#', $buffer)) {
        fclose($fp);
        return false;
    }
    // Bytes past the header block are already frames – keep them.
    $buffer = substr($buffer, $headerEnd + 4);

    mg3d_ws_send($fp, 0x1, json_encode(['APIKey' => $apiKey, 'BoundingBoxes' => $bboxes]));

    $fragment = '';
    $heard = false;
    stream_set_timeout($fp, 1);
    $deadline = microtime(true) + $listenSeconds;
    if ($hardDeadline !== null && $hardDeadline < $deadline) $deadline = $hardDeadline;
    $nextFlush = microtime(true) + MG3D_AIS_FLUSH_SECONDS;
    while (microtime(true) < $deadline) {
        $closed = false;
        while (($frame = mg3d_ws_parse($buffer)) !== null) {
            switch ($frame['opcode']) {
                case 0x0:
                case 0x1:
                case 0x2:
                    $fragment .= $frame['payload'];
                    if ($frame['fin']) {
                        $message = json_decode($fragment, true);
                        $fragment = '';
                        if (is_array($message)) {
                            if ($record !== null) {
                                $record($state, $message, mg3d_now_ms());
                            } else {
                                mg3d_ais_merge($state, $message, mg3d_now_ms());
                            }
                            $heard = true;
                        }
                    }
                    break;
                case 0x8:
                    $closed = true;
                    break;
                case 0x9:
                    mg3d_ws_send($fp, 0xA, $frame['payload']);
                    break;
            }
            if ($closed) break;
        }
        if ($closed) break;
        if ($onFlush !== null && $heard && microtime(true) >= $nextFlush) {
            $onFlush($state);
            $nextFlush = microtime(true) + MG3D_AIS_FLUSH_SECONDS;
        }
        $chunk = fread($fp, 8192);
        if ($chunk !== false && $chunk !== '') {
            $buffer .= $chunk;
            continue;
        }
        if (feof($fp)) break;
    }
    fclose($fp);
    return $heard;
}

// ---------------------------------------------------------------------------
// State file, key lookup, serving
// ---------------------------------------------------------------------------

function mg3d_now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

function mg3d_ais_key(): string
{
    $env = getenv('AISSTREAM_KEY');
    if (is_string($env) && $env !== '') return trim($env);
    foreach ([__DIR__ . '/ais-key.txt', __DIR__ . '/../../aisstream.io-api-key.txt'] as $file) {
        if (is_readable($file)) {
            $key = trim((string) file_get_contents($file));
            if ($key !== '') return $key;
        }
    }
    return '';
}

/** @return array{listenedAt:int, state:array<int,array>} */
function mg3d_ais_load(string $stateFile): array
{
    $raw = @file_get_contents($stateFile);
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($data) || !is_array($data['state'] ?? null)) {
        return ['listenedAt' => 0, 'state' => []];
    }
    // JSON object keys arrive as strings – vessels are keyed by int MMSI.
    $state = [];
    foreach ($data['state'] as $mmsi => $vessel) {
        if (!is_array($vessel)) continue;
        $mmsi = (int) $mmsi;
        // A state file written by an earlier deploy is missing whatever
        // fields were added since. Union with the defaults fills those in
        // (PHP's + keeps the keys the record already has), so a record
        // that predates a field arrives as null rather than as absent.
        $vessel = $vessel + mg3d_ais_default_vessel($mmsi);
        // The track additionally has to BE a list, not merely present.
        if (!is_array($vessel['track'])) $vessel['track'] = [];
        $state[$mmsi] = $vessel;
    }
    return ['listenedAt' => (int) ($data['listenedAt'] ?? 0), 'state' => $state];
}

function mg3d_ais_save(string $stateFile, array $state, int $listenedAt): void
{
    $tmp = $stateFile . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode(['listenedAt' => $listenedAt, 'state' => $state]));
    rename($tmp, $stateFile);
}

/**
 * Answers with the vessels of one city's box – the state holds every
 * city's ships, the browser asked for one harbor.
 */
function mg3d_ais_respond(array $state, int $listenedAt, ?array $box = null): void
{
    $nowMs = mg3d_now_ms();
    $vessels = mg3d_ais_vessels($state, $nowMs);
    if ($box !== null) {
        $vessels = array_values(array_filter(
            $vessels,
            fn(array $vessel) => mg3d_ais_inside($box, $vessel['lat'], $vessel['lon'])
        ));
    }
    // servedAt is the clock-skew anchor: positionAt stamps only compare
    // to the client's clock through the moment THIS response left, not
    // through the (possibly much older) moment the state was written.
    echo json_encode([
        'timestamp' => $listenedAt,
        'servedAt' => $nowMs,
        'vessels' => $vessels,
    ]);
}

// --- CLI: the boxes this script subscribes with ----------------------------
// scripts/test-ais-parity.mjs compares them against the city definitions.
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--bbox') {
    $bboxes = mg3d_ais_bboxes();
    if ($bboxes === null) exit(1);
    echo json_encode($bboxes), "\n";
    exit(0);
}

// --- CLI self-test: state migration ----------------------------------------
// Replays a STATE file (as written to disk) through the loader and prints
// what would be served. scripts/test-ais-state.mjs feeds it a record from
// before a field existed and insists every field comes back.
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--selftest-state') {
    $file = $argv[2] ?? '';
    $nowMs = (int) ($argv[3] ?? 0);
    if (!is_readable($file) || $nowMs <= 0) {
        fwrite(STDERR, "usage: php ais.php --selftest-state state.json <now-ms>\n");
        exit(2);
    }
    $data = mg3d_ais_load($file);
    echo json_encode([
        'timestamp' => $data['listenedAt'],
        'vessels' => mg3d_ais_vessels($data['state'], $nowMs),
    ]), "\n";
    exit(0);
}

// --- CLI self-test: the archive --------------------------------------------
// Records a captured message file – entries of {atMs, message}, in order –
// into an archive directory, as a listen window would. The parity script
// scripts/test-ais-archive-parity.mjs runs the TypeScript writer over the
// same entries and compares the files line by line.
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--selftest-archive') {
    $file = $argv[2] ?? '';
    $dir = $argv[3] ?? '';
    if (!is_readable($file) || $dir === '' || !is_dir($dir)) {
        fwrite(STDERR, "usage: php ais.php --selftest-archive timed-messages.json <archive-dir>\n");
        exit(2);
    }
    $state = [];
    $cities = mg3d_ais_cities();
    $entries = json_decode((string) file_get_contents($file), true);
    foreach (is_array($entries) ? $entries : [] as $entry) {
        if (!is_array($entry['message'] ?? null) || !is_int($entry['atMs'] ?? null)) continue;
        mg3d_ais_archive_record($state, $entry['message'], $entry['atMs'], $cities, $dir);
    }
    exit(0);
}

// --- CLI self-test ---------------------------------------------------------
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--selftest') {
    $file = $argv[2] ?? '';
    $nowMs = (int) ($argv[3] ?? 0);
    if (!is_readable($file) || $nowMs <= 0) {
        fwrite(STDERR, "usage: php ais.php --selftest messages.json <now-ms>\n");
        exit(2);
    }
    $state = [];
    $messages = json_decode((string) file_get_contents($file), true);
    foreach (is_array($messages) ? $messages : [] as $message) {
        if (is_array($message)) mg3d_ais_merge($state, $message, $nowMs);
    }
    echo json_encode(['timestamp' => $nowMs, 'vessels' => mg3d_ais_vessels($state, $nowMs)]), "\n";
    exit(0);
}

// --- HTTP entry ------------------------------------------------------------
header('Content-Type: application/json');
header('Cache-Control: no-store');

$citySlug = $_GET['city'] ?? MG3D_AIS_DEFAULT_CITY;
$cities = mg3d_ais_cities();
if (!is_string($citySlug) || !isset($cities[$citySlug])) {
    http_response_code(404);
    echo json_encode(['error' => 'Unknown city']);
    exit;
}
$cityBox = $cities[$citySlug];

// A recorded hour is served from the archive and needs no stream – see
// mg3d_ais_archive_serve; the browser reads it when its clock is in the past.
if (isset($_GET['hour'])) {
    mg3d_ais_archive_serve(
        mg3d_ais_archive_dir(),
        $citySlug,
        is_string($_GET['hour']) ? $_GET['hour'] : '',
        (int) ($_GET['from'] ?? 0)
    );
    exit;
}

$apiKey = mg3d_ais_key();
if ($apiKey === '') {
    http_response_code(503);
    echo json_encode(['error' => 'No aisstream API key configured (see header comment of ais.php)']);
    exit;
}

$stateFile = sys_get_temp_dir() . '/mg3d-ais-state.json';
$lockFile = sys_get_temp_dir() . '/mg3d-ais-state.lock';

$data = mg3d_ais_load($stateFile);
// A request that names its own window is the keeper cron. Freshness must
// not silence it: the browser's short windows hold the state inside the
// TTL almost continuously, so a keeper that trusted that freshness would
// answer from the cache and skip its window nearly every minute – which
// is the one thing it was deployed to prevent.
$keeper = isset($_GET['listen']);
// Freshness keys on when the last window STARTED: a long window must not
// push the next one further out – the blind gap between windows is what
// a moving ship's jump grows with.
$ageSeconds = (mg3d_now_ms() - $data['listenedAt']) / 1000;
if (!$keeper && $ageSeconds <= MG3D_AIS_TTL_SECONDS) {
    mg3d_ais_respond($data['state'], $data['listenedAt'], $cityBox);
    exit;
}

// Answer from the state either way, then listen with the response gone –
// nobody waits on a window, not even while the keeper queues for the lock.
mg3d_ais_respond($data['state'], $data['listenedAt'], $cityBox);
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
} else {
    flush();
}
set_time_limit(60);

$lock = fopen($lockFile, 'c');
if ($lock === false) exit;
$haveLock = flock($lock, LOCK_EX | LOCK_NB);
if (!$haveLock) {
    // A browser request gives up – whoever holds the lock is refreshing
    // the state anyway. The keeper waits the short window out instead of
    // losing its minute; the wall budget then shortens its own window by
    // whatever the wait cost, so it still ends in time for the next
    // minute's keeper to find the lock free.
    if (!$keeper) {
        fclose($lock);
        exit;
    }
    $waitUntil = microtime(true) + MG3D_AIS_LOCK_WAIT_SECONDS;
    while (!($haveLock = flock($lock, LOCK_EX | LOCK_NB)) && microtime(true) < $waitUntil) {
        usleep(250_000);
    }
    if (!$haveLock) {
        fclose($lock);
        exit;
    }
}

// The keeper asks for a longer window (?listen=45): higher listening
// duty cycle, smaller blind gaps, smoother ships – same single lock.
$listenSeconds = max(5, min(MG3D_AIS_LISTEN_MAX_SECONDS, (int) ($_GET['listen'] ?? MG3D_AIS_LISTEN_SECONDS)));
$requestStart = (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
$windowStart = mg3d_now_ms();
// Re-read the state now that the lock is ours: a keeper that queued
// behind another window would otherwise save its pre-wait snapshot and
// silently drop every track point that window just recorded.
$data = mg3d_ais_load($stateFile);
$state = $data['state'];
$flush = function (array $flushState) use ($stateFile, $windowStart): void {
    mg3d_ais_vessels($flushState, mg3d_now_ms()); // expiry prunes the copy
    mg3d_ais_save($stateFile, $flushState, $windowStart);
};
// Every fix heard goes into the archive as well as into the state – one
// writer at a time, which the lock above already guarantees.
$archiveDir = mg3d_ais_archive_dir();
$record = $archiveDir === null
    ? null
    : function (array &$recordState, array $message, int $nowMs) use ($cities, $archiveDir): void {
        mg3d_ais_archive_record($recordState, $message, $nowMs, $cities, $archiveDir);
    };
$heard = mg3d_ais_listen(
    $state,
    $apiKey,
    $listenSeconds,
    $flush,
    $requestStart + MG3D_AIS_WALL_BUDGET_SECONDS,
    $record
);
if ($heard) {
    // A window that never even reached the stream keeps the old
    // listenedAt – the next request retries right away instead of
    // trusting a freshness the failed window did not earn.
    $nowMs = mg3d_now_ms();
    mg3d_ais_vessels($state, $nowMs); // expiry prunes in place
    mg3d_ais_save($stateFile, $state, $windowStart);
}
flock($lock, LOCK_UN);
fclose($lock);
