/**
 * ASTA - auth.js
 * Control de la Tarjeta de Acceso Glassy:
 * Registro obligatorio de cuenta e Inicio de Sesión verificado para guardar el progreso.
 */

let switchAuthTabGlobal = null;

document.addEventListener('DOMContentLoaded', () => {
    const tabBtns = document.querySelectorAll('.auth-tab-btn');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const btnSwitchMode = document.getElementById('btn-switch-auth-mode');
    const noticeText = document.getElementById('auth-notice-text');

    // 1. Verificar si ya existe una sesión autenticada activa en el servidor
    checkActiveSession();

    // 2. Alternar entre Iniciar Sesión y Crear Cuenta con transición suave
    let currentTab = 'login';

    function switchAuthTab(target) {
        if (!target || target === currentTab) return;
        currentTab = target;

        tabBtns.forEach((b) => {
            const isActive = b.getAttribute('data-tab') === target;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        if (target === 'login') {
            loginForm?.classList.add('active');
            registerForm?.classList.remove('active');
            if (noticeText) {
                noticeText.textContent = '¿Es tu primera vez aquí? Es obligatorio contar con una cuenta registrada.';
            }
            if (btnSwitchMode) {
                btnSwitchMode.textContent = 'Crear una cuenta nueva →';
            }
        } else {
            registerForm?.classList.add('active');
            loginForm?.classList.remove('active');
            if (noticeText) {
                noticeText.textContent = '¿Ya creaste tu cuenta anteriormente?';
            }
            if (btnSwitchMode) {
                btnSwitchMode.textContent = '← Volver a Iniciar Sesión';
            }
        }
    }

    switchAuthTabGlobal = switchAuthTab;

    tabBtns.forEach((btn) => {
        btn.addEventListener('click', () => switchAuthTab(btn.getAttribute('data-tab')));
    });

    if (btnSwitchMode) {
        btnSwitchMode.addEventListener('click', () => {
            switchAuthTab(currentTab === 'login' ? 'register' : 'login');
        });
    }

    // 3. Envío de formulario de Inicio de Sesión (requiere cuenta previamente creada)
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const identifier = document.getElementById('login-identifier').value.trim();
            const password = document.getElementById('login-password').value;

            if (!identifier || !password) {
                showToast('Ingresa tu usuario o correo electrónico y tu contraseña.');
                return;
            }

            const submitBtn = document.getElementById('btn-login-submit');
            if (submitBtn) submitBtn.disabled = true;

            await performLogin(identifier, password);

            if (submitBtn) submitBtn.disabled = false;
        });
    }

    // 4. Envío de formulario de Creación de Cuenta Obligatoria
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('reg-username').value.trim();
            const email = document.getElementById('reg-email').value.trim();
            const password = document.getElementById('reg-password').value;

            if (username.includes('@')) {
                showToast('El nombre de usuario no debe contener "@". Usa un alias o nombre.');
                document.getElementById('reg-username')?.focus();
                return;
            }
            if (username.length < 3) {
                showToast('El nombre de usuario debe tener al menos 3 caracteres.');
                document.getElementById('reg-username')?.focus();
                return;
            }
            if (!email.includes('@') || !email.includes('.')) {
                showToast('Ingresa un correo electrónico válido.');
                document.getElementById('reg-email')?.focus();
                return;
            }
            if (password.length < 6) {
                showToast('La contraseña debe tener al menos 6 caracteres.');
                document.getElementById('reg-password')?.focus();
                return;
            }

            const submitBtn = document.getElementById('btn-register-submit');
            if (submitBtn) submitBtn.disabled = true;

            await performRegister(username, email, password);

            if (submitBtn) submitBtn.disabled = false;
        });
    }
});

/**
 * Envía petición POST al backend compatible con Laragon y AwardSpace (JSON + fallback FormData contra bloqueos 403 WAF)
 */
async function postAuthRequest(action, payloadObj) {
    const url = `../php/auth_api.php?action=${encodeURIComponent(action)}`;
    const bodyWithAction = { action, ...payloadObj };

    // Intento 1: Petición estándar con FormData / URLSearchParams (evita bloqueos 403 de ModSecurity en AwardSpace)
    const formParams = new URLSearchParams();
    Object.keys(bodyWithAction).forEach((k) => {
        if (bodyWithAction[k] !== undefined && bodyWithAction[k] !== null) {
            formParams.append(k, String(bodyWithAction[k]));
        }
    });

    const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json'
        },
        body: formParams.toString()
    });

    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (_) {
        data = null;
    }

    return { ok: res.ok, status: res.status, data };
}

