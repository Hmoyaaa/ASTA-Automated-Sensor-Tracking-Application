<?php
/**
 * ASTA - API IoT para ESP32 (Sensor Ultrasónico HC-SR04 Termo 40oz + Fotoresistencia LDR Sueño)
 * Soporta recepción de datos desde el hardware ESP32 (vía api_token) y modificación manual desde Web/Móvil
 */

require_once __DIR__ . '/config.php';

$pdo = getDB();
$input = getJsonInput();
$action = $_GET['action'] ?? ($input['action'] ?? 'status');

// Permitir autenticación tanto por Sesión Web como por API Token del ESP32 / Galaxy Watch
$apiToken = $_SERVER['HTTP_X_API_TOKEN']
    ?? ($_GET['api_token'] ?? ($_GET['token'] ?? ($input['api_token'] ?? ($input['token'] ?? null))));
$user = null;

if ($apiToken) {
    $stmt = $pdo->prepare("SELECT * FROM users WHERE api_token = ? LIMIT 1");
    $stmt->execute([trim($apiToken)]);
    $user = $stmt->fetch();
    if (!$user) {
        sendJson(['status' => 'error', 'message' => 'API Token de ESP32 inválido'], 403);
    }
} elseif (!empty($_SESSION['asta_user_id'])) {
    $stmt = $pdo->prepare("SELECT * FROM users WHERE id = ? LIMIT 1");
    $stmt->execute([(int)$_SESSION['asta_user_id']]);
    $user = $stmt->fetch();
}

if (!$user) {
    sendJson(['status' => 'unauthorized', 'message' => 'No autenticado. Envía api_token desde el ESP32 o inicia sesión en la web.'], 401);
}

$userId = (int)$user['id'];
$capacityMl = (int)($user['thermos_capacity_ml'] ?: 1183); // 40 oz = 1183 ml
$heightCm   = (float)($user['thermos_height_cm'] ?: 34.0);
$offsetCm   = (float)($user['sensor_offset_cm'] ?: 12.0);
if ($offsetCm == 2.5) {
    $offsetCm = 12.0;
    try {
        $pdo->prepare("UPDATE users SET sensor_offset_cm = 12.00 WHERE id = ?")->execute([$userId]);
    } catch (Throwable $_) {}
}
if ($heightCm == 25.0) {
    $heightCm = 34.0;
    try {
        $pdo->prepare("UPDATE users SET thermos_height_cm = 34.00 WHERE id = ?")->execute([$userId]);
    } catch (Throwable $_) {}
}
$today      = date('Y-m-d');

