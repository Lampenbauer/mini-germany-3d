<?php
/**
 * AIS vessel positions for the Rostock map, from aisstream.io – on shared
 * hosting, which cannot hold a WebSocket open permanently. Every refresh
 * therefore opens the stream for a short listen window, merges what it
 * heard into a persistent state file, and closes again. What that costs
 * is set by the source, not by AIS on-air: aisstream aggregates, and a
 * ship under way arrives on a 30 s grid, mostly every 60 s (measured
 * 2026-08-28 on a permanently open socket – a 15 kn ship therefore jumps
 * ~450 m between fixes no matter what we do). Every window we are NOT
 * listening multiplies that interval, so the duty cycle is the one knob
 * that matters. Moored ships trickle in over the first windows –
 * harmless, their last position is still exactly where they are.
 *
 * Response (also served while a refresh is still pending):
 *   { "timestamp": <unix ms of the state>, "vessels": [ { mmsi, name,
 *     lat, lon, sogKn, cogDeg, headingDeg, navStatus, typeCode,
 *     lengthM, widthM, positionAt, track }, ... ] }
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

const MRT_AIS_HOST = 'stream.aisstream.io';
const MRT_AIS_PATH = '/v0/stream';
/** Rostock camera fence: network bbox + 25 km padding ([[lat,lon] SW, NE]). */
const MRT_AIS_BBOX = [[53.83, 11.64], [54.43, 12.61]];
/**
 * State age at which a BROWSER request triggers the next listen window –
 * it bounds the blind gap the browser-driven path leaves when no keeper
 * cron runs. The keeper ignores it: with the TTL at 40 s the short
 * windows kept the state fresh almost continuously, the keeper answered
 * from the cache instead of listening, and the endpoint spent 27 % of
 * the time on the stream where the minutely cron alone buys 75 %.
 */
const MRT_AIS_TTL_SECONDS = 15;
/** How long the keeper queues for the lock before skipping its minute. */
const MRT_AIS_LOCK_WAIT_SECONDS = 15;
/** Default listen window; ?listen= raises it up to the cap below. */
const MRT_AIS_LISTEN_SECONDS = 12;
/** Hard cap for ?listen= (the 60 s wall-clock budget needs headroom). */
const MRT_AIS_LISTEN_MAX_SECONDS = 45;
/**
 * Wall-clock budget for the whole request in seconds: all-inkl caps PHP
 * at 60 s, and FastCGI timeouts count wall time. The window is bounded
 * by an absolute deadline derived from this, so a slow connect shrinks
 * the listen instead of the process being killed mid-window with the
 * state write still pending.
 */
const MRT_AIS_WALL_BUDGET_SECONDS = 52.0;
/** During a window the state is flushed this often – polls arriving
 *  mid-window pick up near-live fixes instead of waiting for its end. */
const MRT_AIS_FLUSH_SECONDS = 8;
/** Vessels drop out of the LIST after this long without a position. */
const MRT_AIS_EXPIRE_MS = 30 * 60_000;
/** Records survive in the STATE this long – static data (name, type,
 *  dimensions, learned only every 6 minutes) must outlive a ferry's
 *  round trip to Gedser. Mirror of ais-extract.ts. */
const MRT_AIS_STATIC_KEEP_MS = 48 * 3600_000;
/** Track points older than this are pruned. Mirror of ais-extract.ts. */
const MRT_AIS_TRACK_KEEP_MS = 10 * 60_000;
/** Hard cap per vessel – a runaway-transmitter backstop. */
const MRT_AIS_TRACK_MAX_POINTS = 40;

// ---------------------------------------------------------------------------
// Extraction – the PHP twin of src/lib/ais-extract.ts
// ---------------------------------------------------------------------------

/** AIS "not available" sentinels → null (Sog 102.3, Cog 360, heading 511). */
function mrt_ais_sog($value): ?float
{
    return !is_numeric($value) || $value >= 102.3 ? null : (float) $value;
}

function mrt_ais_cog($value): ?float
{
    return !is_numeric($value) || $value >= 360 ? null : (float) $value;
}

function mrt_ais_heading($value): ?float
{
    return !is_numeric($value) || $value >= 511 ? null : (float) $value;
}

/** Dimension halves A+B / C+D → length/width, null when unreported. */
function mrt_ais_dimensions(?array $dim): array
{
    $length = (float) ($dim['A'] ?? 0) + (float) ($dim['B'] ?? 0);
    $width = (float) ($dim['C'] ?? 0) + (float) ($dim['D'] ?? 0);
    return [$length > 0 ? $length : null, $width > 0 ? $width : null];
}

/**
 * Folds one raw aisstream message into the state (mmsi → vessel record).
 * Field-for-field port of mergeAisMessage in src/lib/ais-extract.ts – any
 * behavioral change must land in both, the parity test insists.
 */
