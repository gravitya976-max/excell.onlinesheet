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
        _bellEl.innerHTML = '<i class="fa-solid fa-bell" style="font-size:16px;pointer-events:none"></i>';

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

        _showNotifOverlay(totalDue);
    }

    function _showNotifOverlay(totalDue) {
        const old = document.getElementById('notif-overlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'notif-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '9500',
            background: 'rgba(0,0,0,0.45)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-sans, Inter, system-ui, sans-serif)',
        });

        const card = document.createElement('div');
        Object.assign(card.style, {
            background: '#fff', borderRadius: '16px',
            maxWidth: '420px', width: '92%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            overflow: 'hidden',
        });

        // ── Header section (compact) ────────────────────────
        const header = document.createElement('div');
        Object.assign(header.style, {
            background: 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)',
            padding: '18px 24px 16px', display: 'flex',
            alignItems: 'center', gap: '14px', color: '#fff',
        });
        header.innerHTML = `
            <i class="fa-solid fa-bell" style="font-size:20px;opacity:0.9;flex-shrink:0"></i>
            <div style="flex:1">
                <div style="font-size:16px;font-weight:700;letter-spacing:0.2px">Due Alert</div>
                <div style="font-size:12px;opacity:0.8;margin-top:2px">${totalDue} unpaid from previous months</div>
            </div>
            <div style="font-size:26px;font-weight:800;letter-spacing:-1px">${totalDue}</div>
        `;
        card.appendChild(header);

        // ── Month rows ──────────────────────────────────────
        const body = document.createElement('div');
        Object.assign(body.style, {
            padding: '14px 18px 8px',
        });

        const dueMonths = _data.filter(d => d.due > 0);

        dueMonths.forEach((d, i) => {
            const row = document.createElement('div');
            Object.assign(row.style, {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 14px', borderRadius: '10px',
                background: i % 2 === 0 ? '#fef2f2' : '#fff',
                marginBottom: '6px',
                border: '1px solid ' + (i % 2 === 0 ? '#fecaca' : '#f1f5f9'),
            });

            // Left: month name + total
            const left = document.createElement('div');
            left.innerHTML = `
                <div style="font-size:15px;font-weight:700;color:#0f172a;line-height:1.2">${d.month_name} ${d.year}</div>
                <div style="font-size:11px;color:#64748b;margin-top:2px">${d.total} total policies</div>
            `;

            // Right: due count badge
            const badge = document.createElement('div');
            Object.assign(badge.style, {
                background: d.due > 50 ? '#dc2626' : d.due > 20 ? '#ea580c' : '#f59e0b',
                color: '#fff', fontWeight: '800', fontSize: '18px',
                borderRadius: '8px', padding: '6px 14px',
                minWidth: '48px', textAlign: 'center',
                lineHeight: '1.2',
            });
            badge.innerHTML = `${d.due}<div style="font-size:9px;font-weight:600;opacity:0.85;letter-spacing:0.5px">DUE</div>`;

            row.appendChild(left);
            row.appendChild(badge);
            body.appendChild(row);
        });

        card.appendChild(body);

        // ── Footer ──────────────────────────────────────────
        const footer = document.createElement('div');
        Object.assign(footer.style, {
            padding: '8px 18px 18px', textAlign: 'center',
        });
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Got it';
        Object.assign(btn.style, {
            background: 'var(--green, #16a34a)', color: '#fff',
            border: 'none', outline: 'none', borderRadius: '10px',
            padding: '11px 36px', fontSize: '14px', fontWeight: '700',
            cursor: 'pointer', fontFamily: 'inherit',
            transition: 'background 0.15s, transform 0.1s',
            width: '100%', boxShadow: 'none',
        });
        btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.97)'; });
        btn.addEventListener('mouseup', () => { btn.style.transform = ''; });
        footer.appendChild(btn);
        card.appendChild(footer);

        overlay.appendChild(card);
        document.body.appendChild(overlay);

        // Close handlers
        const close = () => overlay.remove();
        btn.addEventListener('click', close);
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
