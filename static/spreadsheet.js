/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Spreadsheet v2 (Virtual Scroll + DataStore + Navigation)
   
   Merged: spreadsheet.js + navigation.js
   Uses VirtualScroller for rendering only visible rows.
   Uses DataStore as the data source — no local entry copies.
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

    const STATUS_OPTIONS = ['', 'paid', 'autodebit', 'dailycollection', 'branchpaid', 'notinforce'];
    const STATUS_LABELS  = { '': 'Due', 'paid': 'Paid', 'autodebit': 'Auto Debit', 'dailycollection': 'Daily Collection', 'branchpaid': 'Branch Paid', 'notinforce': 'Not in Force' };
    const STATUS_KEYS    = { 'p': 'paid', 'a': 'autodebit', 'd': '', 'c': 'dailycollection', 'b': 'branchpaid', 'n': 'notinforce' };

    let _onStatusChangeCallback = null; // Callback for real-time stat updates

    let currentEditCell = null;
    let _currentEntries = [];  // Current filtered view data

    /* ── Persisted settings ──────────────────────────────────────────── */
    const STORAGE_KEY_COL = 'os_col_widths';
    const STORAGE_KEY_HDR = 'os_header_names';
    const STORAGE_KEY_ROW = 'os_row_heights';
    const DEFAULT_WIDTHS = { sn: 45, policyno: 130, name: 180, doc: 100, fup: 100, sumass: 110, plan: 120, mode: 80, premium: 100, mobileno: 120, status: 120 };
    for (let i = 1; i <= EXTRA_COL_COUNT; i++) DEFAULT_WIDTHS[`note${i}`] = 120;

    let colWidths = { ...DEFAULT_WIDTHS };
    let headerNames = {};
    let rowHeights = {};
    let _colEls = {};

    function loadColWidths()   { try { const s = localStorage.getItem(STORAGE_KEY_COL); if (s) colWidths   = { ...DEFAULT_WIDTHS, ...JSON.parse(s) }; } catch {} }
    function saveColWidths()   { try { localStorage.setItem(STORAGE_KEY_COL, JSON.stringify(colWidths));   } catch {} }
    function loadHeaderNames() { try { const s = localStorage.getItem(STORAGE_KEY_HDR); if (s) headerNames = JSON.parse(s); } catch {} }
    function saveHeaderNames() { try { localStorage.setItem(STORAGE_KEY_HDR, JSON.stringify(headerNames)); } catch {} }
    function loadRowHeights()  { try { const s = localStorage.getItem(STORAGE_KEY_ROW); if (s) rowHeights  = JSON.parse(s); } catch {} }
    function saveRowHeights()  { try { localStorage.setItem(STORAGE_KEY_ROW, JSON.stringify(rowHeights));  } catch {} }
    function getHeaderLabel(col) { return headerNames[col.key] || col.label; }

    /* ── Hovered row tracking (for Ctrl+C) ───────────────────────────── */
    let _hoveredRow = null;

    /* ── Undo / Redo Stacks ────────────────────────────────────────── */
    const _undoStack = [];
    const _redoStack = [];
    const MAX_UNDO = 100;

    function pushUndo(entryId, field, oldValue, newValue) {
        _undoStack.push({ entryId, field, oldValue, newValue, tab: App.state.activeTab, timestamp: Date.now() });
        if (_undoStack.length > MAX_UNDO) _undoStack.shift();
        _redoStack.length = 0; // New edit clears redo history
    }

    async function undo() {
        if (_undoStack.length === 0) {
            App.toast('Nothing to undo', 'info', 1500);
            return;
        }
        const action = _undoStack.pop();
        const { entryId, field, oldValue, newValue, tab } = action;
        let ok;
        if (tab === 'master') {
            ok = await App.updateMasterEntry(entryId, field, oldValue);
        } else {
            ok = await App.updateEntry(entryId, field, oldValue);
        }
        if (ok) {
            _redoStack.push(action);
            // Update cell in DOM if visible
            const tr = document.querySelector(`tr[data-entry-id="${entryId}"]`);
            if (tr) {
                const col = COLUMNS.find(c => c.key === field);
                if (col) {
                    const td = tr.querySelector(`td[data-field="${field}"]`);
                    if (td) restoreCellDisplay(td, col, { [field]: oldValue }, oldValue);
                }
            }
            App.toast('↩ Undo done', 'success', 1500);
        }
    }

    async function redo() {
        if (_redoStack.length === 0) {
            App.toast('Nothing to redo', 'info', 1500);
            return;
        }
        const action = _redoStack.pop();
        const { entryId, field, newValue, tab } = action;
        let ok;
        if (tab === 'master') {
            ok = await App.updateMasterEntry(entryId, field, newValue);
        } else {
            ok = await App.updateEntry(entryId, field, newValue);
        }
        if (ok) {
            _undoStack.push(action);
            const tr = document.querySelector(`tr[data-entry-id="${entryId}"]`);
            if (tr) {
                const col = COLUMNS.find(c => c.key === field);
                if (col) {
                    const td = tr.querySelector(`td[data-field="${field}"]`);
                    if (td) restoreCellDisplay(td, col, { [field]: newValue }, newValue);
                }
            }
            App.toast('↪ Redo done', 'success', 1500);
        }
    }

    /* ── Copy policy number ──────────────────────────────────────────── */
    function copyPolicyNo(tr) {
        const pIdx = getActiveCols().findIndex(c => c.key === 'policyno');
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

    let _copyHighlightTimer = null;
    let _copiedRow = null;

    function clearCopyHighlight() {
        if (_copyHighlightTimer) { clearTimeout(_copyHighlightTimer); _copyHighlightTimer = null; }
        if (_copiedRow) { _copiedRow.classList.remove('copied-row'); _copiedRow = null; }
    }

    function showCopyFeedback(tr, pno) {
        clearCopyHighlight();
        tr.classList.add('copied-row');
        _copiedRow = tr;
        _copyHighlightTimer = setTimeout(clearCopyHighlight, 120000); // 2 minutes
        App.toast(`Copied: ${pno}`, 'success', 1500);
    }

    /* ── Extra (blank) rows data ─────────────────────────────────────── */
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
            url = `/api/list/${App.state.year}/${App.state.month}/new`;
        }

        const body = { ...data, policyno: pno };

        // Add to DataStore immediately (local-first)
        const localEntry = { ...body, id: Date.now(), _local: true };
        if (activeTab === 'master') {
            DataStore.addEntry('master', localEntry);
        } else {
            const monthKey = `${App.state.year}-${App.state.month}`;
            DataStore.addEntry('monthly', localEntry, monthKey);
        }
        delete extraRowData[idx];

        const label = activeTab === 'master' ? 'master data' : 'monthly list';

        if (!navigator.onLine) {
            OfflineQueue.enqueue('POST', url, body);
            App.toast(`✓ Policy ${pno} saved locally (will sync)`, 'success', 4000);
            App.renderCurrentView();
            return;
        }

        App.api('POST', url, body)
            .then(res => {
                let msg = `✓ Policy ${pno} saved to ${label}`;
                if (res.added_to_master) msg += ' + master data';
                App.toast(msg, 'success', 4000);
                App.reloadActive();
            })
            .catch(err => {
                // Network failed mid-request — queue it
                OfflineQueue.enqueue('POST', url, body);
                App.toast(`✓ Policy ${pno} saved locally (will sync)`, 'success', 4000);
            });
    }

    function closeActiveEdit() {
        // Close currentEditCell if it has any input
        if (currentEditCell) {
            const inp = currentEditCell.querySelector('input.cell-input, select.cell-input, input.mobile-status-input');
            if (inp) inp.blur();
            currentEditCell.classList.remove('editing');
            currentEditCell = null;
            _isEditing = false;
        }
        // Global sweep: close ANY leftover editing cells (stale from virtual scroller)
        document.querySelectorAll('td.editing').forEach(td => {
            const picker = td.querySelector('.mobile-status-picker');
            if (picker) {
                // Restore cell to its original display
                const entryId = td.dataset.entryId;
                const field = td.dataset.field || 'status';
                const entry = _currentEntries.find(e => (e._monthlyId || e.id) === parseInt(entryId));
                const col = COLUMNS.find(c => c.key === field);
                const val = entry ? (entry[field] || '') : '';
                restoreCellDisplay(td, col, entry || {}, val);
                addStatusClass(td, val);
            }
            td.classList.remove('editing');
        });
    }

    /* ── Active columns helper ───────────────────────────────────────── */
    function getActiveCols() {
        return App.state.activeTab === 'master' ? COLUMNS.filter(c => c.key !== 'status') : COLUMNS;
    }

    /* ── Colgroup ────────────────────────────────────────────────────── */
    function buildColgroup() {
        const table = document.getElementById('spreadsheet');
        const old = table.querySelector('colgroup');
        if (old) old.remove();
        const activeCols = getActiveCols();
        const colgroup = document.createElement('colgroup');
        activeCols.forEach(col => {
            const colEl = document.createElement('col');
            colEl.style.width = colWidths[col.key] + 'px';
            _colEls[col.key] = colEl;
            colgroup.appendChild(colEl);
        });
        table.prepend(colgroup);
        table.style.width = activeCols.reduce((s, c) => s + (colWidths[c.key] || 100), 0) + 'px';
    }

    /* ── Header ──────────────────────────────────────────────────────── */
    function renderHeader() {
        const headerRow = document.getElementById('header-row');
        headerRow.innerHTML = '';
        getActiveCols().forEach(col => {
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
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'header-edit-input';
        input.value = getHeaderLabel(col);
        input.addEventListener('blur', () => {
            const val = input.value.trim();
            if (val && val !== col.label) headerNames[col.key] = val;
            else delete headerNames[col.key];
            saveHeaderNames();
            th.innerHTML = '';
            labelSpan.textContent = getHeaderLabel(col);
            th.appendChild(labelSpan);
            const handle = document.createElement('div');
            handle.className = 'col-resize-handle';
            handle.addEventListener('mousedown', (e) => startColResize(e, col.key));
            th.appendChild(handle);
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = getHeaderLabel(col); input.blur(); } });
        th.innerHTML = '';
        th.appendChild(input);
        input.focus(); input.select();
    }

    /* ── Column resize ──────────────────────────────────────────────── */
    function startColResize(e, key) {
        e.preventDefault();
        const startX = e.clientX;
        const startW = colWidths[key] || 100;
        document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
        const onMove = (ev) => {
            const w = Math.max(30, startW + ev.clientX - startX);
            colWidths[key] = w;
            if (_colEls[key]) _colEls[key].style.width = w + 'px';
            const table = document.getElementById('spreadsheet');
            const activeCols = getActiveCols();
            table.style.width = activeCols.reduce((s, c) => s + (colWidths[c.key] || 100), 0) + 'px';
        };
        const onUp = () => {
            saveColWidths();
            document.body.style.cursor = ''; document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    }

    /* ── Row resize ─────────────────────────────────────────────────── */
    function startRowResize(e, rowIdx, tr) {
        e.preventDefault(); e.stopPropagation();
        const startY = e.clientY;
        const startH = tr.offsetHeight || 32;
        document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none';
        const onMove = (ev) => {
            const h = Math.max(24, startH + ev.clientY - startY);
            tr.style.height = h + 'px';
            tr.querySelectorAll('td').forEach(td => { td.style.height = h + 'px'; });
            rowHeights[rowIdx] = h;
        };
        const onUp = () => {
            saveRowHeights();
            document.body.style.cursor = ''; document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    }

    /** Wrap matching substrings in <mark> for search highlighting */
    function highlightText(span, text) {
        const filter = (typeof App !== 'undefined' && App.getFilterText) ? App.getFilterText() : '';
        if (!filter || !text) { span.textContent = text; return; }
        const lower = text.toLowerCase();
        const idx = lower.indexOf(filter);
        if (idx === -1) { span.textContent = text; return; }
        // Build: before + <mark> + after
        span.textContent = '';
        if (idx > 0) span.appendChild(document.createTextNode(text.slice(0, idx)));
        const mark = document.createElement('mark');
        mark.className = 'search-hl';
        mark.textContent = text.slice(idx, idx + filter.length);
        span.appendChild(mark);
        if (idx + filter.length < text.length) {
            span.appendChild(document.createTextNode(text.slice(idx + filter.length)));
        }
    }

    /* ════════════════════════════════════════════════════════════════════
       ROW BUILDERS — used by VirtualScroller
       ════════════════════════════════════════════════════════════════════ */

    function createDataRow(entry, idx) {
        const isMaster = App.state.activeTab === 'master';
        const tr = document.createElement('tr');
        // Use _monthlyId for monthly entries, or id for master entries
        const entryId = entry._monthlyId || entry.id;
        tr.dataset.entryId = entryId;
        if (rowHeights[idx]) tr.style.height = rowHeights[idx] + 'px';
        // Dim "Not in Force" rows
        if ((entry.status || '').toLowerCase() === 'notinforce') {
            tr.classList.add('nif-row');
        }

        const activeCols = getActiveCols();
        activeCols.forEach(col => {
            const td = document.createElement('td');
            td.className = `col-${col.key}`;

            if (col.type === 'index') {
                td.classList.add('locked', 'sn-delete');
                td.dataset.entryId = entryId;
                td.style.position = 'relative';
                td.style.cursor = 'pointer';
                const span = document.createElement('span');
                span.className = 'cell-content';
                span.textContent = idx + 1;
                td.appendChild(span);
                const rh = document.createElement('div');
                rh.className = 'row-resize-handle';
                rh.addEventListener('mousedown', (e) => startRowResize(e, idx, tr));
                td.appendChild(rh);

            } else if (col.key === 'policyno') {
                td.classList.add('locked', 'policyno-selectable');
                td.dataset.field = col.key;
                td.dataset.entryId = entryId;
                const span = document.createElement('span');
                span.className = 'cell-content';
                highlightText(span, entry.policyno || '');
                td.appendChild(span);

            } else {
                td.classList.add('editable');
                td.dataset.field = col.key;
                td.dataset.entryId = entryId;
                const value = entry[col.key] || '';
                const span = document.createElement('span');
                span.className = 'cell-content';
                if (col.type === 'status') {
                    const displayVal = STATUS_LABELS[value] || value || 'Due';
                    highlightText(span, displayVal);
                    addStatusClass(td, value);
                } else {
                    highlightText(span, value);
                }
                td.appendChild(span);
            }
            tr.appendChild(td);
        });
        return tr;
    }

    function createExtraRow(extraIdx, snNumber) {
        const tr = document.createElement('tr');
        tr.className = 'extra-row';
        tr.dataset.extraIdx = extraIdx;

        const activeCols = getActiveCols();
        activeCols.forEach(col => {
            const td = document.createElement('td');
            td.className = `col-${col.key}`;

            if (col.type === 'index') {
                td.classList.add('locked', 'sn-delete');
                td.dataset.extraIdx = extraIdx;
                td.style.position = 'relative';
                td.style.cursor = 'pointer';
                const span = document.createElement('span');
                span.className = 'cell-content';
                span.textContent = snNumber;
                td.appendChild(span);
            } else {
                td.classList.add('editable');
                td.dataset.field = col.key;
                td.dataset.extraIdx = extraIdx;
                const span = document.createElement('span');
                span.className = 'cell-content';
                if (col.type === 'status') {
                    const val = (extraRowData[extraIdx] || {})[col.key] || '';
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
        return tr;
    }

    /* ════════════════════════════════════════════════════════════════════
       RENDER — The main entry point. Uses VirtualScroller.
       ════════════════════════════════════════════════════════════════════ */
    let _vsInitialized = false;

    function render(entries) {
        loadColWidths(); loadHeaderNames(); loadRowHeights();
        buildColgroup(); renderHeader();

        // Deselect navigation
        deselectCell();
        closeActiveEdit();

        _currentEntries = entries || [];

        // Split NIF entries out — they render after extra rows (list view only)
        let nifEntries = [];
        if (typeof App !== 'undefined' && App.state.activeTab === 'list') {
            nifEntries = _currentEntries.filter(e => (e.status || '').toLowerCase() === 'notinforce');
            _currentEntries = _currentEntries.filter(e => (e.status || '').toLowerCase() !== 'notinforce');
        }

        const tbody = document.getElementById('spreadsheet-body');
        const scrollContainer = document.getElementById('scroll-container');

        if (!_vsInitialized && scrollContainer) {
            VirtualScroller.init(
                scrollContainer,
                tbody,
                (rowData, rowIndex) => createDataRow(rowData, rowIndex),
                (extraIdx, snNumber) => createExtraRow(extraIdx, snNumber)
            );
            _vsInitialized = true;
        }

        // Feed data to virtual scroller atomically (NIF goes after extra rows)
        VirtualScroller.setAllData(_currentEntries, nifEntries);
    }

    /** Lightweight re-split: moves NIF entries to bottom section */
    function resortEntries() {
        if (typeof App !== 'undefined' && App.state.activeTab !== 'list') return;
        const entries = App.getEntries();
        const nifEntries = entries.filter(e => (e.status || '').toLowerCase() === 'notinforce');
        _currentEntries = entries.filter(e => (e.status || '').toLowerCase() !== 'notinforce');
        VirtualScroller.setAllData(_currentEntries, nifEntries);
    }

    /* ── Status class helper ─────────────────────────────────────────── */
    function addStatusClass(td, value) {
        td.classList.remove('status-due', 'status-paid', 'status-autodebit', 'status-dailycollection', 'status-branchpaid', 'status-notinforce');
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
        _isEditing = true;
        createTextInput(td, entry[col.key] || '', entry, col, initialKey);
    }

    function createTextInput(td, value, entry, col, initialKey) {
        const isNote = col.key.startsWith('note');
        // Regex to detect date prefix: "DD/MM - " at the start
        const DATE_PREFIX_RE = /^(\d{2}\/\d{2})\s*-\s*/;
        let datePrefix = '';  // e.g. "08/07 - "
        let textPart = value; // the editable portion

        if (isNote && value) {
            const m = value.match(DATE_PREFIX_RE);
            if (m) {
                textPart = value.slice(m[0].length); // strip old date
            }
        }

        // Always use today's date for notes (date = last modified)
        if (isNote) {
            const now = new Date();
            const dd = String(now.getDate()).padStart(2, '0');
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            datePrefix = `${dd}/${mm} - `;
        }

        // Build the cell: [locked date prefix] [input]
        if (datePrefix) {
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'note-date-prefix';
            prefixSpan.textContent = datePrefix;
            td.appendChild(prefixSpan);
        }

        const input = document.createElement('input');
        input.type = 'text'; input.className = 'cell-input';
        if (datePrefix) {
            input.classList.add('has-prefix');
        }
        input.value = initialKey || textPart;

        const effectivePrefix = datePrefix;

        input.addEventListener('blur', () => {
            let nv = input.value.trim();
            finishEdit(td);
            _isEditing = false;

            // Recombine: prefix + edited text
            if (effectivePrefix && nv) {
                nv = effectivePrefix + nv;
            } else if (effectivePrefix && !nv) {
                // User cleared the text — save empty (removes the date too)
                nv = '';
            }
            // No prefix and no value → stays empty, no date added

            if (nv !== value) {
                const entryId = parseInt(td.dataset.entryId);
                pushUndo(entryId, col.key, value, nv);
                entry[col.key] = nv;
                saveCell(td, entryId, col.key, nv);
            }
            restoreCellDisplay(td, col, entry, nv);
            selectCell(td);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            else if (e.key === 'Escape') { input.value = textPart; input.blur(); }
            else if (e.key === 'Tab') { e.preventDefault(); input.blur(); }
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

    /* ── Save cell ───────────────────────────────────────────────────── */
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
        return td && td.dataset.extraIdx !== undefined && !td.dataset.entryId;
    }

    function startExtraEdit(td, initialKey) {
        const extraIdx = parseInt(td.dataset.extraIdx);
        const field = td.dataset.field;
        const col = COLUMNS.find(c => c.key === field);
        if (!col || isNaN(extraIdx)) return;
        if (col.type === 'status') return;

        td.classList.add('editing');
        td.innerHTML = '';
        currentEditCell = td;
        _isEditing = true;

        const oldValue = (extraRowData[extraIdx] || {})[field] || '';
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'cell-input';
        input.value = initialKey || oldValue;

        input.addEventListener('blur', () => {
            const val = input.value.trim();
            finishEdit(td);
            _isEditing = false;

            if (!extraRowData[extraIdx]) extraRowData[extraIdx] = {};
            extraRowData[extraIdx][field] = val;

            td.innerHTML = '';
            const span = document.createElement('span');
            span.className = 'cell-content';
            if (col.type === 'status') {
                if (val) { span.textContent = STATUS_LABELS[val] || val; addStatusClass(td, val); }
            } else {
                span.textContent = val;
            }
            td.appendChild(span);

            if (field === 'policyno' && val) commitExtraRow(extraIdx);
            selectCell(td);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = oldValue; input.blur(); }
        });

        td.appendChild(input); input.focus();
        if (initialKey) { input.setSelectionRange(input.value.length, input.value.length); }
        else { input.select(); }
    }

    function getExtraRowData() { return extraRowData; }

    /* ════════════════════════════════════════════════════════════════════
       NAVIGATION (merged from navigation.js)
       ════════════════════════════════════════════════════════════════════ */
    let _selectedCell = null;
    let _lastDirection = 'down';
    let _isEditing = false;

    function isSelectableCell(td) {
        return td && (td.classList.contains('editable') || td.classList.contains('policyno-selectable'));
    }
    function isEditableCell(td) { return td && td.classList.contains('editable'); }
    function isStatusCell(td) { return td && td.classList.contains('col-status'); }
    function isPolicyNoCell(td) { return td && td.classList.contains('policyno-selectable'); }

    function getCellPos(td) {
        const tr = td.closest('tr');
        if (!tr) return null;
        const tbody = tr.closest('tbody');
        if (!tbody) return null;
        // Filter out spacer rows for position calculation
        const rows = Array.from(tbody.rows).filter(r => !r.classList.contains('vs-pad-top') && !r.classList.contains('vs-pad-bottom'));
        const rowIdx = rows.indexOf(tr);
        const colIdx = Array.from(tr.cells).indexOf(td);
        return { row: rowIdx, col: colIdx };
    }

    function getCellAt(row, col) {
        const tbody = document.getElementById('spreadsheet-body');
        if (!tbody) return null;
        const rows = Array.from(tbody.rows).filter(r => !r.classList.contains('vs-pad-top') && !r.classList.contains('vs-pad-bottom'));
        const tr = rows[row];
        if (!tr) return null;
        return tr.cells[col] || null;
    }

    function getGridSize() {
        const tbody = document.getElementById('spreadsheet-body');
        if (!tbody || !tbody.rows.length) return { rows: 0, cols: 0 };
        const rows = Array.from(tbody.rows).filter(r => !r.classList.contains('vs-pad-top') && !r.classList.contains('vs-pad-bottom'));
        if (!rows.length) return { rows: 0, cols: 0 };
        return { rows: rows.length, cols: rows[0].cells.length };
    }

    function selectCell(td) {
        if (_selectedCell === td) return;
        deselectCell();
        if (!td || !isSelectableCell(td)) return;
        _selectedCell = td;
        td.classList.add('nav-selected');
        td.setAttribute('tabindex', '0');
        td.focus();
        const tr = td.closest('tr');
        if (tr && !document.body.classList.contains('crm-sms-active')) tr.classList.add('nav-active-row');
        const table = td.closest('.spreadsheet');
        if (table && !document.body.classList.contains('crm-sms-active')) table.classList.add('nav-has-selection');
    }

    function deselectCell() {
        if (_selectedCell) {
            const tr = _selectedCell.closest('tr');
            if (tr) tr.classList.remove('nav-active-row');
            const table = _selectedCell.closest('.spreadsheet');
            if (table) table.classList.remove('nav-has-selection');
            _selectedCell.classList.remove('nav-selected');
            _selectedCell.removeAttribute('tabindex');
            _selectedCell = null;
        }
        // Clear any stale selections left by virtual scroller re-rendering
        document.querySelectorAll('.nav-selected').forEach(el => el.classList.remove('nav-selected'));
        document.querySelectorAll('.nav-active-row').forEach(el => el.classList.remove('nav-active-row'));
        _isEditing = false;
    }

    function move(direction) {
        if (!_selectedCell) return;
        const pos = getCellPos(_selectedCell);
        if (!pos) return;
        const grid = getGridSize();
        let newRow = pos.row, newCol = pos.col;
        switch (direction) {
            case 'up':    newRow = Math.max(0, pos.row - 1); break;
            case 'down':  newRow = Math.min(grid.rows - 1, pos.row + 1); break;
            case 'left':  newCol = Math.max(0, pos.col - 1); break;
            case 'right': newCol = Math.min(grid.cols - 1, pos.col + 1); break;
        }
        let td = getCellAt(newRow, newCol);
        const maxTries = Math.max(grid.rows, grid.cols);
        let tries = 0;
        while (td && !isSelectableCell(td) && tries < maxTries) {
            switch (direction) {
                case 'up':    newRow--; break;
                case 'down':  newRow++; break;
                case 'left':  newCol--; break;
                case 'right': newCol++; break;
            }
            if (newRow < 0 || newRow >= grid.rows || newCol < 0 || newCol >= grid.cols) break;
            td = getCellAt(newRow, newCol);
            tries++;
        }
        if (td && isSelectableCell(td)) {
            _lastDirection = direction;
            selectCell(td);
        }
    }

    function getCellInfo(td) {
        const field = td.dataset.field;
        const entryId = td.dataset.entryId;
        if (!field || !entryId) return null;
        const col = COLUMNS.find(c => c.key === field);
        const id = parseInt(entryId);
        // Search normal entries first, then all entries (for NIF rows)
        let entry = _currentEntries.find(e => (e._monthlyId || e.id) === id);
        if (!entry && typeof App !== 'undefined') {
            const all = App.getEntries();
            entry = all.find(e => (e._monthlyId || e.id) === id);
        }
        if (!col || !entry) return null;
        return { col, entry };
    }

    function applyStatusKey(td, key) {
        const info = getCellInfo(td);
        if (!info) return;
        const { col, entry } = info;
        const newVal = STATUS_KEYS[key];
        const oldVal = entry[col.key] || '';

        if (newVal !== oldVal) {
            const entryId = parseInt(td.dataset.entryId);
            pushUndo(entryId, col.key, oldVal, newVal);
            entry[col.key] = newVal;
            saveCell(td, entryId, col.key, newVal);
        }
        restoreCellDisplay(td, col, entry, newVal);
        addStatusClass(td, newVal);
        td.classList.add('nav-selected');
        td.setAttribute('tabindex', '0');
        td.focus();

        // Notify App for real-time stat pill updates
        if (newVal !== oldVal && _onStatusChangeCallback) {
            const isNifTransition = newVal === 'notinforce' || oldVal === 'notinforce';
            if (isNifTransition) {
                // Animate row out, then re-split data
                const tr = td.closest('tr');
                if (tr) {
                    tr.classList.add('nif-departing');
                    setTimeout(() => {
                        _onStatusChangeCallback();
                    }, 350); // matches CSS animation duration
                } else {
                    _onStatusChangeCallback();
                }
            } else {
                _onStatusChangeCallback();
            }
        }
    }

    /* ── Keyboard handler ──────────────────────────────────────────────── */
    function onKeyDown(e) {
        // Ctrl+Z
        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !_isEditing) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            e.preventDefault(); undo(); return;
        }
        // Ctrl+Y
        if ((e.ctrlKey || e.metaKey) && e.key === 'y' && !_isEditing) {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            e.preventDefault(); redo(); return;
        }
        // Ctrl+C
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            if (_hoveredRow) { e.preventDefault(); copyPolicyNo(_hoveredRow); return; }
            if (_selectedCell) {
                e.preventDefault();
                const tr = _selectedCell.closest('tr');
                if (tr) copyPolicyNo(tr);
                return;
            }
        }
        if (_isEditing) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if (!_selectedCell) return;

        const key = e.key;
        if (key === 'ArrowUp')    { e.preventDefault(); move('up'); return; }
        if (key === 'ArrowDown')  { e.preventDefault(); move('down'); return; }
        if (key === 'ArrowLeft')  { e.preventDefault(); move('left'); return; }
        if (key === 'ArrowRight') { e.preventDefault(); move('right'); return; }
        if (key === 'Tab') { e.preventDefault(); move(e.shiftKey ? 'left' : 'right'); return; }
        if (key === 'Enter') { e.preventDefault(); move(_lastDirection); return; }
        if (key === 'Escape') { e.preventDefault(); deselectCell(); return; }

        if (isPolicyNoCell(_selectedCell)) return;

        // Status shortcuts
        if (isStatusCell(_selectedCell)) {
            const lk = key.toLowerCase();
            if (lk in STATUS_KEYS) {
                e.preventDefault();
                if (isExtraCell(_selectedCell)) {
                    const extraIdx = parseInt(_selectedCell.dataset.extraIdx);
                    if (!extraRowData[extraIdx]) extraRowData[extraIdx] = {};
                    extraRowData[extraIdx]['status'] = STATUS_KEYS[lk];
                    const col = COLUMNS.find(c => c.key === 'status');
                    const val = STATUS_KEYS[lk];
                    restoreCellDisplay(_selectedCell, col, { status: val }, val);
                    addStatusClass(_selectedCell, val);
                    _selectedCell.classList.add('nav-selected');
                    _selectedCell.setAttribute('tabindex', '0');
                    _selectedCell.focus();
                } else {
                    applyStatusKey(_selectedCell, lk);
                }
                return;
            }
        }

        // Printable key → start editing
        if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (!isStatusCell(_selectedCell) && isEditableCell(_selectedCell)) {
                e.preventDefault();
                _isEditing = true;
                if (isExtraCell(_selectedCell)) {
                    startExtraEdit(_selectedCell, key);
                } else {
                    const info = getCellInfo(_selectedCell);
                    if (info) startEdit(_selectedCell, info.col, info.entry, key);
                }
            }
        }
    }

    /* ════════════════════════════════════════════════════════════════════
       EVENT DELEGATION — single listeners on tbody for performance
       ════════════════════════════════════════════════════════════════════ */
    function initDelegation() {
        const tbody = document.getElementById('spreadsheet-body');
        if (!tbody) return;

        // Click → select cell
        tbody.addEventListener('click', (e) => {
            clearCopyHighlight();
            const td = e.target.closest('td.editable, td.policyno-selectable');
            if (td) {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
                if (e.target.closest('.mobile-status-picker')) return;
                // Close ALL open edits before selecting new cell
                closeActiveEdit();
                selectCell(td);
            }
        });

        // Right-click → edit (desktop)
        tbody.addEventListener('contextmenu', (e) => {
            const td = e.target.closest('td.editable');
            if (!td) return;
            e.preventDefault();
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (td.classList.contains('editing')) return;
            _triggerEdit(td);
        });

        // Double-click → edit on all devices (desktop + mobile fallback)
        tbody.addEventListener('dblclick', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            const td = e.target.closest('td.editable');
            if (td && !td.classList.contains('editing')) {
                _triggerEdit(td);
            }
            // Double-tap on policy number → copy
            const pTd = e.target.closest('td.policyno-selectable');
            if (pTd) {
                const tr = pTd.closest('tr');
                if (tr) copyPolicyNo(tr);
            }
        });

        // ── Mobile touch interactions ─────────────────────────────────
        if (App.isMobile) {
            let _touchTimer = null;
            let _touchStartX = 0;
            let _touchStartY = 0;
            let _touchTd = null;
            let _lastTapTime = 0;
            let _lastTapTd = null;

            tbody.addEventListener('touchstart', (e) => {
                const td = e.target.closest('td.editable, td.policyno-selectable');
                if (!td) return;
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

                const touch = e.touches[0];
                _touchStartX = touch.clientX;
                _touchStartY = touch.clientY;
                _touchTd = td;

                // Long-press timer (500ms) → edit
                _touchTimer = setTimeout(() => {
                    _touchTimer = null;
                    if (_touchTd && _touchTd.classList.contains('editable') && !_touchTd.classList.contains('editing')) {
                        if (navigator.vibrate) navigator.vibrate(50);
                        _triggerEdit(_touchTd);
                    }
                }, 500);
            }, { passive: true });

            tbody.addEventListener('touchmove', (e) => {
                // Cancel long-press if finger moved more than 10px
                if (_touchTimer) {
                    const touch = e.touches[0];
                    const dx = Math.abs(touch.clientX - _touchStartX);
                    const dy = Math.abs(touch.clientY - _touchStartY);
                    if (dx > 10 || dy > 10) {
                        clearTimeout(_touchTimer);
                        _touchTimer = null;
                    }
                }
            }, { passive: true });

            tbody.addEventListener('touchend', (e) => {
                if (_touchTimer) {
                    clearTimeout(_touchTimer);
                    _touchTimer = null;
                }

                // Double-tap detection (300ms window) → copy policy number
                const now = Date.now();
                const td = _touchTd;
                if (td && td.classList.contains('policyno-selectable') && _lastTapTd === td && (now - _lastTapTime) < 300) {
                    e.preventDefault();
                    const tr = td.closest('tr');
                    if (tr) copyPolicyNo(tr);
                    _lastTapTime = 0;
                    _lastTapTd = null;
                } else {
                    _lastTapTime = now;
                    _lastTapTd = td;
                }

                _touchTd = null;
            }, { passive: false });
        }

        // Click SN → delete row
        tbody.addEventListener('click', (e) => {
            const snTd = e.target.closest('td.sn-delete');
            if (!snTd) return;

            // Extra row: clear
            if (snTd.dataset.extraIdx !== undefined && !snTd.dataset.entryId) {
                const extraIdx = parseInt(snTd.dataset.extraIdx);
                const data = extraRowData[extraIdx];
                if (data && Object.keys(data).some(k => data[k])) {
                    delete extraRowData[extraIdx];
                    const tr = snTd.closest('tr.extra-row');
                    if (tr) {
                        tr.querySelectorAll('td.editable .cell-content').forEach(span => { span.textContent = ''; });
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
            const entry = _currentEntries.find(en => (en._monthlyId || en.id) === entryId);
            if (!entry) return;

            const pno = entry.policyno || 'Unknown';
            const name = entry.name || '';
            App.showConfirm(
                `Delete row?`,
                `Policy: ${pno}${name ? ' — ' + name : ''}\nThis will permanently remove this entry.`,
                async () => { await App.deleteEntry(entryId); }
            );
        });

        // Hover tracking
        tbody.addEventListener('mouseover', (e) => {
            const tr = e.target.closest('tr');
            if (tr && !tr.classList.contains('vs-pad-top') && !tr.classList.contains('vs-pad-bottom')) {
                _hoveredRow = tr;
            }
        });
        tbody.addEventListener('mouseleave', () => { _hoveredRow = null; });

        // Global keyboard
        document.addEventListener('keydown', onKeyDown);

        // Click outside → deselect
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.spreadsheet') && !e.target.closest('.mobile-status-picker')) deselectCell();
        });

        // Close edit on click outside
        document.addEventListener('mousedown', (e) => {
            if (!currentEditCell) return;
            if (currentEditCell.contains(e.target)) return;
            if (e.target.closest('.mobile-status-picker')) return;
            closeActiveEdit();
        });
    }

    /** Shared edit trigger — called from contextmenu, dblclick, and long-press */
    function _triggerEdit(td) {
        closeActiveEdit();
        if (isExtraCell(td)) { startExtraEdit(td); return; }

        const field = td.dataset.field;
        const entryId = parseInt(td.dataset.entryId);
        const col = COLUMNS.find(c => c.key === field);
        const entry = _currentEntries.find(en => (en._monthlyId || en.id) === entryId);

        // Mobile status cell → show inline text input with tick
        if (col && col.type === 'status' && App.isMobile && entry) {
            _startMobileStatusEdit(td, col, entry);
            return;
        }

        if (col && entry) startEdit(td, col, entry);
    }

    /** Mobile status edit: text input + ✓ confirm button */
    function _startMobileStatusEdit(td, col, entry) {
        closeActiveEdit();
        td.classList.add('editing');
        currentEditCell = td;
        _isEditing = true;

        const currentVal = entry[col.key] || '';
        const wrapper = document.createElement('div');
        wrapper.className = 'mobile-status-picker';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mobile-status-input';
        input.placeholder = 'Type status...';
        input.value = currentVal;
        input.autocomplete = 'off';
        input.spellcheck = false;

        const tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'mobile-status-tick';
        tick.textContent = '✓';

        wrapper.appendChild(input);
        wrapper.appendChild(tick);
        td.innerHTML = '';
        td.appendChild(wrapper);
        input.focus();

        function resolveStatus(text) {
            const t = (text || '').trim().toLowerCase();
            if (!t) return '';
            // Direct key match (p/a/d/c/b/n)
            if (STATUS_KEYS[t] !== undefined) return STATUS_KEYS[t];
            // Exact match against known statuses
            if (STATUS_OPTIONS.includes(t)) return t;
            // Prefix match against known statuses
            const match = STATUS_OPTIONS.find(s => s && s.startsWith(t));
            return match || t;
        }

        async function confirmStatus() {
            const resolved = resolveStatus(input.value);
            const entryId = parseInt(td.dataset.entryId);

            // Save
            if (isExtraCell(td)) {
                const extraIdx = parseInt(td.dataset.extraIdx);
                if (!extraRowData[extraIdx]) extraRowData[extraIdx] = {};
                extraRowData[extraIdx]['status'] = resolved;
            } else {
                pushUndo(entryId, 'status', currentVal, resolved);
                // Mutate entry directly (same as applyStatusKey)
                entry[col.key] = resolved;
                if (App.state.activeTab === 'master') {
                    await App.updateMasterEntry(entryId, 'status', resolved);
                } else {
                    await App.updateEntry(entryId, 'status', resolved);
                }
                // Handle NIF transition with animation
                if (_onStatusChangeCallback && resolved !== currentVal) {
                    const isNifTransition = resolved === 'notinforce' || currentVal === 'notinforce';
                    if (isNifTransition) {
                        const tr = td.closest('tr');
                        if (tr) {
                            tr.classList.add('nif-departing');
                            setTimeout(() => _onStatusChangeCallback(), 350);
                        } else {
                            _onStatusChangeCallback();
                        }
                    } else {
                        _onStatusChangeCallback();
                    }
                }
            }

            restoreCellDisplay(td, col, { status: resolved }, resolved);
            addStatusClass(td, resolved);
            td.classList.remove('editing');
            td.classList.add('nav-selected');
            currentEditCell = null;
            _isEditing = false;
        }

        tick.addEventListener('click', (e) => { e.stopPropagation(); confirmStatus(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); confirmStatus(); }
            if (e.key === 'Escape') {
                restoreCellDisplay(td, col, entry, currentVal);
                addStatusClass(td, currentVal);
                td.classList.remove('editing');
                currentEditCell = null;
                _isEditing = false;
            }
        });
    }

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

    /* ── Public API ────────────────────────────────────────────────── */
    return {
        render,
        resortEntries,
        COLUMNS,
        // Cell operations (for undo etc.)
        _saveCell: saveCell,
        _restoreCell: restoreCellDisplay,
        _addStatusClass: addStatusClass,
        _startEdit: startEdit,
        _startExtraEdit: startExtraEdit,
        _isExtraCell: isExtraCell,
        _getExtraRowData: getExtraRowData,
        _finishEdit: finishEdit,
        // Undo / Redo
        undo,
        redo,
        pushUndo,
        // Navigation
        selectCell,
        deselectCell,
        // Hover tracking
        getHoveredRow: () => _hoveredRow,
        copyPolicyNo,
        // Status change callback for real-time stat updates
        onStatusChange: (fn) => { _onStatusChangeCallback = fn; },
    };
})();