function mrt_ais_merge(array &$state, array $raw, int $nowMs): void
{
    $meta = $raw['MetaData'] ?? null;
    $mmsi = $meta['MMSI'] ?? null;
    if (!is_int($mmsi) || $mmsi <= 0) return;

    $vessel = $state[$mmsi] ?? [
        'mmsi' => $mmsi,
        'name' => '',
        'lat' => null,
        'lon' => null,
        'sogKn' => null,
        'cogDeg' => null,
        'headingDeg' => null,
        'navStatus' => null,
        'typeCode' => 0,
        'lengthM' => null,
        'widthM' => null,
        'positionAt' => 0,
        'track' => [],
    ];

    // Position: the message payload is authoritative (full precision), the
    // MetaData copy fills in for static reports.
    $report = $raw['Message']['PositionReport']
        ?? $raw['Message']['StandardClassBPositionReport']
        ?? null;
    $lat = $report['Latitude'] ?? $meta['latitude'] ?? null;
    $lon = $report['Longitude'] ?? $meta['longitude'] ?? null;
    $hasFix = is_numeric($lat) && is_numeric($lon) && abs((float) $lat) <= 90;
    if ($hasFix) {
        $vessel['lat'] = (float) $lat;
        $vessel['lon'] = (float) $lon;
        $vessel['positionAt'] = $nowMs;
    }
    if ($report !== null) {
        $vessel['sogKn'] = mrt_ais_sog($report['Sog'] ?? null);
        $vessel['cogDeg'] = mrt_ais_cog($report['Cog'] ?? null);
        $vessel['headingDeg'] = mrt_ais_heading($report['TrueHeading'] ?? null);
        if (array_key_exists('NavigationalStatus', $report)) {
            $vessel['navStatus'] = $report['NavigationalStatus'] ?? $vessel['navStatus'];
        }
    }
    if ($hasFix) {
        // Record AFTER the kinematics update, so a MetaData-only fix
        // (static report) carries the last known speed and course.
        $vessel['track'][] = [$nowMs, $vessel['lat'], $vessel['lon'],
            $vessel['sogKn'], $vessel['cogDeg'], $vessel['headingDeg']];
        $track = [];
        foreach ($vessel['track'] as $point) {
            if ($nowMs - $point[0] <= MRT_AIS_TRACK_KEEP_MS) $track[] = $point;
        }
        $vessel['track'] = array_slice($track, -MRT_AIS_TRACK_MAX_POINTS);
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
    [$length, $width] = mrt_ais_dimensions($staticData['Dimension'] ?? $reportB['Dimension'] ?? null);
    if ($length !== null) $vessel['lengthM'] = $length;
    if ($width !== null) $vessel['widthM'] = $width;

    if ($vessel['lat'] !== null) $state[$mmsi] = $vessel;
}

/**
 * Lists vessels with a fresh position, sorted by MMSI. Stale records
 * stay in the state as memory until MRT_AIS_STATIC_KEEP_MS – see the
 * constant above.
 */
function mrt_ais_vessels(array &$state, int $nowMs): array
{
    $fresh = [];
    foreach ($state as $mmsi => $vessel) {
        $age = $nowMs - $vessel['positionAt'];
        if ($age > MRT_AIS_STATIC_KEEP_MS) {
            unset($state[$mmsi]);
        } elseif ($age <= MRT_AIS_EXPIRE_MS) {
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
function mrt_ws_send($fp, int $opcode, string $payload): void
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
function mrt_ws_parse(string &$buffer): ?array
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
 * One listen window: connect, subscribe, merge everything heard into
 * $state. Failures are silent by design – the previous state stays.
 */
function mrt_ais_listen(
    array &$state,
    string $apiKey,
    int $listenSeconds,
    ?callable $onFlush = null,
    ?float $hardDeadline = null
): bool {
    $context = stream_context_create(['ssl' => ['peer_name' => MRT_AIS_HOST]]);
    $fp = @stream_socket_client(
        'ssl://' . MRT_AIS_HOST . ':443', $errno, $errstr, 10, STREAM_CLIENT_CONNECT, $context
    );
    if ($fp === false) return false;

    $wsKey = base64_encode(random_bytes(16));
    fwrite($fp,
        'GET ' . MRT_AIS_PATH . " HTTP/1.1\r\n" .
        'Host: ' . MRT_AIS_HOST . "\r\n" .
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

    mrt_ws_send($fp, 0x1, json_encode(['APIKey' => $apiKey, 'BoundingBoxes' => [MRT_AIS_BBOX]]));

    $fragment = '';
    $heard = false;
    stream_set_timeout($fp, 1);
    $deadline = microtime(true) + $listenSeconds;
    if ($hardDeadline !== null && $hardDeadline < $deadline) $deadline = $hardDeadline;
    $nextFlush = microtime(true) + MRT_AIS_FLUSH_SECONDS;
    while (microtime(true) < $deadline) {
        $closed = false;
        while (($frame = mrt_ws_parse($buffer)) !== null) {
            switch ($frame['opcode']) {
                case 0x0:
                case 0x1:
                case 0x2:
                    $fragment .= $frame['payload'];
                    if ($frame['fin']) {
                        $message = json_decode($fragment, true);
                        $fragment = '';
                        if (is_array($message)) {
                            mrt_ais_merge($state, $message, mrt_now_ms());
                            $heard = true;
                        }
                    }
                    break;
                case 0x8:
                    $closed = true;
                    break;
                case 0x9:
                    mrt_ws_send($fp, 0xA, $frame['payload']);
                    break;
            }
            if ($closed) break;
        }
        if ($closed) break;
        if ($onFlush !== null && $heard && microtime(true) >= $nextFlush) {
            $onFlush($state);
            $nextFlush = microtime(true) + MRT_AIS_FLUSH_SECONDS;
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

function mrt_now_ms(): int
{
    return (int) round(microtime(true) * 1000);
}

function mrt_ais_key(): string
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
function mrt_ais_load(string $stateFile): array
{
    $raw = @file_get_contents($stateFile);
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($data) || !is_array($data['state'] ?? null)) {
        return ['listenedAt' => 0, 'state' => []];
    }
    // JSON object keys arrive as strings – vessels are keyed by int MMSI.
    $state = [];
    foreach ($data['state'] as $mmsi => $vessel) {
        // States written before the track existed migrate to an empty
        // one – the playback then holds the top-level fix.
        if (!is_array($vessel['track'] ?? null)) $vessel['track'] = [];
        $state[(int) $mmsi] = $vessel;
    }
    return ['listenedAt' => (int) ($data['listenedAt'] ?? 0), 'state' => $state];
}

function mrt_ais_save(string $stateFile, array $state, int $listenedAt): void
{
    $tmp = $stateFile . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode(['listenedAt' => $listenedAt, 'state' => $state]));
    rename($tmp, $stateFile);
}

function mrt_ais_respond(array $state, int $listenedAt): void
{
    $nowMs = mrt_now_ms();
    // servedAt is the clock-skew anchor: positionAt stamps only compare
    // to the client's clock through the moment THIS response left, not
    // through the (possibly much older) moment the state was written.
    echo json_encode([
        'timestamp' => $listenedAt,
        'servedAt' => $nowMs,
        'vessels' => mrt_ais_vessels($state, $nowMs),
    ]);
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
        if (is_array($message)) mrt_ais_merge($state, $message, $nowMs);
    }
    echo json_encode(['timestamp' => $nowMs, 'vessels' => mrt_ais_vessels($state, $nowMs)]), "\n";
    exit(0);
}

// --- HTTP entry ------------------------------------------------------------
header('Content-Type: application/json');
header('Cache-Control: no-store');

$apiKey = mrt_ais_key();
if ($apiKey === '') {
    http_response_code(503);
    echo json_encode(['error' => 'No aisstream API key configured (see header comment of ais.php)']);
    exit;
}

$stateFile = sys_get_temp_dir() . '/mrt-ais-state.json';
$lockFile = sys_get_temp_dir() . '/mrt-ais-state.lock';

$data = mrt_ais_load($stateFile);
// A request that names its own window is the keeper cron. Freshness must
// not silence it: the browser's short windows hold the state inside the
// TTL almost continuously, so a keeper that trusted that freshness would
// answer from the cache and skip its window nearly every minute – which
// is the one thing it was deployed to prevent.
$keeper = isset($_GET['listen']);
// Freshness keys on when the last window STARTED: a long window must not
// push the next one further out – the blind gap between windows is what
// a moving ship's jump grows with.
$ageSeconds = (mrt_now_ms() - $data['listenedAt']) / 1000;
if (!$keeper && $ageSeconds <= MRT_AIS_TTL_SECONDS) {
    mrt_ais_respond($data['state'], $data['listenedAt']);
    exit;
}

// Answer from the state either way, then listen with the response gone –
// nobody waits on a window, not even while the keeper queues for the lock.
mrt_ais_respond($data['state'], $data['listenedAt']);
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
    $waitUntil = microtime(true) + MRT_AIS_LOCK_WAIT_SECONDS;
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
$listenSeconds = max(5, min(MRT_AIS_LISTEN_MAX_SECONDS, (int) ($_GET['listen'] ?? MRT_AIS_LISTEN_SECONDS)));
$requestStart = (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
$windowStart = mrt_now_ms();
// Re-read the state now that the lock is ours: a keeper that queued
// behind another window would otherwise save its pre-wait snapshot and
// silently drop every track point that window just recorded.
$data = mrt_ais_load($stateFile);
$state = $data['state'];
$flush = function (array $flushState) use ($stateFile, $windowStart): void {
    mrt_ais_vessels($flushState, mrt_now_ms()); // expiry prunes the copy
    mrt_ais_save($stateFile, $flushState, $windowStart);
};
$heard = mrt_ais_listen(
    $state,
    $apiKey,
    $listenSeconds,
    $flush,
    $requestStart + MRT_AIS_WALL_BUDGET_SECONDS
);
if ($heard) {
    // A window that never even reached the stream keeps the old
    // listenedAt – the next request retries right away instead of
    // trusting a freshness the failed window did not earn.
    $nowMs = mrt_now_ms();
    mrt_ais_vessels($state, $nowMs); // expiry prunes in place
    mrt_ais_save($stateFile, $state, $windowStart);
}
flock($lock, LOCK_UN);
fclose($lock);
