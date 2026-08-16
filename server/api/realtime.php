<?php
/**
 * Gefilterter GTFS-Realtime-Endpunkt für Shared Hosting (all-inkl):
 * lädt den deutschlandweiten Feed https://realtime.gtfs.de/realtime-free.pb
 * (>10 MB Protobuf) höchstens einmal pro Minute, filtert ihn auf die
 * Rostocker trip_ids aus schedule.json (liegt neben diesem Skript) und
 * liefert dem Browser nur ein kleines JSON:
 *
 *   { "timestamp": <Feed-Unix-Sekunden>, "total": <Entities gesamt>,
 *     "delays": { "<gtfs_trip_id>": <Verspätung in Sekunden>, ... } }
 *
 * Der Protobuf-Parser liest nur die benötigten GTFS-RT-Felder
 * (FeedMessage → entity → trip_update → trip.trip_id / delay /
 * stop_time_update.departure|arrival.delay) direkt aus dem Wire-Format –
 * ohne Composer-Abhängigkeiten.
 *
 * Selbsttest (CLI, ohne Netzwerk):
 *   php realtime.php --selftest feed.pb schedule.json
 */

declare(strict_types=1);

const MRT_UPSTREAM_URL = 'https://realtime.gtfs.de/realtime-free.pb';
const MRT_CACHE_TTL_SECONDS = 60;
const MRT_UPSTREAM_TIMEOUT = 30;

// ---------------------------------------------------------------------------
// Mini-Protobuf-Reader (Wire-Format)
// ---------------------------------------------------------------------------

/**
 * Liest einen Varint ab $pos. 64-Bit-Zweierkomplement über PHP-Ints:
 * negative int32 (10-Byte-Varints) ergeben automatisch den korrekten
 * negativen Wert. Shifts > 63 verwirft PHP als 0.
 */
function mrt_pb_varint(string $data, int &$pos): int
{
    $result = 0;
    $shift = 0;
    $len = strlen($data);
    while ($pos < $len) {
        $byte = ord($data[$pos++]);
        if ($shift < 64) {
            $result |= ($byte & 0x7F) << $shift;
        }
        if (($byte & 0x80) === 0) {
            return $result;
        }
        $shift += 7;
        if ($shift > 70) {
            throw new RuntimeException('Varint zu lang');
        }
    }
    throw new RuntimeException('Unerwartetes Datenende im Varint');
}

/** Überspringt ein Feld des angegebenen Wire-Types. */
function mrt_pb_skip(string $data, int &$pos, int $wire): void
{
    switch ($wire) {
        case 0: // Varint
            mrt_pb_varint($data, $pos);
            break;
        case 1: // fixed64
            $pos += 8;
            break;
        case 2: // length-delimited
            $len = mrt_pb_varint($data, $pos);
            $pos += $len;
            break;
        case 5: // fixed32
            $pos += 4;
            break;
        default:
            throw new RuntimeException("Unbekannter Wire-Type $wire");
    }
}

/** Liest ein length-delimited Feld und liefert den Teilstring. */
function mrt_pb_bytes(string $data, int &$pos): string
{
    $len = mrt_pb_varint($data, $pos);
    $bytes = substr($data, $pos, $len);
    $pos += $len;
    return $bytes;
}

// ---------------------------------------------------------------------------
// GTFS-RT-spezifische Extraktion
// ---------------------------------------------------------------------------

/** StopTimeEvent: { delay = Feld 1 (int32) } – null, wenn nicht gesetzt. */
function mrt_stop_time_event_delay(string $data): ?int
{
    $pos = 0;
    $len = strlen($data);
    while ($pos < $len) {
        $tag = mrt_pb_varint($data, $pos);
        if (($tag >> 3) === 1 && ($tag & 7) === 0) {
            return mrt_pb_varint($data, $pos);
        }
        mrt_pb_skip($data, $pos, $tag & 7);
    }
    return null;
}

