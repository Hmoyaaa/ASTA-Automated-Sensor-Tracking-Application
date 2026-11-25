-- ============================================================================
-- ASTA (Automated Sensor Tracking Application) - Database Schema
-- Compatible con MySQL / MariaDB en Laragon (Local) y AwardSpace (Hosting)
-- ============================================================================

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";

CREATE TABLE IF NOT EXISTS `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL,
  `email` varchar(120) NOT NULL,
  `google_id` varchar(128) DEFAULT NULL COMMENT 'ID único de cuenta de Google OAuth',
  `password_hash` varchar(255) NOT NULL,
  `avatar_data` mediumtext DEFAULT NULL COMMENT 'Foto de perfil en Base64',
  `magic_squad` varchar(60) DEFAULT 'Toros Negros (Black Bulls)',
  `magic_rank` varchar(50) DEFAULT 'Caballero Mágico Junior',
  `api_token` varchar(64) NOT NULL,
  `thermos_capacity_ml` int(11) DEFAULT 1183 COMMENT '40 oz = 1183 ml',
  `thermos_height_cm` decimal(5,2) DEFAULT 34.00 COMMENT 'Distancia del sensor al fondo cuando el termo está vacío (34 cm)',
  `sensor_offset_cm` decimal(5,2) DEFAULT 12.00 COMMENT 'Distancia inicial del sensor HC-SR04 cuando el termo está 100% lleno (12 cm)',
  `daily_water_goal_ml` int(11) DEFAULT 3000,
  `daily_calorie_goal` int(11) DEFAULT 2500,
  `daily_step_goal` int(11) DEFAULT 10000,
  `daily_sleep_goal_hrs` decimal(4,2) DEFAULT 8.00,
  `gemini_api_key` varchar(255) DEFAULT NULL,
  `initial_weight_kg` decimal(5,2) NOT NULL DEFAULT 0.00,
  `current_weight_kg` decimal(5,2) NOT NULL DEFAULT 0.00,
  `goal_weight_kg` decimal(5,2) NOT NULL DEFAULT 0.00,
  `bonus_xp` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `api_token` (`api_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de estado en vivo del ESP32 (Termo 40oz HC-SR04 + Fotoresistencia LDR)
CREATE TABLE IF NOT EXISTS `esp32_live_state` (
  `user_id` int(11) NOT NULL,
  `ultrasonic_cm` decimal(6,2) DEFAULT 12.00,
  `thermos_ml` int(11) DEFAULT 1183,
  `thermos_oz` decimal(5,2) DEFAULT 40.00,
  `thermos_pct` decimal(5,2) DEFAULT 100.00,
  `ldr_raw` int(11) DEFAULT 280 COMMENT 'Valor ADC ESP32 (0-4095)',
  `room_lux_state` varchar(40) DEFAULT 'Oscuridad Óptima',
  `room_darkness_pct` decimal(5,2) DEFAULT 93.20,
  `wifi_rssi` int(11) DEFAULT -52,
  `last_ping` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_esp32_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Gimnasio / Entrenamiento Físico
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
  KEY `idx_gym_user_date` (`user_id`, `logged_date`),
  CONSTRAINT `fk_gym_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Hidratación (Sensor Ultrasónico ESP32 + Registro Manual)
CREATE TABLE IF NOT EXISTS `hydration_logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `source` enum('esp32_ultrasonic','manual') NOT NULL DEFAULT 'manual',
  `water_level_ml` int(11) NOT NULL DEFAULT 0 COMMENT 'Nivel actual en el termo de 40oz',
  `consumed_ml` int(11) NOT NULL DEFAULT 0 COMMENT 'Agua ingerida sumada al día',
  `distance_cm` decimal(6,2) DEFAULT NULL COMMENT 'Distancia medida por el HC-SR04',
  `thermos_pct` decimal(5,2) DEFAULT NULL,
  `logged_date` date NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_hydration_user_date` (`user_id`, `logged_date`),
  CONSTRAINT `fk_hydration_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Sueño (Sensor LDR ESP32 + Samsung Galaxy Watch 8 + Manual)
CREATE TABLE IF NOT EXISTS `sleep_logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `source` enum('esp32_ldr','galaxy_watch','manual') NOT NULL DEFAULT 'manual',
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
  KEY `idx_sleep_user_date` (`user_id`, `logged_date`),
  CONSTRAINT `fk_sleep_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Nutrición y Análisis de Macros con IA
CREATE TABLE IF NOT EXISTS `nutrition_logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `meal_type` enum('Desayuno','Almuerzo','Cena','Snack','Post-Entreno') NOT NULL DEFAULT 'Almuerzo',
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
  KEY `idx_nutrition_user_date` (`user_id`, `logged_date`),
  CONSTRAINT `fk_nutrition_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Telemetría Samsung Galaxy Watch 8
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
  UNIQUE KEY `uniq_watch_user_date` (`user_id`, `logged_date`),
  CONSTRAINT `fk_watch_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Evolución de Peso Corporal y XP de Gamificación
CREATE TABLE IF NOT EXISTS `weight_logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(11) NOT NULL,
  `weight_kg` decimal(5,2) NOT NULL,
  `notes` varchar(160) DEFAULT '',
  `xp_awarded` int(11) NOT NULL DEFAULT 50,
  `logged_date` date NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_weight_user_date` (`user_id`, `logged_date`),
  CONSTRAINT `fk_weight_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

COMMIT;
