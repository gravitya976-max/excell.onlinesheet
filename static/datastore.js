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

    const STORAGE_KEY = 'os_datastore_v2';
    const MONTHLY_ONLY_FIELDS = new Set(['note1','note2','note3','note4','note5',
                                          'note6','note7','note8','note9','note10']);

    // ── Policies index for O(1) lookup ───────────────────────────────
    let _policyIndex = {};  // { policyno: index_in_policies }

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
        // allMonthlyData = { "2026-7": [...], "2026-6": [...], ... }
        for (const key in allMonthlyData) {
            // Don't overwrite if already loaded (user might have edited)
            if (!_monthlyOverlays[key]) {
                _monthlyOverlays[key] = allMonthlyData[key].entries || [];
                _monthlyMeta[key] = allMonthlyData[key].meta || null;
            }
        }
        _availableMonths = availableMonths || [];
        _bulkLoaded = true;
        saveToLocal();
        _notify('bulk');
    }

    /**
     * Set monthly overlay for a specific month (after generate or fresh fetch).
     */
    function setMonthlyData(year, month, entries, meta) {
        const key = `${year}-${month}`;
        _monthlyOverlays[key] = entries || [];
        if (meta) _monthlyMeta[key] = meta;
        _notify('monthly-set');
    }

    /**
     * Replace master policies (after fresh fetch).
     */
    function setMasterData(policies) {
        _policies = policies || [];
        rebuildIndex();
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
        
        _notify('update');
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
            const data = {
                policies: _policies,
                monthlyOverlays: _monthlyOverlays,
                monthlyMeta: _monthlyMeta,
                availableMonths: _availableMonths,
                savedAt: Date.now()
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // Storage full or unavailable — silently skip
        }
    }

    function loadFromLocal() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            
            // Don't use stale data (older than 1 hour)
            if (Date.now() - (data.savedAt || 0) > 3600000) {
                localStorage.removeItem(STORAGE_KEY);
                return false;
            }
            
            _policies = data.policies || [];
            _monthlyOverlays = data.monthlyOverlays || {};
            _monthlyMeta = data.monthlyMeta || {};
            _availableMonths = data.availableMonths || [];
            rebuildIndex();
            _ready = true;
            return true;
        } catch {
            return false;
        }
    }

    function clearLocal() {
        localStorage.removeItem(STORAGE_KEY);
    }

    // ── Listeners ────────────────────────────────────────────────────

    function onChange(callback) {
        _listeners.push(callback);
        return () => { _listeners = _listeners.filter(l => l !== callback); };
    }

    function _notify(reason) {
        _listeners.forEach(cb => { try { cb(reason); } catch {} });
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

    function getMonthlyEntryCount(year, month) {
        const overlay = _monthlyOverlays[`${year}-${month}`];
        return overlay ? overlay.length : 0;
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
        getPolicyCount,
        getMonthlyEntryCount,
    };
})();
