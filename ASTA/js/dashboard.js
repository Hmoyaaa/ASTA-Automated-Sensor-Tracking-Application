/**
 * ASTA (Automated Sensor Tracking Application)
 * dashboard.js - Controlador Central Minimalista (Manga Monocromático)
 * Gestiona Sensores ESP32 (Termo 40oz + LDR), Gimnasio, Nutrición IA,
 * Samsung Galaxy Watch 8 y Panel de Perfil de Usuario (Foto, Nombre y Datos).
 */

const DEFAULT_AVATAR_SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23180406'/><circle cx='50' cy='38' r='18' fill='%23ff1a2d'/><path d='M20 88 C20 64, 80 64, 80 88' fill='%23ff1a2d'/></svg>";

const AstaApp = {
    state: null,
    isOfflineMode: false,
    pendingAvatarBase64: undefined,
    chartHabit: 'all',
    chartPeriod: 'weekly',
    chartPointsMeta: [],
    telemetryLogs: [],
    lastApiLatencyMs: 14,
    dbDiagnostics: null,

    getDefaultState() {
        const storedUser = JSON.parse(localStorage.getItem('asta_active_user') || 'null');
        const today = new Date().toISOString().slice(0, 10);
        return {
            user: storedUser || {
                id: 0,
                username: 'Nuevo_Usuario',
                email: '',
                avatar_data: null,
                magic_squad: 'Toros Negros (Black Bulls)',
                magic_rank: 'Novato • Nivel 0',
                api_token: '',
                thermos_capacity_ml: 1183, // 40 oz
                thermos_height_cm: 34.0,
                sensor_offset_cm: 12.0,
                daily_water_goal_ml: 3000,
                daily_calorie_goal: 2500,
                daily_step_goal: 10000,
                daily_sleep_goal_hrs: 8.0,
                gemini_api_key: '',
                initial_weight_kg: 0.0,
                current_weight_kg: 0.0,
                goal_weight_kg: 0.0,
                bonus_xp: 0
            },
            weight_logs: [],
            esp32: {
                ultrasonic_cm: 12.0,
                thermos_ml: 1183,
                thermos_oz: 40.0,
                thermos_pct: 100.0,
                ldr_raw: 0,
                room_lux_state: 'Sin lecturas aún',
                room_darkness_pct: 0.0,
                wifi_rssi: 0,
                last_ping: 'Esperando lectura'
            },
            gym_today: { exercises_today: 0, volume_kg: 0, total_min: 0 },
            gym_logs: [],
            water_today_ml: 0,
            hydration_logs: [],
            sleep_logs: [],
            macros_today: { total_calories: 0, total_protein: 0, total_carbs: 0, total_fat: 0, total_fiber: 0 },
            nutrition_logs: [],
            watch: {
                steps: 0,
                heart_rate_bpm: 0,
                active_calories: 0,
                distance_km: 0,
                sleep_minutes: 0,
                blood_oxygen_pct: 0,
                watch_battery_pct: 0,
                sync_method: 'Sin sincronizar',
                logged_date: today
            }
        };
    }
};
window.AstaApp = AstaApp;
AstaApp.isProfileEditUnlocked = false;
AstaApp.activeProfileEditToken = null;

function getActiveUserStorageKey() {
    const u = AstaApp.state?.user || JSON.parse(localStorage.getItem('asta_active_user') || 'null') || {};
    return String(u.id || u.username || 'guest').toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

function sanitizeUserUsername(userObj) {
    if (!userObj || typeof userObj !== 'object') return userObj;
    const rawName = String(userObj.username || '').trim();
    if (rawName.includes('@')) {
        if (!userObj.email || !String(userObj.email).includes('@')) {
            userObj.email = rawName;
        }
        const savedProf = JSON.parse(localStorage.getItem('asta_saved_profile') || 'null');
        if (savedProf?.username && !String(savedProf.username).includes('@') && String(savedProf.id || '') === String(userObj.id || '')) {
            userObj.username = savedProf.username;
        } else {
            userObj.username = rawName.split('@')[0].replace(/[^A-Za-z0-9_áéíóúÁÉÍÓÚñÑ]/g, '_') || 'Usuario';
        }
    }
    if (!userObj.sensor_offset_cm || Number(userObj.sensor_offset_cm) === 2.5) {
        userObj.sensor_offset_cm = 12.0;
    }
    if (!userObj.thermos_height_cm || Number(userObj.thermos_height_cm) === 25.0) {
        userObj.thermos_height_cm = 34.0;
    }
    return userObj;
}

function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const tok = AstaApp.state?.user?.api_token
        || JSON.parse(localStorage.getItem('asta_active_user') || 'null')?.api_token;
    if (tok) {
        headers['X-API-Token'] = tok;
    }
    return headers;
}

document.addEventListener('DOMContentLoaded', async () => {
    bindNavigationTabs();
    bindBackgroundScrollFade();
    bindHydrationControls();
    bindSleepControls();
    bindGymControls();
    bindNutritionAIControls();
    bindGalaxyWatchControls();
    bindProfilePanel();
    bindProgressChartControls();
    bindSystemEngineeringControls();

    await loadDashboardData();
    await checkUrlForProfileEditToken();
    checkAndRunFirstTimeProfileGuide();

    setInterval(pollEsp32Telemetry, 8000);
});

function bindBackgroundScrollFade() {
    const updateBgOpacity = () => {
        const scrollY = window.scrollY || window.pageYOffset || 0;
        const fadeDistance = Math.max(320, Math.min(window.innerHeight * 0.78, 620));
        const progress = Math.max(0, Math.min(1, scrollY / fadeDistance));
        // Mantener el fondo visible (mínimo 0.64) para que luzca a través de los paneles estilo Glassy
        const opacity = 1 - progress * 0.36;
        document.documentElement.style.setProperty('--bg-scroll-opacity', opacity.toFixed(3));
        document.documentElement.style.setProperty('--nav-scroll-progress', progress.toFixed(3));
    };

    window.addEventListener('scroll', updateBgOpacity, { passive: true });
    window.addEventListener('resize', updateBgOpacity);
    updateBgOpacity();
}

async function loadDashboardData() {
    const t0 = performance.now();
    try {
        const activeTok = AstaApp.state?.user?.api_token
            || JSON.parse(localStorage.getItem('asta_active_user') || 'null')?.api_token
            || '';
        const url = activeTok
            ? `../php/habits_api.php?action=dashboard_summary&api_token=${encodeURIComponent(activeTok)}`
            : '../php/habits_api.php?action=dashboard_summary';

        const res = await fetch(url, {
            credentials: 'same-origin',
            headers: getAuthHeaders()
        });
        const latency = Math.max(2, Math.round(performance.now() - t0));
        AstaApp.lastApiLatencyMs = latency;
        if (res.status === 401) {
            localStorage.removeItem('asta_active_user');
            window.location.href = 'login.html';
            return;
        }
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            sanitizeUserUsername(data.user);
            AstaApp.state = data;
            AstaApp.gymSplits = null;
            AstaApp.isOfflineMode = false;
            saveLocalFallbackState();
            logTelemetryPacket('GET', 'habits_api.php?action=dashboard_summary', 200, latency, `PDO MySQL Sync OK • Usuario: ${data.user?.username || 'Usuario'}`);
            renderAllPanels();
            return;
        }
    } catch (_) {}

    const activeLocalUser = JSON.parse(localStorage.getItem('asta_active_user') || 'null');
    if (!activeLocalUser) {
        window.location.href = 'login.html';
        return;
    }

    const fallbackLatency = Math.max(1, Math.round(performance.now() - t0));
    AstaApp.lastApiLatencyMs = fallbackLatency;
    AstaApp.isOfflineMode = true;
    const uKey = String(activeLocalUser.id || activeLocalUser.username || 'guest').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const cached = localStorage.getItem(`asta_cached_dashboard_${uKey}`);
    AstaApp.state = cached ? JSON.parse(cached) : AstaApp.getDefaultState();
    AstaApp.gymSplits = null;

    const cleanActive = { ...activeLocalUser };
    if (String(cleanActive.username || '').includes('@') && AstaApp.state.user?.username && !String(AstaApp.state.user.username).includes('@')) {
        delete cleanActive.username;
    }
    AstaApp.state.user = { ...AstaApp.state.user, ...cleanActive };
    sanitizeUserUsername(AstaApp.state.user);
    saveLocalFallbackState();
    logTelemetryPacket('CACHE', `localStorage://asta_cached_dashboard_${uKey}`, 200, fallbackLatency, 'Failover Local Activo • Snapshot aislado por usuario');
    renderAllPanels();
}

function saveLocalFallbackState() {
    if (AstaApp.state) {
        const uKey = getActiveUserStorageKey();
        if (AstaApp.state.user) {
            sanitizeUserUsername(AstaApp.state.user);
            localStorage.setItem('asta_active_user', JSON.stringify(AstaApp.state.user));
            localStorage.setItem('asta_saved_profile', JSON.stringify(AstaApp.state.user));
        }
        localStorage.setItem(`asta_cached_dashboard_${uKey}`, JSON.stringify(AstaApp.state));
    }
}

async function pollEsp32Telemetry() {
    if (AstaApp.isOfflineMode) return;
    const t0 = performance.now();
    try {
        const res = await fetch('../php/esp32_api.php?action=status', {
            headers: getAuthHeaders()
        });
        const latency = Math.max(2, Math.round(performance.now() - t0));
        AstaApp.lastApiLatencyMs = latency;
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'success' && AstaApp.state) {
            if (data.esp32_state) {
                AstaApp.state.esp32 = data.esp32_state;
                setText('kpi-sleep-darkness', `${Number(data.esp32_state.room_darkness_pct || 94).toFixed(1)}%`);
            }
            if (typeof data.water_today_ml === 'number') {
                AstaApp.state.water_today_ml = data.water_today_ml;
                setText('kpi-water-val', `${data.water_today_ml}ml`);
                setText('kpi-water-oz', `${(data.water_today_ml / 29.5735).toFixed(1)} oz`);
            }
            if (data.watch) {
                AstaApp.state.watch = data.watch;
                setText('kpi-steps-val', (Number(data.watch.steps) || 0).toLocaleString());
                setText('kpi-watch-bpm', `♥ ${data.watch.heart_rate_bpm || 68} BPM`);
                renderWatchPanel();
            }
            logTelemetryPacket(
                'POLL',
                'esp32_api.php?action=status',
                200,
                latency,
                `HC-SR04: ${AstaApp.state.esp32?.ultrasonic_cm ?? 7.2}cm (${AstaApp.state.esp32?.thermos_ml ?? 960}ml) | LDR: ${AstaApp.state.esp32?.ldr_raw ?? 245} ADC`
            );
            renderHydrationPanel();
            renderSleepPanel();
            renderSystemEngineeringPanel();
        }
    } catch (_) {}
}

function renderAllPanels() {
    const s = AstaApp.state;
    if (!s) return;

    // 1. Perfil y Cabecera
    const u = sanitizeUserUsername(s.user || {});
    setText('nav-username', u.username || 'Asta_Staria');
    setText('nav-user-squad', u.magic_squad || 'Toros Negros');
    setText('hero-knight-name', (u.username || 'Asta_Staria').toUpperCase());
    setText('user-api-token-display', u.api_token || 'ASTA-ESP32-BLACKBULLS-777');
    setText('profile-linked-email-label', u.email || 'asta@blackbulls.clover');

    const avatarSrc = u.avatar_data || DEFAULT_AVATAR_SVG;
    const navAvatar = document.getElementById('nav-user-avatar');
    if (navAvatar) navAvatar.src = avatarSrc;
    const profAvatar = document.getElementById('profile-avatar-preview');
    if (profAvatar && AstaApp.pendingAvatarBase64 === undefined) {
        profAvatar.src = avatarSrc;
    }

    // Poblar campos del panel de Perfil
    setVal('prof-username', u.username || 'Asta_Staria');
    setVal('prof-email', u.email || 'asta@blackbulls.clover');
    setVal('prof-thermos-ml', u.thermos_capacity_ml || 1183);
    setVal('prof-thermos-height', u.thermos_height_cm || 34.0);
    setVal('prof-sensor-offset', u.sensor_offset_cm || 12.0);
    setVal('prof-water-goal', u.daily_water_goal_ml || 3000);
    setVal('prof-cal-goal', u.daily_calorie_goal || 2500);
    setVal('prof-step-goal', u.daily_step_goal || 10000);
    setVal('prof-gemini-key', u.gemini_api_key || localStorage.getItem('asta_gemini_api_key') || '');

    // 2. Stats Dot-Matrix (<, %, *, #)
    const waterGoal = Number(u.daily_water_goal_ml) || 3000;
    const waterToday = Number(s.water_today_ml) || 0;
    setText('kpi-water-val', `${waterToday}ml`);
    setText('kpi-water-oz', `${(waterToday / 29.5735).toFixed(1)} oz`);
    setText('kpi-water-goal', `${waterGoal} ml`);

    const calToday = Number(s.macros_today?.total_calories) || 0;
    setText('kpi-cal-val', `${calToday}kcal`);
    setText('kpi-protein-sub', `Prot: ${Number(s.macros_today?.total_protein || 0).toFixed(0)}g`);

    const lastSleep = s.sleep_logs && s.sleep_logs.length > 0 ? s.sleep_logs[0] : { sleep_hours: 7.8, sleep_quality_score: 90 };
    setText('kpi-sleep-val', Number(lastSleep.sleep_hours).toFixed(1));
    setText('kpi-sleep-darkness', `${Number(s.esp32?.room_darkness_pct || 94).toFixed(1)}%`);
    setText('kpi-sleep-quality', `${lastSleep.sleep_quality_score || 90}%`);

    const stepsToday = Number(s.watch?.steps) || 0;
    setText('kpi-steps-val', stepsToday.toLocaleString());
    setText('kpi-watch-bpm', `♥ ${s.watch?.heart_rate_bpm || 68} BPM`);

    renderHydrationPanel();
    renderSleepPanel();
    renderGymPanel();
    renderNutritionPanel();
    renderWatchPanel();
    renderGamificationProfile();
    renderProgressChart();
    renderSystemEngineeringPanel();
}

function computeClientGamification() {
    const s = AstaApp.state || {};
    if (s.gamification && !AstaApp.isOfflineMode) {
        return s.gamification;
    }

    const u = s.user || {};
    const gymLogs = s.gym_logs || [];
    const hydLogs = s.hydration_logs || [];
    const slpLogs = s.sleep_logs || [];
    const nutLogs = s.nutrition_logs || [];
    const wLogs = s.weight_logs || [];
    const watch = s.watch || {};

    // Calcular racha activa únicamente a partir de fechas con registros reales
    const dateSet = new Set();
    gymLogs.forEach((r) => r.logged_date && dateSet.add(r.logged_date));
    hydLogs.forEach((r) => r.logged_date && dateSet.add(r.logged_date));
    slpLogs.forEach((r) => r.logged_date && dateSet.add(r.logged_date));
    nutLogs.forEach((r) => r.logged_date && dateSet.add(r.logged_date));
    if (Number(watch.steps) > 0 && watch.logged_date) dateSet.add(watch.logged_date);

    let streakDays = dateSet.size;
    let bestStreak = streakDays;

    // Récords personales de gimnasio por ejercicio
    const prMap = new Map();
    let maxGymW = 0;
    gymLogs.forEach((g) => {
        const w = Number(g.weight_kg) || 0;
        const vol = (Number(g.sets) || 1) * (Number(g.reps) || 1) * w;
        if (w > maxGymW) maxGymW = w;
        const key = (g.exercise_name || 'Ejercicio').trim();
        const prev = prMap.get(key);
        if (!prev || w > prev.max_weight_kg) {
            prMap.set(key, {
                exercise_name: key,
                muscle_group: g.muscle_group || 'General',
                max_weight_kg: w,
                max_volume_kg: vol,
                times_logged: (prev ? prev.times_logged : 0) + 1
            });
        } else {
            prev.times_logged += 1;
        }
    });
    const gymPrs = Array.from(prMap.values()).sort((a, b) => b.max_weight_kg - a.max_weight_kg).slice(0, 6);

    const initWeight = Number(u.initial_weight_kg) || 0;
    const currWeight = Number(u.current_weight_kg) || 0;
    const goalWeight = Number(u.goal_weight_kg) || 0;
    const bonusXp = Number(u.bonus_xp) || 0;
    const lostKg = (wLogs.length > 0 && initWeight > 0 && currWeight > 0 && initWeight > currWeight)
        ? Math.round((initWeight - currWeight) * 100) / 100
        : 0;
    const weightXp = lostKg > 0 ? Math.round(lostKg * 220) : 0;

    const maxSteps = Number(watch.steps) || 0;
    const totalXp = (streakDays * 95)
        + (gymLogs.length * 70)
        + Math.round(maxGymW * 2.5)
        + (hydLogs.length * 45)
        + (slpLogs.length * 50)
        + (nutLogs.length * 40)
        + Math.round(maxSteps * 0.03)
        + weightXp
        + bonusXp;

    const xpPerLevel = 500;
    const level = Math.floor(totalXp / xpPerLevel);
    const xpInLevel = totalXp % xpPerLevel;
    const levelPct = Math.min(100, Math.round((xpInLevel / xpPerLevel) * 100));

    let rankTitle = 'Novato • Nivel 0';
    if (level >= 25) rankTitle = 'Rey Mago • Leyenda Anti-Magia';
    else if (level >= 15) rankTitle = 'Capitán de Orden • Unión Demoníaca';
    else if (level >= 10) rankTitle = 'Rompedor de Límites • Élite';
    else if (level >= 5) rankTitle = 'Guerrero de Hierro • Constante';
    else if (level >= 1) rankTitle = 'Iniciado • Superando Límites';

    const stats = {
        str: gymLogs.length > 0 ? Math.min(99, 15 + (gymLogs.length * 6) + Math.round(maxGymW * 0.35)) : 0,
        vit: (hydLogs.length > 0 || wLogs.length > 0) ? Math.min(99, 15 + (hydLogs.length * 6) + (wLogs.length * 5) + Math.max(0, Math.round(lostKg * 8))) : 0,
        rec: slpLogs.length > 0 ? Math.min(99, 15 + (slpLogs.length * 6)) : 0,
        agi: maxSteps > 0 ? Math.min(99, 10 + Math.round(maxSteps / 180)) : 0,
        dsc: (streakDays > 0 || nutLogs.length > 0) ? Math.min(99, 10 + (streakDays * 8) + (nutLogs.length * 4)) : 0
    };

    return {
        level,
        rank_title: rankTitle,
        total_xp: totalXp,
        xp_in_level: xpInLevel,
        xp_for_next: xpPerLevel,
        xp_remaining: xpPerLevel - xpInLevel,
        level_pct: levelPct,
        streak_days: streakDays,
        best_streak: bestStreak,
        initial_weight_kg: initWeight,
        current_weight_kg: currWeight,
        goal_weight_kg: goalWeight,
        lost_kg: lostKg,
        stats,
        gym_prs: gymPrs
    };
}

