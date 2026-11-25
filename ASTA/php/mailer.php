<?php
/**
 * ASTA (Automated Sensor Tracking Application)
 * Motor de Envío de Correo Real para Producción HTTP/HTTPS (SMTP SSL/TLS + API + RFC 5322 mail())
 * Compatible con AwardSpace, cPanel, Hostinger, VPS y Laragon
 */

/**
 * Envía un correo electrónico real (HTML + Texto Plano multipart/alternative)
 * intentando en orden:
 *   1) API HTTP Transaccional (Brevo / Resend por puerto 443, ideal para hostings que bloquean puertos SMTP)
 *   2) Cliente SMTP directo por Socket SSL/STARTTLS (Gmail App Password, Brevo, Hosting SMTP)
 *   3) Función nativa mail() de PHP con cabeceras RFC 5322 completas + parámetro de sobre (-f)
 *
 * @param string $toEmail      Correo destinatario
 * @param string $subject      Asunto del correo
 * @param string $htmlContent  Cuerpo en HTML
 * @param string $plainContent Cuerpo alternativo en texto plano (opcional)
 * @return array ['sent' => bool, 'transport' => string, 'debug' => string]
 */
function sendAstaRealEmail(string $toEmail, string $subject, string $htmlContent, string $plainContent = ''): array {
    $toEmail = trim($toEmail);
    if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) {
        return ['sent' => false, 'transport' => 'none', 'debug' => 'Invalid recipient email'];
    }

    if ($plainContent === '') {
        $plainContent = trim( html_entity_decode(strip_tags(str_replace(['<br>', '<br/>', '<br />', '</p>', '</div>', '</h2>'], "\n", $htmlContent)), ENT_QUOTES, 'UTF-8') );
    }

    // Determinar dominio real del servidor HTTP donde está montado el proyecto
    $rawHost = $_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? 'asta-app.com');
    $cleanDomain = strtolower(preg_replace('/:\d+$/', '', trim($rawHost)));
    $isLocalHost = in_array($cleanDomain, ['localhost', '127.0.0.1', 'asta.test'], true) || strpos($cleanDomain, '192.168.') === 0;

    $senderDomain = $isLocalHost ? 'asta-tracker.com' : $cleanDomain;
    $fromEmail = (defined('SMTP_FROM_EMAIL') && SMTP_FROM_EMAIL !== '')
        ? SMTP_FROM_EMAIL
        : ((defined('SMTP_USER') && filter_var(SMTP_USER, FILTER_VALIDATE_EMAIL)) ? SMTP_USER : "no-reply@{$senderDomain}");
    $fromName = (defined('SMTP_FROM_NAME') && SMTP_FROM_NAME !== '')
        ? SMTP_FROM_NAME
        : 'A.S.T.A. Security';

    // -------------------------------------------------------------------------
    // 1) TRANSPORTE API HTTP (Puerto 443 - Funciona incluso si el hosting bloquea puertos 25/465/587)
    // -------------------------------------------------------------------------
    if (defined('BREVO_API_KEY') && BREVO_API_KEY !== '') {
        $apiRes = sendViaBrevoHttpApi($toEmail, $fromEmail, $fromName, $subject, $htmlContent, $plainContent, BREVO_API_KEY);
        if ($apiRes['sent']) {
            return $apiRes;
        }
    }

    // -------------------------------------------------------------------------
    // 2) TRANSPORTE SMTP DIRECTO CON AUTENTICACIÓN SSL / STARTTLS
    // -------------------------------------------------------------------------
    if (defined('SMTP_HOST') && SMTP_HOST !== '' && defined('SMTP_USER') && SMTP_USER !== '' && defined('SMTP_PASS') && SMTP_PASS !== '') {
        $smtpPort = defined('SMTP_PORT') ? (int)SMTP_PORT : 587;
        $smtpEnc  = defined('SMTP_ENCRYPTION') ? strtolower(SMTP_ENCRYPTION) : ($smtpPort === 465 ? 'ssl' : 'tls');
        $smtpRes  = sendViaSmtpSocket(
            SMTP_HOST,
            $smtpPort,
            $smtpEnc,
            SMTP_USER,
            SMTP_PASS,
            $fromEmail,
            $fromName,
            $toEmail,
            $subject,
            $htmlContent,
            $plainContent
        );
        if ($smtpRes['sent']) {
            return $smtpRes;
        }
    }

    // -------------------------------------------------------------------------
    // 3) TRANSPORTE NATIVO PHP mail() CON CABECERAS RFC 5322 MULTIPART/ALTERNATIVE
    //    (Optimizado para servidores HTTP como AwardSpace, cPanel, Hostinger, Apache/Nginx)
    // -------------------------------------------------------------------------
    return sendViaNativePhpMail($toEmail, $fromEmail, $fromName, $senderDomain, $subject, $htmlContent, $plainContent);
}

/**
 *Construye un cuerpo MIME multipart/alternative RFC 5322 (Texto plano + HTML)
 */
