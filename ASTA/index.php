<?php
/**
 * ASTA (Automated Sensor Tracking Application)
 * Punto de entrada principal para Laragon y AwardSpace
 */
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

if (!empty($_SESSION['asta_user_id'])) {
    header('Location: html/dashboard.html');
    exit;
} else {
    header('Location: html/login.html');
    exit;
}