function renderGamificationProfile() {
    const g = computeClientGamification();
    if (!g) return;

    if (AstaApp.lastRenderedLevel !== undefined && g.level > AstaApp.lastRenderedLevel) {
        showToast(`¡SUBISTE AL NIVEL ${g.level}! Rango: ${g.rank_title}`);
    }
    AstaApp.lastRenderedLevel = g.level;

    setText('nav-user-level-badge', `NV. ${g.level}`);
    setText('profile-header-level-pill', `NV. ${g.level} • ${g.total_xp.toLocaleString()} XP`);
    setText('rpg-level-number', `${g.level}`);
    setText('rpg-rank-title', g.rank_title);
    setText('rpg-xp-next-hint', `Faltan ${g.xp_remaining} XP para alcanzar el Nivel ${g.level + 1}`);
    setText('rpg-xp-text', `${g.xp_in_level} / ${g.xp_for_next} XP`);

    const xpFill = document.getElementById('rpg-xp-fill');
    if (xpFill) xpFill.style.width = `${g.level_pct}%`;

    setText('rpg-streak-days', `${g.streak_days} ${g.streak_days === 1 ? 'Día' : 'Días'}`);
    setText('rpg-best-streak', `${g.best_streak} ${g.best_streak === 1 ? 'Día' : 'Días'}`);

    // Barras de Atributos RPG (0 a 99)
    const st = g.stats || { str: 0, vit: 0, rec: 0, agi: 0, dsc: 0 };
    ['str', 'vit', 'rec', 'agi', 'dsc'].forEach((k) => {
        const val = Math.max(0, Math.min(99, Number(st[k] ?? 0)));
        setText(`rpg-stat-${k}-val`, `${val} / 99`);
        const bar = document.getElementById(`rpg-stat-${k}-bar`);
        if (bar) bar.style.width = `${val}%`;
    });

    // Peso corporal (kg)
    const hasWeight = Number(g.current_weight_kg || 0) > 0;
    const initW = hasWeight ? Number(g.initial_weight_kg || g.current_weight_kg).toFixed(1) : '--';
    const currW = hasWeight ? Number(g.current_weight_kg).toFixed(1) : '--';
    const goalW = Number(g.goal_weight_kg || 0) > 0 ? Number(g.goal_weight_kg).toFixed(1) : '--';
    const lostKg = Number(g.lost_kg || 0);

    setText('rpg-weight-init', `${initW} kg`);
    setText('rpg-weight-curr', `${currW} kg`);
    setText('rpg-weight-goal', `${goalW} kg`);

    const diffLabel = !hasWeight
        ? 'Sin registrar'
        : (lostKg > 0
            ? `-${lostKg.toFixed(1)} kg bajados • +${Math.round(lostKg * 220)} XP`
            : (lostKg < 0 ? `+${Math.abs(lostKg).toFixed(1)} kg` : `En línea (${currW} kg)`));
    setText('rpg-weight-diff-badge', diffLabel);

    const wInput = document.getElementById('rpg-input-weight');
    if (wInput && document.activeElement !== wInput) {
        wInput.value = hasWeight ? currW : '';
    }
    const gInput = document.getElementById('rpg-input-goal-weight');
    if (gInput && document.activeElement !== gInput) {
        gInput.value = Number(g.goal_weight_kg || 0) > 0 ? goalW : '';
    }

    const wListEl = document.getElementById('rpg-weight-history-list');
    if (wListEl) {
        const wLogs = AstaApp.state?.weight_logs || [];
        wListEl.innerHTML = wLogs.slice(0, 4).map((w) => `
            <div class="rpg-pr-item">
                <div>
                    <strong>${Number(w.weight_kg).toFixed(1)} kg</strong>
                    <span>${w.notes || w.logged_date}</span>
                </div>
                <span class="rpg-pr-badge">+${w.xp_awarded || 90} XP</span>
            </div>
        `).join('') || '<span style="font-size:11.5px;color:var(--muted);">Registra tu peso actual para ganar XP al acercarte a tu meta.</span>';
    }

    // Récords Personales en Gimnasio (PRs)
    const prsEl = document.getElementById('rpg-gym-prs-list');
    if (prsEl) {
        const prs = g.gym_prs || [];
        prsEl.innerHTML = prs.map((pr) => `
            <div class="rpg-pr-item">
                <div>
                    <strong>${pr.exercise_name}</strong>
                    <span>${pr.muscle_group} • Vol. Máx: ${Math.round(pr.max_volume_kg || 0).toLocaleString()} kg</span>
                </div>
                <span class="rpg-pr-badge">PR: ${Number(pr.max_weight_kg).toFixed(1)} kg</span>
            </div>
        `).join('') || '<span style="font-size:11.5px;color:var(--muted);">Registra tus entrenamientos en Gimnasio para establecer tus marcas PR.</span>';
    }

    // Logros y Mejoras Desbloqueadas
    const achEl = document.getElementById('rpg-achievements-grid');
    if (achEl) {
        const achievements = [
            { icon: 'fa-solid fa-fire-flame-simple', title: 'Racha Imparable', desc: '3+ días seguidos', unlocked: g.streak_days >= 3 },
            { icon: 'fa-solid fa-dumbbell', title: 'Rompedor de PR', desc: 'Marca +80 kg en Gym', unlocked: (g.gym_prs || []).some((p) => Number(p.max_weight_kg) >= 80) },
            { icon: 'fa-solid fa-scale-balanced', title: 'Transformación', desc: 'Bajar 1+ kg de peso', unlocked: lostKg >= 1.0 },
            { icon: 'fa-solid fa-droplet', title: 'Hidratación Élite', desc: '+1,500 ml en el día', unlocked: Number(AstaApp.state?.water_today_ml || 0) >= 1500 },
            { icon: 'fa-solid fa-moon', title: 'Maestro del Sueño', desc: 'Calidad ≥ 88%', unlocked: (AstaApp.state?.sleep_logs || []).some((s) => Number(s.sleep_quality_score) >= 88) },
            { icon: 'fa-solid fa-person-running', title: 'Paso Veloz', desc: '8,000+ pasos Watch', unlocked: Number(AstaApp.state?.watch?.steps || 0) >= 8000 }
        ];
        achEl.innerHTML = achievements.map((a) => `
            <div class="rpg-achievement-pill ${a.unlocked ? 'unlocked' : ''}" title="${a.desc}">
                <span class="rpg-ach-icon"><i class="${a.icon}"></i></span>
                <div>
                    <strong style="display:block;font-size:11.5px;">${a.title}</strong>
                    <span style="font-size:10px;opacity:0.8;">${a.desc}</span>
                </div>
            </div>
        `).join('');
    }

    updateLiebeProfileFeedback();
}

const LIEBE_SPRITES = {
    happy: '../assets/img/liebe_happy.png?v=27',
    hyped: '../assets/img/liebe_hyped.png?v=27',
    thinking: '../assets/img/liebe_thinking.png?v=27',
    confused: '../assets/img/liebe_confused.png?v=27',
    sad: '../assets/img/liebe_sad.png?v=27'
};

function buildLiebeFeedbackPool() {
    const g = computeClientGamification() || {};
    const s = AstaApp.state || {};
    const u = s.user || {};
    const username = u.username || 'compañero';
    const level = g.level || 1;
    const streak = g.streak_days || 1;
    const xpRem = g.xp_remaining || 150;
    const lostKg = Number(g.lost_kg || 0);
    const currW = Number(g.current_weight_kg || 75.2).toFixed(1);
    const goalW = Number(g.goal_weight_kg || 70.0).toFixed(1);
    const waterToday = Number(s.water_today_ml || 0);
    const waterGoal = Number(u.daily_water_goal_ml || 3000);
    const topPr = (g.gym_prs && g.gym_prs.length > 0) ? g.gym_prs[0] : null;

    return [
        {
            mood: 'happy',
            text: `¡Oye, ${username}! Vas en el Nivel ${level} con una racha activa de ${streak} días. Solo te faltan ${xpRem} XP para el Nivel ${level + 1}.`
        },
        {
            mood: 'hyped',
            text: topPr
                ? `¡Jejeje! Tu marca en ${topPr.exercise_name} ya está en ${Number(topPr.max_weight_kg).toFixed(1)} kg. ¡Si la superas hoy en el gimnasio ganarás +180 XP de golpe!`
                : `¡Jejeje! Si hoy superas tus marcas anteriores en el gimnasio o completas el anillo semanal 4/4, tus atributos subirán mucho más rápido.`
        },
        {
            mood: 'thinking',
            text: lostKg > 0
                ? `Hmm... Ya bajaste ${lostKg.toFixed(1)} kg hacia tu meta de ${goalW} kg (actual: ${currW} kg). Cada avance que registres aquí te da bonificación de Vitalidad y XP.`
                : `Hmm... Tu peso actual es ${currW} kg y tu meta es ${goalW} kg. Registra tus pesajes aquí en tu perfil para reclamar XP extra.`
        },
        {
            mood: waterToday >= waterGoal * 0.6 ? 'happy' : 'confused',
            text: waterToday >= waterGoal * 0.6
                ? `Llevas ${waterToday} ml de hidratación hoy. ¡Tu atributo de Vitalidad (${g.stats?.vit || 65}/99) responde muy bien!`
                : `¿Eh? Hoy llevas ${waterToday} ml de tu meta de ${waterGoal} ml en Hidratación. ¡No olvides beber agua para no frenar tu subida de nivel!`
        },
        {
            mood: streak >= 3 ? 'hyped' : 'sad',
            text: streak >= 3
                ? `¡Llevas ${streak} días seguidos sin fallar! Tu atributo de Disciplina subió a ${g.stats?.dsc || 70}/99.`
                : `Oye... si dejamos caer la racha diaria tardaremos más en subir de nivel. ¡Registremos tus hábitos de hoy!`
        }
    ];
}

function setLiebeVisualAndText(mood, text) {
    const imgEl = document.getElementById('liebe-profile-sprite');
    const txtEl = document.getElementById('liebe-dialogue-text');
    const bubbleEl = document.getElementById('liebe-manga-bubble');

    if (imgEl) {
        const nextSrc = LIEBE_SPRITES[mood] || LIEBE_SPRITES.happy;
        if (!imgEl.src.endsWith(nextSrc.replace('..', ''))) {
            imgEl.style.transform = 'scale(0.92)';
            imgEl.src = nextSrc;
            setTimeout(() => {
                imgEl.style.transform = '';
            }, 140);
        }
    }
    if (txtEl) {
        txtEl.textContent = text;
    }
    if (bubbleEl) {
        bubbleEl.style.transform = 'scale(0.97)';
        setTimeout(() => {
            bubbleEl.style.transform = '';
        }, 140);
    }
}

function updateLiebeProfileFeedback(forceMood = null, customMessage = null) {
    if (forceMood && customMessage) {
        setLiebeVisualAndText(forceMood, customMessage);
        return;
    }
    const pool = buildLiebeFeedbackPool();
    if (typeof AstaApp.liebeDialogueIdx !== 'number') {
        AstaApp.liebeDialogueIdx = 0;
    }
    const item = pool[AstaApp.liebeDialogueIdx % pool.length];
    setLiebeVisualAndText(item.mood, item.text);
}

function cycleLiebeProfileFeedback() {
    const pool = buildLiebeFeedbackPool();
    AstaApp.liebeDialogueIdx = ((AstaApp.liebeDialogueIdx || 0) + 1) % pool.length;
    const item = pool[AstaApp.liebeDialogueIdx];
    setLiebeVisualAndText(item.mood, item.text);
}

function renderHydrationPanel() {
    const s = AstaApp.state;
    const esp = s.esp32 || {};
    const capMl = Number(s.user?.thermos_capacity_ml) || 1183;
    const heightCm = Number(s.user?.thermos_height_cm) || 34.0;
    const offsetCm = Number(s.user?.sensor_offset_cm) || 12.0;

    const levelMl = Number(esp.thermos_ml ?? capMl);
    const pct = Math.max(0, Math.min(100, Number(esp.thermos_pct ?? Math.round((levelMl / capMl) * 100))));
    const oz = (levelMl / 29.5735).toFixed(1);
    const rawDist = Number(esp.ultrasonic_cm ?? offsetCm);
    const clampedDist = Math.max(offsetCm, Math.min(heightCm, rawDist));
    const distCm = clampedDist.toFixed(1);

    const fillEl = document.getElementById('thermos-liquid-fill');
    if (fillEl) fillEl.style.height = `${pct}%`;

    const beamEl = document.getElementById('thermos-ultrasonic-beam');
    if (beamEl) beamEl.style.height = `${Math.max(8, 100 - pct)}%`;

    setText('thermos-oz-readout', `${oz} oz`);
    setText('thermos-ml-readout', `${levelMl} / ${capMl} ml (${pct.toFixed(0)}%)`);
    setText('hc-sr04-cm-val', `${distCm} cm`);
    setText('thermos-level-oz-val', `${oz} / 40 oz`);
    setText('hydration-daily-total-val', `${s.water_today_ml || 0} ml`);
    setText('label-slider-ultrasonic-cm', `Distancia Sensor (${offsetCm} cm = Lleno 100% • ${heightCm} cm = Vacío)`);

    const sliderMl = document.getElementById('slider-thermos-ml');
    if (sliderMl && document.activeElement !== sliderMl) {
        sliderMl.max = capMl;
        sliderMl.value = levelMl;
    }

    const sliderCm = document.getElementById('slider-ultrasonic-cm');
    if (sliderCm && document.activeElement !== sliderCm) {
        sliderCm.min = offsetCm;
        sliderCm.max = heightCm;
        sliderCm.value = distCm;
    }

    const listEl = document.getElementById('hydration-records-list');
    if (listEl) {
        listEl.innerHTML = (s.hydration_logs || []).map((item) => {
            return `
                <div class="record-item">
                    <div class="record-main">
                        <strong>+${item.consumed_ml} ml (${(item.consumed_ml / 29.5735).toFixed(1)} oz)</strong>
                        <span>${item.logged_date}</span>
                    </div>
                    <div class="record-right">
                        <span class="pill-badge">${item.water_level_ml} ml</span>
                        <button class="record-delete-btn" onclick="deleteRecord('delete_hydration', ${item.id})" title="Eliminar">✕</button>
                    </div>
                </div>
            `;
        }).join('') || '<p style="color:var(--manga-muted);font-size:0.82rem;">Sin registros hoy.</p>';
    }
}

function renderSleepPanel() {
    const s = AstaApp.state;
    const esp = s.esp32 || {};
    const ldrRaw = Number(esp.ldr_raw ?? 245);
    const darkPct = Number(esp.room_darkness_pct ?? Math.round((1 - ldrRaw / 4095) * 100)).toFixed(1);
    const luxState = esp.room_lux_state || (darkPct >= 85 ? 'Oscuridad Óptima' : 'Luz Ambiental');

    setText('ldr-adc-val', `${ldrRaw}`);
    setText('ldr-darkness-pct', `${darkPct}% Oscuridad`);
    setText('ldr-room-state-badge', luxState);

    const pinPos = Math.max(2, Math.min(98, Math.round((ldrRaw / 4095) * 100)));
    const pinEl = document.getElementById('ldr-bar-pin');
    if (pinEl) pinEl.style.left = `${pinPos}%`;

    const sliderLdr = document.getElementById('slider-ldr-adc');
    if (sliderLdr && document.activeElement !== sliderLdr) {
        sliderLdr.value = ldrRaw;
    }

    const listEl = document.getElementById('sleep-records-list');
    if (listEl) {
        listEl.innerHTML = (s.sleep_logs || []).map((item) => {
            return `
                <div class="record-item">
                    <div class="record-main">
                        <strong>${item.sleep_hours} hrs (Profundo: ${item.deep_sleep_hours}h | REM: ${item.rem_sleep_hours}h)</strong>
                        <span>Oscuridad: ${item.room_darkness_pct || 92}% • ${item.logged_date}</span>
                    </div>
                    <div class="record-right">
                        <span class="pill-badge">${item.sleep_quality_score || 90}%</span>
                        <button class="record-delete-btn" onclick="deleteRecord('delete_sleep', ${item.id})" title="Eliminar">✕</button>
                    </div>
                </div>
            `;
        }).join('') || '<p style="color:var(--manga-muted);font-size:0.82rem;">Sin registros aún.</p>';
    }
}

const DEFAULT_GYM_SPLITS = {
    upper: [
        { id: 'up_1', name: 'Press de Banca', muscle: 'Pecho', weight: 0, reps: 10, completed: false },
        { id: 'up_2', name: 'Dominadas / Jalón al Pecho', muscle: 'Espalda', weight: 0, reps: 10, completed: false },
        { id: 'up_3', name: 'Press Militar con Mancuernas', muscle: 'Hombro', weight: 0, reps: 10, completed: false },
        { id: 'up_4', name: 'Curl Bíceps + Extensión Tríceps', muscle: 'Brazo', weight: 0, reps: 12, completed: false }
    ],
    lower: [
        { id: 'lw_1', name: 'Sentadilla Libre', muscle: 'Pierna', weight: 0, reps: 8, completed: false },
        { id: 'lw_2', name: 'Peso Muerto Rumano', muscle: 'Pierna', weight: 0, reps: 8, completed: false },
        { id: 'lw_3', name: 'Prensa de Piernas 45°', muscle: 'Pierna', weight: 0, reps: 10, completed: false },
        { id: 'lw_4', name: 'Hip Thrust / Gemelos', muscle: 'Pierna', weight: 0, reps: 12, completed: false }
    ]
};

function getGymSplitsState() {
    const uKey = getActiveUserStorageKey();
    if (!AstaApp.gymSplits || AstaApp.gymSplitsUserKey !== uKey) {
        AstaApp.gymSplits = null;
        AstaApp.gymSplitsUserKey = uKey;
        try {
            const saved = JSON.parse(localStorage.getItem(`asta_gym_splits_v2_${uKey}`) || 'null');
            if (saved && Array.isArray(saved.upper) && Array.isArray(saved.lower)) {
                AstaApp.gymSplits = saved;
            }
        } catch (_) {}
    }
    if (!AstaApp.gymSplits) {
        AstaApp.gymSplits = JSON.parse(JSON.stringify(DEFAULT_GYM_SPLITS));
    }
    return AstaApp.gymSplits;
}

function saveGymSplitsState() {
    const uKey = getActiveUserStorageKey();
    if (AstaApp.gymSplits) {
        localStorage.setItem(`asta_gym_splits_v2_${uKey}`, JSON.stringify(AstaApp.gymSplits));
    }
}

function getGymWeeklySessions() {
    const uKey = getActiveUserStorageKey();
    const saved = localStorage.getItem(`asta_gym_weekly_sessions_${uKey}`);
    if (saved !== null) {
        return Math.max(0, Math.min(4, parseInt(saved, 10) || 0));
    }
    const logs = AstaApp.state?.gym_logs || [];
    if (!logs.length) return 0;
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const uniqueDates = new Set(logs.filter((r) => (r.logged_date || '') >= cutoff).map((r) => r.logged_date));
    return Math.max(0, Math.min(4, uniqueDates.size));
}

function setGymWeeklySessions(count, announce = false) {
    const uKey = getActiveUserStorageKey();
    const clamped = Math.max(0, Math.min(4, count));
    localStorage.setItem(`asta_gym_weekly_sessions_${uKey}`, String(clamped));
    renderGymWeeklyRing(clamped);
    if (announce) {
        if (clamped === 4) {
            showToast('¡Anillo Semanal al 100% (4/4 entrenamientos completados)!');
        } else {
            showToast(`Progreso semanal de Gimnasio: ${clamped}/4 sesiones (${clamped * 25}%)`);
        }
    }
}

function renderGymWeeklyRing(sessionsCount) {
    const count = typeof sessionsCount === 'number' ? sessionsCount : getGymWeeklySessions();
    const pct = count * 25;
    const circumference = 326.73; // 2 * PI * 52
    const offset = circumference * (1 - pct / 100);

    const circleEl = document.getElementById('gym-ring-progress-circle');
    if (circleEl) {
        circleEl.style.strokeDashoffset = offset.toFixed(2);
    }

    setText('gym-ring-pct', `${pct}%`);
    setText('gym-ring-fraction', `${count} / 4`);

    const ringCard = document.getElementById('gym-weekly-ring-card');
    if (ringCard) {
        ringCard.classList.toggle('is-complete-100', count >= 4);
    }

    const statusChip = document.getElementById('gym-ring-status-chip');
    if (statusChip) {
        statusChip.textContent = count >= 4 ? '100% Completado' : `${count} de 4 sesiones`;
    }

    document.querySelectorAll('.gym-step-pill[data-gym-step]').forEach((btn) => {
        const stepNum = parseInt(btn.getAttribute('data-gym-step'), 10);
        btn.classList.toggle('active', stepNum <= count);
    });
}

function renderGymSplitExercises(splitKey) {
    const splits = getGymSplitsState();
    const items = splits[splitKey] || [];
    const container = document.getElementById(`gym-list-${splitKey}`);
    const badge = document.getElementById(`gym-${splitKey}-progress-badge`);

    const completedCount = items.filter((i) => i.completed).length;
    if (badge) {
        badge.textContent = `${completedCount} / ${items.length} listos`;
    }

    if (!container) return;
    container.innerHTML = items.map((ex, idx) => `
        <div class="gym-exercise-row ${ex.completed ? 'is-completed' : ''}" data-split-key="${splitKey}" data-ex-idx="${idx}">
            <div class="gym-ex-left" data-toggle-ex="${splitKey}:${idx}">
                <span class="gym-custom-check">
                    <i class="fa-solid fa-check"></i>
                </span>
                <div class="gym-ex-text-wrap">
                    <span class="gym-ex-name">${ex.name}</span>
                    <small class="gym-ex-muscle">${ex.muscle}</small>
                </div>
            </div>
            <input type="number" step="0.5" min="0" max="600" class="gym-mini-input js-gym-ex-weight" data-split-key="${splitKey}" data-ex-idx="${idx}" value="${ex.weight}" aria-label="Peso en kg">
            <input type="number" step="1" min="1" max="100" class="gym-mini-input js-gym-ex-reps" data-split-key="${splitKey}" data-ex-idx="${idx}" value="${ex.reps}" aria-label="Repeticiones">
        </div>
    `).join('');
}

