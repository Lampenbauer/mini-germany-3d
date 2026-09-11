<?php
/**
 * Filtered GTFS-Realtime endpoint for shared hosting (all-inkl):
 * fetches the Germany-wide feed https://realtime.gtfs.de/realtime-free.pb
 * (>10 MB protobuf) at most once per minute, filters it down to the
 * trip_ids of the city asked for (?city=<slug>, default rostock) from
 * cities/<slug>/schedule.json next to this script, and returns only a
 * small JSON payload to the browser:
 *
 *   { "timestamp": <feed Unix seconds>, "total": <total entities>,
 *     "delays": { "<gtfs_trip_id>": <delay in seconds>, ... } }
 *
 * One upstream fetch serves every city: the raw feed is cached for the
 * TTL, and each city's filtered JSON on top of it.
 *
 * The protobuf parser reads only the required GTFS-RT fields
 * (FeedMessage → entity → trip_update → trip.trip_id / delay /
 * stop_time_update.departure|arrival.delay) directly from the wire format —
 * no Composer dependencies.
 *
 * Self-test (CLI, no network):
 *   php realtime.php --selftest feed.pb schedule.json
 */

declare(strict_types=1);

const MG3D_UPSTREAM_URL = 'https://realtime.gtfs.de/realtime-free.pb';
const MG3D_CACHE_TTL_SECONDS = 60;
const MG3D_UPSTREAM_TIMEOUT = 30;
const MG3D_DEFAULT_CITY = 'rostock';
/** Where cities/<slug>/schedule.json is looked for: next to the script (the deploy), then the checkout. */
const MG3D_CITY_DIRS = [__DIR__ . '/cities', __DIR__ . '/../../src/cities'];

/**
 * The city a request names (?city=<slug>), as a slug – or null for one
 * that does not look like a slug at all. Whether it exists is decided by
 * the schedule lookup below.
 */
function mg3d_city_slug(): ?string
{
    $slug = $_GET['city'] ?? MG3D_DEFAULT_CITY;
    return is_string($slug) && preg_match('/^[a-z][a-z0-9-]{0,63}$/', $slug) === 1 ? $slug : null;
}

/** The city's schedule.json, or null when no city of that slug is deployed. */
function mg3d_city_schedule(string $slug): ?string
{
    foreach (MG3D_CITY_DIRS as $dir) {
        $file = $dir . '/' . $slug . '/schedule.json';
        if (is_file($file)) return $file;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Mini protobuf reader (wire format)
// ---------------------------------------------------------------------------

/**
 * Reads a varint starting at $pos. 64-bit two's complement via PHP ints:
 * negative int32 values (10-byte varints) automatically yield the correct
 * negative result. PHP discards shifts > 63 as 0.
 */
function mg3d_pb_varint(string $data, int &$pos): int
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
            throw new RuntimeException('Varint too long');
        }
    }
    throw new RuntimeException('Unexpected end of data in varint');
}

/** Skips a field of the given wire type. */
function mg3d_pb_skip(string $data, int &$pos, int $wire): void
{
    switch ($wire) {
        case 0: // Varint
            mg3d_pb_varint($data, $pos);
            break;
        case 1: // fixed64
            $pos += 8;
            break;
        case 2: // length-delimited
            $len = mg3d_pb_varint($data, $pos);
            $pos += $len;
            break;
        case 5: // fixed32
            $pos += 4;
            break;
        default:
            throw new RuntimeException("Unknown wire type $wire");
    }
}

/** Reads a length-delimited field and returns the substring. */
function mg3d_pb_bytes(string $data, int &$pos): string
{
    $len = mg3d_pb_varint($data, $pos);
    $bytes = substr($data, $pos, $len);
    $pos += $len;
    return $bytes;
}

// ---------------------------------------------------------------------------
// GTFS-RT-specific extraction
// ---------------------------------------------------------------------------

/** StopTimeEvent: { delay = field 1 (int32) } — null if not set. */
function mg3d_stop_time_event_delay(string $data): ?int
{
    $pos = 0;
    $len = strlen($data);
    while ($pos < $len) {
        $tag = mg3d_pb_varint($data, $pos);
        if (($tag >> 3) === 1 && ($tag & 7) === 0) {
            return mg3d_pb_varint($data, $pos);
        }
        mg3d_pb_skip($data, $pos, $tag & 7);
    }
    return null;
}

