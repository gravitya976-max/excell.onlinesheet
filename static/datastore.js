/* ══════════════════════════════════════════════════════════════════════
   DataStore — Single Source of Truth for all policy & monthly data
   
   Architecture:
     • policies[]       — master policy data (shared across all views)
     • monthlyOverlays{} — per-month data (status, notes) keyed by "YYYY-M"
     • Views are computed on demand by merging policies + overlays
     • Smart sync rules: edits propagate per field rules
     • localStorage persistence for instant return visits
   ══════════════════════════════════════════════════════════════════════ */

const DataStore = (() => {
    // ── Internal state ───────────────────────────────────────────────
    let _policies = [];              // All master policy records
    let _monthlyOverlays = {};       // { "2026-7": [{ policyno, status, notes... }] }
    let _monthlyMeta = {};           // { "2026-7": { id, generated_at, ... } }
    let _availableMonths = [];       // [{ year, month, id, ... }]
    let _listeners = [];             // onChange callbacks
    let _ready = false;              // true after initial load
    let _bulkLoaded = false;         // true after background bulk load
    let _lastServerSync = 0;         // timestamp of last successful server sync
    let _hasPendingEdits = false;    // true when local edits haven't been confirmed by server

    const STORAGE_KEY = 'os_datastore_v3';
    const CACHE_TTL = 4 * 60 * 60 * 1000;  // 4 hours max cache age
    const MONTHLY_ONLY_FIELDS = new Set(['note1','note2','note3','note4','note5',
                                          'note6','note7','note8','note9','note10',
                                          'due_months','star_note','row_color']);

    // ── Policies index for O(1) lookup ───────────────────────────────
    let _policyIndex = {};  // { policyno: index_in_policies }

    // Debounced save to localStorage (avoid excessive writes on rapid edits)
    let _saveTimer = null;
    function _debouncedSave() {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => saveToLocal(), 500);
    }

    function rebuildIndex() {
        _policyIndex = {};
        _policies.forEach((p, i) => { _policyIndex[p.policyno] = i; });
    }

    // ── Views (computed on demand) ───────────────────────────────────

    /**
     * Get merged view for a monthly sheet.
     * Joins master policy data with monthly overlay (status, notes).
     * Returns a new array suitable for rendering.
     */
    function getMonthlyView(year, month) {
        const key = `${year}-${month}`;
        const overlay = _monthlyOverlays[key] || [];
        
        // Build a lookup of monthly-specific data by policyno
        const overMap = {};
        overlay.forEach(o => { overMap[o.policyno] = o; });

        // Merge: start with overlay entries (they define which policies appear in this month)
        return overlay.map((ov, idx) => {
            const master = _policies[_policyIndex[ov.policyno]];
            // Master fields as base, overlay fields on top
            return {
                ...(master || {}),        // name, mobile, plan, doc, etc.
                ...ov,                     // id (monthly), status, notes, fup, fup_day
                _monthlyId: ov.id,         // monthly_entries.id for API calls
                _masterPolicyno: ov.policyno,
                _rowIndex: idx
            };
        });
    }

    /**
     * Get master data view — just the policies array directly.
     */
    function getMasterView() {
        return _policies.map((p, idx) => ({
            ...p,
            _rowIndex: idx
        }));
    }

    /**
     * Get the right view based on active tab context.
     */
    function getView(activeTab, year, month) {
        if (activeTab === 'master') return getMasterView();
        return getMonthlyView(year, month);
    }

    // ── Data loading ─────────────────────────────────────────────────

    /**
     * Load initial view data (current month or master).
     * Called on first page load.
     */
    function loadInitialData(masterPolicies, monthlyData, monthKey, meta) {
        _policies = masterPolicies || [];
        rebuildIndex();
        if (monthKey && monthlyData) {
            _monthlyOverlays[monthKey] = monthlyData;
            if (meta) _monthlyMeta[monthKey] = meta;
        }
        _ready = true;
        _notify('initial');
    }

    /**
     * Load bulk data (all months) from background fetch.
     */
    function loadBulkData(allMonthlyData, availableMonths) {
        // Determine current viewing month to preserve local edits only for it
        const now = new Date();
        const currentKey = `${now.getFullYear()}-${now.getMonth() + 1}`;

        // allMonthlyData = { "2026-7": [...], "2026-6": [...], ... }
        for (const key in allMonthlyData) {
            const serverEntries = allMonthlyData[key].entries || [];

            if (!_monthlyOverlays[key]) {
                // No local data — use server data directly
                _monthlyOverlays[key] = serverEntries;
                _monthlyMeta[key] = allMonthlyData[key].meta || null;
            } else if (key === currentKey) {
                // Current month: merge — keep local edits (status, notes, star_note, row_color)
                // but use server as base and add any new entries
                const localOverlay = _monthlyOverlays[key];
                const localMap = {};
                localOverlay.forEach(e => { localMap[e.policyno] = e; });

                // Start from server entries, preserve local edits where they exist
                const PRESERVE_FIELDS = new Set(['status','note1','note2','note3','note4','note5',
                                                  'note6','note7','note8','note9','note10',
                                                  'due_months','star_note','row_color']);
                const merged = serverEntries.map(se => {
                    const local = localMap[se.policyno];
                    if (local) {
                        // Server base + local edits on top
                        const result = { ...se };
                        PRESERVE_FIELDS.forEach(f => {
                            if (local[f] !== undefined && local[f] !== '') {
                                result[f] = local[f];
                            }
                        });
                        return result;
                    }
                    return se;
                });
                _monthlyOverlays[key] = merged;
                if (allMonthlyData[key].meta) {
                    _monthlyMeta[key] = allMonthlyData[key].meta;
                }
            } else {
                // Non-current month: always replace with server data
                // (no risk of losing in-progress edits)
                _monthlyOverlays[key] = serverEntries;
                _monthlyMeta[key] = allMonthlyData[key].meta || null;
            }
        }

        // Remove local overlays for months that no longer exist on server
        for (const key in _monthlyOverlays) {
            if (!allMonthlyData[key]) {
                delete _monthlyOverlays[key];
                delete _monthlyMeta[key];
            }
        }

        _availableMonths = availableMonths || [];
        _bulkLoaded = true;
        saveToLocal();
        _notify('bulk');
    }

    /**
     * Set monthly overlay for a specific month (after generate or fresh fetch).
     * This comes from the server — always save to cache immediately.
     */
    function setMonthlyData(year, month, entries, meta) {
        const key = `${year}-${month}`;
        _monthlyOverlays[key] = entries || [];
        if (meta) _monthlyMeta[key] = meta;
        _lastServerSync = Date.now();
        _hasPendingEdits = false;
        _debouncedSave();
        _notify('monthly-set');
    }

    /**
     * Replace master policies (after fresh fetch).
     * This comes from the server — always save to cache immediately.
     */
    function setMasterData(policies) {
        _policies = policies || [];
        rebuildIndex();
        _lastServerSync = Date.now();
        _debouncedSave();
        _notify('master-set');
    }

    // ── Smart field sync ─────────────────────────────────────────────

    /**
     * Determine if a field edit should sync to master.
     * Rules:
     *   - notes (note1-note10): monthly only, never sync
     *   - status = "paid"/"due"/empty: monthly only
     *   - status = anything else (autodebit, etc.): sync to master
     *   - all other fields: always sync to master
     */
    function shouldSyncToMaster(field, value) {
        // Notes are always monthly-only
        if (MONTHLY_ONLY_FIELDS.has(field)) return false;
        
        // Status: "paid" and "due" (and empty) are monthly-only
        if (field === 'status') {
            const v = (value || '').trim().toLowerCase();
            return v !== '' && v !== 'paid' && v !== 'due';
        }
        
        // Everything else syncs
        return true;
    }

    /**
     * Update a field in the DataStore.
     * @param {string} context - 'monthly' or 'master'
     * @param {string} policyno - the policy number
     * @param {string} field - field name
     * @param {*} value - new value
     * @param {string} monthKey - e.g. "2026-7" (required for monthly context)
     * @param {number} entryId - monthly_entries.id or master_policies.id
     */
    function updateField(context, policyno, field, value, monthKey, entryId) {
        if (context === 'monthly') {
            // Update the monthly overlay
            const overlay = _monthlyOverlays[monthKey];
            if (overlay) {
                const entry = overlay.find(e => e.id === entryId || e.policyno === policyno);
                if (entry) entry[field] = value;
            }
            
            // Sync to master if rules say so
            if (shouldSyncToMaster(field, value)) {
                const idx = _policyIndex[policyno];
                if (idx !== undefined && _policies[idx]) {
                    _policies[idx][field] = value;
                }
            }
        } else {
            // Master context — update the policy directly
            const idx = _policyIndex[policyno];
            if (idx !== undefined && _policies[idx]) {
                _policies[idx][field] = value;
            }
        }
        
        _hasPendingEdits = true;
        _notify('update');
        // Debounced persist to localStorage so edits survive browser refresh
        _debouncedSave();
    }

    /**
     * Add a new entry (from extra row commit).
     */
    function addEntry(context, entry, monthKey) {
        if (context === 'master') {
            _policies.push(entry);
            rebuildIndex();
        } else if (monthKey) {
            if (!_monthlyOverlays[monthKey]) _monthlyOverlays[monthKey] = [];
            _monthlyOverlays[monthKey].push(entry);
            
            // Also add/update master if the policy doesn't exist there
            const idx = _policyIndex[entry.policyno];
            if (idx === undefined) {
                const masterEntry = { ...entry };
                // Remove monthly-only fields from master copy
                MONTHLY_ONLY_FIELDS.forEach(f => delete masterEntry[f]);
                const s = (masterEntry.status || '').toLowerCase();
                if (s === 'paid' || s === 'due' || s === '') delete masterEntry.status;
                _policies.push(masterEntry);
                rebuildIndex();
            }
        }
        _notify('add');
    }

    /**
     * Insert an entry at a specific index (for undo-delete restore).
     * @param {string} context - 'master' or 'monthly'
     * @param {Object} entry - the entry data
     * @param {number} index - position to insert at
     * @param {string} [monthKey] - e.g. "2026-7" (required for monthly)
     */
    function insertEntry(context, entry, index, monthKey) {
        if (context === 'master') {
            const pos = Math.min(index, _policies.length);
            _policies.splice(pos, 0, entry);
            rebuildIndex();
        } else if (monthKey) {
            if (!_monthlyOverlays[monthKey]) _monthlyOverlays[monthKey] = [];
            const arr = _monthlyOverlays[monthKey];
            const pos = Math.min(index, arr.length);
            arr.splice(pos, 0, entry);

            // Also add to master if not present
            const idx = _policyIndex[entry.policyno];
            if (idx === undefined) {
                const masterEntry = { ...entry };
                MONTHLY_ONLY_FIELDS.forEach(f => delete masterEntry[f]);
                const s = (masterEntry.status || '').toLowerCase();
                if (s === 'paid' || s === 'due' || s === '') delete masterEntry.status;
                _policies.push(masterEntry);
                rebuildIndex();
            }
        }
        _notify('insert');
    }

    /**
     * Remove an entry (delete row).
     * Always removes from master + all monthly overlays.
     */
    function removeEntry(policyno) {
        // Remove from master
        const idx = _policyIndex[policyno];
        if (idx !== undefined) {
            _policies.splice(idx, 1);
            rebuildIndex();
        }
        // Remove from all monthly overlays
        for (const key in _monthlyOverlays) {
            _monthlyOverlays[key] = _monthlyOverlays[key].filter(e => e.policyno !== policyno);
        }
        _notify('remove');
    }

    // ── Persistence (localStorage) ───────────────────────────────────

    function saveToLocal() {
        try {
            const now = new Date();
            const data = {
                policies: _policies,
                monthlyOverlays: _monthlyOverlays,
                monthlyMeta: _monthlyMeta,
                availableMonths: _availableMonths,
                savedAt: Date.now(),
                savedMonth: now.getMonth() + 1,
                savedYear: now.getFullYear(),
                lastServerSync: _lastServerSync
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.warn('DataStore: saveToLocal failed', e);
        }
    }

    function loadFromLocal() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            
            // Don't use stale data (older than CACHE_TTL — 4 hours)
            if (Date.now() - (data.savedAt || 0) > CACHE_TTL) {
                localStorage.removeItem(STORAGE_KEY);
                return false;
            }

            // Invalidate cache if the month has changed since it was saved
            // (e.g. cache from September should not be used in October)
            const now = new Date();
            const currentMonth = now.getMonth() + 1;
            const currentYear = now.getFullYear();
            if (data.savedMonth && data.savedYear) {
                if (data.savedMonth !== currentMonth || data.savedYear !== currentYear) {
                    console.info('DataStore: cache invalidated — month changed from',
                        data.savedMonth + '/' + data.savedYear, 'to', currentMonth + '/' + currentYear);
                    localStorage.removeItem(STORAGE_KEY);
                    return false;
                }
            }
            
            _policies = data.policies || [];
            _monthlyOverlays = data.monthlyOverlays || {};
            _monthlyMeta = data.monthlyMeta || {};
            _availableMonths = data.availableMonths || [];
            _lastServerSync = data.lastServerSync || 0;
            rebuildIndex();
            _ready = true;
            return true;
        } catch (e) {
            console.warn('DataStore: loadFromLocal failed', e);
            return false;
        }
    }

    /**
     * Migrate: clear old storage keys from previous versions.
     */
    function migrateOldStorage() {
        try {
            const oldKeys = ['os_datastore_v2', 'os_datastore_v1'];
            oldKeys.forEach(k => localStorage.removeItem(k));
        } catch (_) {}
    }
    migrateOldStorage();

    function clearLocal() {
        localStorage.removeItem(STORAGE_KEY);
    }

    // ── Listeners ────────────────────────────────────────────────────

    function onChange(callback) {
        _listeners.push(callback);
        return () => { _listeners = _listeners.filter(l => l !== callback); };
    }

    function _notify(reason) {
        _listeners.forEach(cb => { try { cb(reason); } catch (e) { console.warn('DataStore listener error', e); } });
    }

    // ── Utilities ────────────────────────────────────────────────────

    function getMonthMeta(year, month) {
        return _monthlyMeta[`${year}-${month}`] || null;
    }

    function hasMonthData(year, month) {
        return !!_monthlyOverlays[`${year}-${month}`];
    }

    function getAvailableMonths() {
        return _availableMonths;
    }

    function isReady() { return _ready; }
    function isBulkLoaded() { return _bulkLoaded; }
    function getPolicyCount() { return _policies.length; }
    function getLastServerSync() { return _lastServerSync; }
    function hasPendingEdits() { return _hasPendingEdits; }

    function getMonthlyEntryCount(year, month) {
        const overlay = _monthlyOverlays[`${year}-${month}`];
        return overlay ? overlay.length : 0;
    }

    /**
     * Check if local cache is stale and should be re-fetched from server.
     * Stale = last server sync was more than `maxAgeMs` ago (default 3 min).
     */
    function isStale(maxAgeMs = 180000) {
        if (!_lastServerSync) return true;
        return (Date.now() - _lastServerSync) > maxAgeMs;
    }

    // ── Public API ───────────────────────────────────────────────────
    return {
        // Views
        getView,
        getMonthlyView,
        getMasterView,
        
        // Data loading
        loadInitialData,
        loadBulkData,
        setMonthlyData,
        setMasterData,
        
        // Mutations
        updateField,
        addEntry,
        insertEntry,
        removeEntry,
        shouldSyncToMaster,
        
        // Persistence
        saveToLocal,
        loadFromLocal,
        clearLocal,
        
        // Listeners
        onChange,
        
        // Utilities
        getMonthMeta,
        hasMonthData,
        getAvailableMonths,
        isReady,
        isBulkLoaded,
        isStale,
        getPolicyCount,
        getLastServerSync,
        hasPendingEdits,
        getMonthlyEntryCount,
    };
})();
