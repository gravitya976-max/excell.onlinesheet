/* ══════════════════════════════════════════════════════════════════════
   Online Sheet — Core App Logic
   Inline search: filters the active tab's table rows in place.
   ══════════════════════════════════════════════════════════════════════ */

const App = (() => {
    const state = {
        year: new Date().getFullYear(),
        month: new Date().getMonth() + 1,
        entries: [],
        _allEntries: [],   // full backup used by search filter
        listMeta: null,
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
    }
    function prevMonth() {
        state.month--;
        if (state.month < 1) { state.month = 12; state.year--; }
        updateMonthLabel(); loadList();
    }
    function nextMonth() {
        state.month++;
        if (state.month > 12) { state.month = 1; state.year++; }
        updateMonthLabel(); loadList();
    }

    // ── Tabs ──────────────────────────────────────────────────────────
    function switchTab(tab) {
        state.activeTab = tab;
        document.querySelectorAll('.tab').forEach(t =>
            t.classList.toggle('active', t.dataset.tab === tab)
        );
        if (tab === 'list') {
            $('#month-controls').classList.remove('hidden');
            $('#master-info').classList.add('hidden');
            $('#btn-generate').classList.remove('hidden');
            loadList();
        } else {
            $('#month-controls').classList.add('hidden');
            $('#master-info').classList.remove('hidden');
            $('#btn-generate').classList.add('hidden');
            loadMasterData();
        }
    }

    // ── Load monthly list ─────────────────────────────────────────────
    async function loadList() {
        try {
            const data = await api('GET', `/api/list/${state.year}/${state.month}`);
            state.entries = data.entries || [];
            state._allEntries = [...state.entries];
            state.listMeta = data.list;
            renderList();
            applyFilter($('#search-input').value);
        } catch (e) { toast(`Load failed: ${e.message}`, 'error'); }
    }

    function renderList() {
        const { entries, listMeta } = state;
        if (!listMeta || entries.length === 0) {
            $('#empty-state').classList.remove('hidden');
            $('#spreadsheet').classList.add('hidden');
            $('#info-count').textContent = 'No list generated';
            $('#info-generated-at').textContent = '';
            $('#footer-count').textContent = '0 rows';
            return;
        }
        $('#empty-state').classList.add('hidden');
        $('#spreadsheet').classList.remove('hidden');
        $('#info-count').textContent = `${entries.length} policies`;
        $('#info-generated-at').textContent = listMeta.generated_at
            ? `Generated: ${new Date(listMeta.generated_at).toLocaleString()}` : '';
        $('#footer-count').textContent = `${entries.length} rows`;
        Spreadsheet.render(entries);
    }

    // ── Load master data ──────────────────────────────────────────────
    async function loadMasterData() {
        try {
            const data = await api('GET', '/api/master?limit=5000');
            state.entries = data.data || [];
            state._allEntries = [...state.entries];
            const total = data.total || 0;
            $('#master-count-badge').textContent = `${total} policies`;
            $('#empty-state').classList.add('hidden');
            $('#spreadsheet').classList.remove('hidden');
            $('#info-count').textContent = `${total} master policies`;
            $('#info-generated-at').textContent = '';
            $('#footer-count').textContent = `${total} rows`;
            Spreadsheet.render(state.entries);
            applyFilter($('#search-input').value);
        } catch (e) { toast(`Load failed: ${e.message}`, 'error'); }
    }

    // ── Generate list ─────────────────────────────────────────────────
    async function generateList() {
        showLoading('Generating monthly list...');
        try {
            const data = await api('POST', `/api/generate?year=${state.year}&month=${state.month}`);
            toast(`List generated: ${data.filtered_count} policies due`, 'success');
            await loadList();
        } catch (e) { toast(`Generate failed: ${e.message}`, 'error'); }
        finally { hideLoading(); }
    }

    // ── Update entry ──────────────────────────────────────────────────
    async function updateEntry(entryId, field, value) {
        const syncEl = $('#footer-sync');
        syncEl.textContent = 'Saving...';
        syncEl.className = 'sync-indicator syncing';
        try {
            await api('PUT', `/api/entry/${entryId}`, { [field]: value });
            syncEl.textContent = '✓ Saved';
            syncEl.className = 'sync-indicator synced';
            setTimeout(() => { syncEl.textContent = ''; syncEl.className = 'sync-indicator'; }, 3000);
            return true;
        } catch (e) {
            syncEl.textContent = '✗ Save failed';
            syncEl.className = 'sync-indicator error';
            toast(`Save failed: ${e.message}`, 'error');
            setTimeout(() => { syncEl.textContent = ''; syncEl.className = 'sync-indicator'; }, 3000);
            return false;
        }
    }

    // ── Upload modal ──────────────────────────────────────────────────
    function openUpload() {
        $('#upload-overlay').classList.remove('hidden');
        $('#upload-result').classList.add('hidden');
    }
    function closeUpload() { $('#upload-overlay').classList.add('hidden'); }

    async function handleFiles(fileList) {
        if (!fileList.length) return;
        const resultEl = $('#upload-result');
        resultEl.classList.remove('hidden', 'success', 'failure');
        resultEl.textContent = `Uploading ${fileList.length} file(s)...`;
        resultEl.className = 'test-result';

        const fd = new FormData();
        for (const f of fileList) fd.append('files', f);

        showLoading(`Processing ${fileList.length} file(s)...`);
        try {
            const resp = await fetch('/api/upload', { method: 'POST', body: fd });
            if (!resp.ok) { const text = await resp.text(); throw new Error(text); }
            const data = await resp.json();
            const msg = `✓ ${data.files_processed} file(s) processed. ` +
                `${data.total_inserted} new, ${data.total_updated} enriched. ` +
                `${data.total_records} records parsed.`;
            resultEl.className = 'test-result success';
            resultEl.textContent = msg;
            toast(msg, 'success', 5000);
            if (data.errors && data.errors.length)
                data.errors.forEach(e => toast(`${e.file}: ${e.error}`, 'error', 5000));
            await refreshMasterCount();
        } catch (e) {
            resultEl.className = 'test-result failure';
            resultEl.textContent = `✗ Upload failed: ${e.message}`;
            toast(`Upload failed: ${e.message}`, 'error');
        } finally { hideLoading(); }
    }

    // ── Master count badge ────────────────────────────────────────────
    async function refreshMasterCount() {
        try {
            const data = await api('GET', '/api/master/count');
            const n = data.count ?? 0;
            $('#master-count-badge').textContent = `${n} policies`;
        } catch { /* ignore */ }
    }

    // ── Confirm dialog ────────────────────────────────────────────────
    function showConfirm(title, message, onOk) {
        const overlay = $('#confirm-overlay');
        $('#confirm-title').textContent = title;
        $('#confirm-message').textContent = message;
        overlay.classList.remove('hidden');
        const okBtn = $('#btn-confirm-ok');
        const cancelBtn = $('#btn-confirm-cancel');
        const cleanup = () => {
            overlay.classList.add('hidden');
            okBtn.replaceWith(okBtn.cloneNode(true));
            cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        };
        $('#btn-confirm-ok').addEventListener('click', () => { cleanup(); onOk(); }, { once: true });
        $('#btn-confirm-cancel').addEventListener('click', cleanup, { once: true });
    }

    // ── Search — inline row filter (active tab) ───────────────────────
    let _searchTimer = null;

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    }

    function highlightMatch(text, query) {
        if (!query || !text) return escapeHtml(text || '');
        const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return escapeHtml(text).replace(new RegExp(`(${q})`, 'gi'), '<mark class="search-hl">$1</mark>');
    }

    function applyFilter(query) {
        const q = query.trim().toLowerCase();
        const allRows = document.querySelectorAll('#spreadsheet-body tr:not(.extra-row)');
        const total = state._allEntries.length;
        const label = state.activeTab === 'list' ? 'policies' : 'master policies';

        if (!q) {
            // Restore all rows with plain text
            allRows.forEach(tr => {
                tr.classList.remove('search-hidden');
                tr.querySelectorAll('.cell-content').forEach(span => {
                    if (span.dataset.raw !== undefined) {
                        span.textContent = span.dataset.raw;
                        delete span.dataset.raw;
                    }
                });
            });
            $('#info-count').textContent = `${total} ${label}`;
            $('#footer-count').textContent = `${total} rows`;
            return;
        }

        let visible = 0;
        allRows.forEach(tr => {
            const spans = tr.querySelectorAll('.cell-content');
            // Read raw text for matching (use data-raw if already set)
            const texts = Array.from(spans).map(s => (s.dataset.raw ?? s.textContent).toLowerCase());
            const matches = texts.some(t => t.includes(q));

            if (matches) {
                tr.classList.remove('search-hidden');
                visible++;
                spans.forEach(span => {
                    const raw = span.dataset.raw ?? span.textContent;
                    if (!span.dataset.raw) span.dataset.raw = raw;
                    span.innerHTML = highlightMatch(raw, q);
                });
            } else {
                tr.classList.add('search-hidden');
                spans.forEach(span => {
                    if (!span.dataset.raw) span.dataset.raw = span.textContent;
                });
            }
        });

        $('#info-count').textContent = `${visible} of ${total} ${label}`;
        $('#footer-count').textContent = `${visible} rows`;
    }

    function clearSearchInput() {
        const inp = $('#search-input');
        if (inp) inp.value = '';
        const clr = $('#search-clear');
        if (clr) clr.classList.add('hidden');
    }

    function doSearch(query) {
        $('#search-clear').classList.toggle('hidden', !query.trim());
        applyFilter(query);
    }

    function clearSearch() {
        clearSearchInput();
        applyFilter('');
    }

    // ── Reload active tab (called after new entry saved from empty row) ──
    function reloadActive() {
        if (state.activeTab === 'master') loadMasterData();
        else loadList();
    }

    // ── Init ──────────────────────────────────────────────────────────
    function init() {
        updateMonthLabel();

        $('#btn-prev-month').addEventListener('click', prevMonth);
        $('#btn-next-month').addEventListener('click', nextMonth);

        $('#btn-generate').addEventListener('click', () => {
            showConfirm('Generate List?',
                `This will create/replace the due list for ${MONTH_NAMES[state.month]} ${state.year} from master data.`,
                generateList);
        });

        document.querySelectorAll('.tab').forEach(t =>
            t.addEventListener('click', () => switchTab(t.dataset.tab))
        );

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

        // Search: debounced inline filter
        $('#search-input').addEventListener('input', (e) => {
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => doSearch(e.target.value), 200);
        });
        $('#search-clear').addEventListener('click', clearSearch);
        $('#search-input').addEventListener('keydown', (e) => {
            if (e.key === 'Escape') clearSearch();
        });

        refreshMasterCount();
        loadList();
    }

    document.addEventListener('DOMContentLoaded', init);
    return { state, updateEntry, toast, api, reloadActive };
})();
