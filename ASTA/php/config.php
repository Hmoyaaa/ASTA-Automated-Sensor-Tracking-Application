<?php
/**
 * ASTA (Automated Sensor Tracking Application)
 * Archivo de Configuración y Conexión a Base de Datos (PDO)
 * Compatible con AwardSpace (Hosting Producción) y Laragon (Local)
 */

if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

// Cabeceras CORS y JSON para peticiones desde Web, Móvil y ESP32
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Token');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Detectar entorno automáticamente (AwardSpace Linux vs Laragon Windows Local)
$httpHost   = strtolower($_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? ''));
$isWindows  = (DIRECTORY_SEPARATOR === '\\' || stripos(PHP_OS, 'WIN') === 0);
$isLocal    = $isWindows && (
    $httpHost === ''
    || in_array($httpHost, ['localhost', '127.0.0.1', 'asta.test'], true)
    || strpos($httpHost, 'localhost:') === 0
    || strpos($httpHost, '127.0.0.1:') === 0
    || strpos($httpHost, '192.168.') === 0
);

if ($isLocal) {
    // =========================================================================
    // CONFIGURACIÓN LOCAL (LARAGON)
    // =========================================================================
    define('DB_HOST', '127.0.0.1');
    define('DB_NAME', 'asta_db');
    define('DB_USER', 'root');
    define('DB_PASS', '');
} else {
    // =========================================================================
    // CONFIGURACIÓN AWARDSPACE (HOSTING PRODUCCIÓN)
    // =========================================================================
    define('DB_HOST', 'fdb1030.awardspace.net');
    define('DB_NAME', '4797657_astaht');
    define('DB_USER', '4797657_astaht');
    define('DB_PASS', '1121Marifer');
}

// =========================================================================
// CONFIGURACIÓN DE CORREO REAL (HTTP / HTTPS / SMTP)
// =========================================================================
if (!defined('SMTP_HOST'))       define('SMTP_HOST', getenv('ASTA_SMTP_HOST') ?: '');
if (!defined('SMTP_PORT'))       define('SMTP_PORT', (int)(getenv('ASTA_SMTP_PORT') ?: 587));
if (!defined('SMTP_ENCRYPTION')) define('SMTP_ENCRYPTION', getenv('ASTA_SMTP_ENCRYPTION') ?: 'tls');
if (!defined('SMTP_USER'))       define('SMTP_USER', getenv('ASTA_SMTP_USER') ?: '');
if (!defined('SMTP_PASS'))       define('SMTP_PASS', getenv('ASTA_SMTP_PASS') ?: '');
if (!defined('SMTP_FROM_EMAIL')) define('SMTP_FROM_EMAIL', getenv('ASTA_SMTP_FROM_EMAIL') ?: '');
if (!defined('SMTP_FROM_NAME'))  define('SMTP_FROM_NAME', 'A.S.T.A. Security');
if (!defined('BREVO_API_KEY'))   define('BREVO_API_KEY', getenv('ASTA_BREVO_API_KEY') ?: '');

require_once __DIR__ . '/mailer.php';

/**
 * Obtiene la instancia PDO y auto-inicializa cada tabla individualmente si aún no existe
 */
function getDB(): PDO {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    global $isLocal;

    try {
        if ($isLocal) {
            $initPdo = new PDO("mysql:host=" . DB_HOST . ";charset=utf8mb4", DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
            ]);
            $initPdo->exec("CREATE DATABASE IF NOT EXISTS `" . DB_NAME . "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        }

        $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4";
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => true,
        ]);

        ensureTablesExist($pdo);

        return $pdo;
    } catch (PDOException $e) {
        sendJson([
            'status'  => 'error',
            'db_down' => true,
            'message' => 'Error de conexión a la base de datos MySQL (' . DB_HOST . '): ' . $e->getMessage()
        ], 500);
        exit;
    }
}

/**
 * Crea todas las tablas individualmente (1 sentencia por exec) para total compatibilidad con AwardSpace MySQL
 */