/**
 * TripUpdate: trip = Feld 1, stop_time_update = Feld 2 (repeated),
 * delay = Feld 5 (int32). Liefert [trip_id, delay|null].
 */
function mrt_trip_update_extract(string $data): array
{
    $pos = 0;
    $len = strlen($data);
    $tripId = null;
    $tripUpdateDelay = null;
    $firstStopDelay = null;

    while ($pos < $len) {
        $tag = mrt_pb_varint($data, $pos);
        $field = $tag >> 3;
        $wire = $tag & 7;

        if ($field === 1 && $wire === 2) { // TripDescriptor
            $trip = mrt_pb_bytes($data, $pos);
            $tPos = 0;
            $tLen = strlen($trip);
            while ($tPos < $tLen) {
                $tTag = mrt_pb_varint($trip, $tPos);
                if (($tTag >> 3) === 1 && ($tTag & 7) === 2) { // trip_id
                    $tripId = mrt_pb_bytes($trip, $tPos);
                } else {
                    mrt_pb_skip($trip, $tPos, $tTag & 7);
                }
            }
        } elseif ($field === 5 && $wire === 0) { // trip_update.delay
            $tripUpdateDelay = mrt_pb_varint($data, $pos);
        } elseif ($field === 2 && $wire === 2 && $firstStopDelay === null) {
            // StopTimeUpdate: departure = Feld 3, arrival = Feld 2
            $stu = mrt_pb_bytes($data, $pos);
            $sPos = 0;
            $sLen = strlen($stu);
            $departure = null;
            $arrival = null;
            while ($sPos < $sLen) {
                $sTag = mrt_pb_varint($stu, $sPos);
                $sField = $sTag >> 3;
                if ($sField === 3 && ($sTag & 7) === 2) {
                    $departure = mrt_stop_time_event_delay(mrt_pb_bytes($stu, $sPos));
                } elseif ($sField === 2 && ($sTag & 7) === 2) {
                    $arrival = mrt_stop_time_event_delay(mrt_pb_bytes($stu, $sPos));
                } else {
                    mrt_pb_skip($stu, $sPos, $sTag & 7);
                }
            }
            $firstStopDelay = $departure ?? $arrival;
        } else {
            mrt_pb_skip($data, $pos, $wire);
        }
    }

    return [$tripId, $tripUpdateDelay ?? $firstStopDelay];
}

/**
 * FeedMessage: header = Feld 1, entity = Feld 2 (repeated).
 * Liefert [timestamp, totalEntities, delays(trip_id → Sekunden)].
 */
function mrt_extract_delays(string $data, array $tripIdSet): array
{
    $pos = 0;
    $len = strlen($data);
    $timestamp = 0;
    $total = 0;
    $delays = [];

    while ($pos < $len) {
        $tag = mrt_pb_varint($data, $pos);
        $field = $tag >> 3;
        $wire = $tag & 7;

        if ($field === 1 && $wire === 2) { // FeedHeader: timestamp = Feld 3
            $header = mrt_pb_bytes($data, $pos);
            $hPos = 0;
            $hLen = strlen($header);
            while ($hPos < $hLen) {
                $hTag = mrt_pb_varint($header, $hPos);
                if (($hTag >> 3) === 3 && ($hTag & 7) === 0) {
                    $timestamp = mrt_pb_varint($header, $hPos);
                } else {
                    mrt_pb_skip($header, $hPos, $hTag & 7);
                }
            }
        } elseif ($field === 2 && $wire === 2) { // FeedEntity
            $entity = mrt_pb_bytes($data, $pos);
            $total++;
            $ePos = 0;
            $eLen = strlen($entity);
            while ($ePos < $eLen) {
                $eTag = mrt_pb_varint($entity, $ePos);
                if (($eTag >> 3) === 3 && ($eTag & 7) === 2) { // trip_update
                    [$tripId, $delay] = mrt_trip_update_extract(mrt_pb_bytes($entity, $ePos));
                    if ($tripId !== null && $delay !== null && isset($tripIdSet[$tripId])) {
                        $delays[$tripId] = $delay;
                    }
                } else {
                    mrt_pb_skip($entity, $ePos, $eTag & 7);
                }
            }
        } else {
            mrt_pb_skip($data, $pos, $wire);
        }
    }

    return [$timestamp, $total, $delays];
}