/**
 * TripUpdate: trip = field 1, stop_time_update = field 2 (repeated),
 * delay = field 5 (int32). Returns [trip_id, delay|null].
 */
function mg3d_trip_update_extract(string $data): array
{
    $pos = 0;
    $len = strlen($data);
    $tripId = null;
    $tripUpdateDelay = null;
    $firstStopDelay = null;

    while ($pos < $len) {
        $tag = mg3d_pb_varint($data, $pos);
        $field = $tag >> 3;
        $wire = $tag & 7;

        if ($field === 1 && $wire === 2) { // TripDescriptor
            $trip = mg3d_pb_bytes($data, $pos);
            $tPos = 0;
            $tLen = strlen($trip);
            while ($tPos < $tLen) {
                $tTag = mg3d_pb_varint($trip, $tPos);
                if (($tTag >> 3) === 1 && ($tTag & 7) === 2) { // trip_id
                    $tripId = mg3d_pb_bytes($trip, $tPos);
                } else {
                    mg3d_pb_skip($trip, $tPos, $tTag & 7);
                }
            }
        } elseif ($field === 5 && $wire === 0) { // trip_update.delay
            $tripUpdateDelay = mg3d_pb_varint($data, $pos);
        } elseif ($field === 2 && $wire === 2 && $firstStopDelay === null) {
            // StopTimeUpdate: departure = field 3, arrival = field 2
            $stu = mg3d_pb_bytes($data, $pos);
            $sPos = 0;
            $sLen = strlen($stu);
            $departure = null;
            $arrival = null;
            while ($sPos < $sLen) {
                $sTag = mg3d_pb_varint($stu, $sPos);
                $sField = $sTag >> 3;
                if ($sField === 3 && ($sTag & 7) === 2) {
                    $departure = mg3d_stop_time_event_delay(mg3d_pb_bytes($stu, $sPos));
                } elseif ($sField === 2 && ($sTag & 7) === 2) {
                    $arrival = mg3d_stop_time_event_delay(mg3d_pb_bytes($stu, $sPos));
                } else {
                    mg3d_pb_skip($stu, $sPos, $sTag & 7);
                }
            }
            $firstStopDelay = $departure ?? $arrival;
        } else {
            mg3d_pb_skip($data, $pos, $wire);
        }
    }

    return [$tripId, $tripUpdateDelay ?? $firstStopDelay];
}

/**
 * FeedMessage: header = field 1, entity = field 2 (repeated).
 * Returns [timestamp, totalEntities, delays(trip_id → seconds)].
 */
function mg3d_extract_delays(string $data, array $tripIdSet): array
{
    $pos = 0;
    $len = strlen($data);
    $timestamp = 0;
    $total = 0;
    $delays = [];

    while ($pos < $len) {
        $tag = mg3d_pb_varint($data, $pos);
        $field = $tag >> 3;
        $wire = $tag & 7;

        if ($field === 1 && $wire === 2) { // FeedHeader: timestamp = field 3
            $header = mg3d_pb_bytes($data, $pos);
            $hPos = 0;
            $hLen = strlen($header);
            while ($hPos < $hLen) {
                $hTag = mg3d_pb_varint($header, $hPos);
                if (($hTag >> 3) === 3 && ($hTag & 7) === 0) {
                    $timestamp = mg3d_pb_varint($header, $hPos);
                } else {
                    mg3d_pb_skip($header, $hPos, $hTag & 7);
                }
            }
        } elseif ($field === 2 && $wire === 2) { // FeedEntity
            $entity = mg3d_pb_bytes($data, $pos);
            $total++;
            $ePos = 0;
            $eLen = strlen($entity);
            while ($ePos < $eLen) {
                $eTag = mg3d_pb_varint($entity, $ePos);
                if (($eTag >> 3) === 3 && ($eTag & 7) === 2) { // trip_update
                    [$tripId, $delay] = mg3d_trip_update_extract(mg3d_pb_bytes($entity, $ePos));
                    if ($tripId !== null && $delay !== null && isset($tripIdSet[$tripId])) {
                        $delays[$tripId] = $delay;
                    }
                } else {
                    mg3d_pb_skip($entity, $ePos, $eTag & 7);
                }
            }
        } else {
            mg3d_pb_skip($data, $pos, $wire);
        }
    }

    return [$timestamp, $total, $delays];
}

