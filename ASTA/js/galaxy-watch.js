/**
 * ASTA - galaxy-watch.js
 * Módulo de Conexión e Integración con Samsung Galaxy Watch 8 (Wear OS)
 * Soporta Web Bluetooth API (BLE en vivo) + Sincronización Samsung Health / Manual
 */

window.AstaGalaxyWatch = (function () {
    let bleDevice = null;
    let heartRateChar = null;

    /**
     * Intenta conectar directamente con el Samsung Galaxy Watch 8 vía Web Bluetooth API
     */
    async function connectWatchBLE(onTelemetryUpdate) {
        if (!navigator.bluetooth) {
            throw new Error('Tu navegador actual no soporta Web Bluetooth directo. Usa Chrome en Android/PC o el botón de Sincronización Samsung Health.');
        }

        bleDevice = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: ['heart_rate', 'battery_service', 0x180d, 0x180f, 0x1814]
        });

        const server = await bleDevice.gatt.connect();
        const result = {
            deviceName: bleDevice.name || 'Samsung Galaxy Watch 8',
            bpm: null,
            battery: null
        };

        // Intentar leer batería BLE (0x180F)
        try {
            const battService = await server.getPrimaryService('battery_service');
            const battChar = await battService.getCharacteristic('battery_level');
            const val = await battChar.readValue();
            result.battery = val.getUint8(0);
        } catch (_) {}

        // Intentar suscribirse a Frecuencia Cardíaca BLE (0x180D)
        try {
            const hrService = await server.getPrimaryService('heart_rate');
            heartRateChar = await hrService.getCharacteristic('heart_rate_measurement');
            await heartRateChar.startNotifications();
            heartRateChar.addEventListener('characteristicvaluechanged', (event) => {
                const value = event.target.value;
                const flags = value.getUint8(0);
                const rate16Bits = flags & 0x1;
                const bpm = rate16Bits ? value.getUint16(1, true) : value.getUint8(1);
                if (typeof onTelemetryUpdate === 'function') {
                    onTelemetryUpdate({ heart_rate_bpm: bpm });
                }
            });
        } catch (_) {}

        return result;
    }

    /**
     * Calcula distancia (km) y calorías activas estimadas a partir de los pasos del Galaxy Watch 8
     */
    function deriveMetricsFromSteps(steps, bpm = 72) {
        const cleanSteps = Math.max(0, parseInt(steps, 10) || 0);
        const distanceKm = Math.round(cleanSteps * 0.00076 * 100) / 100;
        const activeCalories = Math.round(cleanSteps * 0.044 + (bpm > 90 ? 110 : 45));
        return {
            steps: cleanSteps,
            distance_km: distanceKm,
            active_calories: activeCalories
        };
    }

    return {
        connectWatchBLE,
        deriveMetricsFromSteps
    };
})();