function buildMultipartMimeMessage(string $boundary, string $htmlContent, string $plainContent): string {
    $eol = "\r\n";
    $body  = "--{$boundary}{$eol}";
    $body .= "Content-Type: text/plain; charset=UTF-8{$eol}";
    $body .= "Content-Transfer-Encoding: base64{$eol}{$eol}";
    $body .= chunk_split(base64_encode($plainContent), 76, $eol) . $eol;

    $body .= "--{$boundary}{$eol}";
    $body .= "Content-Type: text/html; charset=UTF-8{$eol}";
    $body .= "Content-Transfer-Encoding: base64{$eol}{$eol}";
    $body .= chunk_split(base64_encode($htmlContent), 76, $eol) . $eol;

    $body .= "--{$boundary}--{$eol}";
    return $body;
}

/**
 * Envío mediante función mail() de PHP con cabeceras completas anti-spam para servidores HTTP
 */
function sendViaNativePhpMail(
    string $toEmail,
    string $fromEmail,
    string $fromName,
    string $senderDomain,
    string $subject,
    string $htmlContent,
    string $plainContent
): array {
    $boundary = '=_ASTA_MIME_' . bin2hex(random_bytes(12));
    $encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    $encodedFromName = '=?UTF-8?B?' . base64_encode($fromName) . '?=';
    $msgId = '<' . bin2hex(random_bytes(10)) . '@' . $senderDomain . '>';
    $dateHeader = date(DATE_RFC2822);

    $headers = [
        "Date: {$dateHeader}",
        "From: {$encodedFromName} <{$fromEmail}>",
        "Reply-To: {$fromEmail}",
        "Return-Path: {$fromEmail}",
        "Message-ID: {$msgId}",
        "MIME-Version: 1.0",
        "Content-Type: multipart/alternative; boundary=\"{$boundary}\"",
        "X-Mailer: ASTA-Mailer/3.0 (PHP/" . phpversion() . ")",
        "X-Priority: 1 (Highest)"
    ];

    $mimeBody = buildMultipartMimeMessage($boundary, $htmlContent, $plainContent);
    $headerStr = implode("\r\n", $headers);

    // Intento A: Con parámetro -f (envelope sender) requerido por muchos servidores Linux/HTTP (AwardSpace, cPanel)
    $sent = @mail($toEmail, $encodedSubject, $mimeBody, $headerStr, "-f{$fromEmail}");
    if ($sent) {
        return ['sent' => true, 'transport' => 'php_mail_envelope', 'debug' => "Sent via PHP mail(-f {$fromEmail})"];
    }

    // Intento B: Sin parámetro -f (por si el servidor tiene restricciones safe_mode / open_basedir)
    $sentFallback = @mail($toEmail, $encodedSubject, $mimeBody, $headerStr);
    if ($sentFallback) {
        return ['sent' => true, 'transport' => 'php_mail_standard', 'debug' => 'Sent via standard PHP mail()'];
    }

    // Intento C: Con saltos de línea LF (\n) para agentes MTA locales en Linux que rechazan CRLF en headers
    $headerStrLf = implode("\n", $headers);
    $sentLf = @mail($toEmail, $encodedSubject, $mimeBody, $headerStrLf);
    if ($sentLf) {
        return ['sent' => true, 'transport' => 'php_mail_lf', 'debug' => 'Sent via PHP mail() with LF headers'];
    }

    return ['sent' => false, 'transport' => 'php_mail', 'debug' => 'PHP mail() returned false (no local MTA configured)'];
}

/**
 * Cliente SMTP completo sobre sockets nativos de PHP (soporta SSL puerto 465 y STARTTLS puerto 587)
 */
