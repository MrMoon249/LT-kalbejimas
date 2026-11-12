<?php
// Tarpininkas tarp programėlės ir AI paslaugos: API raktas lieka serveryje, AI pasiekiamas tik prisijungus slaptažodžiu.
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function out(int $code, array $data): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(int $code, string $type, string $message): never {
    out($code, ['error' => ['type' => $type, 'message' => $message]]);
}

$cfgFile = __DIR__ . '/config.php';
if (!is_file($cfgFile)) fail(503, 'not_configured', 'Serveryje nėra config.php (nukopijuok config.example.php ir užpildyk).');
$cfg = require $cfgFile;
$apiKey = trim((string)($cfg['api_key'] ?? ''));
$password = (string)($cfg['password'] ?? '');
if ($apiKey === '' || strlen($password) < 8 || str_starts_with($apiKey, 'ĮRAŠYK')) {
    fail(503, 'not_configured', 'config.php neužpildytas: reikia API rakto ir bent 8 ženklų slaptažodžio.');
}
$provider = $cfg['provider'] ?? (stripos($apiKey, 'nexos-') === 0 ? 'nexos' : 'anthropic');
$model = trim((string)($cfg['model'] ?? ''));

$https = (($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
$days = 30;
ini_set('session.gc_maxlifetime', (string)($days * 86400));
session_name('kalbejimas');
session_set_cookie_params(['lifetime' => $days * 86400, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Strict']);
session_start();
$authed = !empty($_SESSION['ok']);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    out(200, ['server' => true, 'authed' => $authed, 'provider' => $provider, 'model' => $model]);
}
if ($method !== 'POST') fail(405, 'method', 'Tik POST.');
$ctype = $_SERVER['CONTENT_TYPE'] ?? '';
if (stripos($ctype, 'multipart/form-data') === 0) {
    $in = $_POST; // garso įrašo įkėlimas
    if (!$in && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) fail(413, 'too_large', 'Failas per didelis serveriui.');
} elseif (stripos($ctype, 'application/json') === 0) {
    $in = json_decode(file_get_contents('php://input') ?: '', true);
} else {
    fail(415, 'content_type', 'Reikia application/json.');
}
if (!is_array($in)) fail(400, 'bad_request', 'Netinkama užklausa.');
$action = (string)($in['action'] ?? '');

if ($action === 'login') {
    // Apsauga nuo spėliojimo: ne daugiau kaip 8 nesėkmingi bandymai per 15 min iš vieno IP.
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'x';
    $file = sys_get_temp_dir() . '/kalbejimas-' . hash('sha256', __DIR__ . '|' . $ip) . '.json';
    $now = time();
    $fails = array_values(array_filter((array)(json_decode(@file_get_contents($file) ?: '[]', true) ?: []), fn($t) => $t > $now - 900));
    if (count($fails) >= 8) fail(429, 'too_many', 'Per daug bandymų. Palauk 15 minučių.');
    if (!hash_equals($password, (string)($in['password'] ?? ''))) {
        $fails[] = $now;
        @file_put_contents($file, json_encode($fails), LOCK_EX);
        sleep(1);
        fail(401, 'bad_password', 'Neteisingas slaptažodis.');
    }
    @unlink($file);
    session_regenerate_id(true);
    $_SESSION['ok'] = true;
    out(200, ['authed' => true, 'provider' => $provider, 'model' => $model]);
}
if ($action === 'logout') {
    $_SESSION = [];
    session_destroy();
    out(200, ['authed' => false]);
}

if (!$authed) fail(401, 'login_required', 'Reikia prisijungti.');
session_write_close(); // ilga AI užklausa neturi blokuoti kitų šios sesijos užklausų

function upstream(string $provider, string $apiKey, string $path, ?array $body, ?array $form = null): never {
    global $cfg;
    $base = $cfg['base_url'] ?? ($provider === 'nexos' ? 'https://api.nexos.ai/v1' : 'https://api.anthropic.com/v1');
    $headers = $provider === 'nexos'
        ? ['Authorization: Bearer ' . $apiKey]
        : ['x-api-key: ' . $apiKey, 'anthropic-version: 2026-10-21'];
    if ($provider !== 'nexos' && isset($body['fallbacks'])) $headers[] = 'anthropic-beta: server-side-fallback-2026-07-01';
    $ch = curl_init($base . $path);
    $opt = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 200, CURLOPT_CONNECTTIMEOUT => 15];
    if ($form !== null) {
        $opt[CURLOPT_POST] = true;
        $opt[CURLOPT_POSTFIELDS] = $form; // multipart
    } elseif ($body !== null) {
        $headers[] = 'Content-Type: application/json';
        $opt[CURLOPT_POST] = true;
        $opt[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    $opt[CURLOPT_HTTPHEADER] = $headers;
    curl_setopt_array($ch, $opt);
    $res = curl_exec($ch);
    if ($res === false) fail(502, 'upstream', 'Serveriui nepavyko pasiekti AI paslaugos: ' . curl_error($ch));
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    // AI paslaugos 401 nepainiojame su „reikia prisijungti“ – tai blogas raktas config.php.
    if ($code === 401 || $code === 403) fail(502, 'upstream_auth', 'AI paslauga atmetė serverio API raktą. Patikrink config.php.');
    http_response_code($code);
    echo $res;
    exit;
}

set_time_limit(220);
if ($action === 'models') {
    if ($provider !== 'nexos') out(200, ['data' => [['id' => $model !== '' ? $model : 'claude-sonnet-5-5']]]);
    upstream($provider, $apiKey, '/models', null);
}
if ($action === 'transcribe') {
    if ($provider !== 'nexos') fail(400, 'unsupported', 'Transkripcija veikia tik su nexos.ai raktu.');
    $f = $_FILES['file'] ?? null;
    if (!$f || ($f['error'] ?? 1) !== UPLOAD_ERR_OK) fail(($f['error'] ?? 0) === UPLOAD_ERR_INI_SIZE ? 413 : 400, 'bad_file', 'Garso failo gauti nepavyko (gal per didelis).');
    upstream($provider, $apiKey, '/audio/transcriptions', null, [
        'file' => new CURLFile($f['tmp_name'], $f['type'] ?: 'application/octet-stream', $f['name'] ?: 'irasas'),
        'model' => (string)($in['model'] ?? ''),
        'language' => 'lt',
    ]);
}
if ($action === 'chat') {
    $body = $in['body'] ?? null;
    if (!is_array($body) || !isset($body['messages'])) fail(400, 'bad_request', 'Trūksta užklausos turinio.');
    if ($model !== '') $body['model'] = $model;
    upstream($provider, $apiKey, $provider === 'nexos' ? '/chat/completions' : '/messages', $body);
}
fail(400, 'bad_request', 'Nežinomas veiksmas.');
