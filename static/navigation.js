/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Navigation Intelligence (Excel-like)
   
   FEATURES:
     • Single click on editable cell  →  select (highlight)
     • Arrow keys                     →  move selection
     • Enter                          →  confirm & move in last direction
     • Escape                         →  deselect
     • Status cells: p/a/d/c/b        →  set status & stay selected
     • Tab / Shift+Tab                →  move right / left
     • Direction memory: if you were moving vertically (Enter/arrows),
       Enter continues vertically; same for horizontal.
   ══════════════════════════════════════════════════════════════════════ */

const Navigation = (() => {
    // ── Status key mapping ────────────────────────────────────────────
    const STATUS_KEYS = {
        'p': 'paid',
        'a': 'autodebit',
        'd': '',           // empty = Due
        'c': 'dailycollection',
        'b': 'branchpaid',
    };

    const STATUS_LABELS = {
        '': 'Due', 'paid': 'Paid', 'autodebit': 'Auto Debit',
        'dailycollection': 'Daily Collection', 'branchpaid': 'Branch Paid',
    };

    // ── State ─────────────────────────────────────────────────────────
    let selectedCell = null;    // currently selected <td>
    let lastDirection = 'down'; // 'up' | 'down' | 'left' | 'right'
    let isEditing = false;      // true when a text input is active

    // ── Helpers: grid position ────────────────────────────────────────
    function getTable() {
        return document.querySelector('.spreadsheet');
    }

    function getCellPos(td) {
        const tr = td.closest('tr');
        if (!tr) return null;
        const tbody = tr.closest('tbody');
        if (!tbody) return null;
        const rowIdx = Array.from(tbody.rows).indexOf(tr);
        const colIdx = Array.from(tr.cells).indexOf(td);
        return { row: rowIdx, col: colIdx };
    }

    function getCellAt(row, col) {
        const table = getTable();
        if (!table) return null;
        const tbody = table.querySelector('tbody');
        if (!tbody) return null;
        const tr = tbody.rows[row];
        if (!tr) return null;
        return tr.cells[col] || null;
    }

    function getGridSize() {
        const table = getTable();
        if (!table) return { rows: 0, cols: 0 };
        const tbody = table.querySelector('tbody');
        if (!tbody || !tbody.rows.length) return { rows: 0, cols: 0 };
        return { rows: tbody.rows.length, cols: tbody.rows[0].cells.length };
    }

    function isEditableCell(td) {
        return td && td.classList.contains('editable');
    }

    function isStatusCell(td) {
        return td && td.classList.contains('col-status');
    }

    function getCellInfo(td) {
        // Retrieve column def and entry from Spreadsheet
        const field = td.dataset.field;
        const entryId = td.dataset.entryId;
        if (!field || !entryId) return null;
        const col = Spreadsheet.COLUMNS.find(c => c.key === field);
        const entry = App.state.entries.find(e => e.id === parseInt(entryId));
        if (!col || !entry) return null;
        return { col, entry };
    }

    // ── Selection ─────────────────────────────────────────────────────
    function selectCell(td) {
        if (selectedCell === td) return;
        deselectCell();
        if (!td || !isEditableCell(td)) return;

        selectedCell = td;
        td.classList.add('nav-selected');
        td.setAttribute('tabindex', '0');
        td.focus();
        // Highlight the entire row
        const tr = td.closest('tr');
        if (tr) tr.classList.add('nav-active-row');
        // Disable hover on other rows
        const table = td.closest('.spreadsheet');
        if (table) table.classList.add('nav-has-selection');
    }

    function deselectCell() {
        if (selectedCell) {
            const tr = selectedCell.closest('tr');
            if (tr) tr.classList.remove('nav-active-row');
            // Re-enable hover
            const table = selectedCell.closest('.spreadsheet');
            if (table) table.classList.remove('nav-has-selection');
            selectedCell.classList.remove('nav-selected');
            selectedCell.removeAttribute('tabindex');
            selectedCell = null;
        }
        isEditing = false;
    }

    // ── Movement ──────────────────────────────────────────────────────
    function move(direction) {
        if (!selectedCell) return;
        const pos = getCellPos(selectedCell);
        if (!pos) return;
        const grid = getGridSize();

        let newRow = pos.row, newCol = pos.col;
        switch (direction) {
            case 'up':    newRow = Math.max(0, pos.row - 1); break;
            case 'down':  newRow = Math.min(grid.rows - 1, pos.row + 1); break;
            case 'left':  newCol = Math.max(0, pos.col - 1); break;
            case 'right': newCol = Math.min(grid.cols - 1, pos.col + 1); break;
        }

        // Skip non-editable cells (sn, policyno) — search further in same direction
        let td = getCellAt(newRow, newCol);
        const maxTries = Math.max(grid.rows, grid.cols);
        let tries = 0;
        while (td && !isEditableCell(td) && tries < maxTries) {
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

        if (td && isEditableCell(td)) {
            lastDirection = direction;
            selectCell(td);
        }
    }

    // ── Status actions ────────────────────────────────────────────────
    function applyStatusKey(td, key) {
        const info = getCellInfo(td);
        if (!info) return;
        const { col, entry } = info;
        const newVal = STATUS_KEYS[key];
        const oldVal = entry[col.key] || '';

        if (newVal !== oldVal) {
            entry[col.key] = newVal;
            // Use Spreadsheet's saveCell via the exposed API
            Spreadsheet._saveCell(td, entry.id, col.key, newVal);
        }

        // Update display
        Spreadsheet._restoreCell(td, col, entry, newVal);
        Spreadsheet._addStatusClass(td, newVal);

        // Stay selected — don't deselect
        td.classList.add('nav-selected');
        td.setAttribute('tabindex', '0');
        td.focus();
    }

    // ── Keyboard handler ──────────────────────────────────────────────
    function onKeyDown(e) {
        // Don't interfere with text editing inputs
        if (isEditing) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
        if (!selectedCell) return;

        const key = e.key;

        // Arrow keys → navigate
        if (key === 'ArrowUp')    { e.preventDefault(); move('up'); return; }
        if (key === 'ArrowDown')  { e.preventDefault(); move('down'); return; }
        if (key === 'ArrowLeft')  { e.preventDefault(); move('left'); return; }
        if (key === 'ArrowRight') { e.preventDefault(); move('right'); return; }

        // Tab / Shift+Tab → horizontal
        if (key === 'Tab') {
            e.preventDefault();
            move(e.shiftKey ? 'left' : 'right');
            return;
        }

        // Enter → move in last direction
        if (key === 'Enter') {
            e.preventDefault();
            move(lastDirection);
            return;
        }

        // Escape → deselect
        if (key === 'Escape') {
            e.preventDefault();
            deselectCell();
            return;
        }

        // Status cell shortcuts
        if (isStatusCell(selectedCell)) {
            const lk = key.toLowerCase();
            if (lk in STATUS_KEYS) {
                e.preventDefault();
                applyStatusKey(selectedCell, lk);
                return;
            }
        }

        // Any other printable key on a non-status editable cell → start editing
        if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (!isStatusCell(selectedCell)) {
                const info = getCellInfo(selectedCell);
                if (info) {
                    e.preventDefault();
                    isEditing = true;
                    Spreadsheet._startEdit(selectedCell, info.col, info.entry, key);
                }
            }
        }
    }

    // ── Click handler: single click to select ─────────────────────────
    function onClick(e) {
        // Find the closest td
        const td = e.target.closest('td.editable');
        if (td) {
            // Don't select if clicking inside an active input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            selectCell(td);
        } else {
            deselectCell();
        }
    }

    // ── Init ──────────────────────────────────────────────────────────
    function init() {
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('click', onClick);
    }

    // ── Public API ────────────────────────────────────────────────────
    return {
        init,
        selectCell,
        deselectCell,
        setEditing(v) { isEditing = v; },
    };
})();

// Auto-init when DOM is ready
document.addEventListener('DOMContentLoaded', () => Navigation.init());