function ensureTablesExist(PDO $pdo): void {
    static $checkedInRequest = false;
    if ($checkedInRequest) {
        return;
    }
    $checkedInRequest = true;

    // 1. Tabla principal de usuarios
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `users` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `username` varchar(50) NOT NULL,
          `email` varchar(120) NOT NULL,
          `google_id` varchar(128) DEFAULT NULL,
          `password_hash` varchar(255) NOT NULL,
          `avatar_data` mediumtext DEFAULT NULL,
          `magic_squad` varchar(60) DEFAULT 'Toros Negros (Black Bulls)',
          `magic_rank` varchar(50) DEFAULT 'Caballero Mágico Junior',
          `api_token` varchar(64) NOT NULL,
          `thermos_capacity_ml` int(11) DEFAULT 1183,
          `thermos_height_cm` decimal(5,2) DEFAULT 34.00,
          `sensor_offset_cm` decimal(5,2) DEFAULT 12.00,
          `daily_water_goal_ml` int(11) DEFAULT 3000,
          `daily_calorie_goal` int(11) DEFAULT 2500,
          `daily_step_goal` int(11) DEFAULT 10000,
          `daily_sleep_goal_hrs` decimal(4,2) DEFAULT 8.00,
          `gemini_api_key` varchar(255) DEFAULT NULL,
          `initial_weight_kg` decimal(5,2) NOT NULL DEFAULT 0.00,
          `current_weight_kg` decimal(5,2) NOT NULL DEFAULT 0.00,
          `goal_weight_kg` decimal(5,2) NOT NULL DEFAULT 0.00,
          `bonus_xp` int(11) NOT NULL DEFAULT 0,
          `profile_edit_token` varchar(128) DEFAULT NULL,
          `profile_edit_exp` int(11) DEFAULT NULL,
          `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          UNIQUE KEY `username` (`username`),
          UNIQUE KEY `email` (`email`),
          UNIQUE KEY `api_token` (`api_token`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // 2. Estado en vivo del ESP32
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `esp32_live_state` (
          `user_id` int(11) NOT NULL,
          `ultrasonic_cm` decimal(6,2) DEFAULT 12.00,
          `thermos_ml` int(11) DEFAULT 1183,
          `thermos_oz` decimal(5,2) DEFAULT 40.00,
          `thermos_pct` decimal(5,2) DEFAULT 100.00,
          `ldr_raw` int(11) DEFAULT 280,
          `room_lux_state` varchar(40) DEFAULT 'Oscuridad Óptima',
          `room_darkness_pct` decimal(5,2) DEFAULT 93.20,
          `wifi_rssi` int(11) DEFAULT -52,
          `last_ping` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (`user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // 3. Gimnasio
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `gym_logs` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `user_id` int(11) NOT NULL,
          `exercise_name` varchar(100) NOT NULL,
          `muscle_group` varchar(50) NOT NULL,
          `sets` int(11) NOT NULL DEFAULT 4,
          `reps` int(11) NOT NULL DEFAULT 10,
          `weight_kg` decimal(6,2) NOT NULL DEFAULT 0.00,
          `duration_min` int(11) DEFAULT 45,
          `rpe_intensity` int(11) DEFAULT 8,
          `notes` varchar(255) DEFAULT NULL,
          `logged_date` date NOT NULL,
          `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          KEY `idx_gym_user_date` (`user_id`, `logged_date`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // 4. Hidratación
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `hydration_logs` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `user_id` int(11) NOT NULL,
          `source` varchar(32) NOT NULL DEFAULT 'manual',
          `water_level_ml` int(11) NOT NULL DEFAULT 0,
          `consumed_ml` int(11) NOT NULL DEFAULT 0,
          `distance_cm` decimal(6,2) DEFAULT NULL,
          `thermos_pct` decimal(5,2) DEFAULT NULL,
          `logged_date` date NOT NULL,
          `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          KEY `idx_hydration_user_date` (`user_id`, `logged_date`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // 5. Sueño
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `sleep_logs` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `user_id` int(11) NOT NULL,
          `source` varchar(32) NOT NULL DEFAULT 'manual',
          `sleep_hours` decimal(4,2) NOT NULL,
          `deep_sleep_hours` decimal(4,2) DEFAULT 0.00,
          `rem_sleep_hours` decimal(4,2) DEFAULT 0.00,
          `light_level_adc` int(11) DEFAULT NULL,
          `room_darkness_pct` decimal(5,2) DEFAULT NULL,
          `sleep_quality_score` int(11) DEFAULT 85,
          `bedtime` time DEFAULT '23:00:00',
          `waketime` time DEFAULT '07:00:00',
          `logged_date` date NOT NULL,
          `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          KEY `idx_sleep_user_date` (`user_id`, `logged_date`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // 6. Nutrición
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `nutrition_logs` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `user_id` int(11) NOT NULL,
          `meal_type` varchar(40) NOT NULL DEFAULT 'Almuerzo',
          `food_name` varchar(150) NOT NULL,
          `calories` int(11) NOT NULL DEFAULT 0,
          `protein_g` decimal(6,2) NOT NULL DEFAULT 0.00,
          `carbs_g` decimal(6,2) NOT NULL DEFAULT 0.00,
          `fat_g` decimal(6,2) NOT NULL DEFAULT 0.00,
          `fiber_g` decimal(6,2) DEFAULT 0.00,
          `ai_confidence` varchar(60) DEFAULT 'Análisis IA Visual',
          `image_data` mediumtext DEFAULT NULL,
          `logged_date` date NOT NULL,
          `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          KEY `idx_nutrition_user_date` (`user_id`, `logged_date`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // 7. Smartwatch
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `watch_telemetry` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `user_id` int(11) NOT NULL,
          `steps` int(11) NOT NULL DEFAULT 0,
          `heart_rate_bpm` int(11) DEFAULT 68,
          `active_calories` int(11) DEFAULT 0,
          `distance_km` decimal(5,2) DEFAULT 0.00,
          `sleep_minutes` int(11) DEFAULT 0,
          `blood_oxygen_pct` int(11) DEFAULT 98,
          `watch_battery_pct` int(11) DEFAULT 85,
          `sync_method` varchar(50) DEFAULT 'Galaxy Watch 8 BLE',
          `logged_date` date NOT NULL,
          `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          UNIQUE KEY `uniq_watch_user_date` (`user_id`, `logged_date`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // 8. Control de peso RPG
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS `weight_logs` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `user_id` int(11) NOT NULL,
          `weight_kg` decimal(5,2) NOT NULL,
          `notes` varchar(160) DEFAULT '',
          `xp_awarded` int(11) NOT NULL DEFAULT 50,
          `logged_date` date NOT NULL,
          `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (`id`),
          KEY `idx_weight_user_date` (`user_id`, `logged_date`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");

    // Verificar columnas adicionales en `users` por si la tabla fue creada con una versión previa del SQL
    ensureGamificationSchema($pdo);
}

/**
 * Asegura que todas las columnas requeridas existan en `users` si la tabla ya había sido importada antes
 */
function ensureGamificationSchema(PDO $pdo): void {
    try {
        $existingColsStmt = $pdo->query("SHOW COLUMNS FROM `users`");
        $existingCols = [];
        if ($existingColsStmt) {
            foreach ($existingColsStmt->fetchAll() as $colRow) {
                $existingCols[strtolower($colRow['Field'] ?? '')] = true;
            }
        }

        $requiredAlterations = [
            'avatar_data'          => "ALTER TABLE `users` ADD COLUMN `avatar_data` MEDIUMTEXT DEFAULT NULL",
            'magic_squad'          => "ALTER TABLE `users` ADD COLUMN `magic_squad` VARCHAR(60) DEFAULT 'Toros Negros (Black Bulls)'",
            'magic_rank'           => "ALTER TABLE `users` ADD COLUMN `magic_rank` VARCHAR(50) DEFAULT 'Caballero Mágico Junior'",
            'api_token'            => "ALTER TABLE `users` ADD COLUMN `api_token` VARCHAR(64) DEFAULT NULL",
            'thermos_capacity_ml'  => "ALTER TABLE `users` ADD COLUMN `thermos_capacity_ml` INT(11) DEFAULT 1183",
            'thermos_height_cm'    => "ALTER TABLE `users` ADD COLUMN `thermos_height_cm` DECIMAL(5,2) DEFAULT 34.00",
            'sensor_offset_cm'     => "ALTER TABLE `users` ADD COLUMN `sensor_offset_cm` DECIMAL(5,2) DEFAULT 12.00",
            'daily_water_goal_ml'  => "ALTER TABLE `users` ADD COLUMN `daily_water_goal_ml` INT(11) DEFAULT 3000",
            'daily_calorie_goal'   => "ALTER TABLE `users` ADD COLUMN `daily_calorie_goal` INT(11) DEFAULT 2500",
            'daily_step_goal'      => "ALTER TABLE `users` ADD COLUMN `daily_step_goal` INT(11) DEFAULT 10000",
            'daily_sleep_goal_hrs' => "ALTER TABLE `users` ADD COLUMN `daily_sleep_goal_hrs` DECIMAL(4,2) DEFAULT 8.00",
            'gemini_api_key'       => "ALTER TABLE `users` ADD COLUMN `gemini_api_key` VARCHAR(255) DEFAULT NULL",
            'initial_weight_kg'    => "ALTER TABLE `users` ADD COLUMN `initial_weight_kg` DECIMAL(5,2) NOT NULL DEFAULT 0.00",
            'current_weight_kg'    => "ALTER TABLE `users` ADD COLUMN `current_weight_kg` DECIMAL(5,2) NOT NULL DEFAULT 0.00",
            'goal_weight_kg'       => "ALTER TABLE `users` ADD COLUMN `goal_weight_kg` DECIMAL(5,2) NOT NULL DEFAULT 0.00",
            'bonus_xp'             => "ALTER TABLE `users` ADD COLUMN `bonus_xp` INT(11) NOT NULL DEFAULT 0",
            'profile_edit_token'   => "ALTER TABLE `users` ADD COLUMN `profile_edit_token` VARCHAR(128) DEFAULT NULL",
            'profile_edit_exp'     => "ALTER TABLE `users` ADD COLUMN `profile_edit_exp` INT(11) DEFAULT NULL"
        ];

        foreach ($requiredAlterations as $colName => $alterSql) {
            if (!isset($existingCols[$colName])) {
                try {
                    $pdo->exec($alterSql);
                } catch (Throwable $_) {}
            }
        }

        // Migrar automáticamente cuentas con medidas antiguas (2.50 cm lleno / 25.00 cm vacío) a las reales (12.00 cm lleno / 34.00 cm vacío)
        try {
            $pdo->exec("UPDATE `users` SET `sensor_offset_cm` = 12.00 WHERE `sensor_offset_cm` = 2.50");
            $pdo->exec("UPDATE `users` SET `thermos_height_cm` = 34.00 WHERE `thermos_height_cm` = 25.00");
        } catch (Throwable $_) {}
    } catch (Throwable $_) {}
}

/**
 * Inicializa el estado base para una cuenta recién creada (12.00 cm = distancia inicial del termo lleno, sin rutinas demo)
 */
function seedInitialUserData(PDO $pdo, int $userId): void {
    try {
        $stmtEsp = $pdo->prepare("INSERT IGNORE INTO esp32_live_state (user_id, ultrasonic_cm, thermos_ml, thermos_oz, thermos_pct, ldr_raw, room_lux_state, room_darkness_pct, wifi_rssi) VALUES (?, 12.00, 1183, 40.0, 100.0, 0, 'Sin lecturas aún', 0.0, 0)");
        $stmtEsp->execute([$userId]);
    } catch (Throwable $_) {}
}

/**
 * Envía respuesta JSON estandarizada
 */
function sendJson(array $data, int $statusCode = 200): void {
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * Obtiene el ID del usuario autenticado en la sesión actual o vía api_token
 */
function requireAuth(): int {
    if (!empty($_SESSION['asta_user_id'])) {
        return (int)$_SESSION['asta_user_id'];
    }

    $token = $_SERVER['HTTP_X_API_TOKEN'] ?? ($_GET['api_token'] ?? '');
    if ($token === '') {
        $input = getJsonInput();
        $token = trim((string)($input['api_token'] ?? ''));
    }
    if ($token !== '') {
        try {
            $pdo = getDB();
            $stmt = $pdo->prepare("SELECT id, username FROM users WHERE api_token = ? LIMIT 1");
            $stmt->execute([$token]);
            $u = $stmt->fetch();
            if ($u) {
                $_SESSION['asta_user_id'] = (int)$u['id'];
                $_SESSION['asta_username'] = $u['username'];
                return (int)$u['id'];
            }
        } catch (Throwable $_) {}
    }

    sendJson([
        'status'  => 'unauthorized',
        'message' => 'Sesión no iniciada. Inicia sesión con tu cuenta para acceder y guardar tus datos.'
    ], 401);
    exit;
}

/**
 * Lee el cuerpo JSON o FormData enviado por fetch() o por el ESP32
 */
function getJsonInput(): array {
    static $cachedInput = null;
    if ($cachedInput !== null) {
        return $cachedInput;
    }

    $raw = file_get_contents('php://input');
    if ($raw) {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) {
            $cachedInput = !empty($_POST) ? array_merge($_POST, $decoded) : $decoded;
            return $cachedInput;
        }
        if (empty($_POST) && strpos($raw, '=') !== false) {
            $parsed = [];
            parse_str($raw, $parsed);
            if (is_array($parsed) && !empty($parsed)) {
                $cachedInput = $parsed;
                return $cachedInput;
            }
        }
    }
    $cachedInput = !empty($_POST) ? $_POST : [];
    return $cachedInput;
}
