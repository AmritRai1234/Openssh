// ── Config ────────────────────────────────────────────────────────
const cfg = {
    async get() { return (await window.openssh.getConfig()) || {}; },
    async set(data) { return window.openssh.setConfig(data); },
};

// ── Screen routing ─────────────────────────────────────────────────
const screens = {
    setup: document.getElementById('screen-setup'),
    dashboard: document.getElementById('screen-dashboard'),
    terminal: document.getElementById('screen-terminal'),
};

let currentScreen = null;
function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
    currentScreen = name;
}

// ── Boot ───────────────────────────────────────────────────────────
(async () => {
    const config = await cfg.get();
    if (config.relayUrl && config.token) {
        startDashboard(config.relayUrl, config.token);
    } else {
        showScreen('setup');
    }
})();

// ════════════════════════════════════════════════════════════════════
// SETUP SCREEN
// ════════════════════════════════════════════════════════════════════
document.getElementById('setup-save').addEventListener('click', async () => {
    const relayUrl = document.getElementById('setup-url').value.trim().replace(/\/$/, '');
    const token = document.getElementById('setup-token').value.trim();
    const err = document.getElementById('setup-error');
    err.textContent = '';

    if (!relayUrl || !token) { err.textContent = 'Both fields are required.'; return; }

    try {
        const r = await fetch(`${relayUrl}/api/status`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`Relay returned ${r.status}`);
        await cfg.set({ relayUrl, token });
        startDashboard(relayUrl, token);
    } catch (e) {
        err.textContent = `Connection failed: ${e.message}`;
    }
});

// ════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════
let dashWs = null;
let relayUrl = '', relayToken = '';

function startDashboard(url, token) {
    relayUrl = url;
    relayToken = token;
    showScreen('dashboard');
    loadHosts();
    connectDashWs();
}

document.getElementById('dash-settings').addEventListener('click', () => {
    if (dashWs) { dashWs.close(); dashWs = null; }
    showScreen('setup');
});
document.getElementById('dash-gift').addEventListener('click', () => {
    require('electron').shell?.openExternal('https://ko-fi.com');
});
document.getElementById('dash-pair').addEventListener('click', showQrModal);
document.getElementById('qr-close').addEventListener('click', () => {
    document.getElementById('qr-modal').classList.add('hidden');
});

async function showQrModal() {
    const modal = document.getElementById('qr-modal');
    const loading = document.getElementById('qr-loading');
    const img = document.getElementById('qr-img');
    const details = document.getElementById('qr-details');

    // Reset state
    loading.classList.remove('hidden');
    loading.textContent = 'Generating QR...';
    img.classList.add('hidden');
    details.classList.add('hidden');
    modal.classList.remove('hidden');

    try {
        // Generate QR directly from saved config — no relay API call needed
        const QRCode = require('qrcode');
        const payload = `russh-api://url=${relayUrl}&token=${relayToken}`;
        const dataUrl = await QRCode.toDataURL(payload, {
            width: 280,
            margin: 2,
            color: { dark: '#1C1C1E', light: '#FFFFFF' },
        });
        img.src = dataUrl;
        document.getElementById('qr-url').textContent = relayUrl;
        document.getElementById('qr-token').textContent = relayToken;
        loading.classList.add('hidden');
        img.classList.remove('hidden');
        details.classList.remove('hidden');
    } catch (e) {
        loading.textContent = `Error: ${e.message}`;
    }
}

async function loadHosts() {
    try {
        const r = await fetch(`${relayUrl}/api/hosts`, {
            headers: { Authorization: `Bearer ${relayToken}` },
        });
        const hosts = await r.json();
        renderHosts(hosts);
    } catch {
        renderHosts([]);
    }
}

