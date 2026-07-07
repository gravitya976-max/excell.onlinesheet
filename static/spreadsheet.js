/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Spreadsheet Rendering & Inline Editing (v2)

   INTERACTIONS:
     • Hover row + Ctrl+C            →  copy policy number
     • Single RIGHT-CLICK on a cell  →  edit that cell
     • Double LEFT-CLICK a header    →  rename the header

   FEATURES:
     • Master data is fully editable (except policy number)
     • Policy number is selectable but never editable
     • Undo stack: Ctrl+Z reverses edits one by one
     • Event delegation for high performance
     • Smooth rendering with DocumentFragment
   ══════════════════════════════════════════════════════════════════════ */

const Spreadsheet = (() => {
    const COLUMNS = [
        { key: 'sn',        label: '#',            editable: false, type: 'index' },
        { key: 'policyno',  label: 'Policy No',    editable: false, type: 'text' },
        { key: 'name',      label: 'Name',          editable: true,  type: 'text' },
        { key: 'doc',       label: 'DOC',           editable: true,  type: 'text' },
        { key: 'fup',       label: 'FUP',           editable: true,  type: 'text' },
        { key: 'sumass',    label: 'Sum Assured',    editable: true,  type: 'text' },
        { key: 'plan',      label: 'Plan',           editable: true,  type: 'text' },
        { key: 'mode',      label: 'Mode',           editable: true,  type: 'text' },
        { key: 'premium',   label: 'Premium',        editable: true,  type: 'text' },
        { key: 'mobileno',  label: 'Mobile No',      editable: true,  type: 'text' },
        { key: 'status',    label: 'Status',          editable: true,  type: 'status' },
    ];

    const EXTRA_COL_COUNT = 10;
    for (let i = 1; i <= EXTRA_COL_COUNT; i++) {
        COLUMNS.push({ key: `note${i}`, label: `Note ${i}`, editable: true, type: 'text' });
    }

    const EXTRA_ROWS = 10;
    const STATUS_OPTIONS = ['', 'paid', 'autodebit', 'dailycollection', 'branchpaid'];
    const STATUS_LABELS = { '': 'Due', 'paid': 'Paid', 'autodebit': 'Auto Debit', 'dailycollection': 'Daily Collection', 'branchpaid': 'Branch Paid' };

    let currentEditCell = null;

    /* ── Persisted settings ──────────────────────────────────────────── */
    const STORAGE_KEY_COL = 'os_col_widths';
    const STORAGE_KEY_HDR = 'os_header_names';
    const STORAGE_KEY_ROW = 'os_row_heights';
    const DEFAULT_WIDTHS = { sn: 45, policyno: 130, name: 180, doc: 100, fup: 100, sumass: 110, plan: 120, mode: 80, premium: 100, mobileno: 120, status: 120 };
    for (let i = 1; i <= EXTRA_COL_COUNT; i++) DEFAULT_WIDTHS[`note${i}`] = 120;

    let colWidths = { ...DEFAULT_WIDTHS };
    let headerNames = {};
    let rowHeights = {};

    function loadColWidths()   { try { const s = localStorage.getItem(STORAGE_KEY_COL); if (s) colWidths   = { ...DEFAULT_WIDTHS, ...JSON.parse(s) }; } catch {} }
    function saveColWidths()   { try { localStorage.setItem(STORAGE_KEY_COL, JSON.stringify(colWidths));   } catch {} }
    function loadHeaderNames() { try { const s = localStorage.getItem(STORAGE_KEY_HDR); if (s) headerNames = JSON.parse(s); } catch {} }
    function saveHeaderNames() { try { localStorage.setItem(STORAGE_KEY_HDR, JSON.stringify(headerNames)); } catch {} }
    function loadRowHeights()  { try { const s = localStorage.getItem(STORAGE_KEY_ROW); if (s) rowHeights  = JSON.parse(s); } catch {} }
    function saveRowHeights()  { try { localStorage.setItem(STORAGE_KEY_ROW, JSON.stringify(rowHeights));  } catch {} }
    function getHeaderLabel(col) { return headerNames[col.key] || col.label; }

    let _colEls = {};

    /* ── Sheet Cache ─────────────────────────────────────────────────── */
    const _sheetCache = {};
    let _currentSheetKey = null;

    /* ── Hovered row tracking (for Ctrl+C) ───────────────────────────── */
    let _hoveredRow = null;

    /* ── Undo Stack ──────────────────────────────────────────────────── */
    const _undoStack = [];
    const MAX_UNDO = 100;

    function pushUndo(entryId, field, oldValue, newValue) {
        _undoStack.push({
            entryId,
            field,
            oldValue,
            newValue,
            tab: App.state.activeTab,
            timestamp: Date.now(),
        });
        if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    }

    async function undo() {
        if (_undoStack.length === 0) {
            if (typeof App !== 'undefined') App.toast('Nothing to undo', 'info', 1500);
            return;
        }
        const action = _undoStack.pop();
        const { entryId, field, oldValue, tab } = action;

        // Call the appropriate API to revert
        let ok;
        if (tab === 'master') {
            ok = await App.updateMasterEntry(entryId, field, oldValue);
        } else {
            ok = await App.updateEntry(entryId, field, oldValue);
        }

        if (ok) {
            // Update the cell in DOM if visible
            const tr = document.querySelector(`tr[data-entry-id="${entryId}"]`);
            if (tr) {
                const col = COLUMNS.find(c => c.key === field);
                if (col) {
                    const td = tr.querySelector(`td[data-field="${field}"]`);
                    if (td) {
                        const entry = App.state.entries.find(e => e.id === entryId);
                        if (entry) {
                            entry[field] = oldValue;
                            restoreCellDisplay(td, col, entry, oldValue);
                        }
                    }
                }
            }
            if (typeof App !== 'undefined') App.toast('↩ Undo done', 'success', 1500);
        }
    }

    /* ── Colgroup ────────────────────────────────────────────────────── */
    function buildColgroup() {
        const table = document.getElementById('spreadsheet');
        const old = table.querySelector('colgroup');
        if (old) old.remove();
        const isMaster = App.state.activeTab === 'master';
        const activeCols = isMaster ? COLUMNS.filter(c => c.key !== 'status') : COLUMNS;
        const colgroup = document.createElement('colgroup');
        activeCols.forEach(col => {
            const colEl = document.createElement('col');
            colEl.style.width = colWidths[col.key] + 'px';
            _colEls[col.key] = colEl;
            colgroup.appendChild(colEl);
        });
        table.prepend(colgroup);
        updateTableWidth();
    }

    function updateTableWidth() {
        const table = document.getElementById('spreadsheet');
        const isMaster = App.state.activeTab === 'master';
        const activeCols = isMaster ? COLUMNS.filter(c => c.key !== 'status') : COLUMNS;
        table.style.width = activeCols.reduce((s, c) => s + (colWidths[c.key] || 100), 0) + 'px';
    }

    /* ── Header ──────────────────────────────────────────────────────── */
    function renderHeader() {
        const headerRow = document.getElementById('header-row');
        headerRow.innerHTML = '';
        const isMaster = App.state.activeTab === 'master';
        const activeCols = isMaster ? COLUMNS.filter(c => c.key !== 'status') : COLUMNS;
        activeCols.forEach(col => {
            const th = document.createElement('th');
            th.className = `col-${col.key}`;
            const labelSpan = document.createElement('span');
            labelSpan.className = 'header-label';
            labelSpan.textContent = getHeaderLabel(col);
            th.appendChild(labelSpan);
            th.addEventListener('dblclick', (e) => { e.stopPropagation(); startHeaderEdit(th, col, labelSpan); });
            const handle = document.createElement('div');
            handle.className = 'col-resize-handle';
            handle.addEventListener('mousedown', (e) => startColResize(e, col.key));
            th.appendChild(handle);
            headerRow.appendChild(th);
        });
    }

    function startHeaderEdit(th, col, labelSpan) {
        if (th.querySelector('.header-input')) return;
        const current = getHeaderLabel(col);
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'header-input'; input.value = current;
        labelSpan.style.display = 'none';
        th.insertBefore(input, labelSpan);
        input.focus(); input.select();
        function save() {
            const n = input.value.trim() || col.label;
            headerNames[col.key] = n; saveHeaderNames();
            labelSpan.textContent = n; labelSpan.style.display = ''; input.remove();
            if (typeof App !== 'undefined') App.toast(`Header → "${n}"`, 'success', 1500);
        }
        input.addEventListener('blur', save);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = current; input.blur(); }
        });
    }

    /* ── Column resize ───────────────────────────────────────────────── */
    function startColResize(e, colKey) {
        e.preventDefault(); e.stopPropagation();
        const colEl = _colEls[colKey]; if (!colEl) return;
        const startX = e.clientX, startW = colWidths[colKey] || 100;
        document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
        const onMove = (ev) => { const w = Math.max(30, startW + ev.clientX - startX); colEl.style.width = w + 'px'; colWidths[colKey] = w; updateTableWidth(); };
        const onUp = () => { saveColWidths(); document.body.style.cursor = ''; document.body.style.userSelect = ''; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    }

    /* ── Row resize ──────────────────────────────────────────────────── */
    function startRowResize(e, rowIdx, tr) {
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY, startH = tr.offsetHeight;
        document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none';
        const onMove = (ev) => { const h = Math.max(24, startH + ev.clientY - startY); tr.style.height = h + 'px'; tr.querySelectorAll('td').forEach(td => td.style.height = h + 'px'); };
        const onUp = () => {
            rowHeights[rowIdx] = parseInt(tr.style.height) || 34;
            saveRowHeights();
            document.body.style.cursor = ''; document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    }

    /* ════════════════════════════════════════════════════════════════════
       COPY POLICY NUMBER (called by Ctrl+C handler)
       ════════════════════════════════════════════════════════════════════ */
    function copyPolicyNo(tr) {
        const pIdx = COLUMNS.findIndex(c => c.key === 'policyno');
        if (pIdx === -1) return;
        const td = tr.children[pIdx];
        if (!td) return;
        const pno = (td.textContent || '').trim();
        if (!pno) return;

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(pno).then(() => showCopyFeedback(tr, pno)).catch(() => fallbackCopy(pno, tr));
        } else {
            fallbackCopy(pno, tr);
        }
    }

    function fallbackCopy(text, tr) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showCopyFeedback(tr, text); } catch {}
        ta.remove();
    }

    function showCopyFeedback(tr, pno) {
        document.querySelectorAll('tr.copied-row').forEach(r => r.classList.remove('copied-row'));
        tr.classList.add('copied-row');
        setTimeout(() => tr.classList.remove('copied-row'), 3000);
        if (typeof App !== 'undefined') App.toast(`Copied: ${pno}`, 'success', 1500);
    }

    // ── Extra (blank) editable rows — always 10 after real data ──────
    const extraRowData = {};

    function commitExtraRow(idx) {
        const data = extraRowData[idx] || {};
        const pno = (data.policyno || '').trim();
        if (!pno) return;

        const activeTab = App.state.activeTab;
        let url;
        if (activeTab === 'master') {
            url = '/api/master/new';
        } else {
            const s = App.state;
            url = `/api/list/${s.year}/${s.month}/new`;
        }

        App.api('POST', url, { ...data, policyno: pno })
            .then(res => {
                const label = activeTab === 'master' ? 'master data' : 'monthly list';
                let msg = `✓ Policy ${pno} saved to ${label}`;
                if (res.added_to_master) msg += ' + master data';
                App.toast(msg, 'success', 4000);
                App.reloadActive();
            })
            .catch(err => App.toast(`Save failed: ${err.message}`, 'error'));
    }

    function closeActiveEdit() {
        if (currentEditCell) {
            const inp = currentEditCell.querySelector('input.cell-input, select.cell-input');
            if (inp) inp.blur();
        }
    }

    /* ════════════════════════════════════════════════════════════════════
       BUILD FRAGMENT — Create all rows off-screen in a DocumentFragment
       ════════════════════════════════════════════════════════════════════ */
    function buildFragment(entries) {
        const frag = document.createDocumentFragment();
        const isMaster = App.state.activeTab === 'master';

        entries.forEach((entry, idx) => frag.appendChild(createDataRow(entry, idx, isMaster)));

        // Extra blank rows — navigable just like data rows
        const extraActiveCols = isMaster ? COLUMNS.filter(c => c.key !== 'status') : COLUMNS;
        for (let i = 0; i < EXTRA_ROWS; i++) {
            const rowIdx = entries.length + i;
            const extraIdx = i;
            const tr = document.createElement('tr');
            tr.className = 'extra-row';
            tr.dataset.extraIdx = extraIdx;
            if (rowHeights[rowIdx]) tr.style.height = rowHeights[rowIdx] + 'px';

            extraActiveCols.forEach(col => {
                const td = document.createElement('td');
                td.className = `col-${col.key}`;
                if (rowHeights[rowIdx]) td.style.height = rowHeights[rowIdx] + 'px';

                if (col.type === 'index') {
                    td.classList.add('locked', 'sn-delete');
                    td.dataset.extraIdx = extraIdx;
                    td.style.position = 'relative';
                    td.style.cursor = 'pointer';
                    const span = document.createElement('span');
                    span.className = 'cell-content';
                    span.textContent = entries.length + i + 1;
                    td.appendChild(span);
                    const rh = document.createElement('div');
                    rh.className = 'row-resize-handle';
                    rh.addEventListener('mousedown', (e) => startRowResize(e, rowIdx, tr));
                    td.appendChild(rh);
                } else {
                    // All non-index cells are editable+selectable, just like data rows
                    td.classList.add('editable');
                    td.dataset.field = col.key;
                    td.dataset.extraIdx = extraIdx;

                    const span = document.createElement('span');
                    span.className = 'cell-content';
                    if (col.type === 'status') {
                        const val = (extraRowData[extraIdx] || {})[col.key] || '';
                        // Only show status label if a value was explicitly set
                        if (val) {
                            span.textContent = STATUS_LABELS[val] || val;
                            addStatusClass(td, val);
                        }
                    } else {
                        span.textContent = (extraRowData[extraIdx] || {})[col.key] || '';
                    }
                    td.appendChild(span);
                }
                tr.appendChild(td);
            });
            frag.appendChild(tr);
        }

        return frag;
    }

    /* ════════════════════════════════════════════════════════════════════
       RENDER — The main entry point. Builds off-screen, swaps instantly.
       ════════════════════════════════════════════════════════════════════ */
    function render(entries, options = {}) {
        const { sheetKey = 'default', animate = true } = options;

        loadColWidths(); loadHeaderNames(); loadRowHeights();
        buildColgroup(); renderHeader();

        const tbody = document.getElementById('spreadsheet-body');

        // Deselect any navigation before swapping
        if (typeof Navigation !== 'undefined') Navigation.deselectCell();
        closeActiveEdit();

        // Clear extra row data when switching sheets
        if (_currentSheetKey !== sheetKey) {
            for (const k in extraRowData) delete extraRowData[k];
        }

        // Build the fragment (always fresh — entries may have changed)
        const frag = buildFragment(entries);

        // Instant swap: clear + append in one go (no blink)
        tbody.innerHTML = '';
        tbody.appendChild(frag);
        _currentSheetKey = sheetKey;
    }

    /* ── Invalidate cache ────────────────────────────────────────────── */
    function invalidateCache(sheetKey) {
        if (sheetKey) {
            delete _sheetCache[sheetKey];
        } else {
            for (const k in _sheetCache) delete _sheetCache[k];
        }
    }

    function getCurrentSheetKey() {
        return _currentSheetKey;
    }

    /* ════════════════════════════════════════════════════════════════════
       CREATE DATA ROW
       isMaster: when true, all fields (except policyno/sn) are editable
       ════════════════════════════════════════════════════════════════════ */
    function createDataRow(entry, idx, isMaster) {
        const tr = document.createElement('tr');
        tr.dataset.entryId = entry.id;
        if (rowHeights[idx]) tr.style.height = rowHeights[idx] + 'px';

        // Determine which columns to render (skip status in master mode)
        const activeCols = isMaster ? COLUMNS.filter(c => c.key !== 'status') : COLUMNS;
        activeCols.forEach(col => {
            const td = document.createElement('td');
            td.className = `col-${col.key}`;
            if (rowHeights[idx]) td.style.height = rowHeights[idx] + 'px';

            if (col.type === 'index') {
                td.classList.add('locked', 'sn-delete');
                td.dataset.entryId = entry.id;
                td.style.position = 'relative';
                td.style.cursor = 'pointer';
                const span = document.createElement('span');
                span.className = 'cell-content'; span.textContent = idx + 1;
                td.appendChild(span);
                const rh = document.createElement('div');
                rh.className = 'row-resize-handle';
                rh.addEventListener('mousedown', (e) => startRowResize(e, idx, tr));
                td.appendChild(rh);

            } else if (col.key === 'policyno') {
                // Policy number: SELECTABLE but NOT editable
                // Use 'policyno-cell' class so Navigation can select it, but no edit
                td.classList.add('locked', 'policyno-selectable');
                td.dataset.field = col.key;
                td.dataset.entryId = entry.id;
                const span = document.createElement('span');
                span.className = 'cell-content';
                span.textContent = entry.policyno || '';
                td.appendChild(span);

            } else {
                // All other columns: editable in BOTH master and monthly
                td.classList.add('editable');
                td.dataset.field = col.key;
                td.dataset.entryId = entry.id;
                const value = entry[col.key] || '';
                const span = document.createElement('span');
                span.className = 'cell-content';
                if (col.type === 'status') { span.textContent = STATUS_LABELS[value] || value || 'Due'; addStatusClass(td, value); }
                else { span.textContent = value; }
                td.appendChild(span);
            }

            tr.appendChild(td);
        });

        return tr;
    }

    /* ── Status keystroke map ───────────────────────────────────────────
       p = Paid, a = Auto Debit, d = Due, c = Daily Collection, b = Branch Paid
    ───────────────────────────────────────────────────────────────────── */
    const STATUS_KEYS = {
        'p': 'paid',
        'a': 'autodebit',
        'd': '',           // empty string = Due
        'c': 'dailycollection',
        'b': 'branchpaid',
    };

    function addStatusClass(td, value) {
        td.classList.remove('status-due', 'status-paid', 'status-autodebit', 'status-dailycollection', 'status-branchpaid');
        if (!value || value === '' || value === 'due') {
            td.classList.add('status-due');
        } else if (STATUS_OPTIONS.includes(value)) {
            td.classList.add(`status-${value}`);
        }
    }

    /* ── Start editing ───────────────────────────────────────────────── */
    function startEdit(td, col, entry, initialKey) {
        if (col.type === 'status') return;

        td.classList.add('editing');
        td.innerHTML = '';
        currentEditCell = td;
        if (typeof Navigation !== 'undefined') Navigation.setEditing(true);
        createTextInput(td, entry[col.key] || '', entry, col, initialKey);
    }

    function createTextInput(td, value, entry, col, initialKey) {
        const isNote = col.key.startsWith('note');
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'cell-input';
        input.value = initialKey || value;

        input.addEventListener('blur', () => {
            let nv = input.value.trim();
            finishEdit(td);
            if (typeof Navigation !== 'undefined') Navigation.setEditing(false);

            // Auto date-tag ONLY when the cell was empty before
            if (isNote && nv && !value) {
                const now = new Date();
                const dd = String(now.getDate()).padStart(2, '0');
                const mm = String(now.getMonth() + 1).padStart(2, '0');
                nv = `${dd}/${mm} - ${nv}`;
            }

            if (nv !== value) {
                // Push to undo stack BEFORE saving
                pushUndo(entry.id, col.key, value, nv);
                entry[col.key] = nv;
                saveCell(td, entry.id, col.key, nv);
            }
            restoreCellDisplay(td, col, entry, nv);
            if (typeof Navigation !== 'undefined') Navigation.selectCell(td);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            else if (e.key === 'Escape') { input.value = value; input.blur(); }
            else if (e.key === 'Tab') { e.preventDefault(); input.blur(); moveToNextEditable(td, col, entry, e.shiftKey); }
        });

        td.appendChild(input); input.focus();
        if (initialKey) {
            input.setSelectionRange(input.value.length, input.value.length);
        } else {
            input.select();
        }
    }

    function finishEdit(td) { td.classList.remove('editing'); if (currentEditCell === td) currentEditCell = null; }

    function restoreCellDisplay(td, col, entry, value) {
        td.innerHTML = '';
        const span = document.createElement('span');
        span.className = 'cell-content';
        span.textContent = (col.type === 'status') ? (STATUS_LABELS[value] || value || 'Due') : (value || '');
        td.appendChild(span);
    }

    /* ── Save cell: routes to correct API based on active tab ─────── */
    async function saveCell(td, entryId, field, value) {
        td.classList.add('saving'); td.classList.remove('saved');
        let ok;
        if (App.state.activeTab === 'master') {
            ok = await App.updateMasterEntry(entryId, field, value);
        } else {
            ok = await App.updateEntry(entryId, field, value);
        }
        td.classList.remove('saving');
        if (ok) { td.classList.add('saved'); setTimeout(() => td.classList.remove('saved'), 2000); }
    }

    /* ── Extra row editing ─────────────────────────────────────────── */
    function isExtraCell(td) {
        return td && td.dataset.extraIdx !== undefined;
    }

    function startExtraEdit(td, initialKey) {
        const extraIdx = parseInt(td.dataset.extraIdx);
        const field = td.dataset.field;
        const col = COLUMNS.find(c => c.key === field);
        if (!col || isNaN(extraIdx)) return;

        // Status cells in extra rows: use keystroke
        if (col.type === 'status') return;

        td.classList.add('editing');
        td.innerHTML = '';
        currentEditCell = td;
        if (typeof Navigation !== 'undefined') Navigation.setEditing(true);

        const oldValue = (extraRowData[extraIdx] || {})[field] || '';
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'cell-input';
        input.value = initialKey || oldValue;

        input.addEventListener('blur', () => {
            const val = input.value.trim();
            finishEdit(td);
            if (typeof Navigation !== 'undefined') Navigation.setEditing(false);

            if (!extraRowData[extraIdx]) extraRowData[extraIdx] = {};
            extraRowData[extraIdx][field] = val;

            // Restore cell display
            td.innerHTML = '';
            const span = document.createElement('span');
            span.className = 'cell-content';
            if (col.type === 'status') {
                if (val) {
                    span.textContent = STATUS_LABELS[val] || val;
                    addStatusClass(td, val);
                }
            } else {
                span.textContent = val;
            }
            td.appendChild(span);

            // Auto-commit when policy number is filled
            if (field === 'policyno' && val) commitExtraRow(extraIdx);

            if (typeof Navigation !== 'undefined') Navigation.selectCell(td);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = oldValue; input.blur(); }
        });

        td.appendChild(input); input.focus();
        if (initialKey) {
            input.setSelectionRange(input.value.length, input.value.length);
        } else {
            input.select();
        }
    }

    function getExtraRowData() { return extraRowData; }

    function moveToNextEditable(currentTd, currentCol, currentEntry, reverse) {
        const tr = currentTd.closest('tr');
        const tds = Array.from(tr.querySelectorAll('td.editable'));
        const idx = tds.indexOf(currentTd);
        if (idx === -1) return;
        const next = reverse ? idx - 1 : idx + 1;
        if (next < 0 || next >= tds.length) return;
        const nextTd = tds[next];
        const field = nextTd.dataset.field;
        const col = COLUMNS.find(c => c.key === field);
        const entryId = parseInt(tr.dataset.entryId);
        const entry = App.state.entries.find(e => e.id === entryId);
        if (entry && col) startEdit(nextTd, col, entry);
    }

    /* ════════════════════════════════════════════════════════════════════
       EVENT DELEGATION — single listeners on tbody for performance
       ════════════════════════════════════════════════════════════════════ */
    function initDelegation() {
        const tbody = document.getElementById('spreadsheet-body');
        if (!tbody) return;

        // Right-click → edit cell (delegated — works for both data rows and extra rows)
        tbody.addEventListener('contextmenu', (e) => {
            const td = e.target.closest('td.editable');
            if (!td) return;
            e.preventDefault();
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (td.classList.contains('editing')) return;

            closeActiveEdit();

            // Check if this is an extra row cell
            if (isExtraCell(td)) {
                startExtraEdit(td);
                return;
            }

            // Regular data row
            const field = td.dataset.field;
            const entryId = parseInt(td.dataset.entryId);
            const col = COLUMNS.find(c => c.key === field);
            const entry = App.state.entries.find(en => en.id === entryId);
            if (col && entry) startEdit(td, col, entry);
        });

        // Click SN cell → delete row with confirmation
        tbody.addEventListener('click', (e) => {
            const snTd = e.target.closest('td.sn-delete');
            if (!snTd) return;

            // Extra row: clear the extra row data
            if (snTd.dataset.extraIdx !== undefined) {
                const extraIdx = parseInt(snTd.dataset.extraIdx);
                const data = extraRowData[extraIdx];
                if (data && Object.keys(data).some(k => data[k])) {
                    // Has data — clear it
                    delete extraRowData[extraIdx];
                    const tr = snTd.closest('tr.extra-row');
                    if (tr) {
                        tr.querySelectorAll('td.editable .cell-content').forEach(span => {
                            span.textContent = '';
                        });
                        // Clear status class
                        tr.querySelectorAll('td.col-status').forEach(td => {
                            td.className = td.className.replace(/status-\w+/g, '').trim();
                        });
                    }
                    App.toast('Row cleared', 'info', 1500);
                }
                return;
            }

            // Data row: delete from DB
            const tr = snTd.closest('tr[data-entry-id]');
            if (!tr) return;
            const entryId = parseInt(tr.dataset.entryId);
            const entry = App.state.entries.find(en => en.id === entryId);
            if (!entry) return;

            const pno = entry.policyno || 'Unknown';
            const name = entry.name || '';
            App.showConfirm(
                `Delete row?`,
                `Policy: ${pno}${name ? ' — ' + name : ''}\nThis will permanently remove this entry.`,
                async () => {
                    await App.deleteEntry(entryId);
                }
            );
        });

        // Hover tracking for Ctrl+C (both data and extra rows)
        tbody.addEventListener('mouseover', (e) => {
            const tr = e.target.closest('tr');
            if (tr) _hoveredRow = tr;
        });
        tbody.addEventListener('mouseleave', () => {
            _hoveredRow = null;
        });
    }

    /* ── Close edit when clicking outside ─────────────────────────── */
    document.addEventListener('mousedown', (e) => {
        if (!currentEditCell) return;
        if (currentEditCell.contains(e.target)) return;
        closeActiveEdit();
    });

    /* ── Init delegation once DOM ready ──────────────────────────── */
    document.addEventListener('DOMContentLoaded', initDelegation);

    /* ── Realtime Clock ────────────────────────────────────────────── */
    function startClock() {
        const el = document.getElementById('realtime-clock');
        if (!el) return;
        function tick() {
            const now = new Date();
            const dd = String(now.getDate()).padStart(2, '0');
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const yyyy = now.getFullYear();
            let h = now.getHours();
            const ampm = h >= 12 ? 'pm' : 'am';
            h = h % 12 || 12;
            const min = String(now.getMinutes()).padStart(2, '0');
            el.innerHTML = `<span class="clock-time">${h}:${min} <span class="clock-ampm">${ampm}</span></span><span class="clock-date">${dd}-${mm}-${yyyy}</span>`;
        }
        tick();
        setInterval(tick, 1000);
    }
    startClock();

    return {
        render,
        invalidateCache,
        getCurrentSheetKey,
        COLUMNS,
        // Exposed for Navigation module
        _saveCell: saveCell,
        _restoreCell: restoreCellDisplay,
        _addStatusClass: addStatusClass,
        _startEdit: startEdit,
        _startExtraEdit: startExtraEdit,
        _isExtraCell: isExtraCell,
        _getExtraRowData: getExtraRowData,
        _finishEdit: finishEdit,
        // Undo
        undo,
        pushUndo,
        // Hover tracking
        getHoveredRow: () => _hoveredRow,
        copyPolicyNo,
    };
})();
