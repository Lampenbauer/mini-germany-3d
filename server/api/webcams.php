<?php
/**
 * Live webcams for the map: asks Windy's Webcams API
 * (https://api.windy.com/webcams/docs) for the cameras around the city
 * named in ?city=<slug> and answers the active ones inside that city's
 * box with their current preview picture and their windy.com page –
 * the shape src/lib/webcams-extract.ts produces for the dev middleware
 * (vite.config.ts), so the browser sees one endpoint in both worlds.
 *
 * Cached per city for ten minutes in the system temp directory: that is
 * how often the cameras refresh, and how long a picture URL is good for
 * on the free tier. A failed upstream call serves the stale answer.
 *
 * API key (never in the repo): first hit of
 *   - environment variable WINDY_KEY
 *   - webcams-key.txt next to this script – the deploy writes it from the
 *     repository secret WINDY_KEY (ci.yml); git-ignored for local tests
 *   - windy-api-key.txt two levels up – above the docroot, where the
 *     rsync --delete deploy (ci.yml) can never touch it
 *
 * Cities: every city's cities/<slug>/city.json next to this script (the
 * deploy copies them, like for ais.php) – or, in a repository checkout,
 * the src/cities folders two levels up.
 *
 * Windy's terms: the pictures are shown as delivered, every one links
 * to its windy.com page, and the map carries a "Webcams: Windy.com"
 * courtesy line (see src/map/WebcamsLayer.ts).
 */

declare(strict_types=1);

ini_set('serialize_precision', '-1');

const MG3D_WEBCAMS_URL = 'https://api.windy.com/webcams/api/v3/webcams';
const MG3D_WEBCAMS_CITY_DIRS = [
    __DIR__ . '/cities',
    __DIR__ . '/../../src/cities',
];
const MG3D_WEBCAMS_DEFAULT_CITY = 'rostock';
const MG3D_WEBCAMS_TTL_SECONDS = 600;
const MG3D_WEBCAMS_PAGE_SIZE = 50;
const MG3D_WEBCAMS_MAX_CAMERAS = 200;

/** @return array<string, array{west:float,south:float,east:float,north:float,exclude:array<int,int>}> */
function mg3d_webcams_cities(): array
{
    foreach (MG3D_WEBCAMS_CITY_DIRS as $dir) {
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
                continue;
            }
            $exclude = $data['webcams']['exclude'] ?? [];
            $cities[$slug] = [
                'west' => (float) $box['west'],
                'south' => (float) $box['south'],
                'east' => (float) $box['east'],
                'north' => (float) $box['north'],
                // Cameras the city leaves off the map (mirror of city.ts)
                'exclude' => is_array($exclude) ? array_map('intval', $exclude) : [],
            ];
        }
        return $cities;
    }
    return [];
}

function mg3d_webcams_key(): string
{
    $env = getenv('WINDY_KEY');
    if (is_string($env) && $env !== '') return trim($env);
    foreach ([__DIR__ . '/webcams-key.txt', __DIR__ . '/../../windy-api-key.txt'] as $file) {
        if (is_readable($file)) {
            $key = trim((string) file_get_contents($file));
            if ($key !== '') return $key;
        }
    }
    return '';
}

/**
 * The circle Windy is asked for: the box's center and the distance to
 * its corner in whole kilometers (mirror of windyNearby in
 * webcams-extract.ts).
 * @param array{west:float,south:float,east:float,north:float} $box
 * @return array{lat:float,lon:float,radiusKm:int}
 */
function mg3d_webcams_nearby(array $box): array
{
    $lat = ($box['south'] + $box['north']) / 2;
    $lon = ($box['west'] + $box['east']) / 2;
    $toRad = fn(float $deg): float => $deg * M_PI / 180;
    $dLat = $toRad($box['north'] - $lat);
    $dLon = $toRad($box['east'] - $lon);
    $a = sin($dLat / 2) ** 2 + cos($toRad($lat)) * cos($toRad($box['north'])) * sin($dLon / 2) ** 2;
    $meters = 2 * 6371000 * asin(sqrt($a));
    return ['lat' => round($lat, 4), 'lon' => round($lon, 4), 'radiusKm' => (int) ceil($meters / 1000)];
}

/**
 * The cameras of the API pages inside the box, minus the city's excluded
 * ids (mirror of extractWebcams).
 * @param array<int, mixed> $raw
 * @param array{west:float,south:float,east:float,north:float,exclude:array<int,int>} $box
 * @return array<int, array<string, mixed>>
 */