/** Rostocker trip_ids aus schedule.json als Set (Keys). */
function mrt_load_trip_ids(string $schedulePath): array
{
    $schedule = json_decode((string) file_get_contents($schedulePath), true);
    $set = [];
    foreach (($schedule['lines'] ?? []) as $dirs) {
        foreach ($dirs as $dir) {
            foreach (($dir['tripIds'] ?? []) as $id) {
                $set[$id] = true;
            }
        }
    }
    return $set;
}

function mrt_build_response(string $feedData, array $tripIdSet): string
{
    [$timestamp, $total, $delays] = mrt_extract_delays($feedData, $tripIdSet);
    return json_encode([
        'timestamp' => $timestamp,
        'total' => $total,
        'delays' => $delays === [] ? new stdClass() : $delays,
    ], JSON_UNESCAPED_SLASHES);
}

// ---------------------------------------------------------------------------
// CLI-Selbsttest:  php realtime.php --selftest feed.pb schedule.json
// ---------------------------------------------------------------------------

if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--selftest') {
    $feed = (string) file_get_contents($argv[2]);
    $tripIds = mrt_load_trip_ids($argv[3]);
    echo mrt_build_response($feed, $tripIds), "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// HTTP-Endpunkt mit Datei-Cache (60 s, stale-while-error)
// ---------------------------------------------------------------------------

header('Content-Type: application/json');
header('Cache-Control: no-store');

$cacheFile = sys_get_temp_dir() . '/mrt-realtime-cache.json';
$lockFile = sys_get_temp_dir() . '/mrt-realtime-cache.lock';

$cacheAge = is_file($cacheFile) ? time() - (int) filemtime($cacheFile) : PHP_INT_MAX;
if ($cacheAge <= MRT_CACHE_TTL_SECONDS) {
    readfile($cacheFile);
    exit;
}

$lock = fopen($lockFile, 'c');
$haveLock = $lock !== false && flock($lock, LOCK_EX | LOCK_NB);

if (!$haveLock) {
    // Ein anderer Request aktualisiert gerade → alte Daten liefern (oder warten)
    if (is_file($cacheFile)) {
        readfile($cacheFile);
        exit;
    }
    if ($lock !== false) {
        flock($lock, LOCK_EX); // blockierend warten, bis der Cache existiert
        flock($lock, LOCK_UN);
    }
    if (is_file($cacheFile)) {
        readfile($cacheFile);
        exit;
    }
    http_response_code(502);
    echo json_encode(['error' => 'Realtime-Cache nicht verfügbar']);
    exit;
}

try {
    $ch = curl_init(MRT_UPSTREAM_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => MRT_UPSTREAM_TIMEOUT,
        CURLOPT_USERAGENT => 'mini-rostock-3d/1.0 (+https://github.com/Lampenbauer/mini-rostock-3d)',
        CURLOPT_ENCODING => '', // gzip erlauben
    ]);
    $feedData = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if (!is_string($feedData) || $status !== 200) {
        throw new RuntimeException("Upstream HTTP $status");
    }

    $tripIds = mrt_load_trip_ids(__DIR__ . '/schedule.json');
    $json = mrt_build_response($feedData, $tripIds);

    // Atomar schreiben, damit parallele Leser nie halbe Dateien sehen
    $tmp = $cacheFile . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, $json);
    rename($tmp, $cacheFile);

    echo $json;
} catch (Throwable $error) {
    if (is_file($cacheFile)) {
        // Veraltete Daten sind besser als keine
        readfile($cacheFile);
    } else {
        http_response_code(502);
        echo json_encode(['error' => $error->getMessage()]);
    }
} finally {
    if ($lock !== false) {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}
