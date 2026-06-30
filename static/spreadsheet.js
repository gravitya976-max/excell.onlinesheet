/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Spreadsheet Rendering & Inline Editing

   INTERACTIONS:
     • Double LEFT-CLICK on a cell   →  edit that cell
     • Single RIGHT-CLICK on a row   →  copy policy number
     • Double LEFT-CLICK a header    →  rename the header
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

    /* ── Colgroup ────────────────────────────────────────────────────── */
    function buildColgroup() {
        const table = document.getElementById('spreadsheet');
        const old = table.querySelector('colgroup');
        if (old) old.remove();
        const colgroup = document.createElement('colgroup');
        COLUMNS.forEach(col => {
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
        table.style.width = COLUMNS.reduce((s, c) => s + (colWidths[c.key] || 100), 0) + 'px';
    }

    /* ── Header ──────────────────────────────────────────────────────── */
    function renderHeader() {
        const headerRow = document.getElementById('header-row');
        headerRow.innerHTML = '';
        COLUMNS.forEach(col => {
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
       SINGLE RIGHT-CLICK → copy policy number
       ════════════════════════════════════════════════════════════════════ */
    function onRowRightClick(e, tr) {
        e.preventDefault(); // block browser context menu
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        copyPolicyNo(tr);
    }

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
        setTimeout(() => tr.classList.remove('copied-row'), 1500);
        if (typeof App !== 'undefined') App.toast(`Copied: ${pno}`, 'success', 1500);
    }

    // ── Extra (blank) editable rows — always 30 after real data ──────
    const extraRowData = {}; // idx → { field: value }

    function commitExtraRow(idx) {
        const data = extraRowData[idx] || {};
        const pno = (data.policyno || '').trim();
        if (!pno) return; // nothing to save yet

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
                // Reload the active tab to reflect new entry + fresh 30 empty rows
                if (activeTab === 'master') {
                    App.reloadActive();
                } else {
                    App.reloadActive();
                }
            })
            .catch(err => App.toast(`Save failed: ${err.message}`, 'error'));
    }

    /* ════════════════════════════════════════════════════════════════════
       DOUBLE LEFT-CLICK → edit cell
       Uses the native 'dblclick' event — no timers needed
       ════════════════════════════════════════════════════════════════════ */
    function onCellDblClick(e, td, col, entry) {
        e.stopPropagation();
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (!col.editable) return;
        if (td.classList.contains('editing')) return;
        closeActiveEdit();
        startEdit(td, col, entry);
    }

    function closeActiveEdit() {
        if (currentEditCell) {
            const inp = currentEditCell.querySelector('input.cell-input, select.cell-input');
            if (inp) inp.blur();
        }
    }

    /* ── Render ───────────────────────────────────────────────────────── */
    function render(entries) {
        loadColWidths(); loadHeaderNames(); loadRowHeights(); buildColgroup(); renderHeader();
        const tbody = document.getElementById('spreadsheet-body');
        tbody.innerHTML = '';
        entries.forEach((entry, idx) => tbody.appendChild(createDataRow(entry, idx)));

        for (let i = 0; i < EXTRA_ROWS; i++) {
            const rowIdx = entries.length + i;
            const extraIdx = i;
            const tr = document.createElement('tr');
            tr.className = 'extra-row';
            if (rowHeights[rowIdx]) tr.style.height = rowHeights[rowIdx] + 'px';

            COLUMNS.forEach(col => {
                const td = document.createElement('td');
                td.className = `col-${col.key}`;
                if (rowHeights[rowIdx]) td.style.height = rowHeights[rowIdx] + 'px';

                if (col.type === 'index') {
                    td.classList.add('locked');
                    td.style.position = 'relative';
                    const span = document.createElement('span');
                    span.className = 'cell-content';
                    span.textContent = entries.length + i + 1;
                    td.appendChild(span);
                    const rh = document.createElement('div');
                    rh.className = 'row-resize-handle';
                    rh.addEventListener('mousedown', (e) => startRowResize(e, rowIdx, tr));
                    td.appendChild(rh);
                } else if (col.type === 'status') {
                    const span = document.createElement('span');
                    span.className = 'cell-content';
                    td.appendChild(span);
                } else {
                    const span = document.createElement('span');
                    span.className = 'cell-content';
                    span.textContent = (extraRowData[extraIdx] || {})[col.key] || '';
                    td.appendChild(span);

                    td.addEventListener('dblclick', () => {
                        if (td.querySelector('input')) return;
                        td.innerHTML = '';
                        td.style.position = 'relative';
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.className = 'cell-input';
                        input.style.position = 'absolute';
                        input.style.inset = '0';
                        input.style.width = '100%';
                        input.style.height = '100%';
                        input.value = (extraRowData[extraIdx] || {})[col.key] || '';
                        input.addEventListener('blur', () => {
                            const val = input.value.trim();
                            if (!extraRowData[extraIdx]) extraRowData[extraIdx] = {};
                            extraRowData[extraIdx][col.key] = val;
                            td.innerHTML = '';
                            const s2 = document.createElement('span');
                            s2.className = 'cell-content';
                            s2.textContent = val;
                            td.appendChild(s2);
                            if (col.key === 'policyno' && val) commitExtraRow(extraIdx);
                        });
                        input.addEventListener('keydown', e => {
                            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); input.blur(); }
                            if (e.key === 'Escape') { input.value = ''; input.blur(); }
                        });
                        td.appendChild(input);
                        input.focus();
                    });
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        }
    }

    function createDataRow(entry, idx) {
        const tr = document.createElement('tr');
        tr.dataset.entryId = entry.id;
        if (rowHeights[idx]) tr.style.height = rowHeights[idx] + 'px';

        // Single right-click anywhere on the row → copy policy number
        tr.addEventListener('contextmenu', (e) => onRowRightClick(e, tr));

        COLUMNS.forEach(col => {
            const td = document.createElement('td');
            td.className = `col-${col.key}`;
            if (rowHeights[idx]) td.style.height = rowHeights[idx] + 'px';

            if (col.type === 'index') {
                td.classList.add('locked');
                td.style.position = 'relative';
                const span = document.createElement('span');
                span.className = 'cell-content'; span.textContent = idx + 1;
                td.appendChild(span);
                const rh = document.createElement('div');
                rh.className = 'row-resize-handle';
                rh.addEventListener('mousedown', (e) => startRowResize(e, idx, tr));
                td.appendChild(rh);

            } else if (col.key === 'policyno') {
                td.classList.add('locked');
                const span = document.createElement('span');
                span.className = 'cell-content';
                span.textContent = entry.policyno || '';
                td.appendChild(span);

            } else {
                td.classList.add('editable');
                td.dataset.field = col.key;
                td.dataset.entryId = entry.id;
                const value = entry[col.key] || '';
                const span = document.createElement('span');
                span.className = 'cell-content';
                if (col.type === 'status') { span.textContent = STATUS_LABELS[value] || value || 'Due'; addStatusClass(td, value); }
                else { span.textContent = value; }
                td.appendChild(span);

                // Double left-click → edit (all columns)
                attachEditDblClick(td, col, entry);
            }

            tr.appendChild(td);
        });

        return tr;
    }

    function attachEditDblClick(td, col, entry) {
        td.addEventListener('dblclick', (e) => onCellDblClick(e, td, col, entry));
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
    function startEdit(td, col, entry) {
        td.classList.add('editing');
        td.innerHTML = '';
        currentEditCell = td;

        if (col.type === 'status') createStatusKeystrokeInput(td, entry[col.key] || '', entry, col);
        else createTextInput(td, entry[col.key] || '', entry, col);
    }

    function createTextInput(td, value, entry, col) {
        const isNote = col.key.startsWith('note');
        const input = document.createElement('input');
        input.type = 'text'; input.className = 'cell-input';
        // For notes, show raw value (user edits without date prefix)
        input.value = value;

        input.addEventListener('blur', () => {
            let nv = input.value.trim();
            finishEdit(td);

            // Auto date-tag ONLY when the cell was empty before
            // If it already had content, the user is editing — save as-is
            if (isNote && nv && !value) {
                const now = new Date();
                const dd = String(now.getDate()).padStart(2, '0');
                const mm = String(now.getMonth() + 1).padStart(2, '0');
                nv = `${dd}/${mm} - ${nv}`;
            }

            if (nv !== value) { entry[col.key] = nv; saveCell(td, entry.id, col.key, nv); }
            restoreCellDisplay(td, col, entry, nv);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            else if (e.key === 'Escape') { input.value = value; input.blur(); }
            else if (e.key === 'Tab') { e.preventDefault(); input.blur(); moveToNextEditable(td, col, entry, e.shiftKey); }
        });

        td.appendChild(input); input.focus(); input.select();
    }

    function createStatusKeystrokeInput(td, value, entry, col) {
        // Show current status text inside the marching-ants cell
        const label = document.createElement('span');
        label.className = 'cell-content';
        label.textContent = STATUS_LABELS[value] || value || 'Due';
        td.appendChild(label);

        // Hidden input to capture keystrokes
        const trap = document.createElement('input');
        trap.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none;';
        td.appendChild(trap);
        trap.focus();

        trap.addEventListener('keydown', (e) => {
            const key = e.key.toLowerCase();
            if (key in STATUS_KEYS) {
                e.preventDefault();
                const newVal = STATUS_KEYS[key];
                if (newVal !== value) {
                    entry[col.key] = newVal;
                    saveCell(td, entry.id, col.key, newVal);
                }
                finishEdit(td);
                restoreCellDisplay(td, col, entry, newVal);
                addStatusClass(td, newVal);
            } else if (key === 'escape') {
                finishEdit(td);
                restoreCellDisplay(td, col, entry, value);
            }
        });

        trap.addEventListener('blur', () => {
            finishEdit(td);
            restoreCellDisplay(td, col, entry, value);
        });
    }

    function finishEdit(td) { td.classList.remove('editing'); if (currentEditCell === td) currentEditCell = null; }

    function restoreCellDisplay(td, col, entry, value) {
        td.innerHTML = '';
        const span = document.createElement('span');
        span.className = 'cell-content';
        span.textContent = (col.type === 'status') ? (STATUS_LABELS[value] || value || 'Due') : (value || '');
        td.appendChild(span);
        attachEditDblClick(td, col, entry);
    }

    async function saveCell(td, entryId, field, value) {
        td.classList.add('saving'); td.classList.remove('saved');
        const ok = await App.updateEntry(entryId, field, value);
        td.classList.remove('saving');
        if (ok) { td.classList.add('saved'); setTimeout(() => td.classList.remove('saved'), 2000); }
    }

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

    /* ── Close edit when clicking outside ─────────────────────────── */
    document.addEventListener('mousedown', (e) => {
        if (!currentEditCell) return;
        if (currentEditCell.contains(e.target)) return;
        closeActiveEdit();
    });

    /* ── Realtime Clock ────────────────────────────────────────────── */
    function startClock() {
        const el = document.getElementById('realtime-clock');
        if (!el) return;
        function tick() {
            const now = new Date();
            const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
            const dd = String(now.getDate()).padStart(2, '0');
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const yyyy = now.getFullYear();
            const hh = String(now.getHours()).padStart(2, '0');
            const min = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            el.textContent = `${days[now.getDay()]}  ${dd}/${mm}/${yyyy}  ${hh}:${min}:${ss}`;
        }
        tick();
        setInterval(tick, 1000);
    }
    startClock();

    return { render, COLUMNS };
})();
