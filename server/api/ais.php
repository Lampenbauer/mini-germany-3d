<?php
/**
 * AIS vessel positions for the Rostock map, from aisstream.io – on shared
 * hosting, which cannot hold a WebSocket open permanently. Every refresh
 * therefore opens the stream for a short listen window, merges what it
 * heard into a persistent state file, and closes again. Ships under way
 * report every 2–30 s and are caught by every window; moored ships report
 * every 3 minutes and trickle in over the first windows – harmless, since
 * a moored ship's last position is still exactly where it is.
 *
 * Response (also served while a refresh is still pending):
 *   { "timestamp": <unix ms of the state>, "vessels": [ { mmsi, name,
 *     lat, lon, sogKn, cogDeg, headingDeg, navStatus, typeCode,
 *     lengthM, widthM, positionAt }, ... ] }
 *
 * The browser is always answered from the state file. When it has gone
 * stale, the request that noticed responds first (stale beats waiting
 * 12 s) and runs the listen window after fastcgi_finish_request. A lock
 * keeps concurrent listeners to one – which also respects aisstream's
 * 3-connections-per-account limit.
 *
 * A keeper cron may call this endpoint with ?listen=45 (capped): longer
 * windows shrink the blind gaps between them, which is what keeps fast
 * movers like the Gedser ferry from freezing and jumping.
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
/** State age at which a request triggers the next listen window. */
const MRT_AIS_TTL_SECONDS = 40;
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
/** Vessels drop out after this long without a position (mirror of ais-extract.ts). */
const MRT_AIS_EXPIRE_MS = 30 * 60_000;

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
    ];

    // Position: the message payload is authoritative (full precision), the
    // MetaData copy fills in for static reports.
    $report = $raw['Message']['PositionReport']
        ?? $raw['Message']['StandardClassBPositionReport']
        ?? null;
    $lat = $report['Latitude'] ?? $meta['latitude'] ?? null;
    $lon = $report['Longitude'] ?? $meta['longitude'] ?? null;
    if (is_numeric($lat) && is_numeric($lon) && abs((float) $lat) <= 90) {
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

/** Expires stale vessels and returns the list sorted by MMSI. */
function mrt_ais_vessels(array &$state, int $nowMs): array
{
    foreach ($state as $mmsi => $vessel) {
        if ($nowMs - $vessel['positionAt'] > MRT_AIS_EXPIRE_MS) unset($state[$mmsi]);
    }
    ksort($state);
    return array_values($state);
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
// Freshness keys on when the last window STARTED: a long window must not
// push the next one further out – the blind gap between windows is what
// a moving ship's jump grows with.
$ageSeconds = (mrt_now_ms() - $data['listenedAt']) / 1000;
if ($ageSeconds <= MRT_AIS_TTL_SECONDS) {
    mrt_ais_respond($data['state'], $data['listenedAt']);
    exit;
}

$lock = fopen($lockFile, 'c');
$haveLock = $lock !== false && flock($lock, LOCK_EX | LOCK_NB);
if (!$haveLock) {
    // Another request is already listening – stale is better than waiting.
    mrt_ais_respond($data['state'], $data['listenedAt']);
    if ($lock !== false) fclose($lock);
    exit;
}

// Serve the stale answer first, then listen with the response already gone.
mrt_ais_respond($data['state'], $data['listenedAt']);
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
} else {
    flush();
}

// The cron may ask for a longer window (?listen=45): higher listening
// duty cycle, smaller blind gaps, smoother ships – same single lock.
$listenSeconds = max(5, min(MRT_AIS_LISTEN_MAX_SECONDS, (int) ($_GET['listen'] ?? MRT_AIS_LISTEN_SECONDS)));
set_time_limit(60);
$requestStart = (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
$windowStart = mrt_now_ms();
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
