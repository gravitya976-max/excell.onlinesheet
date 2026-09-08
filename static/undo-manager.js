/* ══════════════════════════════════════════════════════════════════════
   UndoManager v2 — Instant, Client-Side Undo/Redo for Online Sheet

   Key design:
   • 100% synchronous undo/redo — DataStore updated instantly, no awaits
   • API calls are fire-and-forget in the background (deferred sync)
   • Tracks ALL changes: cell edits, status changes, deletions
   • Works with Ctrl+Z/z and Ctrl+Y/y (case-insensitive)
   • Ctrl+Shift+Z also redoes
   • Shows toast feedback for each action
   ══════════════════════════════════════════════════════════════════════ */

const UndoManager = (() => {
    const _undoStack = [];
    const _redoStack = [];
    const MAX_HISTORY = 200;

    // Debounce: prevent rapid-fire undo/redo
    let _lastActionTime = 0;
    const DEBOUNCE_MS = 150; // faster than before

    // ── Action types ──────────────────────────────────────────────────
    const ACTION_EDIT   = 'edit';    // cell value changed
    const ACTION_STATUS = 'status';  // status changed
    const ACTION_DELETE = 'delete';  // row deleted

    /** Field labels for human-readable toast */
    const FIELD_LABELS = {
        status: 'Status', name: 'Name', policyno: 'Policy',
        doc: 'DOC', fup: 'FUP', sumass: 'Sum Assured',
        plan: 'Plan', mode: 'Mode', premium: 'Premium',
        mobileno: 'Mobile', due_months: 'Due Months',
    };
    for (let i = 1; i <= 10; i++) FIELD_LABELS[`note${i}`] = `Note ${i}`;

    const STATUS_LABELS = {
        '': 'Due', 'paid': 'Paid', 'autodebit': 'Auto Debit',
        'dailycollection': 'Daily Collection', 'branchpaid': 'Branch Paid',
        'notinforce': 'Not in Force',
    };

    function _fieldLabel(field) {
        return FIELD_LABELS[field] || field;
    }

    function _truncate(val, max = 20) {
        const s = String(val || '').trim();
        if (!s) return '(empty)';
        return s.length > max ? s.slice(0, max) + '...' : s;
    }

    function _statusLabel(val) {
        return STATUS_LABELS[(val || '').toLowerCase()] || val || 'Due';
    }

    // ── Record edit ──────────────────────────────────────────────────
    /**
     * Record a cell edit or status change.
     * @param {Object} opts
     * @param {number} opts.entryId   - row id (monthly_entries.id or master_policies.id)
     * @param {string} opts.field     - column key (e.g. 'name', 'status', 'note1')
     * @param {string} opts.oldValue  - value before edit
     * @param {string} opts.newValue  - value after edit
     * @param {string} opts.tab       - 'master' or 'list'
     * @param {string} [opts.policyno] - for display in toast
     */
    function record(opts) {
        if (opts.oldValue === opts.newValue) return; // no-op
        const actionType = opts.field === 'status' ? ACTION_STATUS : ACTION_EDIT;
        _undoStack.push({
            type: actionType,
            entryId: opts.entryId,
            field: opts.field,
            oldValue: opts.oldValue,
            newValue: opts.newValue,
            tab: opts.tab || App.state.activeTab,
            policyno: opts.policyno || '',
            timestamp: Date.now(),
        });
        if (_undoStack.length > MAX_HISTORY) _undoStack.shift();
        _redoStack.length = 0; // new edit clears redo
    }

    // ── Record deletion ──────────────────────────────────────────────
    /**
     * Record a row deletion (for undo-ability).
     * @param {Object} opts
     * @param {number} opts.entryId   - the deleted entry's id
     * @param {Object} opts.entryData - full snapshot of the deleted entry
     * @param {string} opts.tab       - 'master' or 'list'
     * @param {string} opts.policyno  - policy number
     * @param {number} [opts.rowIndex] - original visual row index
     */
    function recordDelete(opts) {
        // Save the original position indices for precise undo
        const entryData = { ...opts.entryData };
        const masterIndex = entryData._rowIndex !== undefined ? entryData._rowIndex : -1;

        // For monthly tab, find the monthly overlay index
        let monthlyIndex = -1;
        if (opts.tab === 'list' || opts.tab !== 'master') {
            const monthKey = `${App.state.year}-${App.state.month}`;
            const view = DataStore.getMonthlyView(App.state.year, App.state.month);
            monthlyIndex = view.findIndex(e => (e._monthlyId || e.id) === opts.entryId || e.policyno === opts.policyno);
            if (monthlyIndex === -1) monthlyIndex = masterIndex;
        }

        _undoStack.push({
            type: ACTION_DELETE,
            entryId: opts.entryId,
            entryData: entryData,
            tab: opts.tab || App.state.activeTab,
            policyno: opts.policyno || '',
            masterIndex: masterIndex,
            monthlyIndex: monthlyIndex,
            year: App.state.year,
            month: App.state.month,
            timestamp: Date.now(),
        });
        if (_undoStack.length > MAX_HISTORY) _undoStack.shift();
        _redoStack.length = 0;
    }

    // ── Apply (instant, synchronous DataStore update) ──────────────
    function _applyEdit(action, value) {
        const { entryId, field, tab } = action;

        // 1. Update DataStore instantly (synchronous, no await)
        if (tab === 'master') {
            // Find the entry to get policyno
            const entries = App.getEntries();
            const entry = entries.find(e => e.id === entryId);
            if (entry) {
                DataStore.updateField('master', entry.policyno, field, value);
                entry[field] = value;
            }
        } else {
            const entries = App.getEntries();
            const entry = entries.find(e => (e._monthlyId || e.id) === entryId);
            if (entry) {
                const monthKey = `${App.state.year}-${App.state.month}`;
                DataStore.updateField('monthly', entry.policyno || entry._masterPolicyno, field, value, monthKey, entryId);
                entry[field] = value;
            }
        }

        // 2. Update visible DOM cell instantly
        const tr = document.querySelector(`tr[data-entry-id="${entryId}"]`);
        if (tr) {
            if (field === 'row_color') {
                // Special case — row_color is not a COLUMNS field, apply inline bg directly
                const ROW_COLORS = typeof Spreadsheet !== 'undefined' ? Spreadsheet.ROW_COLORS : {};
                const bg = (value && ROW_COLORS[value]) ? ROW_COLORS[value] : '';
                tr.style.backgroundColor = bg;
                tr.querySelectorAll('td').forEach(td => { td.style.backgroundColor = bg; });
                if (bg) tr.dataset.rowColor = value; else delete tr.dataset.rowColor;
            } else {
                const cols = typeof Spreadsheet !== 'undefined' ? Spreadsheet.getActiveCols() : [];
                const col = cols.find(c => c.key === field);
                if (col) {
                    const td = tr.querySelector(`td[data-field="${field}"]`);
                    if (td && typeof Spreadsheet !== 'undefined') {
                        Spreadsheet.restoreCell(td, col, { [field]: value }, value);
                        if (field === 'status') {
                            Spreadsheet._addStatusClass(td, value);
                        }
                    }
                }
            }
        }

        // 3. Fire-and-forget API call in background (no await, no blocking)
        _syncToServer(entryId, field, value, tab);
    }

    /** Fire-and-forget API sync — errors are silently queued offline */
    function _syncToServer(entryId, field, value, tab) {
        const url = tab === 'master'
            ? `/api/master/${entryId}`
            : `/api/entry/${entryId}`;
        const body = { [field]: value };

        if (!navigator.onLine) {
            if (typeof OfflineQueue !== 'undefined') {
                OfflineQueue.enqueue('PUT', url, body);
            }
            return;
        }

        App.api('PUT', url, body).catch(() => {
            // Network failed — queue it
            if (typeof OfflineQueue !== 'undefined') {
                OfflineQueue.enqueue('PUT', url, body);
            }
        });
    }

    // ── Undo deletion (re-add the row at original position) ──────
    function _undoDelete(action) {
        const { entryData, tab, policyno, masterIndex, monthlyIndex } = action;
        const cleanData = { ...entryData };

        // Clean internal fields before re-adding
        delete cleanData._monthlyId;
        delete cleanData._masterPolicyno;
        delete cleanData._rowIndex;
        delete cleanData._local;

        // Always re-add to master at original position
        const masterCopy = { ...cleanData };
        ['note1','note2','note3','note4','note5','note6','note7','note8','note9','note10','due_months','list_id','fup_day'].forEach(f => delete masterCopy[f]);
        const mIdx = masterIndex >= 0 ? masterIndex : undefined;
        if (mIdx !== undefined) {
            DataStore.insertEntry('master', masterCopy, mIdx);
        } else {
            DataStore.addEntry('master', masterCopy);
        }

        // Also re-add to monthly overlay at original position
        if (tab === 'list' || entryData._monthlyId) {
            const monthKey = `${action.year}-${action.month}`;
            const monthlyCopy = { ...cleanData };
            if (entryData._monthlyId) monthlyCopy.id = entryData._monthlyId;
            const moIdx = monthlyIndex >= 0 ? monthlyIndex : undefined;
            if (moIdx !== undefined) {
                DataStore.insertEntry('monthly', monthlyCopy, moIdx, monthKey);
            } else {
                DataStore.addEntry('monthly', monthlyCopy, monthKey);
            }
        }

        // Re-render view
        App.renderCurrentView();

        // Fire-and-forget: re-create on server via master/new (handles both)
        const apiBody = { ...cleanData };
        delete apiBody.id;
        delete apiBody.updated_at;
        delete apiBody.list_id;

        // Add to master first
        const masterUrl = '/api/master/new';
        const masterPost = !navigator.onLine
            ? (typeof OfflineQueue !== 'undefined' && OfflineQueue.enqueue('POST', masterUrl, apiBody), Promise.resolve())
            : App.api('POST', masterUrl, apiBody).catch(() => {
                if (typeof OfflineQueue !== 'undefined') OfflineQueue.enqueue('POST', masterUrl, apiBody);
            });

        // If monthly tab, also add to the monthly list
        if (tab === 'list' || entryData._monthlyId) {
            const monthlyUrl = `/api/list/${App.state.year}/${App.state.month}/new`;
            masterPost.then(() => {
                if (!navigator.onLine) {
                    if (typeof OfflineQueue !== 'undefined') OfflineQueue.enqueue('POST', monthlyUrl, apiBody);
                    return;
                }
                App.api('POST', monthlyUrl, apiBody).catch(() => {
                    if (typeof OfflineQueue !== 'undefined') OfflineQueue.enqueue('POST', monthlyUrl, apiBody);
                });
            });
        }
    }

    // ── Redo deletion (re-delete the row from both) ───────────────
    function _redoDelete(action) {
        const { policyno } = action;

        // Find current entry id before removing (it may have new id after re-add)
        const entries = App.getEntries();
        const entry = entries.find(e => (e.policyno || e._masterPolicyno) === policyno);
        const entryId = entry ? (entry._monthlyId || entry.id) : action.entryId;

        // Remove from DataStore instantly (removes from master + all monthly)
        DataStore.removeEntry(policyno);
        App.renderCurrentView();

        // Fire-and-forget API delete (backend removes from both tables)
        const table = action.tab === 'master' ? 'master' : 'monthly';
        const url = `/api/entry/${entryId}?table=${table}`;

        if (!navigator.onLine) {
            if (typeof OfflineQueue !== 'undefined') OfflineQueue.enqueue('DELETE', url, null);
            return;
        }
        App.api('DELETE', url).catch(() => {
            if (typeof OfflineQueue !== 'undefined') OfflineQueue.enqueue('DELETE', url, null);
        });
    }

    // ── Undo ─────────────────────────────────────────────────────────
    function undo() {
        const now = Date.now();
        if (now - _lastActionTime < DEBOUNCE_MS) return;
        _lastActionTime = now;

        if (_undoStack.length === 0) {
            App.toast('Nothing to undo', 'info', 1200);
            return;
        }

        const action = _undoStack.pop();

        if (action.type === ACTION_DELETE) {
            // Undo delete = re-add the row
            _undoDelete(action);
            _redoStack.push(action);
            App.toast(`Undo delete: ${action.policyno}`, 'success', 1500);
            return;
        }

        // Edit / Status undo — restore old value
        _applyEdit(action, action.oldValue);
        _redoStack.push(action);

        if (action.type === ACTION_STATUS) {
            App.toast(
                `Undo ${_fieldLabel(action.field)}: ${_statusLabel(action.oldValue)}`,
                'success', 1500
            );
            // Re-sort NIF if needed
            if (typeof Spreadsheet !== 'undefined' && Spreadsheet.onStatusChange) {
                Spreadsheet.resortEntries();
            }
        } else {
            App.toast(
                `Undo ${_fieldLabel(action.field)}: ${_truncate(action.oldValue)}`,
                'success', 1500
            );
        }
    }

    // ── Redo ─────────────────────────────────────────────────────────
    function redo() {
        const now = Date.now();
        if (now - _lastActionTime < DEBOUNCE_MS) return;
        _lastActionTime = now;

        if (_redoStack.length === 0) {
            App.toast('Nothing to redo', 'info', 1200);
            return;
        }

        const action = _redoStack.pop();

        if (action.type === ACTION_DELETE) {
            // Redo delete = re-delete the row
            _redoDelete(action);
            _undoStack.push(action);
            App.toast(`Redo delete: ${action.policyno}`, 'success', 1500);
            return;
        }

        // Edit / Status redo — apply new value
        _applyEdit(action, action.newValue);
        _undoStack.push(action);

        if (action.type === ACTION_STATUS) {
            App.toast(
                `Redo ${_fieldLabel(action.field)}: ${_statusLabel(action.newValue)}`,
                'success', 1500
            );
            if (typeof Spreadsheet !== 'undefined' && Spreadsheet.onStatusChange) {
                Spreadsheet.resortEntries();
            }
        } else {
            App.toast(
                `Redo ${_fieldLabel(action.field)}: ${_truncate(action.newValue)}`,
                'success', 1500
            );
        }
    }

    // ── Keyboard binding (case-insensitive Z/z and Y/y) ─────────────
    function initKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Don't intercept when user is typing in an input/textarea
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

            // Ctrl+Z/z = undo, Ctrl+Shift+Z/z or Ctrl+Y/y = redo
            if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                const key = e.key.toLowerCase();
                if (key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    undo();
                } else if (key === 'z' && e.shiftKey) {
                    e.preventDefault();
                    redo();
                } else if (key === 'y') {
                    e.preventDefault();
                    redo();
                }
            }
        });
    }

    // ── Status ───────────────────────────────────────────────────────
    function canUndo() { return _undoStack.length > 0; }
    function canRedo() { return _redoStack.length > 0; }
    function undoCount() { return _undoStack.length; }
    function redoCount() { return _redoStack.length; }
    function clear() { _undoStack.length = 0; _redoStack.length = 0; }

    // ── Public API ───────────────────────────────────────────────────
    return {
        record,
        recordDelete,
        undo,
        redo,
        initKeyboard,
        canUndo,
        canRedo,
        undoCount,
        redoCount,
        clear,
    };
})();