function getLocalRegisteredAccounts() {
    try {
        const raw = localStorage.getItem('asta_registered_accounts');
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((a) => a && a.user && a.user.username && a.user.email) : [];
    } catch (_) {
        return [];
    }
}

function saveLocalRegisteredAccount(userObj, rawPassword) {
    if (!userObj || !userObj.username || !userObj.email) return;
    try {
        const targetUser = String(userObj.username).toLowerCase();
        const targetEmail = String(userObj.email).toLowerCase();
        const accounts = getLocalRegisteredAccounts().filter((a) => {
            const uName = String(a?.user?.username || a?.username || '').toLowerCase();
            const uMail = String(a?.user?.email || a?.email || '').toLowerCase();
            return uName !== targetUser && uMail !== targetEmail;
        });
        accounts.push({
            user: userObj,
            password_plain_check: btoa(unescape(encodeURIComponent(rawPassword || '')))
        });
        localStorage.setItem('asta_registered_accounts', JSON.stringify(accounts));
    } catch (_) {}
}

function persistUserLocally(userObj, isNewRegistration = false) {
    if (!userObj) return;
    if (userObj.username && String(userObj.username).includes('@')) {
        userObj.username = String(userObj.username).split('@')[0].replace(/[^A-Za-z0-9_áéíóúÁÉÍÓÚñÑ]/g, '_') || 'Caballero_Asta';
    }
    userObj.is_authenticated = true;

    // Si es una cuenta recién creada o un usuario distinto al anterior en este navegador, limpiar cachés previos para no mezclar rutinas ni datos
    try {
        const prevActive = JSON.parse(localStorage.getItem('asta_active_user') || 'null');
        const isDifferentUser = !prevActive
            || String(prevActive.id || '') !== String(userObj.id || '')
            || String(prevActive.username || '').toLowerCase() !== String(userObj.username || '').toLowerCase();

        if (isNewRegistration || isDifferentUser) {
            localStorage.removeItem('asta_cached_dashboard');
            localStorage.removeItem('asta_saved_profile');
            localStorage.removeItem('asta_gym_weekly_sessions');
            localStorage.removeItem('asta_gym_split_state_v2');
        }
    } catch (_) {}

    if (isNewRegistration) {
        const userKey = String(userObj.id || userObj.username || 'new').toLowerCase();
        localStorage.setItem(`asta_new_account_guide_${userKey}`, 'pending');
        localStorage.removeItem(`asta_gym_weekly_sessions_${userKey}`);
        localStorage.removeItem(`asta_gym_split_state_v2_${userKey}`);
    }

    localStorage.setItem('asta_active_user', JSON.stringify(userObj));
    localStorage.setItem('asta_saved_profile', JSON.stringify(userObj));
}

async function checkActiveSession() {
    try {
        const res = await fetch('../php/auth_api.php?action=session', {
            credentials: 'same-origin'
        });
        if (res.ok) {
            const data = await res.json();
            if (data.status === 'authenticated' && data.user) {
                persistUserLocally(data.user, false);
                window.location.href = 'dashboard.html';
            }
        }
    } catch (_) {}
}

function isLocalDevEnvironment() {
    const h = (window.location.hostname || '').toLowerCase();
    return window.location.protocol === 'file:'
        || h === 'localhost'
        || h === '127.0.0.1'
        || h === 'asta.test'
        || h.startsWith('192.168.');
}