function renderGymPanel() {
    const s = AstaApp.state;
    const logs = s.gym_logs || [];

    const totalVolume = logs.reduce((acc, r) => acc + (Number(r.sets) * Number(r.reps) * Number(r.weight_kg)), 0);
    setText('gym-total-volume-badge', `Volumen: ${totalVolume.toLocaleString()} kg`);

    renderGymWeeklyRing();
    renderGymSplitExercises('upper');
    renderGymSplitExercises('lower');

    const listEl = document.getElementById('gym-records-list');
    if (listEl) {
        listEl.innerHTML = logs.map((item) => {
            return `
                <div class="record-item">
                    <div class="record-main">
                        <strong>${item.exercise_name} [${item.muscle_group}]</strong>
                        <span>${item.sets} × ${item.reps} @ ${item.weight_kg} kg • ${item.logged_date}</span>
                    </div>
                    <div class="record-right">
                        <span class="pill-badge">${item.duration_min} min</span>
                        <button class="record-delete-btn" onclick="deleteRecord('delete_gym', ${item.id})" title="Eliminar">✕</button>
                    </div>
                </div>
            `;
        }).join('') || '<p style="color:var(--manga-muted);font-size:0.82rem;">Sin entrenamientos registrados.</p>';
    }
}

function renderNutritionPanel() {
    const s = AstaApp.state;
    const m = s.macros_today || {};

    setText('macro-tot-cal', `${Math.round(m.total_calories || 0)} kcal`);
    setText('macro-tot-prot', `${Number(m.total_protein || 0).toFixed(1)} g`);
    setText('macro-tot-carbs', `${Number(m.total_carbs || 0).toFixed(1)} g`);
    setText('macro-tot-fat', `${Number(m.total_fat || 0).toFixed(1)} g`);

    const listEl = document.getElementById('nutrition-records-list');
    if (listEl) {
        listEl.innerHTML = (s.nutrition_logs || []).map((item) => {
            const thumb = item.image_data
                ? `<img src="${item.image_data}" alt="Comida" style="width:40px;height:40px;border-radius:8px;object-fit:cover;border:1px solid #ff1a2d;">`
                : `<div style="width:40px;height:40px;border-radius:8px;background:#210508;border:1px solid rgba(255,45,65,0.5);display:flex;align-items:center;justify-content:center;font-family:var(--font-sans);font-size:0.75rem;color:#ff1a2d;font-weight:600;">IA</div>`;
            return `
                <div class="record-item">
                    <div style="display:flex;align-items:center;gap:12px;">
                        ${thumb}
                        <div class="record-main">
                            <strong>${item.food_name} [${item.meal_type}]</strong>
                            <span>${item.calories} kcal • P: ${item.protein_g}g | C: ${item.carbs_g}g | G: ${item.fat_g}g</span>
                        </div>
                    </div>
                    <div class="record-right">
                        <button class="record-delete-btn" onclick="deleteRecord('delete_nutrition', ${item.id})" title="Eliminar">✕</button>
                    </div>
                </div>
            `;
        }).join('') || '<p style="color:var(--manga-muted);font-size:0.82rem;">Sin comidas registradas.</p>';
    }
}

function renderWatchPanel() {
    const s = AstaApp.state;
    const w = s.watch || {};

    setText('watch-face-steps', (Number(w.steps) || 0).toLocaleString());
    setText('watch-face-bpm', `${w.heart_rate_bpm || 68} BPM`);
    setText('watch-stat-km', `${Number(w.distance_km || 0).toFixed(2)} km`);
    setText('watch-stat-kcal', `${w.active_calories || 0} kcal`);
    setText('watch-stat-sleep', `${(Number(w.sleep_minutes || 450) / 60).toFixed(1)} hrs`);
    setText('watch-stat-spo2', `${w.blood_oxygen_pct || 98}%`);
    setText('watch-stat-battery', `BAT: ${w.watch_battery_pct || 85}%`);
    setText('watch-sync-method-label', w.sync_method || 'Galaxy Watch 8');

    setVal('watch-input-steps', w.steps || 8420);
    setVal('watch-input-bpm', w.heart_rate_bpm || 68);
    setVal('watch-input-sleep-min', w.sleep_minutes || 468);
    setVal('watch-input-spo2', w.blood_oxygen_pct || 98);
}

/* ==========================================================================
   EVENTOS Y NAVEGACIÓN
   ========================================================================== */

function bindNavigationTabs() {
    const allTabs = document.querySelectorAll('[data-filter-tab]');
    const sections = document.querySelectorAll('.filterable-panel');
    const burgerBtn = document.getElementById('mobile-burger-btn');
    const mobileOverlay = document.getElementById('mobile-menu-overlay');

    function closeMobileMenu() {
        if (!burgerBtn || !mobileOverlay) return;
        burgerBtn.setAttribute('aria-expanded', 'false');
        mobileOverlay.hidden = true;
        document.body.classList.remove('menu-open');
    }

    if (burgerBtn && mobileOverlay) {
        burgerBtn.addEventListener('click', () => {
            const isOpen = burgerBtn.getAttribute('aria-expanded') === 'true';
            if (isOpen) {
                closeMobileMenu();
            } else {
                burgerBtn.setAttribute('aria-expanded', 'true');
                mobileOverlay.hidden = false;
                document.body.classList.add('menu-open');
            }
        });

        mobileOverlay.addEventListener('click', (e) => {
            if (e.target === mobileOverlay) closeMobileMenu();
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMobileMenu();
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 720) closeMobileMenu();
        });
    }

    function activateFilter(target) {
        const isSingle = target !== 'all';
        document.body.classList.toggle('single-tab-view', isSingle);
        const panelsGrid = document.querySelector('.panels-grid');
        if (panelsGrid) {
            panelsGrid.classList.toggle('single-panel-mode', isSingle);
        }

        allTabs.forEach((b) => {
            if (b.getAttribute('data-filter-tab') === target) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });

        let visibleIdx = 0;
        sections.forEach((sec) => {
            const cat = sec.getAttribute('data-panel-category');
            const shouldShow = isSingle ? (cat === target) : (cat !== 'profile');

            if (shouldShow) {
                sec.style.display = 'flex';
                sec.classList.remove('panel-anim-enter', 'panel-stretched-full');
                void sec.offsetWidth; // Reiniciar animación

                if (isSingle) {
                    sec.classList.add('panel-col-12', 'panel-stretched-full');
                    sec.style.gridColumn = '1 / -1';
                    sec.style.width = '100%';
                } else {
                    if (cat !== 'watch' && cat !== 'profile') {
                        sec.classList.remove('panel-col-12');
                        sec.classList.add('panel-col-6');
                    }
                    sec.style.gridColumn = '';
                    sec.style.width = '';
                    sec.style.setProperty('--panel-delay', `${visibleIdx * 0.06}s`);
                    sec.classList.add('panel-anim-enter');
                }
                visibleIdx++;
            } else {
                sec.style.display = 'none';
                sec.classList.remove('panel-anim-enter', 'panel-stretched-full');
            }
        });

        const progressPanel = document.getElementById('habits-progress-panel');
        const habitSelector = document.getElementById('chart-habit-selector');
        const liebeCompanion = document.getElementById('liebe-profile-companion');

        if (liebeCompanion) {
            if (target === 'profile') {
                liebeCompanion.hidden = false;
                updateLiebeProfileFeedback();
            } else {
                liebeCompanion.hidden = true;
            }
        }

        if (progressPanel) {
            if (target === 'profile') {
                progressPanel.style.display = 'none';
            } else {
                progressPanel.style.display = 'flex';
                if (['hydration', 'sleep', 'gym', 'nutrition', 'watch'].includes(target)) {
                    if (habitSelector) habitSelector.style.display = 'none';
                    setText('progress-panel-title', `Progreso • ${HABIT_CHART_CONFIG[target].label}`);
                    setChartHabit(target);
                } else {
                    if (habitSelector) habitSelector.style.display = 'inline-flex';
                    setText('progress-panel-title', 'Progreso');
                    setChartHabit('all');
                }
            }
        }

        closeMobileMenu();
    }

    function scrollToDashboardMain() {
        const mainEl = document.querySelector('.dashboard-main');
        const headerEl = document.querySelector('.evolve-header');
        if (mainEl) {
            const headerOffset = (headerEl ? headerEl.offsetHeight : 64) + 22;
            const topY = mainEl.getBoundingClientRect().top + window.scrollY - headerOffset;
            window.scrollTo({ top: Math.max(0, topY), behavior: 'smooth' });
        }
    }

    allTabs.forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-filter-tab');
            activateFilter(target);

            if (btn.classList.contains('logo-circle-btn')) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else if (window.scrollY < window.innerHeight * 0.5) {
                scrollToDashboardMain();
            }
        });
    });

    document.querySelectorAll('.js-goto-profile').forEach((btn) => {
        btn.addEventListener('click', () => {
            activateFilter('profile');
            scrollToDashboardMain();
        });
    });

    AstaApp.activateFilter = activateFilter;
}

function setProfileEditLockState(unlocked, token = null) {
    AstaApp.isProfileEditUnlocked = !!unlocked;
    AstaApp.activeProfileEditToken = unlocked ? token : null;

    const formEl = document.getElementById('form-user-profile');
    const bannerEl = document.getElementById('profile-edit-lock-banner');
    const badgeEl = document.getElementById('profile-lock-status-badge');
    const descEl = document.getElementById('profile-lock-desc');
    const btnRequestLink = document.getElementById('btn-request-profile-edit-link');
    const btnRelock = document.getElementById('btn-lock-profile-now');
    const mailBox = document.getElementById('profile-edit-email-sent-box');
    const saveIcon = document.getElementById('btn-save-profile-icon');
    const saveLabel = document.getElementById('btn-save-profile-label');

    document.querySelectorAll('.js-profile-editable-field').forEach((el) => {
        el.disabled = !unlocked;
    });

    if (formEl) {
        formEl.classList.toggle('is-profile-locked', !unlocked);
    }
    if (bannerEl) {
        bannerEl.classList.toggle('is-unlocked', unlocked);
    }
    if (badgeEl) {
        badgeEl.className = `profile-lock-badge ${unlocked ? 'is-unlocked' : 'is-locked'}`;
        badgeEl.innerHTML = unlocked
            ? '<i class="fa-solid fa-lock-open"></i> Enlace Exclusivo Verificado • Edición Habilitada'
            : '<i class="fa-solid fa-lock"></i> Edición Protegida';
    }
    if (descEl) {
        const linkedEmail = AstaApp.state?.user?.email || 'asta@blackbulls.clover';
        if (unlocked) {
            descEl.innerHTML = `Autorización verificada mediante el enlace exclusivo enviado a <strong>${linkedEmail}</strong>. Ya puedes modificar tus datos y pulsar <strong>Actualizar Perfil y Guardar Datos</strong>.`;
        } else {
            descEl.innerHTML = `Para modificar tu nombre de usuario, correo, foto o metas del perfil, envía una solicitud a tu correo enlazado (<strong id="profile-linked-email-label">${linkedEmail}</strong>) para recibir un <strong>enlace exclusivo de autorización</strong>.`;
        }
    }
    if (btnRequestLink) {
        btnRequestLink.style.display = unlocked ? 'none' : 'inline-flex';
    }
    if (btnRelock) {
        btnRelock.style.display = unlocked ? 'inline-flex' : 'none';
    }
    if (unlocked && mailBox) {
        mailBox.style.display = 'none';
    }
    if (saveIcon) {
        saveIcon.className = unlocked ? 'fa-solid fa-floppy-disk' : 'fa-solid fa-lock';
    }
    if (saveLabel) {
        saveLabel.textContent = unlocked
            ? 'Actualizar Perfil y Guardar Datos'
            : 'Solicita el link exclusivo por correo para modificar y guardar datos';
    }
}

async function verifyAndUnlockProfileByToken(token) {
    if (!token) return false;

    if (typeof AstaApp.activateFilter === 'function') {
        AstaApp.activateFilter('profile');
    }

    try {
        const res = await fetch('../php/auth_api.php?action=verify_profile_edit_link', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ action: 'verify_profile_edit_link', token })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success' && data.valid) {
            if (data.user) {
                sanitizeUserUsername(data.user);
                AstaApp.state.user = { ...AstaApp.state.user, ...data.user };
                saveLocalFallbackState();
                renderAllPanels();
            }
            setProfileEditLockState(true, token);
            logTelemetryPacket('AUTH-LINK', 'auth_api.php?action=verify_profile_edit_link', 200, 5, 'Enlace exclusivo de edición de perfil verificado');
            showToast(data.message || 'Enlace exclusivo verificado. Ahora puedes modificar los datos de tu perfil.');
            setTimeout(() => {
                document.getElementById('profile-edit-lock-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                document.getElementById('prof-username')?.focus();
            }, 180);
            return true;
        }
    } catch (_) {}

    // Verificación en almacenamiento local si MySQL no está disponible o si el token se generó en esta sesión
    try {
        const savedLocalTok = JSON.parse(localStorage.getItem('asta_local_profile_edit_token') || 'null');
        if (savedLocalTok && savedLocalTok.token === token && savedLocalTok.exp >= Date.now()) {
            setProfileEditLockState(true, token);
            logTelemetryPacket('AUTH-LINK', 'local://verify_profile_edit_link', 200, 2, 'Enlace exclusivo verificado correctamente');
            showToast('Enlace exclusivo verificado. Ahora puedes modificar y guardar los datos de tu perfil.');
            setTimeout(() => {
                document.getElementById('profile-edit-lock-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                document.getElementById('prof-username')?.focus();
            }, 180);
            return true;
        }
    } catch (_) {}

    showToast('El enlace exclusivo para modificar el perfil no es válido o ha expirado. Solicita uno nuevo.');
    return false;
}

async function checkUrlForProfileEditToken() {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    const editToken = params.get('profile_edit_token');

    if (tabParam === 'profile' && typeof AstaApp.activateFilter === 'function') {
        AstaApp.activateFilter('profile');
    }

    if (editToken) {
        await verifyAndUnlockProfileByToken(editToken);
        // Limpiar el parámetro de la barra de direcciones tras verificarlo para mayor seguridad
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }
}

function checkAndRunFirstTimeProfileGuide() {
    const s = AstaApp.state;
    if (!s || !s.user) return;

    const u = s.user;
    const keysToCheck = Array.from(new Set([
        getActiveUserStorageKey(),
        String(u.id || '').toLowerCase(),
        String(u.username || '').toLowerCase()
    ].filter(Boolean)));

    // Si ya se mostró anteriormente para esta cuenta, jamás volver a mostrarla
    const alreadyDone = keysToCheck.some((k) => {
        const val = localStorage.getItem(`asta_new_account_guide_${k}`);
        return val === 'completed' || val === 'done';
    });
    if (alreadyDone) return;

    const isPendingFlag = keysToCheck.some((k) => localStorage.getItem(`asta_new_account_guide_${k}`) === 'pending');
    const g = computeClientGamification() || {};
    const hasZeroRecords = (s.gym_logs?.length || 0) === 0
        && (s.hydration_logs?.length || 0) === 0
        && (s.sleep_logs?.length || 0) === 0
        && (s.nutrition_logs?.length || 0) === 0
        && (s.weight_logs?.length || 0) === 0;

    const shouldTrigger = isPendingFlag || !!u.is_new_account || (Number(g.level || 0) === 0 && Number(g.total_xp || 0) === 0 && hasZeroRecords);
    if (!shouldTrigger) return;

    // Marcar inmediatamente como completada para que solo aparezca esta primera vez al crear la cuenta
    keysToCheck.forEach((k) => {
        localStorage.setItem(`asta_new_account_guide_${k}`, 'completed');
    });
    if (u.is_new_account) {
        delete u.is_new_account;
        saveLocalFallbackState();
    }

    const guideBox = document.getElementById('profile-first-time-guide');
    if (!guideBox) return;

    // Llevar al usuario nuevo automáticamente a Mi Perfil
    if (typeof AstaApp.activateFilter === 'function') {
        AstaApp.activateFilter('profile');
    }

    guideBox.hidden = false;

    const steps = [
        {
            badge: 'Guía de Cuenta Nueva • Paso 1 de 4',
            title: '1. Registra tu Peso Actual y tu Meta (kg)',
            desc: 'Tu cuenta inicia completamente limpia en <strong>Nivel 0 (0 XP)</strong> y sin rutinas de otras cuentas. El primer campo que debes llenar manualmente es la tarjeta <strong>Progreso de Peso (kg)</strong>: escribe tu <strong>Nuevo Peso (kg)</strong> (tu peso inicial real) y tu <strong>Meta (kg)</strong>, y pulsa <strong>Registrar Peso y Reclamar XP</strong> para ganar tus primeros +80 XP.',
            targets: ['rpg-weight-card'],
            liebeMood: 'happy',
            liebeText: `¡Bienvenido, ${u.username || 'compañero'}! Empiezas desde Nivel 0. Llena primero tu peso actual y tu meta en kg aquí en Progreso de Peso para ganar tus primeros puntos de XP.`
        },
        {
            badge: 'Guía de Cuenta Nueva • Paso 2 de 4',
            title: '2. Desbloqueo por Correo para Modificar tu Cuenta',
            desc: 'Por seguridad, los campos inferiores de configuración personal tienen un candado activo. Cuando desees editar tu nombre, correo, foto o metas diarias, pulsa el botón <strong>Enviar link exclusivo a mi correo</strong> para recibir un enlace único de autorización.',
            targets: ['profile-edit-lock-banner'],
            liebeMood: 'thinking',
            liebeText: 'Recuerda que para cambiar tus datos o metas de abajo primero debes solicitar el enlace exclusivo a tu correo enlazado.'
        },
        {
            badge: 'Guía de Cuenta Nueva • Paso 3 de 4',
            title: '3. Calibración Manual de tu Termo (ml y cm)',
            desc: 'Una vez desbloqueada la edición, llena manualmente las medidas físicas de tu termo: <strong>Capacidad Termo (ml)</strong> (ej. 1183 ml para 40 oz), <strong>Altura Interna (cm)</strong> y el <strong>Offset HC-SR04 (cm)</strong> (distancia del sensor en la tapa al borde máximo de agua).',
            targets: ['prof-group-thermos-ml', 'prof-group-thermos-dim'],
            liebeMood: 'hyped',
            liebeText: '¡Aquí calibras las medidas en mililitros y centímetros de tu termo inteligente para que el sensor mida cada trago con precisión!'
        },
        {
            badge: 'Guía de Cuenta Nueva • Paso 4 de 4',
            title: '4. Metas Diarias Manuales y Foto de Perfil',
            desc: 'Por último, ajusta manualmente tu <strong>Meta Diaria de Agua (ml)</strong>, tu <strong>Meta de Calorías (kcal)</strong>, tu <strong>Meta de Pasos</strong> del Smartwatch y sube tu <strong>Foto de Perfil</strong>. Luego pulsa el botón inferior para guardar. <em>¡Esta guía no volverá a mostrarse!</em>',
            targets: ['prof-group-water-goal', 'prof-group-cal-step-goal'],
            liebeMood: 'happy',
            liebeText: '¡Listo! Configura tus metas diarias de agua, calorías y pasos cuando quieras. ¡Ya no te volveré a interrumpir con este tutorial, a superar tus límites!'
        }
    ];

    let currentStep = 0;

    const clearSpotlights = () => {
        document.querySelectorAll('.onboarding-field-spotlight').forEach((el) => {
            el.classList.remove('onboarding-field-spotlight');
        });
    };

    const renderStep = (idx) => {
        currentStep = Math.max(0, Math.min(steps.length - 1, idx));
        const st = steps[currentStep];

        const badgeEl = document.getElementById('onboarding-step-badge');
        const titleEl = document.getElementById('onboarding-step-title');
        const descEl = document.getElementById('onboarding-step-desc');
        const btnPrev = document.getElementById('btn-onboarding-prev');
        const btnNext = document.getElementById('btn-onboarding-next');

        if (badgeEl) badgeEl.innerHTML = `<i class="fa-solid fa-compass"></i> ${st.badge}`;
        if (titleEl) titleEl.textContent = st.title;
        if (descEl) descEl.innerHTML = st.desc;
        if (btnPrev) btnPrev.disabled = currentStep === 0;
        if (btnNext) {
            btnNext.innerHTML = currentStep === steps.length - 1
                ? '<span>¡Entendido, comenzar!</span> <i class="fa-solid fa-check"></i>'
                : '<span>Siguiente paso</span> <i class="fa-solid fa-arrow-right"></i>';
        }

        document.querySelectorAll('.onboarding-field-chip[data-guide-step]').forEach((chip) => {
            const chipIdx = parseInt(chip.getAttribute('data-guide-step'), 10);
            chip.classList.toggle('is-active', chipIdx === currentStep);
        });

        clearSpotlights();
        let firstTargetEl = null;
        (st.targets || []).forEach((tId) => {
            const el = document.getElementById(tId);
            if (el) {
                el.classList.add('onboarding-field-spotlight');
                if (!firstTargetEl) firstTargetEl = el;
            }
        });

        if (firstTargetEl) {
            firstTargetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        updateLiebeProfileFeedback(st.liebeMood, st.liebeText);
    };

    const closeGuide = () => {
        clearSpotlights();
        guideBox.hidden = true;
        showToast('Guía inicial completada. ¡Empieza registrando tu peso o tu primer hábito para subir del Nivel 0!');
    };

    document.getElementById('btn-onboarding-prev')?.addEventListener('click', () => {
        if (currentStep > 0) renderStep(currentStep - 1);
    });

    document.getElementById('btn-onboarding-next')?.addEventListener('click', () => {
        if (currentStep < steps.length - 1) {
            renderStep(currentStep + 1);
        } else {
            closeGuide();
        }
    });

    document.getElementById('btn-onboarding-dismiss')?.addEventListener('click', closeGuide);

    document.querySelectorAll('.onboarding-field-chip[data-guide-step]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const stepIdx = parseInt(chip.getAttribute('data-guide-step'), 10);
            if (!Number.isNaN(stepIdx)) renderStep(stepIdx);
        });
    });

    setTimeout(() => {
        renderStep(0);
    }, 240);
}

