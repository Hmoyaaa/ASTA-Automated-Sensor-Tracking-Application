<?php
/**
 * ASTA - API de Autenticación, Sesiones y Gestión Completa de Perfil de Usuario
 */

require_once __DIR__ . '/config.php';

$input = getJsonInput();
$action = $_GET['action'] ?? ($input['action'] ?? 'session');

$pdo = getDB();

$userFields = "id, username, email, avatar_data, magic_squad, magic_rank, api_token, thermos_capacity_ml, thermos_height_cm, sensor_offset_cm, daily_water_goal_ml, daily_calorie_goal, daily_step_goal, daily_sleep_goal_hrs, gemini_api_key";

switch ($action) {
    case 'login':
        $identifier = trim($input['identifier'] ?? '');
        $password   = $input['password'] ?? '';

        if ($identifier === '' || $password === '') {
            sendJson(['status' => 'error', 'message' => 'Ingresa tu usuario/correo y tu contraseña.'], 400);
        }

        $stmt = $pdo->prepare("SELECT * FROM users WHERE username = ? OR LOWER(email) = LOWER(?) LIMIT 1");
        $stmt->execute([$identifier, $identifier]);
        $user = $stmt->fetch();

        if (!$user) {
            sendJson(['status' => 'error', 'message' => 'No existe una cuenta registrada con ese usuario o correo. Crea una cuenta primero para guardar tu progreso.'], 401);
        }

        if (!password_verify($password, $user['password_hash'])) {
            sendJson(['status' => 'error', 'message' => 'Contraseña incorrecta. Verifica tus credenciales.'], 401);
        }

        // Si por algún registro previo el username quedó guardado como un correo con '@', repararlo automáticamente
        if (strpos((string)$user['username'], '@') !== false) {
            $cleanPrefix = explode('@', (string)$user['username'])[0];
            $cleanPrefix = preg_replace('/[^A-Za-z0-9_áéíóúÁÉÍÓÚñÑ]/u', '_', $cleanPrefix);
            $cleanPrefix = trim($cleanPrefix, '_');
            if (strlen($cleanPrefix) < 3) {
                $cleanPrefix = 'Caballero_' . $user['id'];
            }
            $fixStmt = $pdo->prepare("UPDATE users SET username = ? WHERE id = ?");
            $fixStmt->execute([$cleanPrefix, (int)$user['id']]);
            $user['username'] = $cleanPrefix;
        }

        $_SESSION['asta_user_id'] = (int)$user['id'];
        $_SESSION['asta_username'] = $user['username'];

        unset($user['password_hash'], $user['profile_edit_token'], $user['profile_edit_exp']);
        sendJson([
            'status'  => 'success',
            'message' => 'Grimorio abierto. Bienvenido, ' . $user['username'],
            'user'    => $user
        ]);
        break;

    case 'register':
        $username   = trim($input['username'] ?? '');
        $email      = trim($input['email'] ?? '');
        $password   = $input['password'] ?? '';
        $magicSquad = trim($input['magic_squad'] ?? 'Toros Negros (Black Bulls)');

        if (strpos($username, '@') !== false) {
            $username = explode('@', $username)[0];
        }

        if (strlen($username) < 3 || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 6) {
            sendJson([
                'status'  => 'error',
                'message' => 'Verifica tus datos: Usuario (mín. 3 letras, sin @), correo válido y contraseña (mín. 6 caracteres).'
            ], 400);
        }

        try {
            $check = $pdo->prepare("SELECT id FROM users WHERE username = ? OR LOWER(email) = LOWER(?) LIMIT 1");
            $check->execute([$username, $email]);
            if ($check->fetch()) {
                sendJson(['status' => 'error', 'message' => 'Ese nombre de usuario o correo ya tiene una cuenta registrada en la base de datos.'], 409);
            }

            $randBytes = function_exists('random_bytes') ? bin2hex(random_bytes(8)) : substr(md5(uniqid((string)mt_rand(), true)), 0, 16);
            $apiToken = 'ASTA-' . strtoupper($randBytes);
            $hash = password_hash($password, PASSWORD_DEFAULT);

            $stmt = $pdo->prepare("
                INSERT INTO users (username, email, password_hash, magic_squad, magic_rank, api_token, thermos_capacity_ml, thermos_height_cm, sensor_offset_cm, initial_weight_kg, current_weight_kg, goal_weight_kg, bonus_xp)
                VALUES (?, ?, ?, ?, 'Iniciado • Nivel 0', ?, 1183, 34.00, 12.00, 0.00, 0.00, 0.00, 0)
            ");
            $stmt->execute([$username, $email, $hash, $magicSquad, $apiToken]);
            $newUserId = (int)$pdo->lastInsertId();

            if ($newUserId <= 0) {
                $idStmt = $pdo->prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1");
                $idStmt->execute([$email]);
                $newUserId = (int)$idStmt->fetchColumn();
            }

            seedInitialUserData($pdo, $newUserId);

            $_SESSION['asta_user_id'] = $newUserId;
            $_SESSION['asta_username'] = $username;

            $stmtUser = $pdo->prepare("SELECT * FROM users WHERE id = ? LIMIT 1");
            $stmtUser->execute([$newUserId]);
            $user = $stmtUser->fetch();
            if (is_array($user)) {
                unset($user['password_hash'], $user['profile_edit_token'], $user['profile_edit_exp']);
                $user['is_new_account'] = true;
            }

            sendJson([
                'status'         => 'success',
                'saved_in_db'    => true,
                'is_new_account' => true,
                'message'        => '¡Cuenta creada en Nivel 0! Vamos a tu perfil para configurar tus datos iniciales.',
                'user'           => $user
            ]);
        } catch (Throwable $e) {
            sendJson([
                'status'  => 'error',
                'message' => 'Error al guardar la cuenta en MySQL: ' . $e->getMessage()
            ], 500);
        }
        break;

    case 'session':
        if (empty($_SESSION['asta_user_id'])) {
            sendJson(['status' => 'unauthenticated']);
        }
        $stmt = $pdo->prepare("SELECT $userFields FROM users WHERE id = ?");
        $stmt->execute([(int)$_SESSION['asta_user_id']]);
        $user = $stmt->fetch();
        if (!$user) {
            session_destroy();
            sendJson(['status' => 'unauthenticated']);
        }
        if (strpos((string)$user['username'], '@') !== false) {
            $cleanPrefix = explode('@', (string)$user['username'])[0];
            $cleanPrefix = preg_replace('/[^A-Za-z0-9_áéíóúÁÉÍÓÚñÑ]/u', '_', $cleanPrefix);
            $cleanPrefix = trim($cleanPrefix, '_') ?: ('Caballero_' . $user['id']);
            $pdo->prepare("UPDATE users SET username = ? WHERE id = ?")->execute([$cleanPrefix, (int)$user['id']]);
            $user['username'] = $cleanPrefix;
            $_SESSION['asta_username'] = $cleanPrefix;
        }
        sendJson([
            'status' => 'authenticated',
            'user'   => $user
        ]);
        break;

    case 'request_profile_edit_link':
        $userId = requireAuth();
        $currStmt = $pdo->prepare("SELECT id, username, email FROM users WHERE id = ?");
        $currStmt->execute([$userId]);
        $current = $currStmt->fetch();
        if (!$current) {
            sendJson(['status' => 'error', 'message' => 'Usuario no encontrado.'], 404);
        }

        $linkedEmail = trim((string)$current['email']);
        if (!filter_var($linkedEmail, FILTER_VALIDATE_EMAIL)) {
            $fallbackInputEmail = trim((string)($input['email'] ?? ''));
            if (filter_var($fallbackInputEmail, FILTER_VALIDATE_EMAIL)) {
                $linkedEmail = $fallbackInputEmail;
            } else {
                sendJson(['status' => 'error', 'message' => 'No hay un correo electrónico válido enlazado a tu cuenta.'], 400);
            }
        }

        $editToken = 'ASTA-EDIT-' . bin2hex(random_bytes(20));
        $expTime   = time() + 1200; // 20 minutos de validez

        try {
            $tokUpd = $pdo->prepare("UPDATE users SET profile_edit_token = ?, profile_edit_exp = ? WHERE id = ?");
            $tokUpd->execute([$editToken, $expTime, $userId]);
        } catch (Throwable $_) {}

        $_SESSION['asta_profile_edit_token'] = $editToken;
        $_SESSION['asta_profile_edit_exp']   = $expTime;

        $dashboardUrl = trim((string)($input['dashboard_url'] ?? ''));
        if ($dashboardUrl === '') {
            $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
            $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
            $basePath = preg_replace('#/php/auth_api\.php.*$#i', '/html/dashboard.html', $_SERVER['REQUEST_URI'] ?? '/ASTA/html/dashboard.html');
            $dashboardUrl = "{$scheme}://{$host}{$basePath}";
        } else {
            $dashboardUrl = strtok($dashboardUrl, '?#');
        }

        $exclusiveLink = $dashboardUrl . '?tab=profile&profile_edit_token=' . urlencode($editToken);
        $usernameSafe  = htmlspecialchars($current['username'], ENT_QUOTES, 'UTF-8');
        $linkSafe      = htmlspecialchars($exclusiveLink, ENT_QUOTES, 'UTF-8');

        $subject = "A.S.T.A. - Enlace exclusivo para modificar datos de tu perfil";
        $htmlBody = "
        <div style='font-family:Inter,Arial,sans-serif;background:#080203;color:#ffffff;padding:28px;border-radius:16px;border:1px solid #ff1a2d;max-width:520px;margin:0 auto;'>
            <h2 style='margin:0 0 12px 0;color:#ff1a2d;letter-spacing:1px;'>A.S.T.A. — Autorización de Modificación de Perfil</h2>
            <p style='color:#d8c6c9;font-size:14px;line-height:1.5;'>Hola <strong>{$usernameSafe}</strong>, recibimos una solicitud para modificar los datos de tu perfil en <strong>Automated Sensor Tracking Application</strong>.</p>
            <p style='color:#d8c6c9;font-size:14px;line-height:1.5;'>Por seguridad, los cambios en tu perfil requieren autorización desde tu correo enlazado (<strong>{$linkedEmail}</strong>). Pulsa el siguiente enlace exclusivo (válido por 20 minutos y de un solo uso) para desbloquear la edición:</p>
            <div style='text-align:center;margin:24px 0;'>
                <a href='{$linkSafe}' style='display:inline-block;background:linear-gradient(135deg,#ff1a2d,#990012);color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:999px;font-weight:700;font-size:14px;border:1px solid rgba(255,255,255,0.25);'>
                    Desbloquear y Modificar Datos de Mi Perfil
                </a>
            </div>
            <p style='color:#b89ea3;font-size:12px;word-break:break-all;background:#140306;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,26,45,0.3);'>
                Enlace directo:<br><a href='{$linkSafe}' style='color:#ff6b7b;'>{$linkSafe}</a>
            </p>
            <p style='color:#9c898d;font-size:12px;margin-top:16px;'>Si no solicitaste modificar tu perfil, ignora este correo y tus datos permanecerán protegidos.</p>
        </div>";

        $plainBody = "Hola {$current['username']},\n\n"
            . "Recibimos una solicitud para modificar los datos de tu perfil en Automated Sensor Tracking Application (A.S.T.A.).\n"
            . "Abre el siguiente enlace exclusivo (válido por 20 minutos y de un solo uso) para desbloquear la edición de tu perfil:\n\n"
            . "{$exclusiveLink}\n\n"
            . "Si no solicitaste este cambio, ignora este mensaje.";

        $mailResult = sendAstaRealEmail($linkedEmail, $subject, $htmlBody, $plainBody);
        $mailSent   = !empty($mailResult['sent']);

        sendJson([
            'status'         => 'success',
            'mail_sent'      => $mailSent,
            'transport'      => $mailResult['transport'] ?? 'php_mail',
            'email'          => $linkedEmail,
            'exclusive_link' => ($mailSent && empty($isLocal)) ? null : $exclusiveLink,
            'token'          => $editToken,
            'expires_in'     => 1200,
            'message'        => $mailSent
                ? "Hemos enviado el enlace exclusivo a tu correo ({$linkedEmail}). Revisa tu bandeja de entrada o spam y ábrelo para modificar tus datos."
                : "Solicitud generada para {$linkedEmail}. Abre el enlace exclusivo para desbloquear la modificación de tus datos."
        ]);
        break;

    case 'verify_profile_edit_link':
        $token = trim((string)($input['token'] ?? ($_GET['token'] ?? '')));
        if ($token === '') {
            sendJson(['status' => 'error', 'message' => 'Token de enlace exclusivo no proporcionado.'], 400);
        }

        // Buscar por token en la base de datos o en la sesión activa
        $matchedUser = null;
        try {
            $vStmt = $pdo->prepare("SELECT * FROM users WHERE profile_edit_token = ? LIMIT 1");
            $vStmt->execute([$token]);
            $matchedUser = $vStmt->fetch();
        } catch (Throwable $_) {}

        $now = time();
        if ($matchedUser) {
            $exp = (int)($matchedUser['profile_edit_exp'] ?? 0);
            if ($exp < $now) {
                sendJson(['status' => 'error', 'message' => 'El enlace exclusivo ha expirado. Solicita uno nuevo desde Mi Perfil.'], 400);
            }
            $_SESSION['asta_user_id']            = (int)$matchedUser['id'];
            $_SESSION['asta_username']           = $matchedUser['username'];
            $_SESSION['asta_profile_edit_token'] = $token;
            $_SESSION['asta_profile_edit_exp']   = $exp;

            $stmtUser = $pdo->prepare("SELECT $userFields FROM users WHERE id = ?");
            $stmtUser->execute([(int)$matchedUser['id']]);
            $cleanUser = $stmtUser->fetch();

            sendJson([
                'status'     => 'success',
                'valid'      => true,
                'expires_in' => max(1, $exp - $now),
                'user'       => $cleanUser,
                'message'    => 'Enlace exclusivo verificado. La edición de datos en Mi Perfil está desbloqueada.'
            ]);
        }

        $sessTok = $_SESSION['asta_profile_edit_token'] ?? '';
        $sessExp = (int)($_SESSION['asta_profile_edit_exp'] ?? 0);
        if ($sessTok !== '' && hash_equals((string)$sessTok, $token) && $sessExp >= $now) {
            sendJson([
                'status'     => 'success',
                'valid'      => true,
                'expires_in' => max(1, $sessExp - $now),
                'message'    => 'Enlace exclusivo verificado. La edición de datos en Mi Perfil está desbloqueada.'
            ]);
        }

        sendJson([
            'status'  => 'error',
            'valid'   => false,
            'message' => 'El enlace exclusivo no es válido, ya fue utilizado o ha expirado.'
        ], 403);
        break;

    case 'update_profile':
    case 'update_settings':
        $userId = requireAuth();

        // Obtener datos actuales del usuario
        $currStmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");
        $currStmt->execute([$userId]);
        $current = $currStmt->fetch();
        if (!$current) {
            sendJson(['status' => 'error', 'message' => 'Usuario no encontrado.'], 404);
        }

        // Verificar que la modificación venga autorizada mediante el enlace exclusivo enviado al correo enlazado
        $providedToken = trim((string)($input['profile_edit_token'] ?? ''));
        $dbToken       = (string)($current['profile_edit_token'] ?? '');
        $dbExp         = (int)($current['profile_edit_exp'] ?? 0);
        $sessToken     = (string)($_SESSION['asta_profile_edit_token'] ?? '');
        $sessExp       = (int)($_SESSION['asta_profile_edit_exp'] ?? 0);
        $now           = time();

        $tokenValidDb   = ($providedToken !== '' && $dbToken !== '' && hash_equals($dbToken, $providedToken) && $dbExp >= $now);
        $tokenValidSess = ($providedToken !== '' && $sessToken !== '' && hash_equals($sessToken, $providedToken) && $sessExp >= $now);

        if (!$tokenValidDb && !$tokenValidSess) {
            sendJson([
                'status'       => 'error',
                'require_link' => true,
                'message'      => 'Para modificar tus datos debes solicitar el correo de verificación y abrir el enlace exclusivo enviado a tu cuenta.'
            ], 403);
        }

        $rawUsername = isset($input['username']) && trim($input['username']) !== '' ? trim($input['username']) : $current['username'];
        // Impedir que un correo electrónico reemplace al nombre de usuario
        if (strpos($rawUsername, '@') !== false) {
            $rawUsername = strpos((string)$current['username'], '@') === false
                ? $current['username']
                : explode('@', $rawUsername)[0];
        }
        $username   = $rawUsername;
        $email      = isset($input['email']) && trim($input['email']) !== '' ? trim($input['email']) : $current['email'];
        $magicSquad = isset($input['magic_squad']) && trim($input['magic_squad']) !== '' ? trim($input['magic_squad']) : $current['magic_squad'];
        $magicRank  = isset($input['magic_rank']) && trim($input['magic_rank']) !== '' ? trim($input['magic_rank']) : $current['magic_rank'];
        $avatarData = array_key_exists('avatar_data', $input) ? $input['avatar_data'] : $current['avatar_data'];

        // Validar duplicados si cambió su nombre de usuario o email
        $dupStmt = $pdo->prepare("SELECT id FROM users WHERE (username = ? OR LOWER(email) = LOWER(?)) AND id != ? LIMIT 1");
        $dupStmt->execute([$username, $email, $userId]);
        if ($dupStmt->fetch()) {
            sendJson(['status' => 'error', 'message' => 'Ese nombre de usuario o correo ya está en uso por otra cuenta.'], 409);
        }

        $thermosCap    = isset($input['thermos_capacity_ml']) ? max(200, (int)$input['thermos_capacity_ml']) : (int)$current['thermos_capacity_ml'];
        $thermosHeight = isset($input['thermos_height_cm']) ? max(5.0, (float)$input['thermos_height_cm']) : (float)$current['thermos_height_cm'];
        $sensorOffset  = isset($input['sensor_offset_cm']) ? max(0.5, (float)$input['sensor_offset_cm']) : (float)$current['sensor_offset_cm'];
        $waterGoal     = isset($input['daily_water_goal_ml']) ? max(500, (int)$input['daily_water_goal_ml']) : (int)$current['daily_water_goal_ml'];
        $calGoal       = isset($input['daily_calorie_goal']) ? max(800, (int)$input['daily_calorie_goal']) : (int)$current['daily_calorie_goal'];
        $stepGoal      = isset($input['daily_step_goal']) ? max(1000, (int)$input['daily_step_goal']) : (int)$current['daily_step_goal'];
        $sleepGoal     = isset($input['daily_sleep_goal_hrs']) ? max(4.0, (float)$input['daily_sleep_goal_hrs']) : (float)$current['daily_sleep_goal_hrs'];
        $geminiKey     = array_key_exists('gemini_api_key', $input) ? trim((string)$input['gemini_api_key']) : $current['gemini_api_key'];

        // Si el usuario ingresó una nueva contraseña para actualizarla
        $newPassword = trim($input['new_password'] ?? '');
        $passwordHash = $current['password_hash'];
        if ($newPassword !== '') {
            if (strlen($newPassword) < 6) {
                sendJson(['status' => 'error', 'message' => 'La nueva contraseña debe tener al menos 6 caracteres.'], 400);
            }
            $passwordHash = password_hash($newPassword, PASSWORD_DEFAULT);
        }

        $stmt = $pdo->prepare("
            UPDATE users
            SET username = ?,
                email = ?,
                password_hash = ?,
                avatar_data = ?,
                magic_squad = ?,
                magic_rank = ?,
                thermos_capacity_ml = ?,
                thermos_height_cm = ?,
                sensor_offset_cm = ?,
                daily_water_goal_ml = ?,
                daily_calorie_goal = ?,
                daily_step_goal = ?,
                daily_sleep_goal_hrs = ?,
                gemini_api_key = ?,
                profile_edit_token = NULL,
                profile_edit_exp = NULL
            WHERE id = ?
        ");
        $stmt->execute([
            $username,
            $email,
            $passwordHash,
            $avatarData,
            $magicSquad,
            $magicRank,
            $thermosCap,
            $thermosHeight,
            $sensorOffset,
            $waterGoal,
            $calGoal,
            $stepGoal,
            $sleepGoal,
            $geminiKey,
            $userId
        ]);

        unset($_SESSION['asta_profile_edit_token'], $_SESSION['asta_profile_edit_exp']);
        $_SESSION['asta_username'] = $username;

        $stmtUser = $pdo->prepare("SELECT $userFields FROM users WHERE id = ?");
        $stmtUser->execute([$userId]);

        sendJson([
            'status'  => 'success',
            'message' => 'Perfil, foto y parámetros actualizados correctamente. El enlace de edición de un solo uso ha sido cerrado.',
            'user'    => $stmtUser->fetch()
        ]);
        break;

    case 'request_password_email':
        $userId = requireAuth();
        $currStmt = $pdo->prepare("SELECT username, email FROM users WHERE id = ?");
        $currStmt->execute([$userId]);
        $current = $currStmt->fetch();
        if (!$current) {
            sendJson(['status' => 'error', 'message' => 'Usuario no encontrado.'], 404);
        }

        $targetEmail = isset($input['email']) && filter_var(trim($input['email']), FILTER_VALIDATE_EMAIL)
            ? trim($input['email'])
            : $current['email'];

        if (!filter_var($targetEmail, FILTER_VALIDATE_EMAIL)) {
            sendJson(['status' => 'error', 'message' => 'Ingresa un correo electrónico válido en tu perfil.'], 400);
        }

        $code = (string)random_int(100000, 999999);
        $_SESSION['asta_pwd_reset_code'] = $code;
        $_SESSION['asta_pwd_reset_exp']  = time() + 900; // 15 minutos de validez

        $subject = "A.S.T.A. - Codigo para cambiar tu contrasena";
        $usernameSafe = htmlspecialchars($current['username'], ENT_QUOTES, 'UTF-8');
        $htmlBody = "
        <div style='font-family:Inter,Arial,sans-serif;background:#080203;color:#ffffff;padding:28px;border-radius:16px;border:1px solid #ff1a2d;max-width:480px;margin:0 auto;'>
            <h2 style='margin:0 0 12px 0;color:#ff1a2d;letter-spacing:1px;'>A.S.T.A. — Cambio de Contraseña</h2>
            <p style='color:#d8c6c9;font-size:14px;line-height:1.5;'>Hola <strong>{$usernameSafe}</strong>, has solicitado cambiar la contraseña de tu cuenta en Automated Sensor Tracking Application.</p>
            <p style='color:#d8c6c9;font-size:14px;'>Usa el siguiente código de verificación en tu perfil (válido por 15 minutos):</p>
            <div style='background:#160407;border:1px solid rgba(255,26,45,0.5);border-radius:12px;padding:14px;text-align:center;font-size:26px;font-weight:700;letter-spacing:6px;color:#ffffff;margin:18px 0;'>
                {$code}
            </div>
            <p style='color:#9c898d;font-size:12px;margin-top:16px;'>Si no solicitaste este cambio, puedes ignorar este mensaje.</p>
        </div>";

        $plainBody = "Hola {$current['username']},\n\n"
            . "Has solicitado cambiar la contraseña de tu cuenta en Automated Sensor Tracking Application (A.S.T.A.).\n"
            . "Usa el siguiente código de verificación en tu perfil (válido por 15 minutos):\n\n"
            . "{$code}\n\n"
            . "Si no solicitaste este cambio, ignora este mensaje.";

        $mailResult = sendAstaRealEmail($targetEmail, $subject, $htmlBody, $plainBody);
        $mailSent   = !empty($mailResult['sent']);

        sendJson([
            'status'    => 'success',
            'mail_sent' => $mailSent,
            'transport' => $mailResult['transport'] ?? 'php_mail',
            'email'     => $targetEmail,
            'dev_code'  => ($mailSent && empty($isLocal)) ? null : $code,
            'message'   => $mailSent
                ? "Hemos enviado un correo real a {$targetEmail} con tu código para cambiar la contraseña. Revisa tu bandeja de entrada o spam."
                : "Correo preparado para {$targetEmail} (Servidor local sin SMTP externo: código {$code})."
        ]);
        break;

    case 'confirm_password_email':
        $userId = requireAuth();
        $code        = trim($input['code'] ?? '');
        $newPassword = trim($input['new_password'] ?? '');

        if ($code === '' || $newPassword === '') {
            sendJson(['status' => 'error', 'message' => 'Ingresa el código recibido en tu correo y tu nueva contraseña.'], 400);
        }
        if (strlen($newPassword) < 6) {
            sendJson(['status' => 'error', 'message' => 'La nueva contraseña debe tener al menos 6 caracteres.'], 400);
        }

        $savedCode = $_SESSION['asta_pwd_reset_code'] ?? null;
        $savedExp  = $_SESSION['asta_pwd_reset_exp'] ?? 0;

        if (!$savedCode || time() > $savedExp) {
            sendJson(['status' => 'error', 'message' => 'El código ha expirado o no se ha solicitado. Envía un nuevo correo.'], 400);
        }
        if ($code !== (string)$savedCode) {
            sendJson(['status' => 'error', 'message' => 'El código de verificación no coincide.'], 400);
        }

        $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
        $upd = $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ?");
        $upd->execute([$newHash, $userId]);

        unset($_SESSION['asta_pwd_reset_code'], $_SESSION['asta_pwd_reset_exp']);

        sendJson([
            'status'  => 'success',
            'message' => '¡Tu contraseña ha sido actualizada correctamente!'
        ]);
        break;

    case 'rotate_token':
        $userId = requireAuth();
        $newToken = 'ASTA-' . strtoupper(bin2hex(random_bytes(8)));
        $upd = $pdo->prepare("UPDATE users SET api_token = ? WHERE id = ?");
        $upd->execute([$newToken, $userId]);

        $stmtUser = $pdo->prepare("SELECT $userFields FROM users WHERE id = ?");
        $stmtUser->execute([$userId]);
        $user = $stmtUser->fetch();

        sendJson([
            'status'    => 'success',
            'api_token' => $newToken,
            'user'      => $user,
            'message'   => 'Nuevo API Token criptográfico generado para tu ESP32: ' . $newToken
        ]);
        break;

    case 'logout':
        session_unset();
        session_destroy();
        sendJson(['status' => 'success', 'message' => 'Sesión finalizada.']);
        break;

    default:
        sendJson(['status' => 'error', 'message' => 'Acción desconocida'], 400);
}
