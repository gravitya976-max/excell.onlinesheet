/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Notifications & Session Restore  (notifications.js v4)

   1. Bell icon — weekly notification about previous months' dues
   2. Session restore — remembers last tab/month on browser close
   ══════════════════════════════════════════════════════════════════════ */

const Notifications = (() => {
    const STORAGE_KEY_SEEN    = 'os_notif_seen_week';
    const STORAGE_KEY_DATA    = 'os_notif_cache';
    const STORAGE_KEY_SESSION = 'os_session_state';

    let _data    = [];
    let _bellEl  = null;
    let _badgeEl = null;
    let _shown   = false;  // have we shown the weekly alert yet?

    /* ── Session save / restore ──────────────────────────────────────── */

    function saveSession(state) {
        try {
            localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify({
                tab:   state.activeTab || 'list',
                year:  state.year      || null,
                month: state.month     || null,
                ts:    Date.now(),
            }));
        } catch {}
    }

    function loadSession() {
        try { const r = localStorage.getItem(STORAGE_KEY_SESSION); return r ? JSON.parse(r) : null; }
        catch { return null; }
    }

    function restoreSession() {
        const s = loadSession();
        if (!s) return;

        if (s.tab === 'master') {
            const t = document.querySelector('[data-tab="master"]');
            if (t) t.click();
            return;
        }

        if (s.year && s.month) {
            const tryR = (n = 0) => {
                if (typeof App === 'undefined' || !App.state) {
                    if (n < 20) setTimeout(() => tryR(n + 1), 150);
                    return;
                }
                App.state.year  = parseInt(s.year);
                App.state.month = parseInt(s.month);
                if (typeof App.updateMonthLabel === 'function') App.updateMonthLabel();
                App.reloadActive();
            };
            tryR();
        }
    }

    /* ── Week helpers ────────────────────────────────────────────────── */

    function currentWeekStr() {
        const now = new Date();
        const jan = new Date(now.getFullYear(), 0, 1);
        const w   = Math.ceil(((now - jan) / 86400000 + jan.getDay() + 1) / 7);
        return `${now.getFullYear()}-W${w}`;
    }
    function hasSeenThisWeek() {
        try { return localStorage.getItem(STORAGE_KEY_SEEN) === currentWeekStr(); } catch { return false; }
    }
    function markSeenThisWeek() {
        try { localStorage.setItem(STORAGE_KEY_SEEN, currentWeekStr()); } catch {}
    }

    /* ── API ─────────────────────────────────────────────────────────── */

    async function fetchSummary() {
        try {
            const cached = localStorage.getItem(STORAGE_KEY_DATA);
            if (cached) _data = JSON.parse(cached);
            const fresh = await App.api('GET', '/api/notifications/due-summary');
            _data = fresh;
            localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(_data));
        } catch {}
        _updateBadge();
    }

    /* ── Bell — inside .header-right ─────────────────────────────────── */

    function _createBell() {
        const wrap = document.createElement('div');
        wrap.id = 'notif-bell-wrap';
        wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;';

        _bellEl = document.createElement('button');
        _bellEl.type = 'button';
        _bellEl.id   = 'notif-bell-btn';
        _bellEl.className = 'action-btn';
        _bellEl.title = 'Due alerts';
        _bellEl.style.cssText = 'padding:8px 10px;gap:0;min-width:0;';
        _bellEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="pointer-events:none"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

        _badgeEl = document.createElement('span');
        _badgeEl.id = 'notif-badge';
        _badgeEl.style.cssText = 'position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;padding:0 4px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;border-radius:9px;display:none;align-items:center;justify-content:center;border:2px solid #fff;pointer-events:none;line-height:1;';

        wrap.appendChild(_bellEl);
        wrap.appendChild(_badgeEl);

        _bellEl.addEventListener('click', () => _showAlert());

        const hr = document.querySelector('.header-right');
        if (hr) hr.insertBefore(wrap, hr.firstChild);
        else {
            const topbar = document.getElementById('topbar');
            if (topbar) topbar.appendChild(wrap);
        }
    }

    function _updateBadge() {
        if (!_badgeEl) return;
        const totalDue = _data.reduce((s, d) => s + d.due, 0);
        if (totalDue > 0 && !hasSeenThisWeek()) {
            _badgeEl.textContent = totalDue;
            _badgeEl.style.display = 'flex';
            // Auto-show alert on first load if not seen this week
            if (!_shown) {
                _shown = true;
                setTimeout(_showAlert, 1500);
            }
        } else {
            _badgeEl.style.display = 'none';
        }
    }

    /* ── Simple alert message ────────────────────────────────────────── */

    function _showAlert() {
        markSeenThisWeek();
        _updateBadge();

        if (_data.length === 0) {
            App.toast('No previous month data.', 'info', 3000);
            return;
        }

        const totalDue = _data.reduce((s, d) => s + d.due, 0);
        if (totalDue === 0) {
            App.toast('All previous months are clear - no dues!', 'success', 3000);
            return;
        }

        // Build message lines
        const lines = _data
            .filter(d => d.due > 0)
            .map(d => `${d.label}: ${d.due} unpaid`)
            .join('\n');

        const msg = `Hey! ${totalDue} policy holders didn't pay in previous months. Go check them!\n\n${lines}`;

        // Use a styled overlay instead of browser alert
        _showNotifOverlay(msg, totalDue);
    }

    function _showNotifOverlay(msg, totalDue) {
        // Remove old one if present
        const old = document.getElementById('notif-overlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'notif-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;animation:np-in 0.18s ease;';

        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border-radius:14px;padding:28px 32px;max-width:400px;width:90%;box-shadow:0 16px 48px rgba(0,0,0,0.2);text-align:center;font-family:var(--font-sans);';

        // Bell icon at top
        card.innerHTML = `
            <div style="margin-bottom:16px">
                <svg viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" width="36" height="36" style="margin:0 auto">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
            </div>
            <div style="font-size:18px;font-weight:800;color:#0f172a;margin-bottom:8px">Due Alert</div>
            <div style="font-size:14px;color:#475569;margin-bottom:16px;white-space:pre-line;line-height:1.6">${msg}</div>
            <button id="notif-dismiss-btn" type="button" style="background:var(--green,#16a34a);color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:14px;font-weight:700;cursor:pointer;font-family:var(--font-sans);transition:background 0.15s;">Got it</button>
        `;

        overlay.appendChild(card);
        document.body.appendChild(overlay);

        // Close handlers
        const close = () => overlay.remove();
        document.getElementById('notif-dismiss-btn').addEventListener('click', close);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    }

    /* ── Session save hooks ──────────────────────────────────────────── */

    function _hookSessionSave() {
        document.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => setTimeout(() => {
                if (typeof App !== 'undefined') saveSession(App.state);
            }, 100));
        });

        ['btn-prev-month', 'btn-next-month'].forEach(id => {
            const b = document.getElementById(id);
            if (b) b.addEventListener('click', () => setTimeout(() => {
                if (typeof App !== 'undefined') saveSession(App.state);
            }, 400));
        });

        document.querySelectorAll('.mobile-prev-month, .mobile-next-month').forEach(b => {
            b.addEventListener('click', () => setTimeout(() => {
                if (typeof App !== 'undefined') saveSession(App.state);
            }, 400));
        });
    }

    /* ── Init ────────────────────────────────────────────────────────── */

    function init() {
        _createBell();
        _hookSessionSave();
        restoreSession();

        const tryFetch = (n = 0) => {
            if (typeof App === 'undefined' || typeof App.api !== 'function') {
                if (n < 30) setTimeout(() => tryFetch(n + 1), 200);
                return;
            }
            fetchSummary();
        };
        tryFetch();

        // Re-check every 30 min
        setInterval(fetchSummary, 30 * 60 * 1000);
    }

    document.addEventListener('DOMContentLoaded', init);

    return { saveSession, loadSession };
})();