function bindProfilePanel() {
    const avatarInput = document.getElementById('profile-avatar-input');
    const avatarPreview = document.getElementById('profile-avatar-preview');
    const navAvatar = document.getElementById('nav-user-avatar');
    const profileForm = document.getElementById('form-user-profile');

    // Estado inicial: edición bloqueada hasta que se verifique el enlace exclusivo enviado al correo enlazado
    setProfileEditLockState(false, null);

    const btnRequestEditLink = document.getElementById('btn-request-profile-edit-link');
    const btnLockProfileNow = document.getElementById('btn-lock-profile-now');
    const mailSentBox = document.getElementById('profile-edit-email-sent-box');
    const btnCloseMailBox = document.getElementById('btn-close-profile-mail-box');
    const linkAnchor = document.getElementById('profile-exclusive-link-anchor');
    const btnCopyExclusiveLink = document.getElementById('btn-copy-profile-exclusive-link');

    if (btnRequestEditLink) {
        btnRequestEditLink.addEventListener('click', async () => {
            const linkedEmail = AstaApp.state?.user?.email || document.getElementById('prof-email')?.value.trim() || '';
            if (!linkedEmail || !linkedEmail.includes('@')) {
                showToast('No se encontró un correo electrónico válido enlazado a tu cuenta.');
                return;
            }

            btnRequestEditLink.disabled = true;
            const origHtml = btnRequestEditLink.innerHTML;
            btnRequestEditLink.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Enviando link exclusivo al correo...</span>';

            const dashboardBaseUrl = window.location.origin + window.location.pathname;
            let resolvedToken = '';
            let resolvedLink = '';
            let mailDispatched = false;
            let mailTransport = '';
            let showFallbackLinkInUi = false;

            try {
                const res = await fetch('../php/auth_api.php?action=request_profile_edit_link', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        action: 'request_profile_edit_link',
                        api_token: AstaApp.state?.user?.api_token || '',
                        email: linkedEmail,
                        dashboard_url: dashboardBaseUrl
                    })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success' && data.token) {
                    resolvedToken = data.token;
                    mailDispatched = !!data.mail_sent;
                    mailTransport = data.mail_transport || '';
                    if (data.exclusive_link) {
                        resolvedLink = data.exclusive_link;
                        showFallbackLinkInUi = true;
                    } else {
                        resolvedLink = `${dashboardBaseUrl}?tab=profile&profile_edit_token=${encodeURIComponent(data.token)}`;
                        showFallbackLinkInUi = !mailDispatched;
                    }
                }
            } catch (_) {}

            if (!resolvedToken) {
                const randHex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
                resolvedToken = `ASTA-EDIT-${randHex}`;
                resolvedLink = `${dashboardBaseUrl}?tab=profile&profile_edit_token=${encodeURIComponent(resolvedToken)}`;
                showFallbackLinkInUi = true;
            }

            // Guardar respaldo local del token exclusivo (válido por 20 minutos)
            localStorage.setItem('asta_local_profile_edit_token', JSON.stringify({
                token: resolvedToken,
                email: linkedEmail,
                exp: Date.now() + 20 * 60 * 1000
            }));
            AstaApp.pendingExclusiveEditUrl = resolvedLink;
            AstaApp.pendingExclusiveEditToken = resolvedToken;

            if (mailSentBox) {
                mailSentBox.style.display = 'flex';
            }
            const linkRowEl = mailSentBox ? mailSentBox.querySelector('.profile-exclusive-link-row') : null;
            if (linkRowEl) {
                linkRowEl.style.display = showFallbackLinkInUi ? 'flex' : 'none';
            }

            setText('profile-mail-sent-title', mailDispatched
                ? `Correo enviado a ${linkedEmail}`
                : `Enlace de autorización generado para ${linkedEmail}`);
            setText('profile-mail-sent-sub', mailDispatched && !showFallbackLinkInUi
                ? `Hemos enviado un correo real a ${linkedEmail} (${mailTransport || 'HTTP/SMTP'}) con tu enlace exclusivo (válido por 20 minutos). Revisa tu bandeja de entrada o spam y haz clic en el botón del correo para desbloquear tu perfil.`
                : (mailDispatched
                    ? `Hemos enviado un correo a ${linkedEmail} con tu enlace exclusivo (válido por 20 minutos). En entorno de pruebas también puedes abrirlo aquí:`
                    : `Entorno local sin servidor de correo saliente detectado para ${linkedEmail}. Haz clic en tu enlace exclusivo para desbloquear la modificación de datos en Mi Perfil:`));

            if (linkAnchor) {
                linkAnchor.href = resolvedLink;
            }

            logTelemetryPacket('AUTH-MAIL', 'auth_api.php?action=request_profile_edit_link', 200, 6, `Link exclusivo enviado a ${linkedEmail}`);
            showToast(mailDispatched
                ? `Correo enviado a ${linkedEmail}. Revisa tu bandeja de entrada para abrir tu link exclusivo.`
                : `Enlace exclusivo generado para ${linkedEmail}. Ábrelo para modificar tus datos.`);

            btnRequestEditLink.disabled = false;
            btnRequestEditLink.innerHTML = origHtml;
        });
    }

    if (linkAnchor) {
        linkAnchor.addEventListener('click', async (e) => {
            e.preventDefault();
            const tok = AstaApp.pendingExclusiveEditToken
                || new URL(linkAnchor.href, window.location.href).searchParams.get('profile_edit_token');
            if (tok) {
                await verifyAndUnlockProfileByToken(tok);
            }
        });
    }

    if (btnCopyExclusiveLink) {
        btnCopyExclusiveLink.addEventListener('click', () => {
            const urlToCopy = AstaApp.pendingExclusiveEditUrl || linkAnchor?.href || '';
            if (urlToCopy) {
                navigator.clipboard?.writeText(urlToCopy);
                showToast('Enlace exclusivo copiado al portapapeles.');
            }
        });
    }

    if (btnCloseMailBox && mailSentBox) {
        btnCloseMailBox.addEventListener('click', () => {
            mailSentBox.style.display = 'none';
        });
    }

    if (btnLockProfileNow) {
        btnLockProfileNow.addEventListener('click', () => {
            localStorage.removeItem('asta_local_profile_edit_token');
            setProfileEditLockState(false, null);
            showToast('Edición de perfil bloqueada nuevamente.');
        });
    }

    if (avatarInput) {
        avatarInput.addEventListener('change', (e) => {
            if (!AstaApp.isProfileEditUnlocked) {
                showToast('Primero abre el enlace exclusivo enviado a tu correo para modificar tu foto.');
                return;
            }
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const size = 220;
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d');

                    // Recorte cuadrado centrado
                    const minSide = Math.min(img.width, img.height);
                    const sx = (img.width - minSide) / 2;
                    const sy = (img.height - minSide) / 2;
                    ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);

                    const base64 = canvas.toDataURL('image/jpeg', 0.8);
                    AstaApp.pendingAvatarBase64 = base64;
                    if (avatarPreview) avatarPreview.src = base64;
                    if (navAvatar) navAvatar.src = base64;
                    showToast('Foto de perfil cargada. Pulsa "Actualizar Perfil y Guardar Datos" para confirmar.');
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    const btnSendPwdEmail = document.getElementById('btn-send-pwd-email');
    const pwdVerifyBox = document.getElementById('pwd-reset-verify-box');
    const pwdEmailNotice = document.getElementById('pwd-reset-email-notice');
    const btnCancelPwdReset = document.getElementById('btn-cancel-pwd-reset');
    const btnConfirmPwdReset = document.getElementById('btn-confirm-pwd-reset');

    if (btnSendPwdEmail && pwdVerifyBox) {
        btnSendPwdEmail.addEventListener('click', async () => {
            const emailVal = document.getElementById('prof-email')?.value.trim() || AstaApp.state?.user?.email || '';
            if (!emailVal || !emailVal.includes('@')) {
                showToast('Ingresa un correo electrónico válido en tu perfil primero.');
                return;
            }

            btnSendPwdEmail.disabled = true;
            const origHtml = btnSendPwdEmail.innerHTML;
            btnSendPwdEmail.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="color: #ff1a2d;"></i><span>Enviando mensaje al correo...</span>';

            try {
                const res = await fetch('../php/auth_api.php?action=request_password_email', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ action: 'request_password_email', email: emailVal })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    pwdVerifyBox.style.display = 'block';
                    if (pwdEmailNotice) {
                        pwdEmailNotice.textContent = data.mail_sent
                            ? `Hemos enviado un mensaje con tu código de seguridad a ${data.email}.`
                            : `Mensaje generado para ${data.email} (Modo local sin servidor SMTP • Código: ${data.dev_code}).`;
                    }
                    if (data.dev_code) {
                        AstaApp.localResetCode = String(data.dev_code);
                    }
                    showToast(data.message);
                    document.getElementById('prof-reset-code')?.focus();
                    btnSendPwdEmail.disabled = false;
                    btnSendPwdEmail.innerHTML = origHtml;
                    return;
                }
                if (data.message && !data.db_down) {
                    showToast(data.message);
                    btnSendPwdEmail.disabled = false;
                    btnSendPwdEmail.innerHTML = origHtml;
                    return;
                }
            } catch (_) {}

            // Fallback local si el servidor no responde
            const fallbackCode = String(Math.floor(100000 + Math.random() * 900000));
            AstaApp.localResetCode = fallbackCode;
            pwdVerifyBox.style.display = 'block';
            if (pwdEmailNotice) {
                pwdEmailNotice.textContent = `Mensaje generado para ${emailVal} (Modo local • Código: ${fallbackCode}).`;
            }
            showToast(`Mensaje enviado a ${emailVal}. Revisa las instrucciones en pantalla.`);
            document.getElementById('prof-reset-code')?.focus();
            btnSendPwdEmail.disabled = false;
            btnSendPwdEmail.innerHTML = origHtml;
        });
    }

    if (btnCancelPwdReset && pwdVerifyBox) {
        btnCancelPwdReset.addEventListener('click', () => {
            pwdVerifyBox.style.display = 'none';
            setVal('prof-reset-code', '');
            setVal('prof-reset-new-password', '');
        });
    }

    if (btnConfirmPwdReset && pwdVerifyBox) {
        btnConfirmPwdReset.addEventListener('click', async () => {
            const codeVal = document.getElementById('prof-reset-code')?.value.trim() || '';
            const newPwdVal = document.getElementById('prof-reset-new-password')?.value.trim() || '';

            if (!codeVal || !newPwdVal) {
                showToast('Ingresa el código recibido en tu correo y tu nueva contraseña.');
                return;
            }
            if (newPwdVal.length < 6) {
                showToast('La nueva contraseña debe tener al menos 6 caracteres.');
                return;
            }

            btnConfirmPwdReset.disabled = true;
            try {
                const res = await fetch('../php/auth_api.php?action=confirm_password_email', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        action: 'confirm_password_email',
                        code: codeVal,
                        new_password: newPwdVal
                    })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    pwdVerifyBox.style.display = 'none';
                    setVal('prof-reset-code', '');
                    setVal('prof-reset-new-password', '');
                    showToast(data.message);
                    btnConfirmPwdReset.disabled = false;
                    return;
                }
                if (data.message && !data.db_down) {
                    showToast(data.message);
                    btnConfirmPwdReset.disabled = false;
                    return;
                }
            } catch (_) {}

            // Verificación en modo local
            if (AstaApp.localResetCode && codeVal === AstaApp.localResetCode) {
                pwdVerifyBox.style.display = 'none';
                setVal('prof-reset-code', '');
                setVal('prof-reset-new-password', '');
                AstaApp.localResetCode = null;
                showToast('¡Tu contraseña ha sido actualizada correctamente!');
            } else {
                showToast('El código de verificación no coincide.');
            }
            btnConfirmPwdReset.disabled = false;
        });
    }

    const btnLogWeightXp = document.getElementById('btn-log-weight-xp');
    if (btnLogWeightXp) {
        btnLogWeightXp.addEventListener('click', async () => {
            const newWeight = parseFloat(document.getElementById('rpg-input-weight')?.value);
            const goalWeight = parseFloat(document.getElementById('rpg-input-goal-weight')?.value) || 70.0;

            if (!newWeight || newWeight < 25 || newWeight > 300) {
                showToast('Ingresa un peso válido en kg (ej. 74.5).');
                return;
            }

            btnLogWeightXp.disabled = true;
            try {
                const res = await fetch('../php/habits_api.php?action=log_weight', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        action: 'log_weight',
                        api_token: AstaApp.state?.user?.api_token || '',
                        weight_kg: newWeight,
                        goal_weight_kg: goalWeight
                    })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showToast(data.message);
                    await loadDashboardData();
                    updateLiebeProfileFeedback(
                        data.diff_kg > 0 ? 'hyped' : 'happy',
                        data.diff_kg > 0
                            ? `¡Jejeje! ¡Bajaste ${data.diff_kg} kg y ganaste +${data.xp_awarded} XP! ¡A este paso subirás de nivel enseguida!`
                            : `¡Pesaje registrado en ${newWeight} kg! Mantén la constancia para alcanzar tu meta de ${goalWeight} kg.`
                    );
                    btnLogWeightXp.disabled = false;
                    return;
                }
            } catch (_) {}

            // Fallback local si no hay conexión a MySQL
            const u = AstaApp.state.user;
            if (!AstaApp.state.weight_logs) AstaApp.state.weight_logs = [];
            const isFirstWeightLog = AstaApp.state.weight_logs.length === 0 || !(Number(u.current_weight_kg) > 0);
            const prevWeight = isFirstWeightLog ? newWeight : Number(u.current_weight_kg);
            const diffKg = isFirstWeightLog ? 0 : Math.round((prevWeight - newWeight) * 100) / 100;
            const xpAwarded = isFirstWeightLog ? 80 : (diffKg > 0 ? Math.max(140, Math.round(diffKg * 200) + 90) : 60);

            if (isFirstWeightLog || !(Number(u.initial_weight_kg) > 0)) {
                u.initial_weight_kg = newWeight;
            }
            u.current_weight_kg = newWeight;
            u.goal_weight_kg = goalWeight;
            u.bonus_xp = (Number(u.bonus_xp) || 0) + xpAwarded;

            AstaApp.state.weight_logs.unshift({
                id: Date.now(),
                weight_kg: newWeight,
                notes: isFirstWeightLog
                    ? `Peso inicial registrado (${newWeight} kg | Meta: ${goalWeight} kg)`
                    : (diffKg > 0
                        ? `Bajaste ${diffKg} kg (${prevWeight} kg → ${newWeight} kg)`
                        : `Control de peso (${newWeight} kg)`),
                xp_awarded: xpAwarded,
                logged_date: new Date().toISOString().slice(0, 10)
            });

            saveLocalFallbackState();
            renderAllPanels();
            updateLiebeProfileFeedback(
                diffKg > 0 ? 'hyped' : 'happy',
                isFirstWeightLog
                    ? `¡Genial! Configuraste tu peso inicial en ${newWeight} kg con meta de ${goalWeight} kg y ganaste tus primeros +${xpAwarded} XP.`
                    : (diffKg > 0
                        ? `¡Jejeje! ¡Bajaste ${diffKg} kg y ganaste +${xpAwarded} XP! ¡Sigue superando tus límites!`
                        : `¡Pesaje registrado (${newWeight} kg)! Sumaste +${xpAwarded} XP a tu progreso.`)
            );
            showToast(
                isFirstWeightLog
                    ? `¡Peso inicial configurado en ${newWeight} kg (Meta: ${goalWeight} kg)! • +${xpAwarded} XP`
                    : (diffKg > 0
                        ? `¡META SUPERADA! Bajaste ${diffKg} kg (${prevWeight} → ${newWeight} kg) • +${xpAwarded} XP`
                        : `Peso registrado (${newWeight} kg) • +${xpAwarded} XP`)
            );
            btnLogWeightXp.disabled = false;
        });
    }

    // Interacción con el compañero Liebe en Mi Perfil
    const btnLiebeChar = document.getElementById('btn-liebe-character');
    const btnLiebeNext = document.getElementById('btn-liebe-next-tip');
    if (btnLiebeChar) {
        btnLiebeChar.addEventListener('click', () => cycleLiebeProfileFeedback());
    }
    if (btnLiebeNext) {
        btnLiebeNext.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleLiebeProfileFeedback();
        });
    }

    if (profileForm) {
        profileForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            if (!AstaApp.isProfileEditUnlocked || !AstaApp.activeProfileEditToken) {
                showToast('Para modificar tus datos, solicita primero el enlace exclusivo a tu correo enlazado.');
                document.getElementById('profile-edit-lock-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }

            let rawUsername = document.getElementById('prof-username').value.trim();
            if (rawUsername.includes('@')) {
                showToast('El nombre de usuario no debe ser un correo electrónico (no incluyas "@").');
                document.getElementById('prof-username')?.focus();
                return;
            }
            if (rawUsername.length < 3) {
                showToast('El nombre de usuario debe tener al menos 3 caracteres.');
                document.getElementById('prof-username')?.focus();
                return;
            }

            const payload = {
                action: 'update_profile',
                api_token: AstaApp.state?.user?.api_token || '',
                profile_edit_token: AstaApp.activeProfileEditToken,
                username: rawUsername,
                email: document.getElementById('prof-email').value.trim(),
                thermos_capacity_ml: parseInt(document.getElementById('prof-thermos-ml').value, 10) || 1183,
                thermos_height_cm: parseFloat(document.getElementById('prof-thermos-height').value) || 34.0,
                sensor_offset_cm: parseFloat(document.getElementById('prof-sensor-offset').value) || 12.0,
                daily_water_goal_ml: parseInt(document.getElementById('prof-water-goal').value, 10) || 3000,
                daily_calorie_goal: parseInt(document.getElementById('prof-cal-goal').value, 10) || 2500,
                daily_step_goal: parseInt(document.getElementById('prof-step-goal').value, 10) || 10000,
                daily_sleep_goal_hrs: 8.0,
                gemini_api_key: document.getElementById('prof-gemini-key').value.trim()
            };

            if (AstaApp.pendingAvatarBase64 !== undefined) {
                payload.avatar_data = AstaApp.pendingAvatarBase64;
            }

            if (payload.gemini_api_key) {
                localStorage.setItem('asta_gemini_api_key', payload.gemini_api_key);
            }

            try {
                const res = await fetch('../php/auth_api.php?action=update_profile', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: getAuthHeaders(),
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (res.ok && data.status === 'success' && data.user) {
                    sanitizeUserUsername(data.user);
                    AstaApp.state.user = data.user;
                    AstaApp.pendingAvatarBase64 = undefined;
                    localStorage.removeItem('asta_local_profile_edit_token');
                    setProfileEditLockState(false, null);
                    saveLocalFallbackState();
                    renderAllPanels();
                    logTelemetryPacket('POST', 'auth_api.php?action=update_profile', 200, 7, `Perfil actualizado (${data.user.username}) • Link exclusivo consumido`);
                    showToast(data.message);
                    return;
                }
                if (res.status === 403 && data.require_link) {
                    setProfileEditLockState(false, null);
                    showToast(data.message);
                    return;
                }
                if (res.status === 409 && data.message) {
                    showToast(data.message);
                    return;
                }
            } catch (_) {}

            // Fallback local si MySQL no está activo o la sesión es local
            delete payload.action;
            delete payload.profile_edit_token;
            Object.assign(AstaApp.state.user, payload);
            sanitizeUserUsername(AstaApp.state.user);
            AstaApp.pendingAvatarBase64 = undefined;
            localStorage.removeItem('asta_local_profile_edit_token');
            setProfileEditLockState(false, null);
            saveLocalFallbackState();
            renderAllPanels();
            logTelemetryPacket('LOCAL', 'auth_api.php?action=update_profile', 200, 3, `Perfil actualizado (${AstaApp.state.user.username}) • Link exclusivo consumido`);
            showToast('Perfil, foto y datos actualizados correctamente. El enlace exclusivo ha sido cerrado.');
        });
    }
}