function renderHosts(hosts) {
    const list = document.getElementById('host-list');
    const empty = document.getElementById('empty-state');
    const count = document.getElementById('host-count');
    count.textContent = `${hosts.length} online`;

    if (hosts.length === 0) {
        list.innerHTML = '';
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    list.innerHTML = hosts.map(h => `
        <div class="host-card" data-id="${h.id}">
            <div class="host-online-dot"></div>
            <div class="host-info">
                <div class="host-name">${h.id}</div>
                <div class="host-meta">${h.relay_addr} · ${formatAge(h.connected_at)}</div>
            </div>
            <div class="host-chevron">›</div>
        </div>
    `).join('');

    document.querySelectorAll('.host-card').forEach(card => {
        card.addEventListener('click', () => {
            const host = hosts.find(h => h.id === card.dataset.id);
            if (host) openTerminal(host);
        });
    });
}

function connectDashWs() {
    if (dashWs) dashWs.close();
    const wsUrl = `${relayUrl.replace(/^http/, 'ws')}/api/events?token=${encodeURIComponent(relayToken)}`;
    dashWs = new WebSocket(wsUrl);
    dashWs.onopen = () => setRelay(true);
    dashWs.onmessage = () => loadHosts();
    dashWs.onclose = () => { setRelay(false); setTimeout(connectDashWs, 3000); };
}

function setRelay(online) {
    document.getElementById('relay-dot').style.background = online ? '#34C759' : '#FF9500';
    document.getElementById('relay-label').textContent = online ? 'Live' : 'Reconnecting...';
}

function formatAge(unix) {
    const diff = Math.floor(Date.now() / 1000 - unix);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
}

// ════════════════════════════════════════════════════════════════════
// TERMINAL
// ════════════════════════════════════════════════════════════════════
let term = null;
let fitAddon = null;
let termWs = null;
let termAutoReconnect = false;
let currentHost = null;

function openTerminal(host) {
    currentHost = host;
    document.getElementById('term-host-name').textContent = host.id;
    showScreen('terminal');

    // Init xterm.js
    if (term) { term.dispose(); }
    term = new Terminal({
        fontFamily: '"Fira Code", "Cascadia Code", "SF Mono", Menlo, monospace',
        fontSize: 14,
        lineHeight: 1.4,
        theme: {
            background: '#1C1C1E',
            foreground: '#E5E5EA',
            cursor: '#5865F2',
            cursorAccent: '#1C1C1E',
            selectionBackground: 'rgba(88, 101, 242, 0.3)',
        },
        cursorBlink: true,
        allowProposedApi: true,
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    window.addEventListener('resize', () => fitAddon?.fit());

    // Send keystrokes to relay
    term.onData(data => {
        if (termWs?.readyState === WebSocket.OPEN) termWs.send(data);
    });

    connectTermWs();
}

function connectTermWs() {
    if (termWs) termWs.close();
    termAutoReconnect = true;
    const wsUrl = `${relayUrl.replace(/^http/, 'ws')}/api/terminal/${currentHost.id}?token=${encodeURIComponent(relayToken)}`;
    termWs = new WebSocket(wsUrl);
    setTermStatus('connecting');

    termWs.onopen = () => {
        setTermStatus('connected');
        term?.writeln('\x1b[90m── Connected ──\x1b[0m');
    };
    termWs.onmessage = (e) => {
        if (typeof e.data === 'string') term?.write(e.data);
        else e.data.text().then(t => term?.write(t));
    };
    termWs.onerror = () => term?.writeln('\x1b[90mConnection error — retrying...\x1b[0m');
    termWs.onclose = (e) => {
        setTermStatus('disconnected');
        term?.writeln(`\x1b[90m── Disconnected${e.reason ? `: ${e.reason}` : ''} ──\x1b[0m`);
        if (termAutoReconnect) {
            term?.writeln('\x1b[90mReconnecting in 3s...\x1b[0m');
            setTimeout(() => { if (termAutoReconnect) connectTermWs(); }, 3000);
        }
    };
}

function setTermStatus(status) {
    const dot = document.getElementById('term-dot');
    const reconnect = document.getElementById('term-reconnect');
    const colors = { connected: '#34C759', connecting: '#FF9500', disconnected: '#FF3B30' };
    dot.style.background = colors[status] || '#FF9500';
    reconnect.classList.toggle('hidden', status !== 'disconnected');
}

document.getElementById('term-back').addEventListener('click', () => {
    termAutoReconnect = false;
    termWs?.close();
    if (term) { term.dispose(); term = null; }
    showScreen('dashboard');
    loadHosts();
});

document.getElementById('term-reconnect').addEventListener('click', connectTermWs);
