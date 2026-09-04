<?php
/**
 * One-shot diagnostic: can THIS host (all-inkl shared hosting) consume the
 * aisstream.io WebSocket from PHP? Probes every layer the planned AIS
 * proxy would need – raw TLS socket, WebSocket handshake, subscription,
 * frame parsing – and reports each step separately, so a failure names
 * the exact layer that is blocked.
 *
 * Usage:
 *   CLI:   php ais-test.php <api-key> [seconds]
 *   HTTP:  curl -X POST -d 'key=<api-key>' -d 'seconds=20' https://<domain>/api/ais-test.php
 *
 * The key is deliberately NOT accepted as a GET parameter – query strings
 * end up in access logs. Delete this file once the question is answered;
 * it holds no secrets, but it has no business being reachable forever.
 */

declare(strict_types=1);

const AIS_HOST = 'stream.aisstream.io';
const AIS_PATH = '/v0/stream';
/**
 * Every city's bounding box as aisstream wants it ([[lat, lon] SW,
 * [lat, lon] NE]), from cities/<slug>/city.json – the definitions the
 * whole project shares (src/cities/). Looked for next to this script
 * (copy them along to the host) and in a repository checkout two levels up.
 */
function aisBbox(): array
{
    foreach ([__DIR__ . '/cities', __DIR__ . '/../../src/cities'] as $dir) {
        $files = glob($dir . '/*/city.json');
        if (!is_array($files) || $files === []) continue;
        $boxes = [];
        foreach ($files as $file) {
            $data = json_decode((string) file_get_contents($file), true);
            $box = is_array($data) ? ($data['boundingBox'] ?? null) : null;
            if (is_array($box) && isset($box['west'], $box['south'], $box['east'], $box['north'])) {
                $boxes[] = [
                    [(float) $box['south'], (float) $box['west']],
                    [(float) $box['north'], (float) $box['east']],
                ];
            }
        }
        if ($boxes !== []) return $boxes;
    }
    exit("No cities/<slug>/city.json found - copy the src/cities folders next to this script.\n");
}

// Shortest round-trip floats in json_encode – some hosts pin
// serialize_precision high, which turns 53.83 into a 48-digit monster.
ini_set('serialize_precision', '-1');

$isCli = PHP_SAPI === 'cli';
if (!$isCli) {
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Accel-Buffering: no');
}

if (!$isCli && isset($_GET['key'])) {
    http_response_code(400);
    exit("Refusing the key as a GET parameter (it would land in access logs). POST it instead:\n" .
        "  curl -X POST -d 'key=...' https://<domain>/api/ais-test.php\n");
}

$key = $isCli ? (string) ($argv[1] ?? '') : (string) ($_POST['key'] ?? '');
$listenSeconds = (int) ($isCli ? ($argv[2] ?? 20) : ($_POST['seconds'] ?? 20));
$listenSeconds = max(5, min(60, $listenSeconds));

if ($key === '') {
    if (!$isCli) http_response_code(400);
    exit("Usage:\n  CLI:   php ais-test.php <api-key> [seconds]\n" .
        "  HTTP:  curl -X POST -d 'key=<api-key>' -d 'seconds=20' https://<domain>/api/ais-test.php\n");
}
$bbox = aisBbox();

function say(string $line): void
{
    echo $line, "\n";
    flush();
}

function step(string $label, bool $ok, string $detail = ''): void
{
    say(sprintf('[%s] %s%s', $ok ? 'OK' : '!!', $label, $detail !== '' ? ' - ' . $detail : ''));
}

/** Sends one masked client frame (RFC 6455: client frames MUST be masked). */
function wsSend($fp, int $opcode, string $payload): void
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

/**
 * Extracts one complete frame from the front of $buffer, or null while the
 * frame is still partial. Server frames arrive unmasked; the masked branch
 * is handled anyway for robustness.
 */
function wsParseFrame(string &$buffer): ?array
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

/** Folds one decoded aisstream JSON message into the running statistics. */
function noteMessage(string $text, array &$stats): void
{
    $message = json_decode($text, true);
    if (!is_array($message)) {
        $stats['types']['(not JSON)'] = ($stats['types']['(not JSON)'] ?? 0) + 1;
        return;
    }
    if (isset($message['error']) && $message['error'] !== '') {
        $stats['error'] = (string) $message['error'];
        return;
    }
    $type = (string) ($message['MessageType'] ?? '(no MessageType)');
    if ($type === 'SubscriptionConfirmation') {
        $stats['confirmed'] = true;
    }
    $stats['messages']++;
    $stats['types'][$type] = ($stats['types'][$type] ?? 0) + 1;
    $meta = $message['MetaData'] ?? [];
    if (isset($meta['MMSI'])) {
        $stats['ships'][(string) $meta['MMSI']] = true;
    }
    if (count($stats['samples']) < 5 && isset($meta['latitude'], $meta['longitude'])) {
        $stats['samples'][] = sprintf(
            '%-10s %-22s %9.4f %9.4f  %s',
            (string) ($meta['MMSI'] ?? '?'),
            trim((string) ($meta['ShipName'] ?? '')),
            (float) $meta['latitude'],
            (float) $meta['longitude'],
            $type
        );
    }
}

say('aisstream.io WebSocket diagnostic');
say(str_repeat('=', 48));
say('PHP ' . PHP_VERSION . ' (' . PHP_SAPI . '), max_execution_time=' . ini_get('max_execution_time'));
step('stream_socket_client available', function_exists('stream_socket_client'));
step('ssl:// transport available', in_array('ssl', stream_get_transports(), true),
    implode(' ', stream_get_transports()));
step('fastcgi_finish_request (for the later proxy)', function_exists('fastcgi_finish_request'),
    PHP_SAPI === 'cli' ? 'missing under CLI is normal - only FPM has it' : '');