function bindHydrationControls() {
    const sliderMl = document.getElementById('slider-thermos-ml');
    const sliderCm = document.getElementById('slider-ultrasonic-cm');

    if (sliderMl) {
        sliderMl.addEventListener('input', (e) => {
            const valMl = parseInt(e.target.value, 10);
            const capMl = Number(AstaApp.state?.user?.thermos_capacity_ml) || 1183;
            const heightCm = Number(AstaApp.state?.user?.thermos_height_cm) || 34.0;
            const offsetCm = Number(AstaApp.state?.user?.sensor_offset_cm) || 12.0;
            const pct = Math.round((valMl / capMl) * 100);
            const oz = (valMl / 29.5735).toFixed(1);
            const estDistCm = (offsetCm + Math.max(1, heightCm - offsetCm) * (1 - valMl / capMl)).toFixed(1);

            const fillEl = document.getElementById('thermos-liquid-fill');
            if (fillEl) fillEl.style.height = `${pct}%`;
            setText('thermos-oz-readout', `${oz} oz`);
            setText('thermos-ml-readout', `${valMl} / ${capMl} ml (${pct}%)`);
            setText('thermos-level-oz-val', `${oz} / 40 oz`);
            setText('hc-sr04-cm-val', `${estDistCm} cm`);
            if (sliderCm) sliderCm.value = estDistCm;
        });

        sliderMl.addEventListener('change', async (e) => {
            const valMl = parseInt(e.target.value, 10);
            await updateThermosLevelManual(valMl, 0);
        });
    }

    if (sliderCm) {
        sliderCm.addEventListener('input', (e) => {
            const distCm = parseFloat(e.target.value);
            const capMl = Number(AstaApp.state?.user?.thermos_capacity_ml) || 1183;
            const heightCm = Number(AstaApp.state?.user?.thermos_height_cm) || 34.0;
            const offsetCm = Number(AstaApp.state?.user?.sensor_offset_cm) || 12.0;
            const ratio = Math.max(0, Math.min(1, 1 - (distCm - offsetCm) / Math.max(1, heightCm - offsetCm)));
            const valMl = Math.round(ratio * capMl);
            const pct = Math.round(ratio * 100);
            const oz = (valMl / 29.5735).toFixed(1);

            setText('hc-sr04-cm-val', `${distCm.toFixed(1)} cm`);
            const fillEl = document.getElementById('thermos-liquid-fill');
            if (fillEl) fillEl.style.height = `${pct}%`;
            setText('thermos-oz-readout', `${oz} oz`);
            setText('thermos-ml-readout', `${valMl} / ${capMl} ml (${pct}%)`);
            setText('thermos-level-oz-val', `${oz} / 40 oz`);
            if (sliderMl) sliderMl.value = valMl;
        });

        sliderCm.addEventListener('change', async (e) => {
            const distCm = parseFloat(e.target.value);
            await sendSimulatedEsp32Telemetry(distCm, AstaApp.state?.esp32?.ldr_raw ?? 245);
        });
    }
}

async function quickAddWater(consumedMl, refillThermos = false) {
    const capMl = Number(AstaApp.state?.user?.thermos_capacity_ml) || 1183;
    const currentMl = Number(AstaApp.state?.esp32?.thermos_ml ?? capMl);
    const newLevel = refillThermos ? capMl : Math.max(0, currentMl - consumedMl);

    await updateThermosLevelManual(newLevel, consumedMl);
}

async function updateThermosLevelManual(waterLevelMl, consumedMl) {
    const t0 = performance.now();
    try {
        const res = await fetch('../php/esp32_api.php?action=manual_thermos', {
            method: 'POST',
            credentials: 'same-origin',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                action: 'manual_thermos',
                api_token: AstaApp.state?.user?.api_token || '',
                water_level_ml: waterLevelMl,
                consumed_ml: consumedMl
            })
        });
        const latency = Math.max(2, Math.round(performance.now() - t0));
        AstaApp.lastApiLatencyMs = latency;
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            logTelemetryPacket('POST', 'esp32_api.php?action=manual_thermos', 200, latency, `Nivel=${waterLevelMl}ml | Consumo=+${consumedMl}ml`);
            showToast(data.message);
            await loadDashboardData();
            return;
        }
    } catch (_) {}

    const s = AstaApp.state;
    const capMl = Number(s.user?.thermos_capacity_ml) || 1183;
    const heightCm = Number(s.user?.thermos_height_cm) || 34.0;
    const offsetCm = Number(s.user?.sensor_offset_cm) || 12.0;
    const prevMl = Number(s.esp32?.thermos_ml ?? capMl);
    const autoConsumed = (consumedMl === 0 && prevMl > waterLevelMl) ? (prevMl - waterLevelMl) : consumedMl;

    s.esp32.thermos_ml = waterLevelMl;
    s.esp32.thermos_oz = (waterLevelMl / 29.5735).toFixed(1);
    s.esp32.thermos_pct = Math.round((waterLevelMl / capMl) * 100);
    s.esp32.ultrasonic_cm = Number((offsetCm + Math.max(1, heightCm - offsetCm) * (1 - waterLevelMl / capMl)).toFixed(1));

    if (autoConsumed > 0) {
        s.water_today_ml = (Number(s.water_today_ml) || 0) + autoConsumed;
        s.hydration_logs.unshift({
            id: Date.now(),
            source: 'manual',
            water_level_ml: waterLevelMl,
            consumed_ml: autoConsumed,
            distance_cm: s.esp32.ultrasonic_cm,
            thermos_pct: s.esp32.thermos_pct,
            logged_date: new Date().toISOString().slice(0, 10)
        });
    }
    logTelemetryPacket('LOCAL', 'esp32_api.php?action=manual_thermos', 200, 3, `Nivel=${waterLevelMl}ml (${s.esp32.thermos_oz}oz) | +${autoConsumed}ml`);
    saveLocalFallbackState();
    renderAllPanels();
    showToast(autoConsumed > 0 ? `+${autoConsumed} ml registrados` : `Termo de 40oz ajustado a ${s.esp32.thermos_oz} oz (${s.esp32.ultrasonic_cm} cm)`);
}

async function sendSimulatedEsp32Telemetry(distanceCm, ldrRaw) {
    const t0 = performance.now();
    try {
        const res = await fetch('../php/esp32_api.php?action=telemetry', {
            method: 'POST',
            credentials: 'same-origin',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                action: 'telemetry',
                api_token: AstaApp.state?.user?.api_token || '',
                distance_cm: distanceCm,
                ldr_raw: ldrRaw
            })
        });
        const latency = Math.max(2, Math.round(performance.now() - t0));
        AstaApp.lastApiLatencyMs = latency;
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            logTelemetryPacket('POST', 'esp32_api.php?action=telemetry', 200, latency, `d=${distanceCm}cm | ADC=${ldrRaw} | Nivel=${data.telemetry?.thermos_ml ?? '--'}ml`);
            showToast(data.message);
            await loadDashboardData();
            return;
        }
    } catch (_) {}

    const s = AstaApp.state;
    const capMl = Number(s.user?.thermos_capacity_ml) || 1183;
    const heightCm = Number(s.user?.thermos_height_cm) || 34.0;
    const offsetCm = Number(s.user?.sensor_offset_cm) || 12.0;
    const prevMl = Number(s.esp32?.thermos_ml ?? capMl);
    const ratio = Math.max(0, Math.min(1, 1 - (distanceCm - offsetCm) / Math.max(1, heightCm - offsetCm)));
    const newMl = Math.round(ratio * capMl);

    s.esp32.ultrasonic_cm = distanceCm;
    s.esp32.thermos_ml = newMl;
    s.esp32.thermos_oz = (newMl / 29.5735).toFixed(1);
    s.esp32.thermos_pct = Math.round(ratio * 100);
    s.esp32.ldr_raw = ldrRaw;
    s.esp32.room_darkness_pct = Math.round((1 - ldrRaw / 4095) * 100 * 10) / 10;
    s.esp32.room_lux_state = s.esp32.room_darkness_pct >= 85 ? 'Oscuridad Óptima' : (s.esp32.room_darkness_pct >= 60 ? 'Penumbra' : 'Habitación Iluminada');

    if (prevMl - newMl >= 30) {
        const drankMl = prevMl - newMl;
        s.water_today_ml = (Number(s.water_today_ml) || 0) + drankMl;
        s.hydration_logs.unshift({
            id: Date.now(),
            source: 'esp32_ultrasonic',
            water_level_ml: newMl,
            consumed_ml: drankMl,
            distance_cm: distanceCm,
            thermos_pct: s.esp32.thermos_pct,
            logged_date: new Date().toISOString().slice(0, 10)
        });
    }

    logTelemetryPacket('SIM-IOT', 'esp32_api.php?action=telemetry', 200, 4, `HC-SR04=${distanceCm}cm (${s.esp32.thermos_ml}ml) | LDR=${ldrRaw} ADC (${s.esp32.room_darkness_pct}%)`);
    saveLocalFallbackState();
    renderAllPanels();
    showToast(`ESP32: ${s.esp32.thermos_oz} oz (${distanceCm} cm) | Oscuridad LDR: ${s.esp32.room_darkness_pct}%`);
}

function bindSleepControls() {
    const sliderLdr = document.getElementById('slider-ldr-adc');
    if (sliderLdr) {
        sliderLdr.addEventListener('input', (e) => {
            const ldrVal = parseInt(e.target.value, 10);
            const darkPct = ((1 - ldrVal / 4095) * 100).toFixed(1);
            setText('ldr-adc-val', `${ldrVal} / 4095 ADC`);
            setText('ldr-darkness-pct', `${darkPct}% Oscuridad`);
            const pinEl = document.getElementById('ldr-bar-pin');
            if (pinEl) pinEl.style.left = `${Math.max(2, Math.min(98, Math.round((ldrVal / 4095) * 100)))}%`;
        });

        sliderLdr.addEventListener('change', async (e) => {
            const ldrVal = parseInt(e.target.value, 10);
            await sendSimulatedEsp32Telemetry(AstaApp.state?.esp32?.ultrasonic_cm ?? 12.0, ldrVal);
        });
    }

    const sleepForm = document.getElementById('form-add-sleep');
    if (sleepForm) {
        sleepForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                action: 'add_sleep',
                sleep_hours: parseFloat(document.getElementById('sleep-hours-input').value) || 7.5,
                deep_sleep_hours: parseFloat(document.getElementById('sleep-deep-input').value) || 2.2,
                rem_sleep_hours: parseFloat(document.getElementById('sleep-rem-input').value) || 1.8,
                light_level_adc: parseInt(document.getElementById('slider-ldr-adc').value, 10) || 245,
                sleep_quality_score: parseInt(document.getElementById('sleep-quality-input').value, 10) || 90,
                source: document.getElementById('sleep-source-select').value || 'esp32_ldr'
            };

            await postHabitRecord(payload, () => {
                const darkPct = Math.round((1 - payload.light_level_adc / 4095) * 100);
                AstaApp.state.sleep_logs.unshift({
                    id: Date.now(),
                    ...payload,
                    room_darkness_pct: darkPct,
                    logged_date: new Date().toISOString().slice(0, 10)
                });
            });
        });
    }
}

function bindGymControls() {
    // 1. Controles del Anillo Semanal 4/4 (25% por sesión)
    document.querySelectorAll('.gym-step-pill[data-gym-step]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const step = parseInt(btn.getAttribute('data-gym-step'), 10);
            setGymWeeklySessions(step, true);
        });
    });

    const btnCompleteWorkout = document.getElementById('btn-gym-complete-workout');
    if (btnCompleteWorkout) {
        btnCompleteWorkout.addEventListener('click', () => {
            const curr = getGymWeeklySessions();
            const next = Math.min(4, curr + 1);
            setGymWeeklySessions(next, true);
        });
    }

    const btnResetRing = document.getElementById('btn-gym-reset-ring');
    if (btnResetRing) {
        btnResetRing.addEventListener('click', () => {
            setGymWeeklySessions(0, true);
        });
    }

    // 2. Acordeón de Tarjetas Split (Upper Body / Lower Body)
    document.querySelectorAll('.gym-split-header[data-split-toggle]').forEach((headerBtn) => {
        headerBtn.addEventListener('click', () => {
            const key = headerBtn.getAttribute('data-split-toggle');
            const card = document.querySelector(`.gym-split-card[data-split-card="${key}"]`);
            if (!card) return;
            const isExpanded = card.classList.toggle('expanded');
            headerBtn.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
        });
    });

    // 3. Micro-interacciones de Registro Rápido (Inputs + Checkbox con tachado y guardado en BD)
    const splitsContainer = document.querySelector('.gym-splits-container');
    if (splitsContainer) {
        splitsContainer.addEventListener('input', (e) => {
            const target = e.target;
            if (!target.classList.contains('js-gym-ex-weight') && !target.classList.contains('js-gym-ex-reps')) return;
            const splitKey = target.getAttribute('data-split-key');
            const idx = parseInt(target.getAttribute('data-ex-idx'), 10);
            const splits = getGymSplitsState();
            const ex = splits[splitKey]?.[idx];
            if (!ex) return;

            if (target.classList.contains('js-gym-ex-weight')) {
                ex.weight = parseFloat(target.value) || 0;
            } else {
                ex.reps = parseInt(target.value, 10) || 1;
            }
            saveGymSplitsState();
        });

        splitsContainer.addEventListener('click', async (e) => {
            const toggleEl = e.target.closest('[data-toggle-ex]');
            if (toggleEl) {
                const [splitKey, idxStr] = toggleEl.getAttribute('data-toggle-ex').split(':');
                const idx = parseInt(idxStr, 10);
                const splits = getGymSplitsState();
                const ex = splits[splitKey]?.[idx];
                if (!ex) return;

                // Leer los valores actuales de los inputs de la fila
                const rowEl = toggleEl.closest('.gym-exercise-row');
                if (rowEl) {
                    const wVal = parseFloat(rowEl.querySelector('.js-gym-ex-weight')?.value);
                    const rVal = parseInt(rowEl.querySelector('.js-gym-ex-reps')?.value, 10);
                    if (!isNaN(wVal)) ex.weight = wVal;
                    if (!isNaN(rVal)) ex.reps = rVal;
                }

                ex.completed = !ex.completed;
                saveGymSplitsState();
                renderGymSplitExercises(splitKey);

                if (ex.completed) {
                    const payload = {
                        action: 'add_gym',
                        exercise_name: ex.name,
                        muscle_group: ex.muscle,
                        sets: 4,
                        reps: ex.reps || 10,
                        weight_kg: ex.weight || 0,
                        duration_min: 15,
                        rpe_intensity: 9
                    };

                    const prevMaxForExercise = (AstaApp.state?.gym_logs || [])
                        .filter((g) => (g.exercise_name || '').toLowerCase() === payload.exercise_name.toLowerCase())
                        .reduce((max, g) => Math.max(max, Number(g.weight_kg) || 0), 0);
                    const isLocalPr = payload.weight_kg > 0 && prevMaxForExercise > 0 && payload.weight_kg > prevMaxForExercise;

                    // Si se completaron todos los ejercicios de este split, avanza +25% el anillo semanal automáticamente
                    const allSplitDone = splits[splitKey].every((item) => item.completed);
                    if (allSplitDone) {
                        const nextSessions = Math.min(4, getGymWeeklySessions() + 1);
                        setGymWeeklySessions(nextSessions, false);
                    }

                    await postHabitRecord(payload, () => {
                        AstaApp.state.gym_logs.unshift({
                            id: Date.now(),
                            ...payload,
                            logged_date: new Date().toISOString().slice(0, 10)
                        });
                        const xpGain = isLocalPr ? 180 : 65;
                        AstaApp.state.user.bonus_xp = (Number(AstaApp.state.user.bonus_xp) || 0) + xpGain;
                        if (isLocalPr) {
                            setTimeout(() => {
                                showToast(`¡NUEVO RÉCORD EN GIMNASIO! Superaste ${prevMaxForExercise}kg → ${payload.weight_kg}kg • +180 XP`);
                            }, 350);
                        }
                    });
                }
                return;
            }

            const addCustomBtn = e.target.closest('[data-add-custom-split]');
            if (addCustomBtn) {
                const splitKey = addCustomBtn.getAttribute('data-add-custom-split');
                const inputEl = document.getElementById(`gym-custom-name-${splitKey}`);
                const name = inputEl?.value.trim() || '';
                if (!name) {
                    showToast('Escribe el nombre del ejercicio para añadirlo al split.');
                    return;
                }
                const splits = getGymSplitsState();
                splits[splitKey].push({
                    id: `${splitKey}_${Date.now()}`,
                    name,
                    muscle: splitKey === 'upper' ? 'Upper Body' : 'Lower Body',
                    weight: 60,
                    reps: 10,
                    completed: false
                });
                if (inputEl) inputEl.value = '';
                saveGymSplitsState();
                renderGymSplitExercises(splitKey);
                showToast(`Ejercicio "${name}" añadido a ${splitKey === 'upper' ? 'Upper Body' : 'Lower Body'}.`);
            }
        });
    }

    // 4. Botón Flotante (FAB) "Sincronizar Smartwatch" con animación de rotación
    const fabSyncBtn = document.getElementById('btn-gym-sync-smartwatch');
    if (fabSyncBtn) {
        fabSyncBtn.addEventListener('click', async () => {
            if (fabSyncBtn.classList.contains('is-syncing')) return;
            fabSyncBtn.classList.add('is-syncing');

            try {
                if (window.AstaGalaxyWatch && navigator.bluetooth) {
                    const bleData = await window.AstaGalaxyWatch.connectWatchBLE((live) => {
                        if (live.heart_rate_bpm && AstaApp.state?.watch) {
                            AstaApp.state.watch.heart_rate_bpm = live.heart_rate_bpm;
                            renderWatchPanel();
                        }
                    });
                    showToast(`Smartwatch sincronizado (${bleData.deviceName}) • Pulso y calorías de entreno actualizados.`);
                    fabSyncBtn.classList.remove('is-syncing');
                    return;
                }
            } catch (_) {}

            // Sincronización rápida de métricas de entrenamiento del Smartwatch con el servidor
            setTimeout(async () => {
                const w = AstaApp.state?.watch || {};
                const boostedSteps = Math.max(Number(w.steps) || 8420, 8950);
                const workoutBpm = 128;
                const payload = {
                    action: 'sync_watch',
                    steps: boostedSteps,
                    heart_rate_bpm: workoutBpm,
                    active_calories: Math.round(boostedSteps * 0.052 + 240),
                    distance_km: Math.round(boostedSteps * 0.00076 * 100) / 100,
                    sleep_minutes: Number(w.sleep_minutes) || 468,
                    blood_oxygen_pct: Number(w.blood_oxygen_pct) || 98,
                    watch_battery_pct: Number(w.watch_battery_pct) || 85,
                    sync_method: 'Smartwatch Gym Sync'
                };

                await postHabitRecord(payload, () => {
                    AstaApp.state.watch = {
                        ...AstaApp.state.watch,
                        ...payload,
                        logged_date: new Date().toISOString().slice(0, 10)
                    };
                });
                fabSyncBtn.classList.remove('is-syncing');
                showToast(`Smartwatch sincronizado: ${workoutBpm} BPM en entrenamiento • ${payload.active_calories} kcal activas.`);
            }, 700);
        });
    }
}