/** A city's trip_ids from its schedule.json as a set (keys). */
function mg3d_load_trip_ids(string $schedulePath): array
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

function mg3d_build_response(string $feedData, array $tripIdSet): string
{
    [$timestamp, $total, $delays] = mg3d_extract_delays($feedData, $tripIdSet);
    return json_encode([
        'timestamp' => $timestamp,
        'total' => $total,
        'delays' => $delays === [] ? new stdClass() : $delays,
    ], JSON_UNESCAPED_SLASHES);
}

// ---------------------------------------------------------------------------
// CLI self-test:  php realtime.php --selftest feed.pb schedule.json
// ---------------------------------------------------------------------------

if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === '--selftest') {
    $feed = (string) file_get_contents($argv[2]);
    $tripIds = mg3d_load_trip_ids($argv[3]);
    echo mg3d_build_response($feed, $tripIds), "\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// HTTP endpoint with file cache (60 s, stale-while-error)
// ---------------------------------------------------------------------------

header('Content-Type: application/json');
header('Cache-Control: no-store');

$slug = mg3d_city_slug();
$schedulePath = $slug === null ? null : mg3d_city_schedule($slug);
if ($slug === null || $schedulePath === null) {
    http_response_code(404);
    echo json_encode(['error' => 'Unknown city']);
    exit;
}

$cacheFile = sys_get_temp_dir() . '/mg3d-realtime-' . $slug . '.json';
$feedFile = sys_get_temp_dir() . '/mg3d-realtime-feed.pb';
$lockFile = sys_get_temp_dir() . '/mg3d-realtime-cache.lock';

$cacheAge = is_file($cacheFile) ? time() - (int) filemtime($cacheFile) : PHP_INT_MAX;
if ($cacheAge <= MG3D_CACHE_TTL_SECONDS) {
    readfile($cacheFile);
    exit;
}

$lock = fopen($lockFile, 'c');
$haveLock = $lock !== false && flock($lock, LOCK_EX | LOCK_NB);

if (!$haveLock) {
    // Another request is currently refreshing → serve stale data (or wait)
    if (is_file($cacheFile)) {
        readfile($cacheFile);
        exit;
    }
    if ($lock !== false) {
        flock($lock, LOCK_EX); // block until the cache exists
        flock($lock, LOCK_UN);
    }
    if (is_file($cacheFile)) {
        readfile($cacheFile);
        exit;
    }
    http_response_code(502);
    echo json_encode(['error' => 'Realtime cache unavailable']);
    exit;
}

try {
    // The raw feed is shared by every city: a second city within the TTL
    // reuses the download instead of fetching >10 MB again.
    $feedAge = is_file($feedFile) ? time() - (int) filemtime($feedFile) : PHP_INT_MAX;
    if ($feedAge > MG3D_CACHE_TTL_SECONDS) {
        $ch = curl_init(MG3D_UPSTREAM_URL);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => MG3D_UPSTREAM_TIMEOUT,
            CURLOPT_USERAGENT => 'mini-germany-3d/1.0 (+https://github.com/Lampenbauer/mini-germany-3d)',
            CURLOPT_ENCODING => '', // allow gzip
        ]);
        $feedData = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if (!is_string($feedData) || $status !== 200) {
            throw new RuntimeException("Upstream HTTP $status");
        }
        $tmpFeed = $feedFile . '.' . getmypid() . '.tmp';
        file_put_contents($tmpFeed, $feedData);
        rename($tmpFeed, $feedFile);
    } else {
        $feedData = (string) file_get_contents($feedFile);
    }

    $tripIds = mg3d_load_trip_ids($schedulePath);
    $json = mg3d_build_response($feedData, $tripIds);

    // Write atomically so concurrent readers never see partial files
    $tmp = $cacheFile . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, $json);
    rename($tmp, $cacheFile);

    echo $json;
} catch (Throwable $error) {
    if (is_file($cacheFile)) {
        // Stale data is better than none
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