set_time_limit($listenSeconds + 40);

// --- DNS ------------------------------------------------------------------
$ip = gethostbyname(AIS_HOST);
step('DNS ' . AIS_HOST, $ip !== AIS_HOST, $ip);

// --- TCP + TLS ------------------------------------------------------------
$t0 = microtime(true);
$context = stream_context_create(['ssl' => ['peer_name' => AIS_HOST]]);
$fp = @stream_socket_client(
    'ssl://' . AIS_HOST . ':443', $errno, $errstr, 10, STREAM_CLIENT_CONNECT, $context
);
step('TLS connect :443', $fp !== false,
    $fp !== false ? sprintf('%.0f ms', (microtime(true) - $t0) * 1000) : trim($errno . ' ' . $errstr));
if ($fp === false) {
    say('');
    say('VERDICT: FAILED - outbound raw TLS sockets are blocked on this host.');
    exit(1);
}

// --- WebSocket handshake --------------------------------------------------
$wsKey = base64_encode(random_bytes(16));
fwrite($fp,
    'GET ' . AIS_PATH . " HTTP/1.1\r\n" .
    'Host: ' . AIS_HOST . "\r\n" .
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
if ($headerEnd === false) {
    step('WebSocket handshake', false, 'no HTTP response within 5 s');
    say('');
    say('VERDICT: FAILED - connection stands but the upgrade got no answer.');
    exit(1);
}
$headers = substr($buffer, 0, $headerEnd);
// Bytes past the header block are already frames - keep them.
$buffer = substr($buffer, $headerEnd + 4);
$statusLine = strtok($headers, "\r\n");
$is101 = (bool) preg_match('#^HTTP/1\.[01] 101#', $headers);
$expectedAccept = base64_encode(sha1($wsKey . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
step('WebSocket handshake (HTTP 101)', $is101, $statusLine);
step('Sec-WebSocket-Accept valid', stripos($headers, 'Sec-WebSocket-Accept: ' . $expectedAccept) !== false);
if (!$is101) {
    say('');
    say('VERDICT: FAILED - the upgrade was answered with "' . $statusLine . '".');
    exit(1);
}

// --- Subscribe and listen -------------------------------------------------
wsSend($fp, 0x1, json_encode(['APIKey' => $key, 'BoundingBoxes' => $bbox]));
step('Subscription sent', true, 'boxes ' . json_encode($bbox) . ', listening ' . $listenSeconds . ' s');

$stats = [
    'messages' => 0, 'types' => [], 'ships' => [], 'samples' => [],
    'confirmed' => false, 'error' => null, 'close' => null,
];
$fragment = '';
stream_set_timeout($fp, 1);
$deadline = microtime(true) + $listenSeconds;

while (microtime(true) < $deadline && $stats['error'] === null && $stats['close'] === null) {
    while (($frame = wsParseFrame($buffer)) !== null) {
        switch ($frame['opcode']) {
            case 0x0: // continuation
            case 0x1: // text
            case 0x2: // binary (aisstream sends JSON either way)
                $fragment .= $frame['payload'];
                if ($frame['fin']) {
                    noteMessage($fragment, $stats);
                    $fragment = '';
                }
                break;
            case 0x8: // close
                $code = strlen($frame['payload']) >= 2
                    ? (string) unpack('n', substr($frame['payload'], 0, 2))[1]
                    : '?';
                $stats['close'] = $code . ' ' . substr($frame['payload'], 2);
                break;
            case 0x9: // ping -> pong, mandatory to stay connected
                wsSend($fp, 0xA, $frame['payload']);
                break;
        }
        if ($stats['error'] !== null || $stats['close'] !== null) break;
    }
    if ($stats['error'] !== null || $stats['close'] !== null) break;
    $chunk = fread($fp, 8192);
    if ($chunk !== false && $chunk !== '') {
        $buffer .= $chunk;
        continue;
    }
    if (feof($fp)) {
        $stats['close'] = 'EOF without close frame';
        break;
    }
}
fclose($fp);

// --- Report ---------------------------------------------------------------
say('');
say('Result:');
say('  messages: ' . $stats['messages'] . ' from ' . count($stats['ships']) . ' distinct ships');
foreach ($stats['types'] as $type => $count) {
    say('    ' . $type . ': ' . $count);
}
if ($stats['samples'] !== []) {
    say('  samples (MMSI, name, lat, lon, type):');
    foreach ($stats['samples'] as $sample) {
        say('    ' . $sample);
    }
}
if ($stats['error'] !== null) say('  server error: ' . $stats['error']);
if ($stats['close'] !== null) say('  connection closed: ' . $stats['close']);
say('');

$positionReports = 0;
foreach ($stats['types'] as $type => $count) {
    if (stripos((string) $type, 'PositionReport') !== false) $positionReports += $count;
}
if ($stats['error'] !== null) {
    say('VERDICT: FAILED - the server rejected the subscription (check the API key).');
} elseif ($positionReports > 0) {
    say('VERDICT: SUCCESS - this host can consume the aisstream WebSocket. ' .
        $positionReports . ' position reports in ' . $listenSeconds . ' s.');
} elseif ($stats['confirmed']) {
    say('VERDICT: PARTIAL - subscription confirmed but no position report in the window. ' .
        'Raise seconds or retry; harbor traffic varies.');
} elseif (!$stats['confirmed'] && $stats['close'] !== null) {
    say('VERDICT: FAILED - the server dropped the connection before confirming the ' .
        'subscription. That is how aisstream answers an invalid API key: no error ' .
        'text, just a hangup. Check the key first.');
} else {
    say('VERDICT: FAILED - handshake fine, but no data arrived. Details above.');
}
