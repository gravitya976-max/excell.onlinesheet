/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Core App Logic (v2)
   Uses DataStore as single source of truth.
   Initial load fetches current view, then bulk-loads everything in background.
   Tab/month switching is instant — no API calls after bulk load.
   ══════════════════════════════════════════════════════════════════════ */

const App = (() => {
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
        $('#current-month-label').textContent = `${MONTH_NAMES[state.month]} ${state.year}`;
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
        updateStatPills(0, 0, 0);
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
        const dueCount = entries.filter(e => {
            const s = (e.status || '').trim().toLowerCase();
            return s === '' || s === 'due';
        }).length;
        updateStatPills(entries.length, dueCount, entries.length - dueCount);
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

    function updateStatPills(total, due, paid) {
        const totalEl = $('#stat-total-val');
        const dueEl = $('#stat-due-val');
        const paidEl = $('#stat-paid-val');
        if (totalEl) totalEl.textContent = total;
        if (dueEl) dueEl.textContent = due;
        if (paidEl) paidEl.textContent = paid;
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
        try {
            await api('PUT', `/api/entry/${entryId}`, { [field]: value });
            // Find the policyno for this entry to update DataStore
            const entries = getEntries();
            const entry = entries.find(e => (e._monthlyId || e.id) === entryId);
            if (entry) {
                const monthKey = `${state.year}-${state.month}`;
                DataStore.updateField('monthly', entry.policyno || entry._masterPolicyno, field, value, monthKey, entryId);
            }
            return true;
        } catch (e) {
            toast(`Update failed: ${e.message}`, 'error');
            return false;
        }
    }

    // ── Update master entry ───────────────────────────────────────────
    async function updateMasterEntry(entryId, field, value) {
        try {
            await api('PUT', `/api/master/${entryId}`, { [field]: value });
            // Update DataStore
            const entries = getEntries();
            const entry = entries.find(e => e.id === entryId);
            if (entry) {
                DataStore.updateField('master', entry.policyno, field, value);
            }
            return true;
        } catch (e) {
            toast(`Update failed: ${e.message}`, 'error');
            return false;
        }
    }

    // ── Delete entry ──────────────────────────────────────────────────
    async function deleteEntry(entryId) {
        const table = state.activeTab === 'master' ? 'master' : 'monthly';
        try {
            const res = await api('DELETE', `/api/entry/${entryId}?table=${table}`);
            const pno = res.policyno;
            if (pno) DataStore.removeEntry(pno);
            toast(`Deleted: ${pno}`, 'success', 2000);
            renderCurrentView();
            refreshMasterCount();
            return true;
        } catch (e) {
            toast(`Delete failed: ${e.message}`, 'error');
            return false;
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
            const res = await api('POST', '/api/upload');
            // Actually we need FormData upload, not JSON
            const resp = await fetch('/api/upload', { method: 'POST', body: fd });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            toast(`Uploaded: ${data.total_inserted} new, ${data.total_updated} updated`, 'success');
            closeUpload();
            // Reload master data in DataStore
            await refreshBulkData();
            renderCurrentView();
        } catch (e) { toast(`Upload failed: ${e.message}`, 'error'); }
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

        // Search – capture value eagerly so fast typing doesn't lose it
        $('#search-input').addEventListener('input', (e) => {
            const val = e.target.value;
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => doSearch(val), 200);
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
    }

    document.addEventListener('DOMContentLoaded', init);

    return {
        state,
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
