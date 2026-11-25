/*
 * ============================================================================
 * PROYECTO: ASTA (Automated Sensor Tracking Application)
 * ARCHIVO:  esp32/asta_sensors.ino
 * HARDWARE: ESP32 DevKit V1 + Sensor Ultrasónico HC-SR04 (Termo 40oz) + LDR (Sueño)
 * ============================================================================
 *
 * DIAGRAMA DE CONEXIÓN ELECTRÓNICA (ESP32):
 * ----------------------------------------------------------------------------
 * 1. SENSOR ULTRASÓNICO HC-SR04 (Nivel de Agua en Termo de 40 oz / 1183 ml):
 *    - VCC  ---> VIN (5V) del ESP32
 *    - TRIG ---> GPIO 5
 *    - ECHO ---> GPIO 18 (Recomendado: divisor resistivo 1kΩ / 2kΩ a GND para 3.3V)
 *    - GND  ---> GND
 *
 * 2. SENSOR FOTORESISTENCIA LDR (Nivel de Luz / Oscuridad para Sueño):
 *    - Pin 1 del LDR ---> 3.3V del ESP32
 *    - Pin 2 del LDR ---> GPIO 34 (ADC1_CH6) + Resistencia 10kΩ hacia GND
 *    * NOTA ELECTRÓNICA: Usamos GPIO 34 (ADC1) porque el ADC2 del ESP32 entra
 *      en conflicto cuando el módulo Wi-Fi está activo.
 * ============================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>

// ===================== CONFIGURACIÓN WIFI =====================
const char* WIFI_SSID     = "TU_RED_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD_WIFI";

// ===================== SERVIDOR ASTA (AWARDSPACE O LARAGON) =====================
// Para AwardSpace: "http://tudominio.atwebpages.com/php/esp32_api.php?action=telemetry"
// Para Laragon Local: "http://192.168.1.100/ASTA/php/esp32_api.php?action=telemetry"
const char* SERVER_URL    = "http://tudominio.atwebpages.com/php/esp32_api.php?action=telemetry";

// Copia tu API Token desde el botón "Ajustes / ESP32" de tu panel web ASTA:
const char* API_TOKEN     = "ASTA-ESP32-BLACKBULLS-777";

// ===================== PINES DE SENSORES =====================
const int PIN_TRIG = 5;
const int PIN_ECHO = 18;
const int PIN_LDR  = 34; // ADC1 (0 - 4095)

// Parámetros físicos de tu Termo de 40 oz (1183 ml)
const float THERMOS_HEIGHT_CM = 34.0; // Distancia cuando el termo está vacío (34 cm)
const float SENSOR_OFFSET_CM  = 12.0; // Distancia inicial cuando el termo está 100% lleno (12 cm)
const unsigned long SEND_INTERVAL_MS = 10000; // Enviar cada 10 segundos

unsigned long lastSendTime = 0;

void setup() {
    Serial.begin(115200);

    pinMode(PIN_TRIG, OUTPUT);
    pinMode(PIN_ECHO, INPUT);
    pinMode(PIN_LDR, INPUT);

    // Resolución de 12 bits para el ADC del ESP32 (0 a 4095)
    analogReadResolution(12);

    Serial.println("\n====================================================");
    Serial.println("  ASTA - Inicializando Sensores ESP32 (Black Bulls)");
    Serial.println("====================================================");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("Conectando a WiFi");
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\n[OK] WiFi Conectado! IP: " + WiFi.localIP().toString());
}

/**
 * Mide la distancia en cm con el sensor ultrasónico HC-SR04 promediando 5 muestras
 * para evitar fluctuaciones por el movimiento del agua en el termo de 40oz.
 */
float readUltrasonicDistanceCm() {
    float validSum = 0;
    int validSamples = 0;

    for (int i = 0; i < 5; i++) {
        digitalWrite(PIN_TRIG, LOW);
        delayMicroseconds(2);
        digitalWrite(PIN_TRIG, HIGH);
        delayMicroseconds(10);
        digitalWrite(PIN_TRIG, LOW);

        long duration = pulseIn(PIN_ECHO, HIGH, 30000); // Timeout 30ms
        if (duration > 0) {
            float cm = (duration * 0.0343f) / 2.0f;
            if (cm >= 1.5f && cm <= 40.0f) {
                validSum += cm;
                validSamples++;
            }
        }
        delay(30);
    }

    if (validSamples == 0) {
        return 12.0f; // Valor seguro inicial (12.0 cm = termo lleno) si la tapa está retirada temporalmente
    }
    return validSum / validSamples;
}

/**
 * Lee el nivel de iluminación de la habitación desde la fotoresistencia LDR (0 - 4095)
 */
int readPhotoresistorLdr() {
    long sum = 0;
    for (int i = 0; i < 8; i++) {
        sum += analogRead(PIN_LDR);
        delay(5);
    }
    return (int)(sum / 8);
}

void loop() {
    unsigned long now = millis();
    if (now - lastSendTime < SEND_INTERVAL_MS) {
        return;
    }
    lastSendTime = now;

    float distanceCm = readUltrasonicDistanceCm();
    int ldrRaw       = readPhotoresistorLdr();
    int wifiRssi     = WiFi.RSSI();

    Serial.printf("[SENSORES] Termo HC-SR04: %.2f cm | Habitación LDR: %d / 4095 | RSSI: %d dBm\n",
                  distanceCm, ldrRaw, wifiRssi);

    if (WiFi.status() == WL_CONNECTED) {
        HTTPClient http;
        http.begin(SERVER_URL);
        http.addHeader("Content-Type", "application/json");
        http.addHeader("X-API-Token", API_TOKEN);

        String jsonPayload = "{";
        jsonPayload += "\"action\":\"telemetry\",";
        jsonPayload += "\"api_token\":\"" + String(API_TOKEN) + "\",";
        jsonPayload += "\"distance_cm\":" + String(distanceCm, 2) + ",";
        jsonPayload += "\"ldr_raw\":" + String(ldrRaw) + ",";
        jsonPayload += "\"wifi_rssi\":" + String(wifiRssi);
        jsonPayload += "}";

        int httpResponseCode = http.POST(jsonPayload);
        if (httpResponseCode > 0) {
            String response = http.getString();
            Serial.printf("[SERVIDOR %d]: %s\n", httpResponseCode, response.c_str());
        } else {
            Serial.printf("[ERROR HTTP]: %s\n", http.errorToString(httpResponseCode).c_str());
        }
        http.end();
    } else {
        Serial.println("[WIFI] Reconectando...");
        WiFi.reconnect();
    }
}