async function performRegister(username, email, password) {
    try {
        const { ok, status, data } = await postAuthRequest('register', {
            username,
            email,
            password
        });

        if (ok && data && data.status === 'success' && data.user) {
            saveLocalRegisteredAccount(data.user, password);
            persistUserLocally(data.user, true);
            showToast(data.message || `¡Cuenta creada en Nivel 0! Bienvenido, ${data.user.username}.`);
            setTimeout(() => {
                window.location.href = 'dashboard.html';
            }, 450);
            return;
        }

        if (data && data.message) {
            showToast(data.message);
            if (status === 409 && typeof switchAuthTabGlobal === 'function') {
                switchAuthTabGlobal('login');
            }
            if (!isLocalDevEnvironment() || !data.db_down) {
                return;
            }
        } else if (!isLocalDevEnvironment()) {
            showToast(`No se pudo guardar la cuenta en el servidor (HTTP ${status}). Verifica la conexión a la base de datos.`);
            return;
        }
    } catch (err) {
        if (!isLocalDevEnvironment()) {
            showToast('Error de red al conectar con el servidor de base de datos.');
            return;
        }
    }

    // Respaldo local únicamente para desarrollo local en PC cuando MySQL está apagado
    const accounts = getLocalRegisteredAccounts();
    const duplicate = accounts.find(
        (a) => a.user.username.toLowerCase() === username.toLowerCase()
            || a.user.email.toLowerCase() === email.toLowerCase()
    );
    if (duplicate) {
        showToast('Ese nombre de usuario o correo ya tiene una cuenta registrada. Inicia sesión.');
        if (typeof switchAuthTabGlobal === 'function') switchAuthTabGlobal('login');
        return;
    }

    const randHex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('').toUpperCase();
    const newUser = {
        id: Date.now(),
        username,
        email,
        avatar_data: null,
        magic_squad: 'Toros Negros (Black Bulls)',
        magic_rank: 'Novato • Nivel 0',
        api_token: `ASTA-${randHex}`,
        thermos_capacity_ml: 1183,
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
        bonus_xp: 0,
        is_new_account: true
    };

    saveLocalRegisteredAccount(newUser, password);
    persistUserLocally(newUser, true);
    showToast(`¡Cuenta creada en Nivel 0! Bienvenido, ${username}.`);
    setTimeout(() => {
        window.location.href = 'dashboard.html';
    }, 450);
}

async function performLogin(identifier, password) {
    try {
        const { ok, status, data } = await postAuthRequest('login', {
            identifier,
            password
        });

        if (ok && data && data.status === 'success' && data.user) {
            saveLocalRegisteredAccount(data.user, password);
            persistUserLocally(data.user);
            showToast(data.message || `Sesión iniciada. Bienvenido, ${data.user.username}.`);
            setTimeout(() => {
                window.location.href = 'dashboard.html';
            }, 450);
            return;
        }

        if (data && data.message) {
            showToast(data.message);
            if (!isLocalDevEnvironment() || !data.db_down) {
                return;
            }
        } else if (!isLocalDevEnvironment()) {
            showToast(`No se pudo verificar la cuenta en el servidor (HTTP ${status}).`);
            return;
        }
    } catch (_) {
        if (!isLocalDevEnvironment()) {
            showToast('Error de red al conectar con el servidor.');
            return;
        }
    }

    // Verificación estricta contra cuentas registradas localmente cuando MySQL está offline
    const accounts = getLocalRegisteredAccounts();
    const encodedPwd = btoa(unescape(encodeURIComponent(password)));
    const matched = accounts.find(
        (a) => (a.user.username.toLowerCase() === identifier.toLowerCase()
            || a.user.email.toLowerCase() === identifier.toLowerCase())
            && a.password_plain_check === encodedPwd
    );

    if (!matched) {
        const existsUser = accounts.some(
            (a) => a.user.username.toLowerCase() === identifier.toLowerCase()
                || a.user.email.toLowerCase() === identifier.toLowerCase()
        );
        if (!existsUser) {
            showToast('No existe una cuenta con ese usuario o correo. Es obligatorio crear una cuenta primero.');
            if (typeof switchAuthTabGlobal === 'function') {
                switchAuthTabGlobal('register');
            }
        } else {
            showToast('Contraseña incorrecta. Verifica tus credenciales.');
        }
        return;
    }

    persistUserLocally(matched.user);
    showToast(`Sesión iniciada. Bienvenido, ${matched.user.username}.`);
    setTimeout(() => {
        window.location.href = 'dashboard.html';
    }, 450);
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
    toast.innerHTML = `<i class="fa-solid fa-bolt" style="color:#ff1a2d;"></i><div>${message}</div>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3600);
}
