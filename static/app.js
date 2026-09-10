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

    // ── Clickable stat pills — filter by status ──────────────────────
    let _activeStatFilter = null; // null | 'total' | 'due' | 'paid' | 'nif'
    const PAID_FILTER_SET = new Set(['paid', 'autodebit', 'dailycollection', 'branchpaid']);

    function initStatPillClicks() {
        const pills = {
            total: document.querySelector('.stat-total'),
            due:   document.querySelector('.stat-due'),
            paid:  document.querySelector('.stat-paid'),
            nif:   document.querySelector('.stat-nif'),
        };

        Object.entries(pills).forEach(([key, el]) => {
            if (!el) return;
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => {
                if (_activeStatFilter === key) {
                    // Toggle off — show all
                    _activeStatFilter = null;
                    _clearStatHighlight(pills);
                    applyFilter($('#search-input').value);
                    return;
                }
                _activeStatFilter = key;
                _highlightStat(pills, key);
                _filterByStatus(key);
            });
        });
    }

    function _highlightStat(pills, activeKey) {
        Object.entries(pills).forEach(([key, el]) => {
            if (!el) return;
            if (key === activeKey) {
                el.classList.add('stat-active');
            } else {
                el.classList.remove('stat-active');
            }
        });
    }

    function _clearStatHighlight(pills) {
        Object.values(pills).forEach(el => {
            if (el) el.classList.remove('stat-active');
        });
    }

    function _filterByStatus(key) {
        const all = getEntries();
        let filtered;
        if (key === 'total') {
            filtered = all;
        } else if (key === 'due') {
            filtered = all.filter(e => {
                const s = (e.status || '').trim().toLowerCase();
                return s === '' || s === 'due' || (!PAID_FILTER_SET.has(s) && s !== 'notinforce');
            });
        } else if (key === 'paid') {
            filtered = all.filter(e => PAID_FILTER_SET.has((e.status || '').trim().toLowerCase()));
        } else if (key === 'nif') {
            filtered = all.filter(e => (e.status || '').trim().toLowerCase() === 'notinforce');
        } else {
            filtered = all;
        }
        Spreadsheet.render(filtered);
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

        // Record deletion in UndoManager (snapshot before removal)
        if (entry && typeof UndoManager !== 'undefined' && UndoManager.recordDelete) {
            UndoManager.recordDelete({
                entryId: entryId,
                entryData: entry,
                tab: state.activeTab,
                policyno: pno,
            });
        }

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

    // ── Edit Master Entry (modal) ───────────────────────────────────
    let _editMasterEntry = null;

    function openEditMaster(entry) {
        if (!entry) return;
        _editMasterEntry = entry;

        // Pre-fill the modal fields
        document.getElementById('edit-master-id').value = entry.id;
        document.getElementById('edit-master-policyno').value = entry.policyno || '';
        document.getElementById('edit-master-name').value = entry.name || '';
        document.getElementById('edit-master-doc').value = entry.doc || '';
        document.getElementById('edit-master-fup').value = entry.fup || '';
        document.getElementById('edit-master-sumass').value = entry.sumass || '';
        document.getElementById('edit-master-plan').value = entry.plan || '';
        document.getElementById('edit-master-mode').value = entry.mode || '';
        document.getElementById('edit-master-premium').value = entry.premium || '';
        document.getElementById('edit-master-mobileno').value = entry.mobileno || '';

        // Show the modal
        $('#edit-master-overlay').classList.remove('hidden');

        // Focus policy number field
        setTimeout(() => document.getElementById('edit-master-policyno').focus(), 100);
    }

    function closeEditMaster() {
        $('#edit-master-overlay').classList.add('hidden');
        _editMasterEntry = null;
    }

    function saveEditMaster() {
        if (!_editMasterEntry) return;

        const entryId = _editMasterEntry.id;
        const oldPno = _editMasterEntry.policyno || '';

        // Gather values from modal
        const newPno = document.getElementById('edit-master-policyno').value.trim();
        const newName = document.getElementById('edit-master-name').value.trim();
        const newDoc = document.getElementById('edit-master-doc').value.trim();
        const newFup = document.getElementById('edit-master-fup').value.trim();
        const newSumass = document.getElementById('edit-master-sumass').value.trim();
        const newPlan = document.getElementById('edit-master-plan').value.trim();
        const newMode = document.getElementById('edit-master-mode').value.trim();
        const newPremium = document.getElementById('edit-master-premium').value.trim();
        const newMobileno = document.getElementById('edit-master-mobileno').value.trim();

        if (!newPno) {
            toast('Policy number cannot be empty', 'error');
            return;
        }

        // Build the update body
        const body = {
            policyno: newPno,
            name: newName,
            doc: newDoc,
            fup: newFup,
            sumass: newSumass,
            plan: newPlan,
            mode: newMode,
            premium: newPremium,
            mobileno: newMobileno,
        };

        const pnoChanged = newPno !== oldPno;
        const confirmTitle = pnoChanged ? 'Update Policy Number?' : 'Save Changes?';
        const confirmMsg = pnoChanged
            ? `Change policy number from ${oldPno} to ${newPno}? This will update all associated monthly entries as well.`
            : `Save changes to policy ${oldPno}?`;

        // Close edit form first, then show confirmation
        closeEditMaster();

        showConfirm(confirmTitle, confirmMsg, async () => {
            showLoading('Saving changes...');
            try {
                const resp = await api('PUT', `/api/master/${entryId}`, body);
                let msg = `Updated: ${resp.policyno}`;
                if (resp.policyno_changed) {
                    msg = `Policy number changed: ${resp.old_policyno} → ${resp.policyno}`;
                }
                toast(msg, 'success', 4000);

                // Reload data to reflect changes
                await reloadActive();
                await refreshBulkData();
            } catch (e) {
                toast(`Update failed: ${e.message}`, 'error');
            }
            hideLoading();
        });
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

        // Edit Master modal buttons
        const editOverlay = $('#edit-master-overlay');
        if (editOverlay) {
            $('#btn-close-edit-master')?.addEventListener('click', closeEditMaster);
            $('#btn-edit-master-cancel')?.addEventListener('click', closeEditMaster);
            $('#btn-edit-master-save')?.addEventListener('click', saveEditMaster);
            editOverlay.addEventListener('click', (e) => {
                if (e.target === editOverlay) closeEditMaster();
            });
            // Enter key in any field triggers save
            editOverlay.querySelectorAll('.edit-field input').forEach(inp => {
                inp.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveEditMaster(); }
                    if (e.key === 'Escape') closeEditMaster();
                });
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

        // Initialize UndoManager keyboard bindings (Ctrl+Z, Ctrl+Y)
        if (typeof UndoManager !== 'undefined') UndoManager.initKeyboard();

        // ── Color picker toolbar ───────────────────────────────────
        initColorPicker();

        // ── Star note button ───────────────────────────────────────
        initStarNote();

        // ── Clickable stat pills (filter by status) ───────────────
        initStatPillClicks();

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
            if (undoBtn) undoBtn.addEventListener('click', () => UndoManager.undo());
            if (redoBtn) redoBtn.addEventListener('click', () => UndoManager.redo());
        }
    }

    document.addEventListener('DOMContentLoaded', init);

    // ── Star/Color mode state ──────────────────────────────────────────
    let _starNoteMode = false;

    // ── Shared: turn off color mode ────────────────────────────────────
    function deactivateColorMode() {
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        document.body.classList.remove('color-mode-active');
        Spreadsheet.setActiveColorKey(null);
    }

    // ── Shared: turn off star mode ─────────────────────────────────────
    function deactivateStarMode() {
        _starNoteMode = false;
        const btn = $('#btn-star-note');
        if (btn) btn.classList.remove('active');
    }

    // ── Color Picker ──────────────────────────────────────────────────
    function initColorPicker() {
        const allSwatches = document.querySelectorAll('.color-swatch');

        allSwatches.forEach(swatch => {
            swatch.addEventListener('click', () => {
                const colorKey = swatch.dataset.color;
                const wasActive = swatch.classList.contains('active');

                // Turn off star mode first (mutually exclusive)
                deactivateStarMode();

                // Deactivate all swatches
                allSwatches.forEach(s => s.classList.remove('active'));

                if (wasActive && colorKey !== '__clear__') {
                    document.body.classList.remove('color-mode-active');
                    Spreadsheet.setActiveColorKey(null);
                } else {
                    swatch.classList.add('active');
                    document.body.classList.add('color-mode-active');
                    Spreadsheet.setActiveColorKey(colorKey || '__clear__');
                }
            });
        });
    }

    // ── Star Note ─────────────────────────────────────────────────────
    // (let _starNoteMode declared above)

    // Parse star_note: returns an array of starred field keys, e.g. ["note3","note7"]
    // Handles legacy format (plain text) by matching against note1-note10
    function parseStarNote(entry) {
        const raw = entry.star_note || '';
        if (!raw) return [];
        // Try JSON array first
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        } catch (_) { /* not JSON — legacy format */ }
        // Legacy: raw is the note text content — find which field matches
        for (let i = 1; i <= 10; i++) {
            if (entry[`note${i}`] && entry[`note${i}`] === raw) {
                return [`note${i}`];
            }
        }
        return []; // can't match legacy text — clear it
    }

    function initStarNote() {
        const btn = $('#btn-star-note');
        if (!btn) return;

        btn.addEventListener('click', () => {
            const turningOn = !_starNoteMode;

            // Turn off color mode first (mutually exclusive)
            if (turningOn) deactivateColorMode();

            _starNoteMode = turningOn;
            btn.classList.toggle('active', _starNoteMode);
            if (_starNoteMode) {
                toast('Star mode ON — click any note cell to star/unstar it', 'info', 3000);
            }
        });

        // Listen for note cell clicks when star mode is on (capture phase)
        document.addEventListener('click', (e) => {
            if (!_starNoteMode) return;
            const td = e.target.closest('td.editable');
            if (!td) return;
            const field = td.dataset.field;
            if (!field || !field.startsWith('note')) return;

            const entryId = parseInt(td.dataset.entryId);
            const entries = getEntries();
            const entry = entries.find(en => (en._monthlyId || en.id) === entryId);
            if (!entry) return;

            // Only intercept now that we know it's a valid star target
            e.stopPropagation();
            e.preventDefault();

            const noteVal = entry[field] || '';
            if (!noteVal.trim()) {
                toast('Note is empty — add text first', 'info', 2000);
                return;
            }

            // Parse current starred keys
            const oldRaw = entry.star_note || '';
            const starred = parseStarNote(entry);
            const idx = starred.indexOf(field);
            const isStarring = idx === -1;

            if (isStarring) {
                starred.push(field);
            } else {
                starred.splice(idx, 1);
            }

            // Save as JSON array (or empty string if none)
            const newRaw = starred.length ? JSON.stringify(starred) : '';

            // Update DataStore source data (so future getEntries() calls reflect the change)
            const policyno = entry.policyno || entry._masterPolicyno;
            const context = state.activeTab === 'master' ? 'master' : 'monthly';
            const monthKey = `${state.year}-${state.month}`;
            DataStore.updateField(context, policyno, 'star_note', newRaw, monthKey, entryId);

            // Also update VirtualScroller's cached data (so scroll re-renders use correct value)
            VirtualScroller.updateFieldByEntryId(entryId, 'star_note', newRaw);

            // Immediate visual feedback on the clicked note cell
            td.classList.toggle('starred-note', isStarring);

            // Direct DOM update on the status cell in the same row (no full refresh)
            const tr = td.closest('tr');
            if (tr) {
                const statusTd = tr.querySelector('td.col-status');
                if (statusTd) {
                    const existingStar = statusTd.querySelector('.star-indicator');
                    if (starred.length > 0) {
                        // Add or update star indicator
                        if (existingStar) {
                            // Update badge
                            const badge = existingStar.querySelector('.star-badge');
                            if (starred.length > 1) {
                                if (badge) {
                                    badge.textContent = starred.length;
                                } else {
                                    const newBadge = document.createElement('span');
                                    newBadge.className = 'star-badge';
                                    newBadge.textContent = starred.length;
                                    existingStar.appendChild(newBadge);
                                }
                            } else if (badge) {
                                badge.remove();
                            }
                            existingStar.title = starred.length + ' starred note' + (starred.length > 1 ? 's' : '');
                        } else {
                            // Create star indicator
                            const star = document.createElement('div');
                            star.className = 'star-indicator';
                            star.title = starred.length + ' starred note' + (starred.length > 1 ? 's' : '');
                            star.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
                            if (starred.length > 1) {
                                const newBadge = document.createElement('span');
                                newBadge.className = 'star-badge';
                                newBadge.textContent = starred.length;
                                star.appendChild(newBadge);
                            }
                            star.addEventListener('mouseenter', (ev) => {
                                // Re-fetch entry for latest data
                                const freshEntries = getEntries();
                                const freshEntry = freshEntries.find(en => (en._monthlyId || en.id) === entryId);
                                if (freshEntry && typeof Spreadsheet !== 'undefined' && Spreadsheet.showStarTooltip) {
                                    Spreadsheet.showStarTooltip(ev, freshEntry);
                                }
                            });
                            star.addEventListener('mouseleave', () => {
                                if (typeof Spreadsheet !== 'undefined' && Spreadsheet.hideStarTooltip) {
                                    Spreadsheet.hideStarTooltip();
                                }
                            });
                            star.addEventListener('click', (ev) => {
                                ev.stopPropagation();
                                const freshEntries = getEntries();
                                const freshEntry = freshEntries.find(en => (en._monthlyId || en.id) === entryId);
                                if (freshEntry) showStarNoteDetail(freshEntry);
                            });
                            statusTd.appendChild(star);
                        }
                    } else if (existingStar) {
                        // Remove star indicator — no more starred notes
                        existingStar.remove();
                    }
                }
            }

            // Save to server
            api('PUT', `/api/entry/${entryId}`, { star_note: newRaw }).catch(() => {
                toast('Failed to save star note', 'error');
                // Revert DataStore and VirtualScroller cache
                DataStore.updateField(context, policyno, 'star_note', oldRaw, monthKey, entryId);
                VirtualScroller.updateFieldByEntryId(entryId, 'star_note', oldRaw);
                td.classList.toggle('starred-note', !isStarring);
                VirtualScroller.refresh(); // full refresh to revert everything
            });

            const noteLabel = field.replace('note', 'Note ');
            toast(isStarring ? `★ ${noteLabel} starred` : `${noteLabel} unstarred`,
                  isStarring ? 'success' : 'info', 2000);
        }, true);
    }

    function showStarNoteDetail(entry) {
        const starred = parseStarNote(entry);
        if (!starred.length) return;
        // Show all starred notes
        const lines = starred.map(key => {
            const label = key.replace('note', 'Note ');
            const text = entry[key] || '(empty)';
            return `★ ${label}: ${text}`;
        });
        toast(lines.join('\n'), 'info', 5000);
    }

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
        openEditMaster,
        showStarNoteDetail,
        parseStarNote,
        applyFilter,
        clearSearch,
        updateMonthLabel,
    };
})();