function sendViaSmtpSocket(
    string $host,
    int $port,
    string $encryption,
    string $username,
    string $password,
    string $fromEmail,
    string $fromName,
    string $toEmail,
    string $subject,
    string $htmlContent,
    string $plainContent
): array {
    $remote = ($encryption === 'ssl' ? 'ssl://' : 'tcp://') . $host . ':' . $port;
    $context = stream_context_create([
        'ssl' => [
            'verify_peer'       => false,
            'verify_peer_name'  => false,
            'allow_self_signed' => true
        ]
    ]);

    $errno = 0;
    $errstr = '';
    $socket = @stream_socket_client($remote, $errno, $errstr, 12, STREAM_CLIENT_CONNECT, $context);
    if (!$socket) {
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "Connection failed: {$errstr} ({$errno})"];
    }

    stream_set_timeout($socket, 12);

    $readResponse = static function ($fp): string {
        $data = '';
        while ($str = fgets($fp, 515)) {
            $data .= $str;
            if (isset($str[3]) && $str[3] === ' ') {
                break;
            }
        }
        return $data;
    };

    $sendCmd = static function ($fp, string $cmd, array $expectedCodes) use ($readResponse): array {
        fwrite($fp, $cmd . "\r\n");
        $resp = $readResponse($fp);
        $code = (int)substr($resp, 0, 3);
        return ['ok' => in_array($code, $expectedCodes, true), 'resp' => $resp];
    };

    $greeting = $readResponse($socket);
    if ((int)substr($greeting, 0, 3) !== 220) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "Invalid greeting: {$greeting}"];
    }

    $localHost = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $ehlo = $sendCmd($socket, "EHLO {$localHost}", [250]);
    if (!$ehlo['ok']) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "EHLO failed: {$ehlo['resp']}"];
    }

    if ($encryption === 'tls') {
        $startTls = $sendCmd($socket, "STARTTLS", [220]);
        if (!$startTls['ok']) {
            fclose($socket);
            return ['sent' => false, 'transport' => 'smtp', 'debug' => "STARTTLS failed: {$startTls['resp']}"];
        }
        $cryptoOk = @stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT);
        if (!$cryptoOk) {
            fclose($socket);
            return ['sent' => false, 'transport' => 'smtp', 'debug' => 'TLS negotiation failed'];
        }
        $ehloTls = $sendCmd($socket, "EHLO {$localHost}", [250]);
        if (!$ehloTls['ok']) {
            fclose($socket);
            return ['sent' => false, 'transport' => 'smtp', 'debug' => "EHLO after TLS failed: {$ehloTls['resp']}"];
        }
    }

    $auth = $sendCmd($socket, "AUTH LOGIN", [334]);
    if (!$auth['ok']) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "AUTH LOGIN failed: {$auth['resp']}"];
    }

    $userStep = $sendCmd($socket, base64_encode($username), [334]);
    if (!$userStep['ok']) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "SMTP username rejected: {$userStep['resp']}"];
    }

    $passStep = $sendCmd($socket, base64_encode($password), [235]);
    if (!$passStep['ok']) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "SMTP password rejected: {$passStep['resp']}"];
    }

    $mailFrom = $sendCmd($socket, "MAIL FROM:<{$fromEmail}>", [250]);
    if (!$mailFrom['ok']) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "MAIL FROM failed: {$mailFrom['resp']}"];
    }

    $rcptTo = $sendCmd($socket, "RCPT TO:<{$toEmail}>", [250, 251]);
    if (!$rcptTo['ok']) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "RCPT TO failed: {$rcptTo['resp']}"];
    }

    $dataCmd = $sendCmd($socket, "DATA", [354]);
    if (!$dataCmd['ok']) {
        fclose($socket);
        return ['sent' => false, 'transport' => 'smtp', 'debug' => "DATA command failed: {$dataCmd['resp']}"];
    }

    $boundary = '=_ASTA_SMTP_' . bin2hex(random_bytes(12));
    $encodedSubject  = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    $encodedFromName = '=?UTF-8?B?' . base64_encode($fromName) . '?=';
    $msgId = '<' . bin2hex(random_bytes(10)) . '@' . ($host ?: 'asta-app.com') . '>';

    $headers = [
        "Date: " . date(DATE_RFC2822),
        "From: {$encodedFromName} <{$fromEmail}>",
        "To: <{$toEmail}>",
        "Subject: {$encodedSubject}",
        "Reply-To: {$fromEmail}",
        "Message-ID: {$msgId}",
        "MIME-Version: 1.0",
        "Content-Type: multipart/alternative; boundary=\"{$boundary}\""
    ];

    $mimeBody = buildMultipartMimeMessage($boundary, $htmlContent, $plainContent);
    $fullPayload = implode("\r\n", $headers) . "\r\n\r\n" . $mimeBody . "\r\n.";

    $sendData = $sendCmd($socket, $fullPayload, [250]);
    $sendCmd($socket, "QUIT", [221, 250]);
    fclose($socket);

    if ($sendData['ok']) {
        return ['sent' => true, 'transport' => 'smtp_socket', 'debug' => 'Sent via authenticated SMTP'];
    }
    return ['sent' => false, 'transport' => 'smtp', 'debug' => "SMTP DATA rejected: {$sendData['resp']}"];
}

/**
 * Envío por API HTTP de Brevo (Puerto 443 HTTPS) en caso de configurar BREVO_API_KEY
 */
function sendViaBrevoHttpApi(
    string $toEmail,
    string $fromEmail,
    string $fromName,
    string $subject,
    string $htmlContent,
    string $plainContent,
    string $apiKey
): array {
    $payload = json_encode([
        'sender'      => ['name' => $fromName, 'email' => $fromEmail],
        'to'          => [['email' => $toEmail]],
        'subject'     => $subject,
        'htmlContent' => $htmlContent,
        'textContent' => $plainContent
    ]);

    $ctx = stream_context_create([
        'http' => [
            'method'  => 'POST',
            'header'  => "Accept: application/json\r\nContent-Type: application/json\r\napi-key: {$apiKey}\r\n",
            'content' => $payload,
            'timeout' => 10
        ]
    ]);

    $resp = @file_get_contents('https://api.brevo.com/v3/smtp/email', false, $ctx);
    if ($resp !== false) {
        $decoded = json_decode($resp, true);
        if (is_array($decoded) && !empty($decoded['messageId'])) {
            return ['sent' => true, 'transport' => 'brevo_http_api', 'debug' => 'Sent via Brevo HTTP API'];
        }
    }
    return ['sent' => false, 'transport' => 'brevo_http_api', 'debug' => 'Brevo API failed'];
}