switch ($action) {
    case 'telemetry':
        // Endpoint llamado por el ESP32 físico (Schematik AI / Arduino) o por el calibrador en vivo de la Web
        // Soporta nombres de variables en inglés o español para máxima compatibilidad con Schematik AI
        $rawDist = $input['distance_cm'] ?? $input['distancia_cm'] ?? $input['distancia'] ?? $input['distance'] ?? $input['ultrasonic_cm'] ?? $input['cm']
            ?? $_GET['distance_cm'] ?? $_GET['distancia_cm'] ?? $_GET['distancia'] ?? $_GET['cm'] ?? null;

        $rawLdr = $input['ldr_raw'] ?? $input['ldr'] ?? $input['luz'] ?? $input['light'] ?? $input['fotoresistencia']
            ?? $_GET['ldr_raw'] ?? $_GET['ldr'] ?? $_GET['luz'] ?? null;

        $distanceCm = ($rawDist !== null) ? (float)$rawDist : 12.0;
        $ldrRaw     = ($rawLdr !== null) ? (int)$rawLdr : 260;
        $wifiRssi   = isset($input['wifi_rssi']) ? (int)$input['wifi_rssi'] : (isset($_GET['wifi_rssi']) ? (int)$_GET['wifi_rssi'] : -50);

        // Cálculo físico del nivel de agua en el termo de 40 oz con HC-SR04
        $effectiveHeight = max(1.0, $heightCm - $offsetCm);
        $waterDepthRatio = 1.0 - (($distanceCm - $offsetCm) / $effectiveHeight);
        $waterDepthRatio = max(0.0, min(1.0, $waterDepthRatio));

        $thermosPct = round($waterDepthRatio * 100, 1);
        $thermosMl  = (int)round($waterDepthRatio * $capacityMl);
        $thermosOz  = round($thermosMl / 29.5735, 1);

        // Obtener lectura previa para detectar si el usuario bebió agua automáticamente
        $prevStmt = $pdo->prepare("SELECT thermos_ml FROM esp32_live_state WHERE user_id = ?");
        $prevStmt->execute([$userId]);
        $prevRow = $prevStmt->fetch();
        $drankMl = 0;

        if ($prevRow) {
            $prevMl = (int)$prevRow['thermos_ml'];
            // Si el nivel bajó entre 30 ml y 1183 ml, registramos automáticamente el trago consumido
            if ($prevMl - $thermosMl >= 30) {
                $drankMl = $prevMl - $thermosMl;
                $logHyd = $pdo->prepare("INSERT INTO hydration_logs (user_id, source, water_level_ml, consumed_ml, distance_cm, thermos_pct, logged_date) VALUES (?, 'esp32_ultrasonic', ?, ?, ?, ?, ?)");
                $logHyd->execute([$userId, $thermosMl, $drankMl, $distanceCm, $thermosPct, $today]);
            }
        }

        // Cálculo del nivel de oscuridad de la habitación con la fotoresistencia LDR (ADC 0-4095)
        $ldrClamped = max(0, min(4095, $ldrRaw));
        // Menor valor LDR (o mayor según divisor, estandarizado a 0 = oscuridad total, 4095 = luz intensa)
        $darknessPct = round((1.0 - ($ldrClamped / 4095.0)) * 100, 1);

        if ($darknessPct >= 85) {
            $luxState = 'Oscuridad Óptima (Sueño Profundo)';
        } elseif ($darknessPct >= 60) {
            $luxState = 'Penumbra (Descanso Ligero)';
        } elseif ($darknessPct >= 30) {
            $luxState = 'Luz Ambiental Moderada';
        } else {
            $luxState = 'Habitación Iluminada (Vigilia)';
        }

        // Guardar estado en tiempo real
        $upsert = $pdo->prepare("
            INSERT INTO esp32_live_state (user_id, ultrasonic_cm, thermos_ml, thermos_oz, thermos_pct, ldr_raw, room_lux_state, room_darkness_pct, wifi_rssi)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                ultrasonic_cm = VALUES(ultrasonic_cm),
                thermos_ml = VALUES(thermos_ml),
                thermos_oz = VALUES(thermos_oz),
                thermos_pct = VALUES(thermos_pct),
                ldr_raw = VALUES(ldr_raw),
                room_lux_state = VALUES(room_lux_state),
                room_darkness_pct = VALUES(room_darkness_pct),
                wifi_rssi = VALUES(wifi_rssi),
                last_ping = CURRENT_TIMESTAMP
        ");
        $upsert->execute([
            $userId,
            $distanceCm,
            $thermosMl,
            $thermosOz,
            $thermosPct,
            $ldrClamped,
            $luxState,
            $darknessPct,
            $wifiRssi
        ]);

        sendJson([
            'status'          => 'success',
            'message'         => $drankMl > 0
                ? "ESP32: Nivel actualizado ({$thermosOz} oz / {$thermosMl} ml). ¡Se detectó un consumo de +{$drankMl} ml!"
                : "ESP32: Telemetría sincronizada ({$thermosOz} oz | Oscuridad {$darknessPct}%)",
            'auto_logged_ml'  => $drankMl,
            'esp32_state'     => [
                'ultrasonic_cm'     => $distanceCm,
                'thermos_ml'        => $thermosMl,
                'thermos_oz'        => $thermosOz,
                'thermos_pct'       => $thermosPct,
                'ldr_raw'           => $ldrClamped,
                'room_lux_state'    => $luxState,
                'room_darkness_pct' => $darknessPct,
                'wifi_rssi'         => $wifiRssi,
                'last_ping'         => date('Y-m-d H:i:s')
            ]
        ]);
        break;

    case 'manual_thermos':
        // Modificación manual del nivel del termo o suma de agua desde Web / Móvil
        $newLevelMl = isset($input['water_level_ml']) ? max(0, min($capacityMl, (int)$input['water_level_ml'])) : null;
        $addConsumedMl = isset($input['consumed_ml']) ? (int)$input['consumed_ml'] : 0;

        $currStmt = $pdo->prepare("SELECT * FROM esp32_live_state WHERE user_id = ?");
        $currStmt->execute([$userId]);
        $curr = $currStmt->fetch();

        $currentMl = $curr ? (int)$curr['thermos_ml'] : 900;
        if ($newLevelMl !== null) {
            // Si el usuario bajó manualmente el nivel del termo y no especificó consumed_ml, calculamos la diferencia
            if ($addConsumedMl === 0 && $currentMl > $newLevelMl) {
                $addConsumedMl = $currentMl - $newLevelMl;
            }
            $currentMl = $newLevelMl;
        }

        $thermosPct = round(($currentMl / max(1, $capacityMl)) * 100, 1);
        $thermosOz  = round($currentMl / 29.5735, 1);
        $effectiveHeight = max(1.0, $heightCm - $offsetCm);
        $estimatedCm = round($offsetCm + $effectiveHeight * (1.0 - ($thermosPct / 100.0)), 2);

        $upd = $pdo->prepare("
            UPDATE esp32_live_state
            SET thermos_ml = ?, thermos_oz = ?, thermos_pct = ?, ultrasonic_cm = ?, last_ping = CURRENT_TIMESTAMP
            WHERE user_id = ?
        ");
        $upd->execute([$currentMl, $thermosOz, $thermosPct, $estimatedCm, $userId]);

        if ($addConsumedMl > 0) {
            $ins = $pdo->prepare("INSERT INTO hydration_logs (user_id, source, water_level_ml, consumed_ml, distance_cm, thermos_pct, logged_date) VALUES (?, 'manual', ?, ?, ?, ?, ?)");
            $ins->execute([$userId, $currentMl, $addConsumedMl, $estimatedCm, $thermosPct, $today]);
        }

        sendJson([
            'status'      => 'success',
            'message'     => $addConsumedMl > 0
                ? "¡Hidratación actualizada! +{$addConsumedMl} ml añadidos (Termo: {$thermosOz} oz / {$currentMl} ml)"
                : "Nivel del termo de 40oz ajustado a {$thermosOz} oz ({$currentMl} ml)",
            'thermos_ml'  => $currentMl,
            'thermos_oz'  => $thermosOz,
            'thermos_pct' => $thermosPct,
            'distance_cm' => $estimatedCm
        ]);
        break;

    case 'watch_telemetry':
        // Endpoint para recibir mediciones del Samsung Galaxy Watch (vía HTTP POST/GET con api_token o sesión)
        $steps       = (int)($input['steps'] ?? $input['pasos'] ?? $_GET['steps'] ?? $_GET['pasos'] ?? 0);
        $bpm         = (int)($input['heart_rate_bpm'] ?? $input['bpm'] ?? $input['pulso'] ?? $_GET['bpm'] ?? $_GET['pulso'] ?? 70);
        $sleepMin    = (int)($input['sleep_minutes'] ?? $input['sueno_min'] ?? $_GET['sleep_minutes'] ?? 450);
        if (isset($input['sleep_hours']) || isset($_GET['sleep_hours'])) {
            $sleepMin = (int)round(((float)($input['sleep_hours'] ?? $_GET['sleep_hours'])) * 60);
        }
        $spo2        = (int)($input['blood_oxygen_pct'] ?? $input['spo2'] ?? $_GET['spo2'] ?? 98);
        $battery     = (int)($input['watch_battery_pct'] ?? $input['battery'] ?? $input['bateria'] ?? $_GET['battery'] ?? 85);
        $distanceKm  = isset($input['distance_km']) ? (float)$input['distance_km'] : round($steps * 0.00076, 2);
        $activeCal   = isset($input['active_calories']) ? (int)$input['active_calories'] : (int)round($steps * 0.044 + ($bpm > 90 ? 110 : 45));
        $syncMethod  = trim($input['sync_method'] ?? 'Galaxy Watch 8 Live');

        $stmt = $pdo->prepare("
            INSERT INTO watch_telemetry (user_id, steps, heart_rate_bpm, active_calories, distance_km, sleep_minutes, blood_oxygen_pct, watch_battery_pct, sync_method, logged_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                steps = VALUES(steps),
                heart_rate_bpm = VALUES(heart_rate_bpm),
                active_calories = VALUES(active_calories),
                distance_km = VALUES(distance_km),
                sleep_minutes = VALUES(sleep_minutes),
                blood_oxygen_pct = VALUES(blood_oxygen_pct),
                watch_battery_pct = VALUES(watch_battery_pct),
                sync_method = VALUES(sync_method),
                updated_at = CURRENT_TIMESTAMP
        ");
        $stmt->execute([$userId, $steps, $bpm, $activeCal, $distanceKm, $sleepMin, $spo2, $battery, $syncMethod, $today]);

        $watchStmt = $pdo->prepare("SELECT * FROM watch_telemetry WHERE user_id = ? ORDER BY logged_date DESC LIMIT 1");
        $watchStmt->execute([$userId]);

        sendJson([
            'status'  => 'success',
            'message' => "Galaxy Watch sincronizado: {$steps} pasos | {$bpm} BPM | SpO2 {$spo2}%",
            'watch'   => $watchStmt->fetch()
        ]);
        break;

    case 'system_diagnostics':
        $tables = ['users', 'esp32_live_state', 'hydration_logs', 'sleep_logs', 'gym_logs', 'nutrition_logs', 'watch_telemetry', 'weight_logs'];
        $counts = [];
        $totalRecords = 0;
        foreach ($tables as $tb) {
            try {
                if ($tb === 'users') {
                    $c = (int)$pdo->query("SELECT COUNT(*) FROM `{$tb}`")->fetchColumn();
                } else {
                    $st = $pdo->prepare("SELECT COUNT(*) FROM `{$tb}` WHERE user_id = ?");
                    $st->execute([$userId]);
                    $c = (int)$st->fetchColumn();
                }
                $counts[$tb] = $c;
                $totalRecords += $c;
            } catch (Throwable $_) {
                $counts[$tb] = 0;
            }
        }

        $espSt = $pdo->prepare("SELECT * FROM esp32_live_state WHERE user_id = ?");
        $espSt->execute([$userId]);
        $espRow = $espSt->fetch();

        sendJson([
            'status'        => 'success',
            'engine'        => 'MySQL / MariaDB InnoDB (PDO)',
            'php_version'   => PHP_VERSION,
            'mysql_version' => $pdo->getAttribute(PDO::ATTR_SERVER_VERSION),
            'server_time'   => date('Y-m-d H:i:s'),
            'table_counts'  => $counts,
            'total_records' => $totalRecords,
            'esp32_state'   => $espRow
        ]);
        break;

    default:
        $stmt = $pdo->prepare("SELECT * FROM esp32_live_state WHERE user_id = ?");
        $stmt->execute([$userId]);
        $state = $stmt->fetch();

        $wStmt = $pdo->prepare("SELECT * FROM watch_telemetry WHERE user_id = ? ORDER BY logged_date DESC LIMIT 1");
        $wStmt->execute([$userId]);
        $watchLatest = $wStmt->fetch();

        $hydSumStmt = $pdo->prepare("SELECT COALESCE(SUM(consumed_ml), 0) AS total_water_ml FROM hydration_logs WHERE user_id = ? AND logged_date = ?");
        $hydSumStmt->execute([$userId, $today]);
        $waterTodayMl = (int)$hydSumStmt->fetch()['total_water_ml'];

        sendJson([
            'status'         => 'success',
            'esp32_state'    => $state,
            'watch'          => $watchLatest,
            'water_today_ml' => $waterTodayMl
        ]);
}