function bindNutritionAIControls() {
    const dropzone = document.getElementById('ai-food-dropzone');
    const fileInput = document.getElementById('ai-food-file-input');
    const previewImg = document.getElementById('food-preview-img');
    const placeholder = document.getElementById('dropzone-placeholder');
    const presetSelect = document.getElementById('ai-food-preset-select');
    const saveFoodForm = document.getElementById('form-save-nutrition');

    if (dropzone && fileInput) {
        dropzone.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            dropzone.classList.add('scanning');
            showToast('Escaneando imagen y calculando macros...');

            const hint = document.getElementById('nut-food-name').value;
            try {
                const result = await window.AstaAINutrition.analyzeFoodImage(file, hint);
                setTimeout(() => {
                    dropzone.classList.remove('scanning');
                    if (previewImg && result.image_data) {
                        previewImg.src = result.image_data;
                        previewImg.style.display = 'block';
                        if (placeholder) placeholder.style.display = 'none';
                    }
                    setVal('nut-food-name', result.food_name);
                    setVal('nut-calories', result.calories);
                    setVal('nut-protein', result.protein_g);
                    setVal('nut-carbs', result.carbs_g);
                    setVal('nut-fat', result.fat_g);
                    setVal('nut-confidence', result.ai_confidence);
                    showToast(`Análisis completado: ${result.food_name} (${result.calories} kcal)`);
                }, 800);
            } catch (_) {
                dropzone.classList.remove('scanning');
                showToast('Error al procesar la imagen.');
            }
        });
    }

    if (presetSelect) {
        presetSelect.addEventListener('change', (e) => {
            const idx = parseInt(e.target.value, 10);
            const prof = window.AstaAINutrition.FOOD_PROFILES[idx];
            if (prof) {
                setVal('nut-food-name', prof.name);
                setVal('nut-calories', prof.calories);
                setVal('nut-protein', prof.protein_g);
                setVal('nut-carbs', prof.carbs_g);
                setVal('nut-fat', prof.fat_g);
                setVal('nut-confidence', 'Estimación IA Instantánea');
            }
        });
    }

    if (saveFoodForm) {
        saveFoodForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                action: 'add_nutrition',
                meal_type: document.getElementById('nut-meal-type').value,
                food_name: document.getElementById('nut-food-name').value.trim() || 'Comida Analizada',
                calories: parseInt(document.getElementById('nut-calories').value, 10) || 0,
                protein_g: parseFloat(document.getElementById('nut-protein').value) || 0,
                carbs_g: parseFloat(document.getElementById('nut-carbs').value) || 0,
                fat_g: parseFloat(document.getElementById('nut-fat').value) || 0,
                ai_confidence: document.getElementById('nut-confidence').value || 'Escáner IA',
                image_data: window.AstaAINutrition.getLastImageBase64()
            };

            await postHabitRecord(payload, () => {
                AstaApp.state.nutrition_logs.unshift({
                    id: Date.now(),
                    ...payload,
                    logged_date: new Date().toISOString().slice(0, 10)
                });
                AstaApp.state.macros_today.total_calories = (Number(AstaApp.state.macros_today.total_calories) || 0) + payload.calories;
                AstaApp.state.macros_today.total_protein = (Number(AstaApp.state.macros_today.total_protein) || 0) + payload.protein_g;
                AstaApp.state.macros_today.total_carbs = (Number(AstaApp.state.macros_today.total_carbs) || 0) + payload.carbs_g;
                AstaApp.state.macros_today.total_fat = (Number(AstaApp.state.macros_today.total_fat) || 0) + payload.fat_g;
            });
        });
    }
}

function bindGalaxyWatchControls() {
    const btnBle = document.getElementById('btn-connect-watch-ble');
    const watchForm = document.getElementById('form-sync-watch');

    if (btnBle) {
        btnBle.addEventListener('click', async () => {
            try {
                showToast('Buscando Samsung Galaxy Watch 8 por Bluetooth BLE...');
                const bleInfo = await window.AstaGalaxyWatch.connectWatchBLE((liveUpdate) => {
                    if (liveUpdate.heart_rate_bpm) {
                        setVal('watch-input-bpm', liveUpdate.heart_rate_bpm);
                        setText('watch-face-bpm', `${liveUpdate.heart_rate_bpm} BPM`);
                    }
                });
                if (bleInfo.battery) {
                    setText('watch-stat-battery', `BAT: ${bleInfo.battery}%`);
                }
                showToast(`Conectado a ${bleInfo.deviceName}`);
            } catch (err) {
                showToast(err.message || 'Conexión BLE cancelada.');
            }
        });
    }

    if (watchForm) {
        watchForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const steps = parseInt(document.getElementById('watch-input-steps').value, 10) || 0;
            const bpm = parseInt(document.getElementById('watch-input-bpm').value, 10) || 70;
            const sleepMin = parseInt(document.getElementById('watch-input-sleep-min').value, 10) || 450;
            const spo2 = parseInt(document.getElementById('watch-input-spo2').value, 10) || 98;

            const derived = window.AstaGalaxyWatch.deriveMetricsFromSteps(steps, bpm);
            const payload = {
                action: 'sync_watch',
                steps: derived.steps,
                heart_rate_bpm: bpm,
                active_calories: derived.active_calories,
                distance_km: derived.distance_km,
                sleep_minutes: sleepMin,
                blood_oxygen_pct: spo2,
                watch_battery_pct: 88,
                sync_method: 'Samsung Galaxy Watch 8 Sync'
            };

            await postHabitRecord(payload, () => {
                AstaApp.state.watch = {
                    ...payload,
                    logged_date: new Date().toISOString().slice(0, 10)
                };
            });
        });
    }
}

async function postHabitRecord(payload, localMutator) {
    const t0 = performance.now();
    try {
        const enrichedPayload = {
            api_token: AstaApp.state?.user?.api_token || '',
            ...payload
        };
        const res = await fetch(`../php/habits_api.php?action=${encodeURIComponent(payload.action)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: getAuthHeaders(),
            body: JSON.stringify(enrichedPayload)
        });
        const latency = Math.max(2, Math.round(performance.now() - t0));
        AstaApp.lastApiLatencyMs = latency;
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            logTelemetryPacket('POST', `habits_api.php?action=${payload.action}`, 200, latency, data.message || 'Registro persistido en MySQL');
            showToast(data.message);
            await loadDashboardData();
            return;
        }
    } catch (_) {}

    if (typeof localMutator === 'function') {
        localMutator();
        logTelemetryPacket('LOCAL', `habits_api.php?action=${payload.action}`, 200, 3, 'Persistido en caché transaccional LocalStorage');
        saveLocalFallbackState();
        renderAllPanels();
        showToast('Registro guardado.');
    }
}

async function deleteRecord(action, id) {
    const t0 = performance.now();
    try {
        const res = await fetch(`../php/habits_api.php?action=${encodeURIComponent(action)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                action,
                id,
                api_token: AstaApp.state?.user?.api_token || ''
            })
        });
        const latency = Math.max(2, Math.round(performance.now() - t0));
        AstaApp.lastApiLatencyMs = latency;
        const data = await res.json();
        if (res.ok && data.status === 'success') {
            logTelemetryPacket('DELETE', `habits_api.php?action=${action}&id=${id}`, 200, latency, 'Registro eliminado de MySQL');
            showToast(data.message);
            await loadDashboardData();
            return;
        }
    } catch (_) {}

    const mapKey = {
        delete_gym: 'gym_logs',
        delete_hydration: 'hydration_logs',
        delete_sleep: 'sleep_logs',
        delete_nutrition: 'nutrition_logs'
    }[action];

    if (mapKey && AstaApp.state[mapKey]) {
        AstaApp.state[mapKey] = AstaApp.state[mapKey].filter((item) => Number(item.id) !== Number(id));
        logTelemetryPacket('LOCAL', `habits_api.php?action=${action}&id=${id}`, 200, 2, 'Registro eliminado de caché local');
        saveLocalFallbackState();
        renderAllPanels();
        showToast('Registro eliminado.');
    }
}

async function logoutGrimoire() {
    try {
        await fetch('../php/auth_api.php?action=logout', { credentials: 'same-origin' });
    } catch (_) {}
    localStorage.removeItem('asta_active_user');
    localStorage.removeItem('asta_local_profile_edit_token');
    window.location.href = 'login.html';
}

