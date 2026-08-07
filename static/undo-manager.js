/* ══════════════════════════════════════════════════════════════════════
   UndoManager — Centralized Undo/Redo for Online Sheet
   
   A standalone module that:
   • Records every cell edit (value change, status change, note edit)
   • Supports Ctrl+Z (undo) and Ctrl+Y / Ctrl+Shift+Z (redo)
   • Shows toast with what was undone/redone (field + old → new)
   • Debounces rapid undo presses to avoid double-firing
   • Works across tabs (master + monthly)
   ══════════════════════════════════════════════════════════════════════ */

const UndoManager = (() => {
    const _undoStack = [];
    const _redoStack = [];
    const MAX_HISTORY = 100;

    // Debounce: prevent rapid-fire undo/redo
    let _lastActionTime = 0;
    const DEBOUNCE_MS = 300;

    /** Field labels for human-readable toast */
    const FIELD_LABELS = {
        status: 'Status', name: 'Name', policyno: 'Policy',
        doc: 'DOC', fup: 'FUP', sumass: 'Sum Assured',
        plan: 'Plan', mode: 'Mode', premium: 'Premium',
        mobileno: 'Mobile', due_months: 'Due Months',
    };
    for (let i = 1; i <= 10; i++) FIELD_LABELS[`note${i}`] = `Note ${i}`;

    function _fieldLabel(field) {
        return FIELD_LABELS[field] || field;
    }

    function _truncate(val, max = 20) {
        const s = String(val || '').trim();
        if (!s) return '(empty)';
        return s.length > max ? s.slice(0, max) + '…' : s;
    }

    // ── Record ───────────────────────────────────────────────────────
    /**
     * Record an edit action.
     * @param {Object} opts
     * @param {number} opts.entryId - row id
     * @param {string} opts.field   - column key
     * @param {string} opts.oldValue - value before edit
     * @param {string} opts.newValue - value after edit
     * @param {string} opts.tab     - 'master' | 'monthly'
     * @param {string} [opts.policyno] - for display
     */
    function record(opts) {
        if (opts.oldValue === opts.newValue) return; // no-op
        _undoStack.push({
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

    // ── Apply (shared by undo/redo) ──────────────────────────────────
    async function _apply(action, value, direction) {
        const { entryId, field, tab } = action;
        let ok;
        if (tab === 'master') {
            ok = await App.updateMasterEntry(entryId, field, value);
        } else {
            ok = await App.updateEntry(entryId, field, value);
        }
        if (!ok) {
            App.toast(`${direction} failed`, 'error', 2000);
            return false;
        }

        // Update DOM cell if visible
        const tr = document.querySelector(`tr[data-entry-id="${entryId}"]`);
        if (tr) {
            const cols = typeof Spreadsheet !== 'undefined' ? Spreadsheet.getActiveCols() : [];
            const col = cols.find(c => c.key === field);
            if (col) {
                const td = tr.querySelector(`td[data-field="${field}"]`);
                if (td && typeof Spreadsheet !== 'undefined') {
                    Spreadsheet.restoreCell(td, col, { [field]: value }, value);
                }
            }
        }
        return true;
    }

    // ── Undo ─────────────────────────────────────────────────────────
    async function undo() {
        const now = Date.now();
        if (now - _lastActionTime < DEBOUNCE_MS) return;
        _lastActionTime = now;

        if (_undoStack.length === 0) {
            App.toast('Nothing to undo', 'info', 1200);
            return;
        }

        const action = _undoStack.pop();
        const ok = await _apply(action, action.oldValue, 'Undo');
        if (ok) {
            _redoStack.push(action);
            App.toast(
                `↩ Undo ${_fieldLabel(action.field)}: ${_truncate(action.oldValue)}`,
                'success', 1500
            );
        } else {
            // Put it back if failed
            _undoStack.push(action);
        }
    }

    // ── Redo ─────────────────────────────────────────────────────────
    async function redo() {
        const now = Date.now();
        if (now - _lastActionTime < DEBOUNCE_MS) return;
        _lastActionTime = now;

        if (_redoStack.length === 0) {
            App.toast('Nothing to redo', 'info', 1200);
            return;
        }

        const action = _redoStack.pop();
        const ok = await _apply(action, action.newValue, 'Redo');
        if (ok) {
            _undoStack.push(action);
            App.toast(
                `↪ Redo ${_fieldLabel(action.field)}: ${_truncate(action.newValue)}`,
                'success', 1500
            );
        } else {
            _redoStack.push(action);
        }
    }

    // ── Keyboard binding ─────────────────────────────────────────────
    function initKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Don't intercept when user is typing in an input/textarea
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

            // Ctrl+Z = undo, Ctrl+Shift+Z or Ctrl+Y = redo
            if ((e.ctrlKey || e.metaKey) && !e.altKey) {
                if (e.key === 'z' && !e.shiftKey) {
                    e.preventDefault();
                    undo();
                } else if (e.key === 'z' && e.shiftKey) {
                    e.preventDefault();
                    redo();
                } else if (e.key === 'y') {
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
