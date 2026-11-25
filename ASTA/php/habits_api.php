<?php
/**
 * ASTA - API Central de Hábitos (Gimnasio, Hidratación, Sueño, Nutrición IA y Samsung Galaxy Watch 8)
 */

require_once __DIR__ . '/config.php';

$pdo = getDB();
$userId = requireAuth();
$input = getJsonInput();
$action = $_GET['action'] ?? ($input['action'] ?? 'dashboard_summary');
$today = date('Y-m-d');

switch ($action) {
    case 'dashboard_summary':
        // 1. Perfil y metas del usuario
        $uStmt = $pdo->prepare("SELECT id, username, email, avatar_data, magic_squad, magic_rank, api_token, thermos_capacity_ml, thermos_height_cm, sensor_offset_cm, daily_water_goal_ml, daily_calorie_goal, daily_step_goal, daily_sleep_goal_hrs, gemini_api_key, initial_weight_kg, current_weight_kg, goal_weight_kg, bonus_xp FROM users WHERE id = ?");
        $uStmt->execute([$userId]);
        $user = $uStmt->fetch();
        if ($user && strpos((string)$user['username'], '@') !== false) {
            $cleanPrefix = explode('@', (string)$user['username'])[0];
            $cleanPrefix = preg_replace('/[^A-Za-z0-9_áéíóúÁÉÍÓÚñÑ]/u', '_', $cleanPrefix);
            $cleanPrefix = trim($cleanPrefix, '_') ?: ('Caballero_' . $user['id']);
            $pdo->prepare("UPDATE users SET username = ? WHERE id = ?")->execute([$cleanPrefix, (int)$user['id']]);
            $user['username'] = $cleanPrefix;
            $_SESSION['asta_username'] = $cleanPrefix;
        }

        // 2. Estado en vivo del ESP32
        $espStmt = $pdo->prepare("SELECT * FROM esp32_live_state WHERE user_id = ?");
        $espStmt->execute([$userId]);
        $esp32 = $espStmt->fetch();

        // 3. Gimnasio (recientes + estadísticas semanales)
        $gymStmt = $pdo->prepare("SELECT * FROM gym_logs WHERE user_id = ? ORDER BY logged_date DESC, id DESC LIMIT 15");
        $gymStmt->execute([$userId]);
        $gymLogs = $gymStmt->fetchAll();

        $gymTodayStmt = $pdo->prepare("SELECT COUNT(*) as exercises_today, COALESCE(SUM(sets * reps * weight_kg), 0) as volume_kg, COALESCE(SUM(duration_min), 0) as total_min FROM gym_logs WHERE user_id = ? AND logged_date = ?");
        $gymTodayStmt->execute([$userId, $today]);
        $gymToday = $gymTodayStmt->fetch();

        // 4. Hidratación (hoy + historial reciente)
        $hydTodayStmt = $pdo->prepare("SELECT COALESCE(SUM(consumed_ml), 0) as total_ml FROM hydration_logs WHERE user_id = ? AND logged_date = ?");
        $hydTodayStmt->execute([$userId, $today]);
        $waterTodayMl = (int)$hydTodayStmt->fetchColumn();

        $hydLogsStmt = $pdo->prepare("SELECT * FROM hydration_logs WHERE user_id = ? ORDER BY logged_date DESC, id DESC LIMIT 12");
        $hydLogsStmt->execute([$userId]);
        $hydrationLogs = $hydLogsStmt->fetchAll();

        // 5. Sueño (última noche + historial 7 días)
        $slpStmt = $pdo->prepare("SELECT * FROM sleep_logs WHERE user_id = ? ORDER BY logged_date DESC, id DESC LIMIT 10");
        $slpStmt->execute([$userId]);
        $sleepLogs = $slpStmt->fetchAll();

        // 6. Nutrición e IA Macros (hoy + lista de comidas)
        $nutTodayStmt = $pdo->prepare("
            SELECT
                COALESCE(SUM(calories), 0) as total_calories,
                COALESCE(SUM(protein_g), 0) as total_protein,
                COALESCE(SUM(carbs_g), 0) as total_carbs,
                COALESCE(SUM(fat_g), 0) as total_fat,
                COALESCE(SUM(fiber_g), 0) as total_fiber
            FROM nutrition_logs
            WHERE user_id = ? AND logged_date = ?
        ");
        $nutTodayStmt->execute([$userId, $today]);
        $macrosToday = $nutTodayStmt->fetch();

        $nutLogsStmt = $pdo->prepare("SELECT * FROM nutrition_logs WHERE user_id = ? ORDER BY logged_date DESC, id DESC LIMIT 12");
        $nutLogsStmt->execute([$userId]);
        $nutritionLogs = $nutLogsStmt->fetchAll();

        // 7. Samsung Galaxy Watch 8
        $watchStmt = $pdo->prepare("SELECT * FROM watch_telemetry WHERE user_id = ? ORDER BY logged_date DESC LIMIT 1");
        $watchStmt->execute([$userId]);
        $watchData = $watchStmt->fetch();
        if (!$watchData) {
            $watchData = [
                'steps'             => 0,
                'heart_rate_bpm'    => 68,
                'active_calories'   => 0,
                'distance_km'       => 0,
                'sleep_minutes'     => 0,
                'blood_oxygen_pct'  => 98,
                'watch_battery_pct' => 90,
                'sync_method'       => 'Galaxy Watch 8 BLE',
                'logged_date'       => $today
            ];
        }

        $wLogsStmt = $pdo->prepare("SELECT * FROM weight_logs WHERE user_id = ? ORDER BY logged_date DESC, id DESC LIMIT 10");
        $wLogsStmt->execute([$userId]);
        $weightLogs = $wLogsStmt->fetchAll();

        // Migrar medidas antiguas del termo (2.50 cm lleno / 25.00 cm vacío) a las reales (12.00 cm lleno / 34.00 cm vacío)
        if ($user && (float)($user['sensor_offset_cm'] ?? 0) == 2.50) {
            $pdo->prepare("UPDATE users SET sensor_offset_cm = 12.00 WHERE id = ?")->execute([$userId]);
            $user['sensor_offset_cm'] = 12.00;
        }
        if ($user && (float)($user['thermos_height_cm'] ?? 0) == 25.00) {
            $pdo->prepare("UPDATE users SET thermos_height_cm = 34.00 WHERE id = ?")->execute([$userId]);
            $user['thermos_height_cm'] = 34.00;
        }

        // Si la cuenta no tiene pesajes registrados pero tenía los pesos demo antiguos (78.50 / 75.20), limpiarlos a 0
        if (empty($weightLogs) && $user && (float)($user['initial_weight_kg'] ?? 0) == 78.50 && (float)($user['current_weight_kg'] ?? 0) == 75.20) {
            $pdo->prepare("UPDATE users SET initial_weight_kg = 0.00, current_weight_kg = 0.00, goal_weight_kg = 0.00 WHERE id = ?")->execute([$userId]);
            $user['initial_weight_kg'] = 0.00;
            $user['current_weight_kg'] = 0.00;
            $user['goal_weight_kg']    = 0.00;
        }

        // Si tenía la fila demo de watch_telemetry (8420 pasos / 66 BPM) sin ningún hábito registrado, limpiarla a 0
        if (
            empty($gymLogs) && empty($hydrationLogs) && empty($sleepLogs) && empty($nutritionLogs) && empty($weightLogs)
            && !empty($watchData['id']) && (int)($watchData['steps'] ?? 0) === 8420 && (int)($watchData['heart_rate_bpm'] ?? 0) === 66
        ) {
            $pdo->prepare("DELETE FROM watch_telemetry WHERE id = ? AND user_id = ?")->execute([(int)$watchData['id'], $userId]);
            $watchData = [
                'steps'             => 0,
                'heart_rate_bpm'    => 0,
                'active_calories'   => 0,
                'distance_km'       => 0,
                'sleep_minutes'     => 0,
                'blood_oxygen_pct'  => 0,
                'watch_battery_pct' => 0,
                'sync_method'       => 'Sin sincronizar',
                'logged_date'       => $today
            ];
        }

        if ($esp32 && empty($hydrationLogs) && ((float)($esp32['ultrasonic_cm'] ?? 0) == 7.20 || (float)($esp32['ultrasonic_cm'] ?? 0) < 12.0)) {
            $capMlInit = (int)($user['thermos_capacity_ml'] ?? 1183);
            $pdo->prepare("UPDATE esp32_live_state SET ultrasonic_cm = 12.00, thermos_ml = ?, thermos_oz = 40.0, thermos_pct = 100.0 WHERE user_id = ?")->execute([$capMlInit, $userId]);
            $esp32['ultrasonic_cm'] = 12.00;
            $esp32['thermos_ml']    = $capMlInit;
            $esp32['thermos_oz']    = 40.0;
            $esp32['thermos_pct']   = 100.0;
        }

        sendJson([
            'status'         => 'success',
            'user'           => $user,
            'esp32'          => $esp32,
            'gym_today'      => $gymToday,
            'gym_logs'       => $gymLogs,
            'water_today_ml' => $waterTodayMl,
            'hydration_logs' => $hydrationLogs,
            'sleep_logs'     => $sleepLogs,
            'macros_today'   => $macrosToday,
            'nutrition_logs' => $nutritionLogs,
            'watch'          => $watchData,
            'weight_logs'    => $weightLogs,
            'gamification'   => buildGamificationProfile($pdo, $userId, $user),
            'analytics'      => [
                'weekly'  => buildAnalyticsProgress($pdo, $userId, 'weekly'),
                'monthly' => buildAnalyticsProgress($pdo, $userId, 'monthly'),
                'yearly'  => buildAnalyticsProgress($pdo, $userId, 'yearly')
            ]
        ]);
        break;

    case 'analytics_progress':
        $period = $_GET['period'] ?? ($input['period'] ?? 'weekly');
        if (!in_array($period, ['weekly', 'monthly', 'yearly'], true)) {
            $period = 'weekly';
        }
        sendJson([
            'status' => 'success',
            'period' => $period,
            'data'   => buildAnalyticsProgress($pdo, $userId, $period)
        ]);
        break;

    case 'add_gym':
        $exercise = trim($input['exercise_name'] ?? '');
        $muscle   = trim($input['muscle_group'] ?? 'Pecho');
        $sets     = max(1, (int)($input['sets'] ?? 4));
        $reps     = max(1, (int)($input['reps'] ?? 10));
        $weight   = max(0, (float)($input['weight_kg'] ?? 0));
        $duration = max(1, (int)($input['duration_min'] ?? 45));
        $rpe      = max(1, min(10, (int)($input['rpe_intensity'] ?? 8)));
        $notes    = trim($input['notes'] ?? '');
        $date     = $input['logged_date'] ?? $today;

        if ($exercise === '') {
            sendJson(['status' => 'error', 'message' => 'Indica el nombre del ejercicio realizado.'], 400);
        }

        // Comprobar si supera la marca anterior (PR) en este ejercicio o grupo muscular
        $prStmt = $pdo->prepare("SELECT MAX(weight_kg) as max_w FROM gym_logs WHERE user_id = ? AND (LOWER(exercise_name) = LOWER(?) OR muscle_group = ?)");
        $prStmt->execute([$userId, $exercise, $muscle]);
        $prevMax = (float)($prStmt->fetchColumn() ?: 0);
        $isNewPr = ($weight > 0 && $prevMax > 0 && $weight > $prevMax);

        $stmt = $pdo->prepare("INSERT INTO gym_logs (user_id, exercise_name, muscle_group, sets, reps, weight_kg, duration_min, rpe_intensity, notes, logged_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        $stmt->execute([$userId, $exercise, $muscle, $sets, $reps, $weight, $duration, $rpe, $notes, $date]);

        $xpGain = $isNewPr ? 180 : 65;
        $pdo->prepare("UPDATE users SET bonus_xp = bonus_xp + ? WHERE id = ?")->execute([$xpGain, $userId]);

        sendJson([
            'status'    => 'success',
            'is_new_pr' => $isNewPr,
            'xp_gained' => $xpGain,
            'message'   => $isNewPr
                ? "¡NUEVO RÉCORD EN GIMNASIO! Superaste tu marca anterior ({$prevMax}kg → {$weight}kg) en {$exercise} • +{$xpGain} XP"
                : "¡Entrenamiento registrado! {$exercise} ({$sets}x{$reps} @ {$weight}kg) • +{$xpGain} XP"
        ]);
        break;

    case 'delete_gym':
        $id = (int)($input['id'] ?? 0);
        $stmt = $pdo->prepare("DELETE FROM gym_logs WHERE id = ? AND user_id = ?");
        $stmt->execute([$id, $userId]);
        sendJson(['status' => 'success', 'message' => 'Registro de entrenamiento eliminado.']);
        break;

    case 'add_hydration':
        $consumedMl = max(10, (int)($input['consumed_ml'] ?? 250));
        $source     = ($input['source'] ?? 'manual') === 'esp32_ultrasonic' ? 'esp32_ultrasonic' : 'manual';
        $date       = $input['logged_date'] ?? $today;

        $espStmt = $pdo->prepare("SELECT thermos_ml, ultrasonic_cm, thermos_pct FROM esp32_live_state WHERE user_id = ?");
        $espStmt->execute([$userId]);
        $esp = $espStmt->fetch();

        $waterLevel = $esp ? (int)$esp['thermos_ml'] : 960;
        $distCm     = $esp ? (float)$esp['ultrasonic_cm'] : null;
        $pct        = $esp ? (float)$esp['thermos_pct'] : null;

        $stmt = $pdo->prepare("INSERT INTO hydration_logs (user_id, source, water_level_ml, consumed_ml, distance_cm, thermos_pct, logged_date) VALUES (?, ?, ?, ?, ?, ?, ?)");
        $stmt->execute([$userId, $source, $waterLevel, $consumedMl, $distCm, $pct, $date]);

        sendJson([
            'status'  => 'success',
            'message' => "¡+{$consumedMl} ml de hidratación añadidos a tu registro diario!"
        ]);
        break;

    case 'delete_hydration':
        $id = (int)($input['id'] ?? 0);
        $stmt = $pdo->prepare("DELETE FROM hydration_logs WHERE id = ? AND user_id = ?");
        $stmt->execute([$id, $userId]);
        sendJson(['status' => 'success', 'message' => 'Registro de hidratación eliminado.']);
        break;

    case 'add_sleep':
        $sleepHours = max(0.5, min(24.0, (float)($input['sleep_hours'] ?? 7.5)));
        $deepHours  = max(0.0, (float)($input['deep_sleep_hours'] ?? round($sleepHours * 0.3, 1)));
        $remHours   = max(0.0, (float)($input['rem_sleep_hours'] ?? round($sleepHours * 0.23, 1)));
        $ldrAdc     = isset($input['light_level_adc']) ? (int)$input['light_level_adc'] : 250;
        $darkPct    = round((1.0 - (max(0, min(4095, $ldrAdc)) / 4095.0)) * 100, 1);
        $quality    = max(10, min(100, (int)($input['sleep_quality_score'] ?? 88)));
        $bedtime    = $input['bedtime'] ?? '23:00:00';
        $waketime   = $input['waketime'] ?? '06:30:00';
        $source     = in_array($input['source'] ?? 'manual', ['esp32_ldr', 'galaxy_watch', 'manual']) ? $input['source'] : 'manual';
        $date       = $input['logged_date'] ?? $today;

        $stmt = $pdo->prepare("
            INSERT INTO sleep_logs (user_id, source, sleep_hours, deep_sleep_hours, rem_sleep_hours, light_level_adc, room_darkness_pct, sleep_quality_score, bedtime, waketime, logged_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([$userId, $source, $sleepHours, $deepHours, $remHours, $ldrAdc, $darkPct, $quality, $bedtime, $waketime, $date]);

        // Actualizar también el sensor LDR en esp32_live_state si provino de ajuste
        $luxState = $darkPct >= 85 ? 'Oscuridad Óptima (Sueño Profundo)' : ($darkPct >= 60 ? 'Penumbra (Descanso Ligero)' : 'Habitación Iluminada');
        $updEsp = $pdo->prepare("UPDATE esp32_live_state SET ldr_raw = ?, room_darkness_pct = ?, room_lux_state = ? WHERE user_id = ?");
        $updEsp->execute([$ldrAdc, $darkPct, $luxState, $userId]);

        sendJson([
            'status'  => 'success',
            'message' => "¡Sueño registrado! {$sleepHours} hrs con {$darkPct}% de oscuridad ambiental."
        ]);
        break;

    case 'delete_sleep':
        $id = (int)($input['id'] ?? 0);
        $stmt = $pdo->prepare("DELETE FROM sleep_logs WHERE id = ? AND user_id = ?");
        $stmt->execute([$id, $userId]);
        sendJson(['status' => 'success', 'message' => 'Registro de sueño eliminado.']);
        break;

    case 'add_nutrition':
        $mealType   = $input['meal_type'] ?? 'Almuerzo';
        $foodName   = trim($input['food_name'] ?? 'Platillo Analizado');
        $calories   = max(0, (int)($input['calories'] ?? 0));
        $protein    = max(0, (float)($input['protein_g'] ?? 0));
        $carbs      = max(0, (float)($input['carbs_g'] ?? 0));
        $fat        = max(0, (float)($input['fat_g'] ?? 0));
        $fiber      = max(0, (float)($input['fiber_g'] ?? 0));
        $confidence = trim($input['ai_confidence'] ?? 'Escáner IA');
        $imageData  = $input['image_data'] ?? null;
        $date       = $input['logged_date'] ?? $today;

        $stmt = $pdo->prepare("
            INSERT INTO nutrition_logs (user_id, meal_type, food_name, calories, protein_g, carbs_g, fat_g, fiber_g, ai_confidence, image_data, logged_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([$userId, $mealType, $foodName, $calories, $protein, $carbs, $fat, $fiber, $confidence, $imageData, $date]);

        sendJson([
            'status'  => 'success',
            'message' => "¡Comida guardada! {$foodName} ({$calories} kcal | P:{$protein}g C:{$carbs}g G:{$fat}g)"
        ]);
        break;

    case 'delete_nutrition':
        $id = (int)($input['id'] ?? 0);
        $stmt = $pdo->prepare("DELETE FROM nutrition_logs WHERE id = ? AND user_id = ?");
        $stmt->execute([$id, $userId]);
        sendJson(['status' => 'success', 'message' => 'Registro nutricional eliminado.']);
        break;

    case 'sync_watch':
        $steps       = max(0, (int)($input['steps'] ?? 0));
        $bpm         = max(40, min(220, (int)($input['heart_rate_bpm'] ?? 70)));
        $activeCal   = max(0, (int)($input['active_calories'] ?? round($steps * 0.045)));
        $distanceKm  = max(0, (float)($input['distance_km'] ?? round($steps * 0.00076, 2)));
        $sleepMin    = max(0, (int)($input['sleep_minutes'] ?? 450));
        $spo2        = max(80, min(100, (int)($input['blood_oxygen_pct'] ?? 98)));
        $battery     = max(1, min(100, (int)($input['watch_battery_pct'] ?? 85)));
        $syncMethod  = trim($input['sync_method'] ?? 'Samsung Galaxy Watch 8');
        $date        = $input['logged_date'] ?? $today;

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
        $stmt->execute([$userId, $steps, $bpm, $activeCal, $distanceKm, $sleepMin, $spo2, $battery, $syncMethod, $date]);

        sendJson([
            'status'  => 'success',
            'message' => "Samsung Galaxy Watch 8 sincronizado: {$steps} pasos, {$bpm} BPM, " . round($sleepMin / 60, 1) . " hrs de sueño."
        ]);
        break;

    case 'log_weight':
        $weightKg = isset($input['weight_kg']) ? (float)$input['weight_kg'] : 0;
        if ($weightKg < 25 || $weightKg > 300) {
            sendJson(['status' => 'error', 'message' => 'Ingresa un peso válido en kg (25 - 300 kg).'], 400);
        }

        $uStmt = $pdo->prepare("SELECT initial_weight_kg, current_weight_kg, goal_weight_kg, bonus_xp FROM users WHERE id = ?");
        $uStmt->execute([$userId]);
        $uRow = $uStmt->fetch();

        $cntWStmt = $pdo->prepare("SELECT COUNT(*) FROM weight_logs WHERE user_id = ?");
        $cntWStmt->execute([$userId]);
        $hasPrevLogs = ((int)$cntWStmt->fetchColumn()) > 0;

        $prevWeight = $hasPrevLogs && (float)($uRow['current_weight_kg'] ?? 0) > 0
            ? (float)$uRow['current_weight_kg']
            : $weightKg;
        $initWeight = $hasPrevLogs && (float)($uRow['initial_weight_kg'] ?? 0) > 0
            ? (float)$uRow['initial_weight_kg']
            : $weightKg;
        $goalWeight = isset($input['goal_weight_kg']) && (float)$input['goal_weight_kg'] >= 25
            ? (float)$input['goal_weight_kg']
            : ((float)($uRow['goal_weight_kg'] ?? 0) >= 25 ? (float)$uRow['goal_weight_kg'] : $weightKg);

        $diffKg = $hasPrevLogs ? round($prevWeight - $weightKg, 2) : 0.0;
        $prevDistToGoal = abs($prevWeight - $goalWeight);
        $newDistToGoal  = abs($weightKg - $goalWeight);
        $improvedTowardsGoal = $hasPrevLogs && (($newDistToGoal < $prevDistToGoal) || ($diffKg > 0));

        $xpAwarded = !$hasPrevLogs
            ? 80
            : ($improvedTowardsGoal ? (int)max(120, round(abs($diffKg) * 200) + 90) : 50);

        $notes = !$hasPrevLogs
            ? "Peso inicial registrado ({$weightKg} kg | Meta: {$goalWeight} kg)"
            : ($diffKg > 0
                ? "Bajaste " . abs($diffKg) . " kg ({$prevWeight} kg → {$weightKg} kg)"
                : ($diffKg < 0 ? "Variación +" . abs($diffKg) . " kg ({$weightKg} kg)" : "Control de peso mantenido ({$weightKg} kg)"));

        $insW = $pdo->prepare("INSERT INTO weight_logs (user_id, weight_kg, notes, xp_awarded, logged_date) VALUES (?, ?, ?, ?, ?)");
        $insW->execute([$userId, $weightKg, $notes, $xpAwarded, $today]);

        $updU = $pdo->prepare("UPDATE users SET initial_weight_kg = ?, current_weight_kg = ?, goal_weight_kg = ?, bonus_xp = bonus_xp + ? WHERE id = ?");
        $updU->execute([$initWeight, $weightKg, $goalWeight, $xpAwarded, $userId]);

        sendJson([
            'status'     => 'success',
            'xp_awarded' => $xpAwarded,
            'diff_kg'    => $diffKg,
            'message'    => !$hasPrevLogs
                ? "¡Peso inicial configurado en {$weightKg} kg (Meta: {$goalWeight} kg)! • +{$xpAwarded} XP"
                : ($diffKg > 0
                    ? "¡META SUPERADA! Bajaste {$diffKg} kg ({$prevWeight} → {$weightKg} kg) • +{$xpAwarded} XP"
                    : "Peso actualizado a {$weightKg} kg (Meta: {$goalWeight} kg) • +{$xpAwarded} XP")
        ]);
        break;

    default:
        sendJson(['status' => 'error', 'message' => 'Acción no reconocida en habits_api'], 400);
}

/**
 * Construye las series históricas desde MySQL para consultas Semanales (7 días),
 * Mensuales (30 días) y Anuales (12 meses) de todos los hábitos.
 */
function buildAnalyticsProgress(PDO $pdo, int $userId, string $period): array {
    $dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    $monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    if ($period === 'yearly') {
        $startDate = date('Y-m-01', strtotime('-11 months'));
        $buckets = [];
        $labels = [];
        for ($i = 11; $i >= 0; $i--) {
            $ts = strtotime("-{$i} months");
            $key = date('Y-m', $ts);
            $mIdx = (int)date('n', $ts) - 1;
            $buckets[] = $key;
            $labels[] = $monthNames[$mIdx] . ' ' . date('y', $ts);
        }

        $qHyd = $pdo->prepare("SELECT DATE_FORMAT(logged_date, '%Y-%m') as k, COALESCE(SUM(consumed_ml), 0) as v FROM hydration_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qSlp = $pdo->prepare("SELECT DATE_FORMAT(logged_date, '%Y-%m') as k, ROUND(COALESCE(AVG(sleep_hours), 0), 1) as v FROM sleep_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qNut = $pdo->prepare("SELECT DATE_FORMAT(logged_date, '%Y-%m') as k, COALESCE(SUM(calories), 0) as v FROM nutrition_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qGym = $pdo->prepare("SELECT DATE_FORMAT(logged_date, '%Y-%m') as k, ROUND(COALESCE(SUM(sets * reps * weight_kg), 0)) as v FROM gym_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qWtc = $pdo->prepare("SELECT DATE_FORMAT(logged_date, '%Y-%m') as k, COALESCE(SUM(steps), 0) as v FROM watch_telemetry WHERE user_id = ? AND logged_date >= ? GROUP BY k");
    } else {
        $daysCount = ($period === 'monthly') ? 30 : 7;
        $startDate = date('Y-m-d', strtotime('-' . ($daysCount - 1) . ' days'));
        $buckets = [];
        $labels = [];
        for ($i = $daysCount - 1; $i >= 0; $i--) {
            $ts = strtotime("-{$i} days");
            $key = date('Y-m-d', $ts);
            $buckets[] = $key;
            if ($period === 'weekly') {
                $labels[] = $dayNames[(int)date('w', $ts)] . ' ' . date('d', $ts);
            } else {
                $labels[] = date('d/m', $ts);
            }
        }

        $qHyd = $pdo->prepare("SELECT logged_date as k, COALESCE(SUM(consumed_ml), 0) as v FROM hydration_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qSlp = $pdo->prepare("SELECT logged_date as k, ROUND(COALESCE(AVG(sleep_hours), 0), 1) as v FROM sleep_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qNut = $pdo->prepare("SELECT logged_date as k, COALESCE(SUM(calories), 0) as v FROM nutrition_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qGym = $pdo->prepare("SELECT logged_date as k, ROUND(COALESCE(SUM(sets * reps * weight_kg), 0)) as v FROM gym_logs WHERE user_id = ? AND logged_date >= ? GROUP BY k");
        $qWtc = $pdo->prepare("SELECT logged_date as k, COALESCE(MAX(steps), 0) as v FROM watch_telemetry WHERE user_id = ? AND logged_date >= ? GROUP BY k");
    }

    $fetchMap = function (PDOStatement $stmt) use ($userId, $startDate): array {
        $stmt->execute([$userId, $startDate]);
        $map = [];
        while ($row = $stmt->fetch()) {
            $map[$row['k']] = (float)$row['v'];
        }
        return $map;
    };

    $hydMap = $fetchMap($qHyd);
    $slpMap = $fetchMap($qSlp);
    $nutMap = $fetchMap($qNut);
    $gymMap = $fetchMap($qGym);
    $wtcMap = $fetchMap($qWtc);

    $series = [
        'hydration' => [],
        'sleep'     => [],
        'nutrition' => [],
        'gym'       => [],
        'watch'     => []
    ];

    foreach ($buckets as $b) {
        $series['hydration'][] = $hydMap[$b] ?? 0;
        $series['sleep'][]     = $slpMap[$b] ?? 0;
        $series['nutrition'][] = $nutMap[$b] ?? 0;
        $series['gym'][]       = $gymMap[$b] ?? 0;
        $series['watch'][]     = $wtcMap[$b] ?? 0;
    }

    return [
        'labels' => $labels,
        'keys'   => $buckets,
        'series' => $series
    ];
}

/**
 * Calcula los datos de Gamificación RPG (Nivel, XP, Racha de días, Récords Personales en Gimnasio,
 * Evolución de Peso en kg, Atributos de Videojuego y Logros Desbloqueados).
 */
function buildGamificationProfile(PDO $pdo, int $userId, array $user): array {
    // 1. Días activos combinados para calcular Racha Actual (Streak) y Mejor Racha
    $datesStmt = $pdo->prepare("
        SELECT DISTINCT d FROM (
            SELECT logged_date AS d FROM hydration_logs WHERE user_id = ?
            UNION
            SELECT logged_date AS d FROM sleep_logs WHERE user_id = ?
            UNION
            SELECT logged_date AS d FROM gym_logs WHERE user_id = ?
            UNION
            SELECT logged_date AS d FROM nutrition_logs WHERE user_id = ?
            UNION
            SELECT logged_date AS d FROM watch_telemetry WHERE user_id = ?
        ) AS all_days
        ORDER BY d DESC
    ");
    $datesStmt->execute([$userId, $userId, $userId, $userId, $userId]);
    $activeDates = $datesStmt->fetchAll(PDO::FETCH_COLUMN);

    $streakDays = 0;
    $bestStreak = 0;
    if (!empty($activeDates)) {
        $todayStr = date('Y-m-d');
        $yesterdayStr = date('Y-m-d', strtotime('-1 day'));
        $checkCursor = ($activeDates[0] === $todayStr) ? $todayStr : (($activeDates[0] === $yesterdayStr) ? $yesterdayStr : null);

        $dateSet = array_flip($activeDates);
        if ($checkCursor !== null) {
            $curr = $checkCursor;
            while (isset($dateSet[$curr])) {
                $streakDays++;
                $curr = date('Y-m-d', strtotime($curr . ' -1 day'));
            }
        }

        // Calcular mejor racha histórica
        $sortedAsc = array_reverse($activeDates);
        $run = 1;
        $bestStreak = 1;
        for ($i = 1, $n = count($sortedAsc); $i < $n; $i++) {
            $expected = date('Y-m-d', strtotime($sortedAsc[$i - 1] . ' +1 day'));
            if ($sortedAsc[$i] === $expected) {
                $run++;
                if ($run > $bestStreak) $bestStreak = $run;
            } else {
                $run = 1;
            }
        }
    }
    $bestStreak = max($bestStreak, $streakDays, 0);

    // 2. Récords Personales (PRs) en Gimnasio
    $prStmt = $pdo->prepare("
        SELECT exercise_name, muscle_group, MAX(weight_kg) AS max_weight_kg, MAX(sets * reps * weight_kg) AS max_volume_kg, COUNT(*) AS times_logged
        FROM gym_logs
        WHERE user_id = ?
        GROUP BY exercise_name, muscle_group
        ORDER BY max_weight_kg DESC
        LIMIT 6
    ");
    $prStmt->execute([$userId]);
    $gymPrs = $prStmt->fetchAll();

    // 3. Contadores globales para XP y Atributos RPG
    $cntGym = (int)$pdo->query("SELECT COUNT(*) FROM gym_logs WHERE user_id = {$userId}")->fetchColumn();
    $maxGymW = (float)($pdo->query("SELECT COALESCE(MAX(weight_kg), 0) FROM gym_logs WHERE user_id = {$userId}")->fetchColumn());
    $cntHyd = (int)$pdo->query("SELECT COUNT(DISTINCT logged_date) FROM hydration_logs WHERE user_id = {$userId}")->fetchColumn();
    $cntSlp = (int)$pdo->query("SELECT COUNT(*) FROM sleep_logs WHERE user_id = {$userId}")->fetchColumn();
    $cntNut = (int)$pdo->query("SELECT COUNT(*) FROM nutrition_logs WHERE user_id = {$userId}")->fetchColumn();
    $maxSteps = (int)$pdo->query("SELECT COALESCE(MAX(steps), 0) FROM watch_telemetry WHERE user_id = {$userId}")->fetchColumn();
    $cntWeightLogs = (int)$pdo->query("SELECT COUNT(*) FROM weight_logs WHERE user_id = {$userId}")->fetchColumn();

    $initWeight = (float)($user['initial_weight_kg'] ?? 0.0);
    $currWeight = (float)($user['current_weight_kg'] ?? 0.0);
    $goalWeight = (float)($user['goal_weight_kg'] ?? 0.0);
    $bonusXp    = (int)($user['bonus_xp'] ?? 0);

    $lostKg = ($cntWeightLogs > 0 && $initWeight > 0 && $currWeight > 0 && $initWeight > $currWeight)
        ? round($initWeight - $currWeight, 2)
        : 0.0;
    $weightXp = $lostKg > 0 ? (int)round($lostKg * 220) : 0;

    // Cálculo total de XP como videojuego RPG (las cuentas nuevas inician en 0 XP = Nivel 0)
    $totalXp = ($streakDays * 95)
        + ($cntGym * 70)
        + (int)round($maxGymW * 2.5)
        + ($cntHyd * 45)
        + ($cntSlp * 50)
        + ($cntNut * 40)
        + (int)round($maxSteps * 0.03)
        + $weightXp
        + $bonusXp;

    $xpPerLevel = 500;
    $level = (int)floor($totalXp / $xpPerLevel);
    $xpInLevel = $totalXp % $xpPerLevel;
    $levelPct = (int)min(100, round(($xpInLevel / $xpPerLevel) * 100));

    if ($level >= 25) {
        $rankTitle = 'Rey Mago • Leyenda Anti-Magia';
    } elseif ($level >= 15) {
        $rankTitle = 'Capitán de Orden • Unión Demoníaca';
    } elseif ($level >= 10) {
        $rankTitle = 'Rompedor de Límites • Élite';
    } elseif ($level >= 5) {
        $rankTitle = 'Guerrero de Hierro • Constante';
    } elseif ($level >= 1) {
        $rankTitle = 'Iniciado • Superando Límites';
    } else {
        $rankTitle = 'Novato • Nivel 0';
    }

    // 4. Estadísticas RPG (0 a 99: empiezan en 0 en cuentas nuevas y suben con cada hábito)
    $stats = [
        'str' => $cntGym > 0 ? min(99, 15 + ($cntGym * 6) + (int)round($maxGymW * 0.35)) : 0,
        'vit' => ($cntHyd > 0 || $cntWeightLogs > 0) ? min(99, 15 + ($cntHyd * 6) + ($cntWeightLogs * 5) + max(0, (int)round($lostKg * 8))) : 0,
        'rec' => $cntSlp > 0 ? min(99, 15 + ($cntSlp * 6)) : 0,
        'agi' => $maxSteps > 0 ? min(99, 10 + (int)round($maxSteps / 180)) : 0,
        'dsc' => ($streakDays > 0 || $cntNut > 0) ? min(99, 10 + ($streakDays * 8) + ($cntNut * 4)) : 0
    ];

    return [
        'level'             => $level,
        'rank_title'        => $rankTitle,
        'total_xp'          => $totalXp,
        'xp_in_level'       => $xpInLevel,
        'xp_for_next'       => $xpPerLevel,
        'xp_remaining'      => $xpPerLevel - $xpInLevel,
        'level_pct'         => $levelPct,
        'streak_days'       => $streakDays,
        'best_streak'       => $bestStreak,
        'total_active_days' => count($activeDates),
        'initial_weight_kg' => $initWeight,
        'current_weight_kg' => $currWeight,
        'goal_weight_kg'    => $goalWeight,
        'lost_kg'           => $lostKg,
        'stats'             => $stats,
        'gym_prs'           => $gymPrs
    ];
}