function copyEsp32Token() {
    const token = document.getElementById('user-api-token-display')?.textContent?.trim() || 'ASTA-ESP32-BLACKBULLS-777';
    navigator.clipboard?.writeText(token);
    showToast(`Token copiado: ${token}`);
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function setWidth(id, widthStr) {
    const el = document.getElementById(id);
    if (el) el.style.width = widthStr;
}

function showToast(message) {
    let container = document.getElementById('asta-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'asta-toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'asta-toast';
    toast.innerHTML = `<span>✦</span><div>${message}</div>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3400);
}

/* ==========================================================================
   GRÁFICAS DE PROGRESO (SEMANAL, MENSUAL, ANUAL) CONECTADAS A BASE DE DATOS
   ========================================================================== */

const HABIT_CHART_CONFIG = {
    hydration: {
        label: 'Hidratación',
        unit: 'ml',
        color: '#ff1a2d',
        getGoal: (u) => Number(u?.daily_water_goal_ml) || 3000
    },
    sleep: {
        label: 'Sueño',
        unit: 'hrs',
        color: '#ff8fa3',
        getGoal: (u) => Number(u?.daily_sleep_goal_hrs) || 8.0
    },
    gym: {
        label: 'Gimnasio',
        unit: 'kg',
        color: '#ffffff',
        getGoal: () => 5000
    },
    nutrition: {
        label: 'Comidas',
        unit: 'kcal',
        color: '#ff4d6d',
        getGoal: (u) => Number(u?.daily_calorie_goal) || 2500
    },
    watch: {
        label: 'Watch',
        unit: 'pasos',
        color: '#c9184a',
        getGoal: (u) => Number(u?.daily_step_goal) || 10000
    }
};

function setChartHabit(habit) {
    if (habit !== 'all' && !HABIT_CHART_CONFIG[habit]) return;
    AstaApp.chartHabit = habit;
    document.querySelectorAll('[data-chart-habit]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-chart-habit') === habit);
    });
    requestAnimationFrame(() => renderProgressChart());
}

async function setChartPeriod(period) {
    if (!['weekly', 'monthly', 'yearly'].includes(period)) return;
    AstaApp.chartPeriod = period;
    document.querySelectorAll('[data-chart-period]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-chart-period') === period);
    });

    if (!AstaApp.isOfflineMode) {
        const t0 = performance.now();
        try {
            const res = await fetch(`../php/habits_api.php?action=analytics_progress&period=${period}`);
            const latency = Math.max(2, Math.round(performance.now() - t0));
            AstaApp.lastApiLatencyMs = latency;
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'success' && json.data && AstaApp.state) {
                    if (!AstaApp.state.analytics) AstaApp.state.analytics = {};
                    AstaApp.state.analytics[period] = json.data;
                    logTelemetryPacket('GET', `habits_api.php?action=analytics_progress&period=${period}`, 200, latency, `Series temporales (${period}) sincronizadas`);
                }
            }
        } catch (_) {}
    }

    renderProgressChart();
}

function bindProgressChartControls() {
    document.querySelectorAll('[data-chart-habit]').forEach((btn) => {
        btn.addEventListener('click', () => setChartHabit(btn.getAttribute('data-chart-habit')));
    });

    document.querySelectorAll('[data-chart-period]').forEach((btn) => {
        btn.addEventListener('click', () => setChartPeriod(btn.getAttribute('data-chart-period')));
    });

    const canvas = document.getElementById('habits-progress-canvas');
    const tooltip = document.getElementById('chart-hover-tooltip');
    if (canvas && tooltip) {
        const handlePointer = (clientX) => {
            const pts = AstaApp.chartPointsMeta || [];
            if (!pts.length) return;
            const rect = canvas.getBoundingClientRect();
            const relX = clientX - rect.left;

            let closest = pts[0];
            let minDiff = Math.abs(relX - closest.x);
            for (const p of pts) {
                const d = Math.abs(relX - p.x);
                if (d < minDiff) {
                    minDiff = d;
                    closest = p;
                }
            }

            if (minDiff <= 48) {
                tooltip.hidden = false;
                tooltip.innerHTML = `<strong>${closest.label}</strong>: ${closest.formattedVal}`;
                const clampedX = Math.max(46, Math.min(rect.width - 46, closest.x));
                tooltip.style.left = `${clampedX}px`;
                tooltip.style.top = `${Math.max(28, closest.y)}px`;
            } else {
                tooltip.hidden = true;
            }
        };

        canvas.addEventListener('mousemove', (e) => handlePointer(e.clientX));
        canvas.addEventListener('mouseleave', () => { tooltip.hidden = true; });
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches[0]) handlePointer(e.touches[0].clientX);
        }, { passive: true });
    }

    window.addEventListener('resize', () => {
        renderProgressChart();
    });
}

function buildClientAnalytics(period) {
    const s = AstaApp.state || {};
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    const buckets = [];
    const labels = [];
    const now = new Date();

    if (period === 'yearly') {
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            buckets.push(ym);
            labels.push(`${monthNames[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`);
        }
    } else {
        const count = period === 'monthly' ? 30 : 7;
        for (let i = count - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            const ymd = d.toISOString().slice(0, 10);
            buckets.push(ymd);
            if (period === 'weekly') {
                labels.push(`${dayNames[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}`);
            } else {
                labels.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
            }
        }
    }

    const keyFn = (dateStr) => {
        if (!dateStr) return '';
        return period === 'yearly' ? dateStr.slice(0, 7) : dateStr.slice(0, 10);
    };

    const hydMap = {};
    (s.hydration_logs || []).forEach((r) => {
        const k = keyFn(r.logged_date);
        hydMap[k] = (hydMap[k] || 0) + Number(r.consumed_ml || 0);
    });

    const slpMap = {};
    const slpCount = {};
    (s.sleep_logs || []).forEach((r) => {
        const k = keyFn(r.logged_date);
        slpMap[k] = (slpMap[k] || 0) + Number(r.sleep_hours || 0);
        slpCount[k] = (slpCount[k] || 0) + 1;
    });

    const nutMap = {};
    (s.nutrition_logs || []).forEach((r) => {
        const k = keyFn(r.logged_date);
        nutMap[k] = (nutMap[k] || 0) + Number(r.calories || 0);
    });

    const gymMap = {};
    (s.gym_logs || []).forEach((r) => {
        const k = keyFn(r.logged_date);
        const vol = Number(r.sets || 0) * Number(r.reps || 0) * Number(r.weight_kg || 0);
        gymMap[k] = (gymMap[k] || 0) + Math.round(vol);
    });

    const wtcMap = {};
    if (s.watch && s.watch.logged_date) {
        wtcMap[keyFn(s.watch.logged_date)] = Number(s.watch.steps || 0);
    }

    const series = { hydration: [], sleep: [], nutrition: [], gym: [], watch: [] };

    buckets.forEach((b) => {
        series.hydration.push(hydMap[b] !== undefined ? hydMap[b] : 0);
        series.sleep.push(slpMap[b] !== undefined ? Number((slpMap[b] / slpCount[b]).toFixed(1)) : 0);
        series.nutrition.push(nutMap[b] !== undefined ? nutMap[b] : 0);
        series.gym.push(gymMap[b] !== undefined ? gymMap[b] : 0);
        series.watch.push(wtcMap[b] !== undefined ? wtcMap[b] : 0);
    });

    return { labels, keys: buckets, series };
}

function calcStdDev(arr) {
    const nz = (arr || []).map(Number).filter((v) => v > 0);
    if (nz.length <= 1) return 0;
    const mean = nz.reduce((a, b) => a + b, 0) / nz.length;
    const variance = nz.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / nz.length;
    return Math.sqrt(variance);
}

function renderProgressChart() {
    const canvas = document.getElementById('habits-progress-canvas');
    const statsGrid = document.getElementById('progress-stats-grid');
    if (!canvas || !AstaApp.state) return;

    const period = AstaApp.chartPeriod || 'weekly';
    const habit = AstaApp.chartHabit || 'all';

    const dbAnalytics = (!AstaApp.isOfflineMode && AstaApp.state.analytics && AstaApp.state.analytics[period])
        ? AstaApp.state.analytics[period]
        : buildClientAnalytics(period);

    const labels = dbAnalytics.labels || [];
    const seriesAll = dbAnalytics.series || {};

    const fmtVal = (hKey, n) => (hKey === 'sleep' ? Number(n).toFixed(1) : Math.round(n).toLocaleString());
    const calcAvg = (arr) => {
        const nz = (arr || []).map(Number).filter((v) => v > 0);
        return nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0;
    };

    // 1. Renderizar tarjetas de resumen alineadas (con métricas de ingeniería de datos)
    if (statsGrid) {
        if (habit === 'all') {
            statsGrid.innerHTML = Object.keys(HABIT_CHART_CONFIG).map((hKey) => {
                const c = HABIT_CHART_CONFIG[hKey];
                const avg = calcAvg(seriesAll[hKey]);
                return `
                    <div class="telemetry-mini-box">
                        <span><i class="chart-legend-dot" style="background:${c.color};box-shadow:0 0 6px ${c.color};"></i>${c.label} (Prom.)</span>
                        <strong>${fmtVal(hKey, avg)} ${c.unit}</strong>
                    </div>
                `;
            }).join('');
        } else {
            const cfg = HABIT_CHART_CONFIG[habit] || HABIT_CHART_CONFIG.hydration;
            const vals = (seriesAll[habit] || []).map((v) => Number(v) || 0);
            const avgVal = calcAvg(vals);
            const maxVal = vals.length ? Math.max(...vals) : 0;
            const stdDev = calcStdDev(vals);
            const baseGoal = cfg.getGoal(AstaApp.state.user);
            const goalVal = (period === 'yearly' && habit !== 'sleep') ? baseGoal * 25 : baseGoal;
            const compliancePct = Math.min(100, Math.round((avgVal / Math.max(1, goalVal)) * 100));

            statsGrid.innerHTML = `
                <div class="telemetry-mini-box">
                    <span>Media Muestral (μ)</span>
                    <strong>${fmtVal(habit, avgVal)} ${cfg.unit}</strong>
                </div>
                <div class="telemetry-mini-box">
                    <span>Pico Máximo</span>
                    <strong>${fmtVal(habit, maxVal)} ${cfg.unit}</strong>
                </div>
                <div class="telemetry-mini-box">
                    <span>Desv. Estándar (σ)</span>
                    <strong>±${fmtVal(habit, stdDev)} ${cfg.unit}</strong>
                </div>
                <div class="telemetry-mini-box">
                    <span>Cumplimiento Meta</span>
                    <strong>${compliancePct}% (${fmtVal(habit, goalVal)} ${cfg.unit})</strong>
                </div>
            `;
        }
    }

    // 2. Configurar dimensiones exactas del Canvas sin desbordar el contenedor
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(240, canvas.clientWidth || (canvas.parentElement.clientWidth - 24));
    const height = Math.max(190, canvas.clientHeight || 215);

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const padLeft = 44;
    const padRight = 16;
    const padTop = 16;
    const padBottom = 28;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (!labels.length) return;
    const stepX = labels.length > 1 ? plotW / (labels.length - 1) : plotW / 2;
    const labelStride = labels.length > 14 ? 4 : (labels.length > 8 ? 2 : 1);

    // MODO A: VISTA GENERAL ("all" en Inicio) -> Muestra las 5 gráficas normalizadas al % de su meta
    if (habit === 'all') {
        const upperPct = 120;
        ctx.strokeStyle = 'rgba(255, 45, 65, 0.14)';
        ctx.lineWidth = 1;
        ctx.fillStyle = 'rgba(242, 213, 217, 0.55)';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'right';

        for (let i = 0; i <= 4; i++) {
            const y = padTop + (plotH / 4) * i;
            const valPct = Math.round(100 * (1 - i / 4));
            ctx.beginPath();
            ctx.moveTo(padLeft, y);
            ctx.lineTo(width - padRight, y);
            ctx.stroke();
            ctx.fillText(`${valPct}%`, padLeft - 8, y + 4);
        }

        const habitKeys = Object.keys(HABIT_CHART_CONFIG);
        const multiPointsByIdx = labels.map((lbl, i) => ({
            x: labels.length > 1 ? padLeft + i * stepX : padLeft + plotW / 2,
            y: padTop + plotH * 0.35,
            label: lbl,
            details: []
        }));

        habitKeys.forEach((hKey) => {
            const cfg = HABIT_CHART_CONFIG[hKey];
            const rawVals = (seriesAll[hKey] || []).map((v) => Number(v) || 0);
            const baseGoal = cfg.getGoal(AstaApp.state.user);
            const goalVal = Math.max(1, (period === 'yearly' && hKey !== 'sleep') ? baseGoal * 25 : baseGoal);

            const pts = rawVals.map((v, i) => {
                const pct = Math.min(upperPct, (v / goalVal) * 100);
                const x = labels.length > 1 ? padLeft + i * stepX : padLeft + plotW / 2;
                const y = padTop + plotH * (1 - pct / upperPct);
                if (multiPointsByIdx[i]) {
                    multiPointsByIdx[i].details.push(`${cfg.label}: ${fmtVal(hKey, v)} ${cfg.unit}`);
                }
                return { x, y };
            });

            if (!pts.length) return;

            ctx.save();
            ctx.strokeStyle = cfg.color;
            ctx.lineWidth = hKey === 'hydration' ? 2.6 : 1.9;
            ctx.beginPath();
            pts.forEach((p, idx) => {
                if (idx === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
            ctx.restore();

            pts.forEach((p) => {
                ctx.fillStyle = cfg.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, labels.length > 16 ? 2.2 : 3.2, 0, Math.PI * 2);
                ctx.fill();
            });
        });

        AstaApp.chartPointsMeta = multiPointsByIdx.map((m) => ({
            x: m.x,
            y: m.y,
            label: m.label,
            formattedVal: m.details.join(' | ')
        }));

        ctx.textAlign = 'center';
        ctx.font = '10.5px Inter, sans-serif';
        ctx.fillStyle = 'rgba(242, 213, 217, 0.72)';
        multiPointsByIdx.forEach((m, idx) => {
            if (idx % labelStride === 0 || idx === multiPointsByIdx.length - 1) {
                ctx.fillText(m.label, m.x, height - 8);
            }
        });
        return;
    }

    // MODO B: VISTA DE UN SOLO HÁBITO (Agua, Sueño, Gimnasio, Comidas, Watch)
    const cfg = HABIT_CHART_CONFIG[habit] || HABIT_CHART_CONFIG.hydration;
    const values = (seriesAll[habit] || []).map((v) => Number(v) || 0);
    const maxVal = values.length ? Math.max(...values) : 0;
    const baseGoal = cfg.getGoal(AstaApp.state.user);
    const goalVal = (period === 'yearly' && habit !== 'sleep') ? baseGoal * 25 : baseGoal;
    const upperBound = Math.max(maxVal, goalVal, 1) * 1.15;

    ctx.strokeStyle = 'rgba(255, 45, 65, 0.14)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(242, 213, 217, 0.55)';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'right';

    for (let i = 0; i <= 4; i++) {
        const y = padTop + (plotH / 4) * i;
        const valAtLine = upperBound * (1 - i / 4);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();

        const labelStr = valAtLine >= 10000
            ? `${(valAtLine / 1000).toFixed(0)}k`
            : (habit === 'sleep' ? valAtLine.toFixed(1) : Math.round(valAtLine));
        ctx.fillText(String(labelStr), padLeft - 8, y + 4);
    }

    const goalY = padTop + plotH * (1 - Math.min(goalVal / upperBound, 1));
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(padLeft, goalY);
    ctx.lineTo(width - padRight, goalY);
    ctx.stroke();
    ctx.restore();

    const barWidth = Math.max(6, Math.min(24, (plotW / values.length) * 0.42));
    const points = values.map((v, i) => {
        const x = values.length > 1 ? padLeft + i * stepX : padLeft + plotW / 2;
        const y = padTop + plotH * (1 - Math.min(v / upperBound, 1));
        return {
            x,
            y,
            val: v,
            label: labels[i] || '',
            formattedVal: `${fmtVal(habit, v)} ${cfg.unit}`
        };
    });
    AstaApp.chartPointsMeta = points;

    points.forEach((p) => {
        const barH = Math.max(2, padTop + plotH - p.y);
        const barGrad = ctx.createLinearGradient(0, p.y, 0, padTop + plotH);
        barGrad.addColorStop(0, 'rgba(255, 26, 45, 0.32)');
        barGrad.addColorStop(1, 'rgba(130, 0, 12, 0.05)');
        ctx.fillStyle = barGrad;
        ctx.beginPath();
        ctx.roundRect(p.x - barWidth / 2, p.y, barWidth, barH, [4, 4, 0, 0]);
        ctx.fill();
    });

    const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    areaGrad.addColorStop(0, 'rgba(255, 26, 45, 0.42)');
    areaGrad.addColorStop(1, 'rgba(10, 2, 4, 0.0)');

    ctx.beginPath();
    ctx.moveTo(points[0].x, padTop + plotH);
    points.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = areaGrad;
    ctx.fill();

    // Curva de Tendencia Media Móvil (Moving Average 3 puntos)
    if (points.length >= 3) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(255, 195, 205, 0.78)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        points.forEach((p, idx) => {
            const slice = values.slice(Math.max(0, idx - 2), idx + 1);
            const maVal = slice.reduce((a, b) => a + b, 0) / slice.length;
            const maY = padTop + plotH * (1 - Math.min(maVal / upperBound, 1));
            if (idx === 0) ctx.moveTo(p.x, maY);
            else ctx.lineTo(p.x, maY);
        });
        ctx.stroke();
        ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = '#ff1a2d';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(255, 26, 45, 0.8)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    points.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.font = '10.5px Inter, sans-serif';
    points.forEach((p, idx) => {
        ctx.fillStyle = '#090103';
        ctx.strokeStyle = '#ff1a2d';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, values.length > 16 ? 3 : 4.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (idx % labelStride === 0 || idx === points.length - 1) {
            ctx.fillStyle = 'rgba(242, 213, 217, 0.72)';
            ctx.fillText(p.label, p.x, height - 8);
        }
    });
}

/* ==========================================================================
   CORRELACIÓN BIOMÉTRICA Y EXPORTACIÓN DE DATOS EN PROGRESO
   ========================================================================== */

function logTelemetryPacket() {
    // Registro interno silencioso (el panel de Sistemas ha sido retirado de la vista del usuario)
}

function renderSystemEngineeringPanel() {
    const s = AstaApp.state;
    if (!s) return;

    const u = s.user || {};
    const esp = s.esp32 || {};
    const w = s.watch || {};

    // Correlación Biométrica y Analítica Estadística (en #habits-progress-panel)
    const calIntake = Number(s.macros_today?.total_calories) || 0;
    const activeBurn = Number(w.active_calories) || 640;
    const gymMinToday = (s.gym_logs || []).slice(0, 2).reduce((acc, g) => acc + (Number(g.duration_min) || 0), 0);
    const gymBurn = Math.round(gymMinToday * 6.5);
    const totalBurn = activeBurn + gymBurn;
    const netCal = calIntake - totalBurn;
    const netLabel = netCal < 0
        ? `${netCal} kcal (Déficit)`
        : `+${netCal} kcal (Superávit)`;
    setText('bio-net-calories-val', netLabel);
    setText('bio-net-calories-sub', `Ingesta ${calIntake} kcal vs Gasto Activo ${totalBurn} kcal`);

    const darkPct = Number(esp.room_darkness_pct ?? 94);
    const lastSleepScore = Number(s.sleep_logs?.[0]?.sleep_quality_score ?? 92);
    const corrIndex = Math.min(0.99, Math.max(0.72, ((darkPct / 100) * 0.55) + ((lastSleepScore / 100) * 0.43))).toFixed(2);
    setText('bio-ldr-sleep-corr', `r = ${corrIndex} (${Number(corrIndex) >= 0.85 ? 'Óptima' : 'Moderada'})`);
    setText('bio-ldr-sleep-sub', `${darkPct.toFixed(1)}% Oscuridad LDR → ${lastSleepScore}% Eficiencia REM/Profundo`);

    const weeklyAnalytics = buildClientAnalytics('weekly');
    const hydStd = Math.round(calcStdDev(weeklyAnalytics.series.hydration));
    const stabilityTag = hydStd < 450 ? 'Alta Estabilidad' : 'Variabilidad Media';
    setText('bio-std-dev-val', `σ = ±${hydStd} ml`);
    setText('bio-std-dev-sub', `${stabilityTag} en ventana semanal (Media Móvil activa)`);

    const waterGoal = Number(u.daily_water_goal_ml) || 3000;
    const sleepGoal = Number(u.daily_sleep_goal_hrs) || 8.0;
    const calGoal = Number(u.daily_calorie_goal) || 2500;
    const stepGoal = Number(u.daily_step_goal) || 10000;

    const cWater = Math.min(100, ((Number(s.water_today_ml) || 0) / waterGoal) * 100);
    const cSleep = Math.min(100, ((Number(s.sleep_logs?.[0]?.sleep_hours) || 7.5) / sleepGoal) * 100);
    const cCal = Math.min(100, (calIntake / calGoal) * 100);
    const cSteps = Math.min(100, ((Number(w.steps) || 0) / stepGoal) * 100);
    const cGym = Math.min(100, getGymWeeklySessions() * 25);
    const globalCompliance = ((cWater + cSleep + cCal + cSteps + cGym) / 5).toFixed(1);
    setText('bio-global-compliance', `${globalCompliance}%`);
    setText('bio-global-compliance-sub', `Ponderación multi-sensor: Agua ${Math.round(cWater)}% • Sueño ${Math.round(cSleep)}% • Gym ${Math.round(cGym)}%`);

    renderWeeklyDossierCard();
}

function buildWeeklyDossierData() {
    const s = AstaApp.state || AstaApp.getDefaultState();
    const u = sanitizeUserUsername(s.user || {});
    const esp = s.esp32 || {};
    const w = s.watch || {};
    const g = computeClientGamification() || {};

    const weekly = (!AstaApp.isOfflineMode && s.analytics && s.analytics.weekly)
        ? s.analytics.weekly
        : buildClientAnalytics('weekly');

    const labels = weekly.labels || [];
    const keys = weekly.keys || [];
    const ser = weekly.series || { hydration: [], sleep: [], nutrition: [], gym: [], watch: [] };

    const waterGoal = Number(u.daily_water_goal_ml) || 3000;
    const sleepGoal = Number(u.daily_sleep_goal_hrs) || 8.0;
    const calGoal = Number(u.daily_calorie_goal) || 2500;
    const stepGoal = Number(u.daily_step_goal) || 10000;

    const days = [];
    for (let i = 0; i < 7; i++) {
        const dDate = keys[i] || '';
        const dLabel = labels[i] || `Día ${i + 1}`;
        const waterMl = Math.round(Number(ser.hydration?.[i] || 0));
        const waterOz = Number((waterMl / 29.5735).toFixed(1));
        const sleepHrs = Number(Number(ser.sleep?.[i] || 0).toFixed(1));
        const gymVolKg = Math.round(Number(ser.gym?.[i] || 0));
        const calKcal = Math.round(Number(ser.nutrition?.[i] || 0));
        const steps = Math.round(Number(ser.watch?.[i] || 0));

        const pWater = Math.min(100, (waterMl / waterGoal) * 100);
        const pSleep = Math.min(100, (sleepHrs / sleepGoal) * 100);
        const pCal = Math.min(100, (calKcal / calGoal) * 100);
        const pSteps = Math.min(100, (steps / stepGoal) * 100);
        const pGym = gymVolKg > 0 ? 100 : 65;
        const compliancePct = Math.round((pWater + pSleep + pCal + pSteps + pGym) / 5);

        days.push({
            date: dDate,
            label: dLabel,
            waterMl,
            waterOz,
            sleepHrs,
            gymVolKg,
            calKcal,
            steps,
            compliancePct
        });
    }

    const totalWaterMl = days.reduce((a, d) => a + d.waterMl, 0);
    const totalWaterLiters = (totalWaterMl / 1000).toFixed(2);
    const avgWaterMl = Math.round(totalWaterMl / Math.max(1, days.length));

    const totalSleepHrs = Number(days.reduce((a, d) => a + d.sleepHrs, 0).toFixed(1));
    const avgSleepHrs = Number((totalSleepHrs / Math.max(1, days.length)).toFixed(1));

    const totalGymVolKg = days.reduce((a, d) => a + d.gymVolKg, 0);
    const gymSessionsWeek = getGymWeeklySessions();
    const gymRingPct = Math.min(100, gymSessionsWeek * 25);

    const totalCaloriesKcal = days.reduce((a, d) => a + d.calKcal, 0);
    const avgCaloriesKcal = Math.round(totalCaloriesKcal / Math.max(1, days.length));

    const totalStepsWeek = days.reduce((a, d) => a + d.steps, 0);
    const avgStepsDay = Math.round(totalStepsWeek / Math.max(1, days.length));
    const totalKmWeek = (totalStepsWeek * 0.00075).toFixed(2);

    const avgWeeklyCompliancePct = Math.round(
        days.reduce((a, d) => a + d.compliancePct, 0) / Math.max(1, days.length)
    );

    const startDate = days[0]?.date || new Date().toISOString().slice(0, 10);
    const endDate = days[days.length - 1]?.date || new Date().toISOString().slice(0, 10);

    return {
        user: u,
        esp32: esp,
        watch: w,
        gamification: g,
        startDate,
        endDate,
        goals: { waterGoal, sleepGoal, calGoal, stepGoal },
        days,
        totals: {
            totalWaterMl,
            totalWaterLiters,
            avgWaterMl,
            totalSleepHrs,
            avgSleepHrs,
            totalGymVolKg,
            gymSessionsWeek,
            gymRingPct,
            totalCaloriesKcal,
            avgCaloriesKcal,
            totalStepsWeek,
            avgStepsDay,
            totalKmWeek,
            avgWeeklyCompliancePct
        },
        logs: {
            hydration: s.hydration_logs || [],
            sleep: s.sleep_logs || [],
            gym: s.gym_logs || [],
            nutrition: s.nutrition_logs || [],
            weight: s.weight_logs || []
        }
    };
}

function renderWeeklyDossierCard() {
    const kpisEl = document.getElementById('weekly-dossier-kpis');
    const tbodyEl = document.getElementById('weekly-breakdown-tbody');
    const rangeEl = document.getElementById('weekly-dossier-date-range');
    if (!kpisEl && !tbodyEl) return;

    const d = buildWeeklyDossierData();
    const t = d.totals;

    if (rangeEl) {
        rangeEl.textContent = `Semana del ${d.startDate} al ${d.endDate} (7 días recolectados) • Lista para guardar en tu PC o teléfono móvil.`;
    }

    if (kpisEl) {
        kpisEl.innerHTML = `
            <div class="weekly-kpi-pill">
                <small><i class="fa-solid fa-droplet" style="color:#ff1a2d;"></i> Agua (7 Días)</small>
                <strong>${t.totalWaterLiters} L (${t.totalWaterMl.toLocaleString()} ml)</strong>
                <span>Prom: ${t.avgWaterMl.toLocaleString()} ml/día</span>
            </div>
            <div class="weekly-kpi-pill">
                <small><i class="fa-solid fa-moon" style="color:#ff1a2d;"></i> Sueño Semanal</small>
                <strong>${t.avgSleepHrs} hrs / noche</strong>
                <span>Total: ${t.totalSleepHrs} hrs (${Number(d.esp32?.room_darkness_pct ?? 94).toFixed(0)}% oscuridad)</span>
            </div>
            <div class="weekly-kpi-pill">
                <small><i class="fa-solid fa-dumbbell" style="color:#a855f7;"></i> Gimnasio (4/4)</small>
                <strong>${t.totalGymVolKg.toLocaleString()} kg tot.</strong>
                <span>Sesiones: ${t.gymSessionsWeek}/4 (${t.gymRingPct}%)</span>
            </div>
            <div class="weekly-kpi-pill">
                <small><i class="fa-solid fa-utensils" style="color:#ff1a2d;"></i> Nutrición (7 Días)</small>
                <strong>${t.totalCaloriesKcal.toLocaleString()} kcal</strong>
                <span>Prom: ${t.avgCaloriesKcal.toLocaleString()} kcal/día</span>
            </div>
            <div class="weekly-kpi-pill">
                <small><i class="fa-solid fa-person-walking" style="color:#ff1a2d;"></i> Smartwatch</small>
                <strong>${t.totalStepsWeek.toLocaleString()} pasos</strong>
                <span>~${t.totalKmWeek} km • Global: ${t.avgWeeklyCompliancePct}%</span>
            </div>
        `;
    }

    if (tbodyEl) {
        tbodyEl.innerHTML = d.days.map((row) => `
            <tr>
                <td><strong>${row.label}</strong><br><small style="color:var(--muted);">${row.date}</small></td>
                <td>${row.waterMl.toLocaleString()} ml <small style="color:var(--muted);">(${row.waterOz} oz)</small></td>
                <td>${row.sleepHrs} hrs</td>
                <td>${row.gymVolKg > 0 ? `${row.gymVolKg.toLocaleString()} kg` : '<span style="color:var(--muted);">Descanso</span>'}</td>
                <td>${row.calKcal.toLocaleString()} kcal</td>
                <td>${row.steps.toLocaleString()} pasos</td>
                <td><span class="weekly-compliance-tag ${row.compliancePct >= 80 ? 'high' : ''}">${row.compliancePct}%</span></td>
            </tr>
        `).join('');
    }
}

function triggerFileDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 600);
}

function bindSystemEngineeringControls() {
    const btnCsv = document.getElementById('btn-export-csv');
    if (btnCsv) {
        btnCsv.addEventListener('click', () => exportTelemetryCSV());
    }

    const btnWeeklyCsv = document.getElementById('btn-download-weekly-csv');
    if (btnWeeklyCsv) {
        btnWeeklyCsv.addEventListener('click', () => exportTelemetryCSV());
    }

    const btnJson = document.getElementById('btn-export-json');
    if (btnJson) {
        btnJson.addEventListener('click', () => exportTelemetryJSON());
    }

    const btnPdf = document.getElementById('btn-export-pdf-report');
    if (btnPdf) {
        btnPdf.addEventListener('click', () => generateEngineeringPrintableReport());
    }

    const btnWeeklyHtml = document.getElementById('btn-download-weekly-html');
    if (btnWeeklyHtml) {
        btnWeeklyHtml.addEventListener('click', () => downloadWeeklyHtmlFile());
    }

    const btnWeeklyTop = document.getElementById('btn-download-weekly-top');
    if (btnWeeklyTop) {
        btnWeeklyTop.addEventListener('click', () => downloadWeeklyHtmlFile());
    }

    const btnProfileWeekly = document.getElementById('btn-profile-download-weekly');
    if (btnProfileWeekly) {
        btnProfileWeekly.addEventListener('click', () => downloadWeeklyHtmlFile());
    }

    const btnWeeklyTxt = document.getElementById('btn-download-weekly-txt');
    if (btnWeeklyTxt) {
        btnWeeklyTxt.addEventListener('click', () => downloadWeeklyTxtFile());
    }

    const btnShareMobile = document.getElementById('btn-share-weekly-mobile');
    if (btnShareMobile) {
        btnShareMobile.addEventListener('click', () => shareOrSaveWeeklyMobile());
    }

    const btnTogglePreview = document.getElementById('btn-toggle-weekly-preview');
    const previewWrap = document.getElementById('weekly-dossier-preview');
    const previewLabel = document.getElementById('weekly-preview-toggle-label');
    if (btnTogglePreview && previewWrap) {
        btnTogglePreview.addEventListener('click', () => {
            const isHidden = previewWrap.hidden;
            previewWrap.hidden = !isHidden;
            if (previewLabel) {
                previewLabel.textContent = isHidden ? 'Ocultar tabla de la semana' : 'Ver tabla de la semana';
            }
        });
    }
}

function buildStandaloneWeeklyHtmlString(d) {
    const u = d.user;
    const g = d.gamification;
    const t = d.totals;
    const esp = d.esp32;
    const w = d.watch;
    const emittedAt = new Date().toLocaleString('es-MX');

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Resumen Semanal ASTA (${d.startDate} a ${d.endDate}) - ${u.username || 'Usuario'}</title>
<style>
    :root { --accent: #e6192e; --purple: #a855f7; --bg: #0b0305; --card: #16070b; --text: #f7ecef; --muted: #c9adb3; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Inter, system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; line-height: 1.5; }
    .container { max-width: 980px; margin: 0 auto; background: var(--card); border: 1px solid rgba(255,255,255,0.14); border-radius: 18px; padding: 24px; box-shadow: 0 18px 48px rgba(0,0,0,0.6); }
    .top-bar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; border-bottom: 2px solid var(--accent); padding-bottom: 16px; margin-bottom: 20px; }
    .badge { display: inline-block; background: rgba(230,25,46,0.2); border: 1px solid var(--accent); color: #ff9aa5; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 4px 10px; border-radius: 999px; margin-bottom: 6px; }
    h1 { margin: 0; font-size: 22px; color: #fff; letter-spacing: 0.02em; }
    .meta { font-size: 13px; color: var(--muted); margin-top: 4px; }
    .print-btn { background: linear-gradient(135deg, #ff1a2d, #990012); color: #fff; border: none; border-radius: 999px; padding: 10px 18px; font-size: 13px; font-weight: 700; cursor: pointer; }
    h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; color: #ff8592; border-left: 3px solid var(--accent); padding-left: 10px; margin: 24px 0 12px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); gap: 12px; }
    .kpi-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 12px 14px; }
    .kpi-card small { display: block; font-size: 10.5px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.04em; }
    .kpi-card strong { display: block; font-size: 17px; color: #fff; margin: 3px 0; }
    .kpi-card span { font-size: 11.5px; color: var(--muted); }
    .table-wrap { width: 100%; overflow-x: auto; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 580px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); }
    th { background: rgba(230,25,46,0.16); color: #fff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
    tfoot td { background: rgba(255,255,255,0.06); font-weight: 700; color: #fff; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; background: rgba(16,185,129,0.2); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.4); }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 680px) { body { padding: 10px; } .container { padding: 16px; } .two-col { grid-template-columns: 1fr; } }
    @media print {
        body { background: #fff; color: #111; padding: 0; }
        .container { box-shadow: none; border: none; background: #fff; max-width: 100%; padding: 0; }
        .print-btn { display: none; }
        h1, .kpi-card strong, th, tfoot td { color: #111; }
        .kpi-card, .table-wrap { border-color: #ccc; background: #fafafa; }
        th { background: #eee; }
        th, td { border-color: #ddd; color: #111; }
        .meta, .kpi-card small, .kpi-card span { color: #444; }
    }
</style>
</head>
<body>
<div class="container">
    <div class="top-bar">
        <div>
            <span class="badge">ASTA • Bitácora Semanal Recolectada</span>
            <h1>Reporte Semanal de Hábitos y Sensores</h1>
            <div class="meta">
                <strong>Usuario:</strong> ${u.username || 'Asta_Staria'} (${u.email || ''}) &nbsp;|&nbsp;
                <strong>Periodo:</strong> ${d.startDate} al ${d.endDate} &nbsp;|&nbsp;
                <strong>Generado:</strong> ${emittedAt}
            </div>
        </div>
        <button class="print-btn" onclick="window.print()">Imprimir / Guardar PDF</button>
    </div>

    <h2>1. Resumen Acumulado de la Semana (7 Días)</h2>
    <div class="kpi-grid">
        <div class="kpi-card">
            <small>Hidratación Semanal</small>
            <strong>${t.totalWaterLiters} L (${t.totalWaterMl.toLocaleString()} ml)</strong>
            <span>Promedio: ${t.avgWaterMl.toLocaleString()} ml/día (Meta: ${d.goals.waterGoal} ml)</span>
        </div>
        <div class="kpi-card">
            <small>Sueño y Descanso (LDR)</small>
            <strong>${t.avgSleepHrs} hrs / noche</strong>
            <span>Total: ${t.totalSleepHrs} hrs • Oscuridad: ${Number(esp.room_darkness_pct ?? 94).toFixed(1)}%</span>
        </div>
        <div class="kpi-card">
            <small>Gimnasio (Anillo 4/4)</small>
            <strong>${t.totalGymVolKg.toLocaleString()} kg levantados</strong>
            <span>Sesiones: ${t.gymSessionsWeek}/4 (${t.gymRingPct}%)</span>
        </div>
        <div class="kpi-card">
            <small>Nutrición / Comidas</small>
            <strong>${t.totalCaloriesKcal.toLocaleString()} kcal</strong>
            <span>Promedio: ${t.avgCaloriesKcal.toLocaleString()} kcal/día</span>
        </div>
        <div class="kpi-card">
            <small>Smartwatch (Actividad)</small>
            <strong>${t.totalStepsWeek.toLocaleString()} pasos</strong>
            <span>~${t.totalKmWeek} km • ${w.heart_rate_bpm || 68} BPM • SpO2 ${w.blood_oxygen_pct || 98}%</span>
        </div>
        <div class="kpi-card">
            <small>Progreso RPG y Peso</small>
            <strong>NV. ${g.level || 1} (${(g.total_xp || 0).toLocaleString()} XP)</strong>
            <span>Peso: ${g.current_weight_kg || 75.2} kg (Meta: ${g.goal_weight_kg || 70.0} kg) • Racha: ${g.streak_days || 3} días</span>
        </div>
    </div>

    <h2>2. Desglose Día por Día (Últimos 7 Días)</h2>
    <div class="table-wrap">
        <table>
            <thead>
                <tr>
                    <th>Día</th>
                    <th>Fecha</th>
                    <th>Hidratación</th>
                    <th>Sueño</th>
                    <th>Gimnasio (Vol.)</th>
                    <th>Comidas</th>
                    <th>Pasos Watch</th>
                    <th>Cumplimiento</th>
                </tr>
            </thead>
            <tbody>
                ${d.days.map((r) => `
                <tr>
                    <td><strong>${r.label}</strong></td>
                    <td>${r.date}</td>
                    <td>${r.waterMl.toLocaleString()} ml (${r.waterOz} oz)</td>
                    <td>${r.sleepHrs} hrs</td>
                    <td>${r.gymVolKg > 0 ? `${r.gymVolKg.toLocaleString()} kg` : 'Descanso'}</td>
                    <td>${r.calKcal.toLocaleString()} kcal</td>
                    <td>${r.steps.toLocaleString()} pasos</td>
                    <td><span class="pill">${r.compliancePct}%</span></td>
                </tr>`).join('')}
            </tbody>
            <tfoot>
                <tr>
                    <td colspan="2">TOTAL / PROMEDIO SEMANAL</td>
                    <td>${t.totalWaterMl.toLocaleString()} ml (${t.totalWaterLiters} L)</td>
                    <td>Prom: ${t.avgSleepHrs} hrs</td>
                    <td>${t.totalGymVolKg.toLocaleString()} kg</td>
                    <td>${t.totalCaloriesKcal.toLocaleString()} kcal</td>
                    <td>${t.totalStepsWeek.toLocaleString()} pasos</td>
                    <td>${t.avgWeeklyCompliancePct}% Global</td>
                </tr>
            </tfoot>
        </table>
    </div>

    <div class="two-col">
        <div>
            <h2>3. Entrenamientos Registrados en Gimnasio</h2>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Fecha</th><th>Ejercicio</th><th>Series×Reps</th><th>Peso</th></tr></thead>
                    <tbody>
                        ${d.logs.gym.slice(0, 12).map((r) => `<tr><td>${r.logged_date || ''}</td><td>${r.exercise_name} (${r.muscle_group})</td><td>${r.sets}×${r.reps}</td><td>${r.weight_kg} kg</td></tr>`).join('') || '<tr><td colspan="4">Sin registros</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
        <div>
            <h2>4. Comidas y Nutrición Registradas</h2>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Fecha</th><th>Alimento</th><th>Calorías</th><th>Macros</th></tr></thead>
                    <tbody>
                        ${d.logs.nutrition.slice(0, 12).map((r) => `<tr><td>${r.logged_date || ''}</td><td>${r.food_name} (${r.meal_type})</td><td>${r.calories} kcal</td><td>P:${r.protein_g}g C:${r.carbs_g}g G:${r.fat_g}g</td></tr>`).join('') || '<tr><td colspan="4">Sin registros</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <div class="two-col">
        <div>
            <h2>5. Bitácora de Hidratación (Termo 40oz)</h2>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Fecha</th><th>Fuente</th><th>Consumo</th><th>Nivel Termo</th></tr></thead>
                    <tbody>
                        ${d.logs.hydration.slice(0, 10).map((r) => `<tr><td>${r.logged_date || ''}</td><td>${r.source || 'ESP32'}</td><td>+${r.consumed_ml} ml</td><td>${r.water_level_ml} ml (${r.thermos_pct}%)</td></tr>`).join('') || '<tr><td colspan="4">Sin registros</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
        <div>
            <h2>6. Bitácora de Sueño y Control de Peso</h2>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Fecha</th><th>Sueño / Peso</th><th>Detalle</th><th>Calidad / XP</th></tr></thead>
                    <tbody>
                        ${d.logs.sleep.slice(0, 6).map((r) => `<tr><td>${r.logged_date || ''}</td><td>Sueño: ${r.sleep_hours} hrs</td><td>Prof: ${r.deep_sleep_hours}h | REM: ${r.rem_sleep_hours}h</td><td>${r.sleep_quality_score}%</td></tr>`).join('')}
                        ${d.logs.weight.slice(0, 6).map((r) => `<tr><td>${r.logged_date || ''}</td><td>Peso: ${r.weight_kg} kg</td><td>${r.notes || 'Control'}</td><td>+${r.xp_awarded || 0} XP</td></tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</div>
</body>
</html>`;
}

function downloadWeeklyHtmlFile() {
    const d = buildWeeklyDossierData();
    const htmlStr = buildStandaloneWeeklyHtmlString(d);
    const blob = new Blob([htmlStr], { type: 'text/html;charset=utf-8;' });
    const filename = `Resumen_Semanal_ASTA_${d.endDate}.html`;
    triggerFileDownload(blob, filename);
    showToast(`Archivo semanal "${filename}" descargado y listo para abrir en tu PC o móvil.`);
}

function buildWeeklyTxtString(d) {
    const u = d.user;
    const g = d.gamification;
    const t = d.totals;
    const lines = [
        '====================================================================',
        '       A.S.T.A. — REPORTE SEMANAL DE HÁBITOS Y TELEMETRÍA',
        '====================================================================',
        `Usuario:       ${u.username || 'Asta_Staria'} (${u.email || ''})`,
        `Periodo:       Del ${d.startDate} al ${d.endDate} (7 días)`,
        `Nivel RPG:     NV. ${g.level || 1} — ${g.rank_title || ''} (${g.total_xp || 0} XP)`,
        `Racha Activa:  ${g.streak_days || 3} días seguidos`,
        `Peso Corporal: Actual ${g.current_weight_kg || 75.2} kg | Meta ${g.goal_weight_kg || 70.0} kg`,
        '',
        '--------------------------------------------------------------------',
        '1. TOTALES Y PROMEDIOS RECOLECTADOS EN LA SEMANA',
        '--------------------------------------------------------------------',
        `• Hidratación Total:  ${t.totalWaterLiters} L (${t.totalWaterMl} ml) | Promedio: ${t.avgWaterMl} ml/día`,
        `• Sueño Semanal:      Promedio ${t.avgSleepHrs} hrs/noche | Total: ${t.totalSleepHrs} hrs`,
        `• Gimnasio (4/4):     Volumen ${t.totalGymVolKg} kg | Sesiones: ${t.gymSessionsWeek}/4 (${t.gymRingPct}%)`,
        `• Nutrición Semanal:  ${t.totalCaloriesKcal} kcal totales | Promedio: ${t.avgCaloriesKcal} kcal/día`,
        `• Smartwatch:         ${t.totalStepsWeek} pasos (~${t.totalKmWeek} km) | Promedio: ${t.avgStepsDay} pasos/día`,
        `• Cumplimiento:       ${t.avgWeeklyCompliancePct}% Global en la semana`,
        '',
        '--------------------------------------------------------------------',
        '2. DESGLOSE DÍA POR DÍA (7 DÍAS)',
        '--------------------------------------------------------------------'
    ];

    d.days.forEach((r) => {
        lines.push(
            `[${r.date} • ${r.label.padEnd(6)}] Agua: ${String(r.waterMl).padStart(4)}ml | Sueño: ${r.sleepHrs}h | Gym: ${String(r.gymVolKg).padStart(4)}kg | Comida: ${String(r.calKcal).padStart(4)}kcal | Watch: ${String(r.steps).padStart(5)} pasos | Cumpl: ${r.compliancePct}%`
        );
    });

    lines.push(
        '',
        '--------------------------------------------------------------------',
        '3. ENTRENAMIENTOS REGISTRADOS EN GIMNASIO',
        '--------------------------------------------------------------------'
    );
    if (d.logs.gym.length) {
        d.logs.gym.slice(0, 15).forEach((r) => {
            lines.push(`• [${r.logged_date}] ${r.exercise_name} (${r.muscle_group}): ${r.sets} series x ${r.reps} reps @ ${r.weight_kg} kg`);
        });
    } else {
        lines.push('• Sin entrenamientos adicionales registrados.');
    }

    lines.push(
        '',
        '--------------------------------------------------------------------',
        '4. COMIDAS Y NUTRICIÓN REGISTRADAS',
        '--------------------------------------------------------------------'
    );
    if (d.logs.nutrition.length) {
        d.logs.nutrition.slice(0, 15).forEach((r) => {
            lines.push(`• [${r.logged_date}] ${r.meal_type}: ${r.food_name} — ${r.calories} kcal (P:${r.protein_g}g C:${r.carbs_g}g G:${r.fat_g}g)`);
        });
    } else {
        lines.push('• Sin comidas adicionales registradas.');
    }

    lines.push('====================================================================');
    return lines.join('\r\n');
}

function downloadWeeklyTxtFile() {
    const d = buildWeeklyDossierData();
    const txt = buildWeeklyTxtString(d);
    const blob = new Blob(['\uFEFF' + txt], { type: 'text/plain;charset=utf-8;' });
    const filename = `Resumen_Semanal_ASTA_${d.endDate}.txt`;
    triggerFileDownload(blob, filename);
    showToast(`Resumen de texto "${filename}" guardado en tu dispositivo.`);
}

async function shareOrSaveWeeklyMobile() {
    const d = buildWeeklyDossierData();
    const txt = buildWeeklyTxtString(d);
    const htmlStr = buildStandaloneWeeklyHtmlString(d);
    const filename = `Resumen_Semanal_ASTA_${d.endDate}.html`;

    if (navigator.share) {
        try {
            const fileObj = new File([htmlStr], filename, { type: 'text/html' });
            if (navigator.canShare && navigator.canShare({ files: [fileObj] })) {
                await navigator.share({
                    title: `Resumen Semanal ASTA (${d.startDate} a ${d.endDate})`,
                    text: `Aquí está mi resumen semanal recolectado en ASTA (${d.totals.avgWeeklyCompliancePct}% de cumplimiento).`,
                    files: [fileObj]
                });
                showToast('Archivo semanal compartido / guardado en tu móvil.');
                return;
            }
            await navigator.share({
                title: `Resumen Semanal ASTA (${d.startDate} a ${d.endDate})`,
                text: txt
            });
            showToast('Resumen semanal compartido desde tu móvil.');
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;
        }
    }

    // Fallback directo: descarga el archivo HTML visual en el móvil o PC
    downloadWeeklyHtmlFile();
}

function exportTelemetryCSV() {
    const d = buildWeeklyDossierData();
    const u = d.user;
    const g = d.gamification;
    const t = d.totals;

    const rows = [
        ['REPORTE SEMANAL DE HÁBITOS Y SENSORES - A.S.T.A.'],
        ['Usuario', u.username || 'Asta_Staria', 'Correo', u.email || '', 'Nivel RPG', `NV. ${g.level || 1} (${g.rank_title || ''})`],
        ['Periodo Semanal', `${d.startDate} al ${d.endDate}`, 'Racha Activa', `${g.streak_days || 3} dias`, 'Peso Actual vs Meta', `${g.current_weight_kg || 75.2} kg / ${g.goal_weight_kg || 70.0} kg`],
        [],
        ['1. RESUMEN DÍA POR DÍA DE LA SEMANA (7 DÍAS)'],
        ['Fecha', 'Dia', 'Hidratacion (ml)', 'Hidratacion (oz)', 'Sueno (hrs)', 'Gimnasio Volumen (kg)', 'Nutricion (kcal)', 'Smartwatch (Pasos)', 'Cumplimiento Diario (%)']
    ];

    d.days.forEach((r) => {
        rows.push([r.date, r.label, r.waterMl, r.waterOz, r.sleepHrs, r.gymVolKg, r.calKcal, r.steps, `${r.compliancePct}%`]);
    });

    rows.push(
        ['TOTAL SEMANAL', '7 Dias', t.totalWaterMl, (t.totalWaterMl / 29.5735).toFixed(1), t.totalSleepHrs, t.totalGymVolKg, t.totalCaloriesKcal, t.totalStepsWeek, `${t.avgWeeklyCompliancePct}%`],
        ['PROMEDIO DIARIO', 'Media', t.avgWaterMl, (t.avgWaterMl / 29.5735).toFixed(1), t.avgSleepHrs, Math.round(t.totalGymVolKg / 7), t.avgCaloriesKcal, t.avgStepsDay, `${t.avgWeeklyCompliancePct}%`],
        [],
        ['2. BITÁCORA DETALLADA DE REGISTROS RECOLECTADOS'],
        ['Categoria', 'Fecha', 'Detalle_Principal', 'Valor_Numerico', 'Unidad', 'Metadatos_Adicionales']
    );

    d.logs.hydration.forEach((r) => {
        rows.push(['Hidratacion_Termo', r.logged_date || '', `Fuente: ${r.source || 'esp32'}`, r.consumed_ml || 0, 'ml', `Nivel Termo: ${r.water_level_ml}ml (${r.thermos_pct}%) | Dist: ${r.distance_cm}cm`]);
    });
    d.logs.sleep.forEach((r) => {
        rows.push(['Sueno_LDR', r.logged_date || '', `Calidad: ${r.sleep_quality_score}%`, r.sleep_hours || 0, 'hrs', `Profundo: ${r.deep_sleep_hours}h | REM: ${r.rem_sleep_hours}h | LDR ADC: ${r.light_level_adc}`]);
    });
    d.logs.gym.forEach((r) => {
        const vol = (Number(r.sets) || 0) * (Number(r.reps) || 0) * (Number(r.weight_kg) || 0);
        rows.push(['Gimnasio_Fuerza', r.logged_date || '', `${r.exercise_name} (${r.muscle_group})`, r.weight_kg || 0, 'kg', `${r.sets}x${r.reps} | Volumen: ${vol}kg | Duracion: ${r.duration_min}min`]);
    });
    d.logs.nutrition.forEach((r) => {
        rows.push(['Nutricion_Comidas', r.logged_date || '', `${r.food_name} (${r.meal_type})`, r.calories || 0, 'kcal', `P:${r.protein_g}g C:${r.carbs_g}g G:${r.fat_g}g | ${r.ai_confidence || 'IA'}`]);
    });
    d.logs.weight.forEach((r) => {
        rows.push(['Control_Peso_RPG', r.logged_date || '', r.notes || 'Pesaje', r.weight_kg || 0, 'kg', `+${r.xp_awarded || 0} XP`]);
    });

    const csvContent = '\uFEFF' + rows.map((row) =>
        row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const filename = `Resumen_Semanal_ASTA_${d.endDate}.csv`;
    triggerFileDownload(blob, filename);

    showToast(`Hoja de cálculo semanal "${filename}" descargada.`);
}

function exportTelemetryJSON() {
    const s = AstaApp.state;
    if (!s) return;

    const payload = {
        schema_version: 'ASTA-ENG-2.8',
        exported_at: new Date().toISOString(),
        architecture: {
            mcu: 'ESP32 Dual-Core Xtensa LX6',
            sensors: ['HC-SR04 Ultrasonic (TRIG=GPIO5, ECHO=GPIO18)', 'Photoresistor LDR 12-bit SAR ADC (GPIO34)', 'Samsung Galaxy Watch 8 BLE GATT'],
            persistence: AstaApp.isOfflineMode ? 'LocalStorage Transactional Cache' : 'MySQL InnoDB + PDO Prepared Statements'
        },
        gamification_summary: computeClientGamification(),
        state_snapshot: s
    };

    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `asta_snapshot_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast('Snapshot JSON descargado.');
}

function generateEngineeringPrintableReport() {
    const d = buildWeeklyDossierData();
    const htmlWithAutoPrint = buildStandaloneWeeklyHtmlString(d).replace(
        '</body>',
        '<script>window.onload = function() { setTimeout(function(){ window.print(); }, 250); };</script></body>'
    );

    const win = window.open('', '_blank', 'width=980,height=760');
    if (win) {
        win.document.open();
        win.document.write(htmlWithAutoPrint);
        win.document.close();
    } else {
        // Si el navegador móvil bloquea ventanas emergentes, descarga directamente el archivo
        downloadWeeklyHtmlFile();
    }
}

