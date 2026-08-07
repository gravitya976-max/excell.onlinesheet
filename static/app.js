/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Core App Logic (v2)
   Uses DataStore as single source of truth.
   Initial load fetches current view, then bulk-loads everything in background.
   Tab/month switching is instant — no API calls after bulk load.
   ══════════════════════════════════════════════════════════════════════ */

const App = (() => {
    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    const state = {
        year: new Date().getFullYear(),
        month: new Date().getMonth() + 1,
        activeTab: 'list',
    };

    const MONTH_NAMES = [
        '', 'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const $ = (sel) => document.querySelector(sel);

    // ── API helper ────────────────────────────────────────────────────
    async function api(method, path, body = null) {
        const opts = { method, headers: {} };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const resp = await fetch(path, opts);
        if (!resp.ok) {
            const text = await resp.text();
            let msg;
            try { msg = JSON.parse(text).detail || text; } catch { msg = text; }
            throw new Error(msg);
        }
        return resp.json();
    }

    // ── Toast ─────────────────────────────────────────────────────────
    function toast(message, type = 'info', duration = 3500) {
        const container = $('#toast-container');
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.classList.add('removing');
            setTimeout(() => el.remove(), 200);
        }, duration);
    }

    // ── Loading ───────────────────────────────────────────────────────
    function showLoading(text = 'Processing...') {
        $('#loading-text').textContent = text;
        $('#loading-overlay').classList.remove('hidden');
    }
    function hideLoading() { $('#loading-overlay').classList.add('hidden'); }

    // ── Month navigation ──────────────────────────────────────────────
    function updateMonthLabel() {
        const label = `${MONTH_NAMES[state.month]} ${state.year}`;
        $('#current-month-label').textContent = label;
        // Sync mobile menu label
        const mobileLabel = document.getElementById('mobile-month-label');
        if (mobileLabel) mobileLabel.textContent = label;
        // Set pastel header color for current month
        const table = document.querySelector('.spreadsheet');
        if (table) {
            if (state.activeTab === 'list') {
                table.setAttribute('data-month', state.month);
            } else {
                table.removeAttribute('data-month');
            }
        }
    }
    function prevMonth() {
        state.month--;
        if (state.month < 1) { state.month = 12; state.year--; }
        updateMonthLabel();
        renderCurrentView();
    }
    function nextMonth() {
        state.month++;
        if (state.month > 12) { state.month = 1; state.year++; }
        updateMonthLabel();
        renderCurrentView();
    }

    // ── Tabs ──────────────────────────────────────────────────────────
    function switchTab(tab) {
        if (state.activeTab === tab) return;
        state.activeTab = tab;
        // Don't clear search — persist across tabs

        document.querySelectorAll('.tab').forEach(t => {
            if (t.dataset.tab === tab) {
                t.classList.add('tab-active');
                t.classList.remove('tab-inactive');
            } else {
                t.classList.remove('tab-active');
                t.classList.add('tab-inactive');
            }
        });
        if (tab === 'list') {
            $('#month-controls').classList.remove('hidden');
            $('#master-info').classList.add('hidden');
            $('#btn-generate').classList.remove('hidden');
        } else {
            $('#month-controls').classList.add('hidden');
            $('#master-info').classList.remove('hidden');
            $('#btn-generate').classList.add('hidden');
        }
        updateMonthLabel();
        renderCurrentView();
    }

    // ── Render current view (instant from DataStore) ──────────────────
    function renderCurrentView() {
        const entries = getEntries();
        
        if (state.activeTab === 'list') {
            const meta = DataStore.getMonthMeta(state.year, state.month);
            if (!meta && entries.length === 0) {
                // No list generated for this month — check if we need to fetch
                if (DataStore.isBulkLoaded() || DataStore.hasMonthData(state.year, state.month)) {
                    showEmptyState();
                } else {
                    // Not yet loaded — fetch this month
                    fetchMonthData(state.year, state.month);
                }
                return;
            }
            showListState(entries, meta);
        } else {
            // Master tab — fetch from server if DataStore has no master data yet
            if (entries.length === 0 && !DataStore.isBulkLoaded()) {
                fetchMasterData();
                return;
            }
            showMasterState(entries);
        }

        Spreadsheet.render(entries);
        applyFilter($('#search-input').value);
    }

    function getEntries() {
        return DataStore.getView(state.activeTab, state.year, state.month);
    }

    function showEmptyState() {
        $('#empty-state').classList.remove('hidden');
        $('#scroll-container').classList.add('hidden');
        $('#info-count').textContent = 'No list generated';
        $('#info-generated-at').textContent = '';
        $('#footer-count').textContent = '0 rows';
        updateStatPills(0, 0, 0, 0);
        // Button shows "Generate" when no sheet
        const btn = $('#btn-generate');
        if (btn) btn.textContent = 'Generate';
    }

    function showListState(entries, meta) {
        $('#empty-state').classList.add('hidden');
        $('#scroll-container').classList.remove('hidden');
        $('#info-count').textContent = `${entries.length} policies`;
        $('#info-generated-at').textContent = meta && meta.generated_at
            ? `Last refreshed: ${new Date(meta.generated_at).toLocaleString()}` : '';
        $('#footer-count').textContent = `${entries.length} rows`;
        computeAndUpdateStats(entries);
        // Button shows "↻ Refresh" when sheet exists
        const btn = $('#btn-generate');
        if (btn) btn.textContent = '↻ Refresh';
    }

    function showMasterState(entries) {
        $('#empty-state').classList.add('hidden');
        $('#scroll-container').classList.remove('hidden');
        const total = DataStore.getPolicyCount();
        $('#master-count-badge').textContent = `${total} policies`;
        $('#info-count').textContent = `${total} master policies`;
        $('#info-generated-at').textContent = '';
        $('#footer-count').textContent = `${total} rows`;
    }

    /** Compute stat counts from entries and update the pills */
    function computeAndUpdateStats(entries) {
        if (!entries) entries = getEntries();
        let due = 0, paid = 0, nif = 0;
        const PAID_STATUSES = new Set(['paid', 'autodebit', 'dailycollection', 'branchpaid']);
        for (const e of entries) {
            const s = (e.status || '').trim().toLowerCase();
            if (s === 'notinforce') {
                nif++;
            } else if (PAID_STATUSES.has(s)) {
                paid++;
            } else {
                // '' or 'due' or anything else → Due
                due++;
            }
        }
        updateStatPills(entries.length, due, paid, nif);
    }

    function updateStatPills(total, due, paid, nif) {
        const totalEl = $('#stat-total-val');
        const dueEl = $('#stat-due-val');
        const paidEl = $('#stat-paid-val');
        const nifEl = $('#stat-nif-val');
        if (totalEl) totalEl.textContent = total;
        if (dueEl) dueEl.textContent = due;
        if (paidEl) paidEl.textContent = paid;
        if (nifEl) nifEl.textContent = nif;
    }

    // ── Fetch individual month (fallback if not in bulk cache) ────────
    async function fetchMonthData(year, month) {
        try {
            $('#info-count').textContent = 'Loading...';
            const data = await api('GET', `/api/list/${year}/${month}`);
            DataStore.setMonthlyData(year, month, data.entries || [], data.list);
            // Only render if still viewing this month
            if (state.activeTab === 'list' && state.year === year && state.month === month) {
                renderCurrentView();
            }
        } catch (e) { toast(`Load failed: ${e.message}`, 'error'); }
    }

    // ── Fetch master data (fallback if bulk not loaded yet) ───────────
    async function fetchMasterData() {
        try {
            $('#info-count').textContent = 'Loading master data...';
            const data = await api('GET', '/api/master?limit=5000');
            if (data && data.entries) {
                DataStore.setMasterPolicies(data.entries);
            }
            if (state.activeTab === 'master') {
                renderCurrentView();
            }
        } catch (e) { toast(`Master load failed: ${e.message}`, 'error'); }
    }

    // ── Generate list ─────────────────────────────────────────────────
    async function generateList() {
        const isRefresh = _hasMonthlyEntries();
        showLoading(isRefresh ? 'Refreshing data...' : 'Generating monthly list...');
        try {
            const data = await api('POST', `/api/generate?year=${state.year}&month=${state.month}`);
            let msg = data.is_refresh
                ? `Refreshed: ${data.filtered_count} policies`
                : `Generated: ${data.filtered_count} policies due`;
            if (data.removed > 0) msg += `, ${data.removed} removed`;
            toast(msg, 'success');
            // Re-fetch this month's data to update DataStore
            const freshData = await api('GET', `/api/list/${state.year}/${state.month}`);
            DataStore.setMonthlyData(state.year, state.month, freshData.entries || [], freshData.list);
            renderCurrentView();
        } catch (e) { toast(`${isRefresh ? 'Refresh' : 'Generate'} failed: ${e.message}`, 'error'); }
        hideLoading();
    }

    /** Check if current month already has entries */
    function _hasMonthlyEntries() {
        const entries = DataStore.getView('list', state.year, state.month);
        return entries && entries.length > 0;
    }

    // ── Search / filter ───────────────────────────────────────────────
    let _searchTimer = null;
    let _filterText = '';

    function doSearch(query) {
        _filterText = (query || '').trim().toLowerCase();
        // Show/hide clear button
        const clearBtn = $('#search-clear');
        if (clearBtn) clearBtn.classList.toggle('hidden', !_filterText);
        applyFilter(_filterText);
    }

    function applyFilter(text) {
        _filterText = (text || '').trim().toLowerCase();
        if (!_filterText) {
            // No filter — render full view
            Spreadsheet.render(getEntries());
            return;
        }
        const all = getEntries();
        const filtered = all.filter(entry => {
            return Object.values(entry).some(v =>
                v != null && String(v).toLowerCase().includes(_filterText)
            );
        });
        Spreadsheet.render(filtered);
    }

    function getFilterText() { return _filterText; }

    function clearSearchInput() {
        const inp = $('#search-input');
        if (inp) inp.value = '';
        _filterText = '';
    }

    function clearSearch() {
        clearSearchInput();
        const clearBtn = $('#search-clear');
        if (clearBtn) clearBtn.classList.add('hidden');
        applyFilter('');
    }

    // ── Update entry (monthly) ────────────────────────────────────────
    async function updateEntry(entryId, field, value) {
        // Update DataStore immediately (local-first)
        const entries = getEntries();
        const entry = entries.find(e => (e._monthlyId || e.id) === entryId);
        if (entry) {
            const monthKey = `${state.year}-${state.month}`;
            DataStore.updateField('monthly', entry.policyno || entry._masterPolicyno, field, value, monthKey, entryId);
        }
        // API call (or queue if offline)
        const url = `/api/entry/${entryId}`;
        const body = { [field]: value };
        if (!navigator.onLine) {
            await OfflineQueue.enqueue('PUT', url, body);
            return true;
        }
        try {
            await api('PUT', url, body);
            return true;
        } catch (e) {
            // Network failed mid-request — queue it
            await OfflineQueue.enqueue('PUT', url, body);
            return true;
        }
    }

    // ── Update master entry ───────────────────────────────────────────
    async function updateMasterEntry(entryId, field, value) {
        // Update DataStore immediately
        const entries = getEntries();
        const entry = entries.find(e => e.id === entryId);
        if (entry) {
            DataStore.updateField('master', entry.policyno, field, value);
        }
        // API call (or queue if offline)
        const url = `/api/master/${entryId}`;
        const body = { [field]: value };
        if (!navigator.onLine) {
            await OfflineQueue.enqueue('PUT', url, body);
            return true;
        }
        try {
            await api('PUT', url, body);
            return true;
        } catch (e) {
            await OfflineQueue.enqueue('PUT', url, body);
            return true;
        }
    }

    // ── Delete entry ──────────────────────────────────────────────────
    async function deleteEntry(entryId) {
        const table = state.activeTab === 'master' ? 'master' : 'monthly';
        // Find entry before removing
        const entries = getEntries();
        const entry = entries.find(e => (e._monthlyId || e.id) === entryId);
        const pno = entry ? (entry.policyno || entry._masterPolicyno) : '';

        // Remove from DataStore immediately (local-first)
        if (pno) DataStore.removeEntry(pno);
        renderCurrentView();
        refreshMasterCount();
        toast(`Deleted: ${pno}`, 'success', 2000);

        // API call (or queue if offline)
        const url = `/api/entry/${entryId}?table=${table}`;
        if (!navigator.onLine) {
            await OfflineQueue.enqueue('DELETE', url, null);
            return true;
        }
        try {
            await api('DELETE', url);
            return true;
        } catch (e) {
            await OfflineQueue.enqueue('DELETE', url, null);
            return true;
        }
    }

    // ── Confirm dialog ────────────────────────────────────────────────
    let _confirmCallback = null;
    function showConfirm(title, message, onConfirm) {
        const overlay = $('#confirm-overlay');
        if (!overlay) { if (confirm(message)) onConfirm(); return; }
        $('#confirm-title').textContent = title;
        $('#confirm-message').textContent = message;
        _confirmCallback = onConfirm;
        overlay.classList.remove('hidden');
    }

    // ── Upload ────────────────────────────────────────────────────────
    function openUpload() { $('#upload-overlay').classList.remove('hidden'); }
    function closeUpload() { $('#upload-overlay').classList.add('hidden'); }

    async function handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        showLoading(`Uploading ${fileList.length} file(s)...`);
        const fd = new FormData();
        for (const f of fileList) fd.append('files', f);
        try {
            const resp = await fetch('/api/upload', { method: 'POST', body: fd });
            if (!resp.ok) {
                let errText = '';
                try { const j = await resp.json(); errText = j.detail || j.message || resp.statusText; } catch { errText = await resp.text().catch(() => resp.statusText); }
                throw new Error(errText);
            }
            const data = await resp.json();
            toast(`Uploaded: ${data.total_inserted} new, ${data.total_updated} updated`, 'success');
            closeUpload();
            // Reload master data in DataStore
            await refreshBulkData();
            renderCurrentView();
        } catch (e) { toast(`Upload failed: ${e.message || e}`, 'error'); }
        hideLoading();
    }

    // ── Reload active view (called after new entry from extra row) ───
    async function reloadActive() {
        if (state.activeTab === 'master') {
            const data = await api('GET', '/api/master?limit=5000');
            DataStore.setMasterData(data.data || []);
        } else {
            const data = await api('GET', `/api/list/${state.year}/${state.month}`);
            DataStore.setMonthlyData(state.year, state.month, data.entries || [], data.list);
        }
        renderCurrentView();
        refreshMasterCount();
    }

    // ── Background bulk load ──────────────────────────────────────────
    async function refreshBulkData() {
        try {
            const data = await api('GET', '/api/session/bulk');
            DataStore.loadInitialData(
                data.policies,
                null, null, null  // don't overwrite current month
            );
            DataStore.loadBulkData(data.monthlyData, data.availableMonths);
        } catch (e) {
            console.warn('Bulk load failed:', e.message);
        }
    }

    // ── Refresh master count badge ────────────────────────────────────
    async function refreshMasterCount() {
        try {
            const data = await api('GET', '/api/master/count');
            const badge = $('#master-count-badge');
            if (badge) badge.textContent = `${data.count} policies`;
        } catch {}
    }

    // ── Init ──────────────────────────────────────────────────────────
    function init() {
        updateMonthLabel();

        // Month nav (original buttons + split hitbox overlays)
        $('#btn-prev-month').addEventListener('click', prevMonth);
        $('#btn-next-month').addEventListener('click', nextMonth);
        $('#hit-prev').addEventListener('click', prevMonth);
        $('#hit-next').addEventListener('click', nextMonth);

        // Generate / Refresh
        $('#btn-generate').addEventListener('click', () => {
            const isRefresh = _hasMonthlyEntries();
            const title = isRefresh ? '↻ Refresh Data?' : 'Generate List?';
            const msg = isRefresh
                ? `Update ${MONTH_NAMES[state.month]} ${state.year} with latest master data. Your notes & status will be preserved.`
                : `Create the due list for ${MONTH_NAMES[state.month]} ${state.year} from master data.`;
            showConfirm(title, msg, generateList);
        });

        // Tabs
        document.querySelectorAll('.tab').forEach(t =>
            t.addEventListener('click', () => switchTab(t.dataset.tab))
        );

        // Upload
        $('#btn-upload').addEventListener('click', openUpload);
        $('#btn-close-upload').addEventListener('click', closeUpload);
        $('#upload-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeUpload();
        });
        const dz = $('#drop-zone');
        const fi = $('#file-input');
        dz.addEventListener('click', () => fi.click());
        fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });
        dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
        dz.addEventListener('drop', (e) => {
            e.preventDefault(); dz.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });

        // Search – always read live input value when debounce fires
        const searchInput = $('#search-input');
        searchInput.addEventListener('input', () => {
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => doSearch(searchInput.value), 120);
        });
        $('#search-clear').addEventListener('click', clearSearch);
        $('#search-input').addEventListener('keydown', (e) => {
            if (e.key === 'Escape') clearSearch();
        });

        // Confirm modal buttons
        const overlay = $('#confirm-overlay');
        if (overlay) {
            $('#btn-confirm-ok')?.addEventListener('click', () => {
                overlay.classList.add('hidden');
                if (_confirmCallback) { _confirmCallback(); _confirmCallback = null; }
            });
            $('#btn-confirm-cancel')?.addEventListener('click', () => {
                overlay.classList.add('hidden');
                _confirmCallback = null;
            });
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) { overlay.classList.add('hidden'); _confirmCallback = null; }
            });
        }

        // ── Initial data load strategy ──────────────────────────────
        // 1. Try localStorage cache (instant)
        // 2. Fetch current view from API
        // 3. Background bulk load everything else

        const hasCached = DataStore.loadFromLocal();
        if (hasCached) {
            // Instant render from cache
            refreshMasterCount();
            renderCurrentView();
            toast('Loaded from cache', 'info', 1500);
        }

        // Always fetch fresh current view
        fetchMonthData(state.year, state.month).then(() => {
            refreshMasterCount();
        });

        // Background: bulk load all data
        setTimeout(() => refreshBulkData(), hasCached ? 3000 : 500);

        // Real-time stat pill updates + NIF re-sort when a status cell changes
        if (Spreadsheet.onStatusChange) {
            Spreadsheet.onStatusChange(() => {
                computeAndUpdateStats();
                Spreadsheet.resortEntries(); // Move NIF rows to bottom
            });
        }

        // ── Online / Offline events ────────────────────────────────
        window.addEventListener('online', () => {
            toast('Back online — syncing...', 'success', 2500);
            // Flush offline queue
            if (typeof OfflineQueue !== 'undefined') {
                OfflineQueue.flush().then(() => {
                    OfflineQueue.updateIndicator();
                });
            }
            // Auto-fetch fresh data
            fetchMonthData(state.year, state.month).then(() => refreshMasterCount());
            setTimeout(() => refreshBulkData(), 1000);
        });
        window.addEventListener('offline', () => {
            toast('You are offline — changes will sync later', 'info', 3000);
            if (typeof OfflineQueue !== 'undefined') OfflineQueue.updateIndicator();
        });

        // ── Register Service Worker ────────────────────────────────
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
                .then(reg => { if (reg) reg.update(); })
                .catch(() => {});
        }

        // ── Hamburger menu (mobile) ────────────────────────────────
        const hamburger = $('#hamburger-btn');
        const mobileMenu = $('#mobile-menu');
        if (hamburger && mobileMenu) {
            hamburger.addEventListener('click', () => {
                mobileMenu.classList.toggle('open');
                hamburger.classList.toggle('active');
            });
            // Close menu when tapping a menu item
            mobileMenu.querySelectorAll('.mobile-menu-item').forEach(item => {
                item.addEventListener('click', () => {
                    mobileMenu.classList.remove('open');
                    hamburger.classList.remove('active');
                });
            });

            // Mobile tab switching
            mobileMenu.querySelectorAll('.tab[data-tab]').forEach(t => {
                t.addEventListener('click', () => switchTab(t.dataset.tab));
            });

            // Mobile month nav
            document.querySelectorAll('.mobile-prev-month').forEach(el =>
                el.addEventListener('click', prevMonth)
            );
            document.querySelectorAll('.mobile-next-month').forEach(el =>
                el.addEventListener('click', nextMonth)
            );

            // Mobile generate button
            const mobileGen = $('#mobile-btn-generate');
            if (mobileGen) {
                mobileGen.addEventListener('click', () => {
                    const isRefresh = _hasMonthlyEntries();
                    const title = isRefresh ? '↻ Refresh Data?' : 'Generate List?';
                    const msg = isRefresh
                        ? `Update ${MONTH_NAMES[state.month]} ${state.year} with latest master data. Your notes & status will be preserved.`
                        : `Create the due list for ${MONTH_NAMES[state.month]} ${state.year} from master data.`;
                    showConfirm(title, msg, generateList);
                });
            }

            // Mobile upload button
            const mobileUpload = $('#mobile-btn-upload');
            if (mobileUpload) mobileUpload.addEventListener('click', openUpload);

            // Undo/Redo FABs
            const undoBtn = $('#btn-mobile-undo');
            const redoBtn = $('#btn-mobile-redo');
            if (undoBtn) undoBtn.addEventListener('click', () => Spreadsheet.undo());
            if (redoBtn) redoBtn.addEventListener('click', () => Spreadsheet.redo());
        }
    }

    document.addEventListener('DOMContentLoaded', init);

    return {
        state,
        isMobile,
        updateEntry,
        updateMasterEntry,
        deleteEntry,
        toast,
        api,
        reloadActive,
        showConfirm,
        renderCurrentView,
        getEntries,
        getFilterText,
    };
})();