function mg3d_webcams_extract(array $raw, array $box): array
{
    $webcams = [];
    $excluded = array_flip($box['exclude'] ?? []);
    foreach ($raw as $cam) {
        if (!is_array($cam)) continue;
        $id = $cam['webcamId'] ?? null;
        if (is_int($id) && isset($excluded[$id])) continue;
        $lon = $cam['location']['longitude'] ?? null;
        $lat = $cam['location']['latitude'] ?? null;
        $image = $cam['images']['current']['preview'] ?? null;
        $detail = $cam['urls']['detail'] ?? null;
        if (!is_int($id) || !is_numeric($lon) || !is_numeric($lat) || !is_string($image)
            || !is_string($detail) || ($cam['status'] ?? null) !== 'active') {
            continue;
        }
        $lon = (float) $lon;
        $lat = (float) $lat;
        if ($lon < $box['west'] || $lon > $box['east'] || $lat < $box['south'] || $lat > $box['north']) {
            continue;
        }
        $webcams[] = [
            'id' => $id,
            'title' => is_string($cam['title'] ?? null) ? $cam['title'] : 'Webcam ' . $id,
            'lon' => $lon,
            'lat' => $lat,
            'image' => $image,
            'detailUrl' => $detail,
            'updatedAt' => is_string($cam['lastUpdatedOn'] ?? null) ? $cam['lastUpdatedOn'] : '',
        ];
    }
    return $webcams;
}

/**
 * Every page Windy has for the circle, merged.
 * @param array{lat:float,lon:float,radiusKm:int} $nearby
 * @return array<int, mixed>
 */
function mg3d_webcams_fetch(string $apiKey, array $nearby): array
{
    $pages = [];
    $offset = 0;
    $total = PHP_INT_MAX;
    while ($offset < $total && $offset < MG3D_WEBCAMS_MAX_CAMERAS) {
        $url = MG3D_WEBCAMS_URL . '?nearby=' . $nearby['lat'] . ',' . $nearby['lon'] . ',' . $nearby['radiusKm']
            . '&limit=' . MG3D_WEBCAMS_PAGE_SIZE . '&offset=' . $offset . '&include=images,location,urls';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_HTTPHEADER => ['x-windy-api-key: ' . $apiKey, 'Accept: application/json'],
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if (!is_string($body) || $status !== 200) {
            throw new RuntimeException('Windy answered HTTP ' . $status);
        }
        $data = json_decode($body, true);
        $page = is_array($data['webcams'] ?? null) ? $data['webcams'] : [];
        foreach ($page as $cam) $pages[] = $cam;
        $total = is_int($data['total'] ?? null) ? $data['total'] : count($pages);
        if ($page === []) break;
        $offset += MG3D_WEBCAMS_PAGE_SIZE;
    }
    return $pages;
}

header('Content-Type: application/json');
header('Cache-Control: no-store');

$slug = $_GET['city'] ?? MG3D_WEBCAMS_DEFAULT_CITY;
$cities = mg3d_webcams_cities();
if (!is_string($slug) || !isset($cities[$slug])) {
    http_response_code(404);
    echo json_encode(['error' => 'Unknown city']);
    exit;
}
$apiKey = mg3d_webcams_key();
if ($apiKey === '') {
    http_response_code(503);
    echo json_encode(['error' => 'No Windy API key configured (see header comment of webcams.php)']);
    exit;
}

$cacheFile = sys_get_temp_dir() . '/mg3d-webcams-' . $slug . '.json';
$cacheAge = is_file($cacheFile) ? time() - (int) filemtime($cacheFile) : PHP_INT_MAX;
if ($cacheAge <= MG3D_WEBCAMS_TTL_SECONDS) {
    readfile($cacheFile);
    exit;
}

try {
    $raw = mg3d_webcams_fetch($apiKey, mg3d_webcams_nearby($cities[$slug]));
    $answer = json_encode([
        'servedAt' => (int) round(microtime(true) * 1000),
        'webcams' => mg3d_webcams_extract($raw, $cities[$slug]),
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    file_put_contents($cacheFile, $answer, LOCK_EX);
    echo $answer;
} catch (Throwable $e) {
    error_log('webcams.php: ' . $e->getMessage());
    if (is_file($cacheFile)) {
        readfile($cacheFile);
        exit;
    }
    http_response_code(502);
    echo json_encode(['error' => $e->getMessage()]);
}
