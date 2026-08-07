/* ══════════════════════════════════════════════════════════════════════
   CRM — SMS & Call Communication Module
   Hooks into existing blue-pen row selection (nav-active-row).
   Does NOT modify any existing JS files.

   MODES:
     • SMS mode  → select rows → floating box → send
     • Call mode → click row → confirmation popup → trigger call
     • Neutral   → no CRM behaviour (default)
   ══════════════════════════════════════════════════════════════════════ */

const CRM = (() => {
    // ── State ─────────────────────────────────────────────────────────
    let mode = null;  // null | 'sms' | 'call'
    let selectedContacts = [];
    let isSending = false;
    let batchId = null;
    let pollTimer = null;
    let gatewayTimer = null;
    let gatewayOnline = false;  // tracks whether SMS/call gateway is reachable
    let activeTab = 'select'; // 'select' | 'history'
    let _historyCache = null;  // cached history HTML for instant tab switch

    // ── DOM refs ──────────────────────────────────────────────────────
    const $  = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    // ── Init ──────────────────────────────────────────────────────────
    // ── Drag-select state ─────────────────────────────────────────────
    let _dragging = false;
    let _dragAction = null;           // 'select' or 'deselect'
    let _anchorDataIdx = -1;          // data index (vsIdx) of anchor row
    let _currentDataIdx = -1;         // data index of current row under pointer
    let _lastMouseX = 0;
    let _lastMouseY = 0;
    let _scrollSpeed = 0;             // px/frame: negative = up, positive = down
    let _dragRAF = null;              // single rAF loop for scroll + selection
    let _preDragContacts = [];        // snapshot of selectedContacts before drag
    let _preDragPnos = new Set();     // policy_nos selected before drag
    let _lastRangeLo = -1;            // optimization: skip rebuild if range unchanged
    let _lastRangeHi = -1;
    let _suppressNextClick = false;   // prevent click handler after drag-select

    function init() {
        // Mode buttons — SMS flyout options replace direct click
        // Direct click on sms-btn now just toggles flyout visibility (handled by CSS hover + click fallback)
        $('#crm-sms-btn')?.addEventListener('click', (e) => {
            // If already in sms or sms-custom mode, clicking the icon deactivates
            if (mode === 'sms' || mode === 'sms-custom') {
                toggleMode(null);
                return;
            }
            // Otherwise, let the flyout handle it (CSS :hover shows flyout)
            const flyout = $('#crm-sms-flyout');
            if (flyout) flyout.classList.toggle('force-show');
        });

        // Flyout option clicks
        document.querySelectorAll('.crm-flyout-opt').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const smsMode = btn.dataset.smsMode; // 'normal' or 'custom'
                const flyout = $('#crm-sms-flyout');
                if (flyout) flyout.classList.remove('force-show');
                if (smsMode === 'normal') {
                    toggleMode('sms');
                } else if (smsMode === 'custom') {
                    toggleMode('sms-custom');
                }
            });
        });

        // Close flyout on click outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#crm-sms-wrapper')) {
                const flyout = $('#crm-sms-flyout');
                if (flyout) flyout.classList.remove('force-show');
            }
        });

        $('#crm-call-btn')?.addEventListener('click', () => toggleMode('call'));
        $('#crm-queue-btn')?.addEventListener('click', () => toggleQueue());

        // Floating box controls
        $('#crm-clear-all')?.addEventListener('click', closeAndDeselect);

        // Send SMS button (exists in HTML, attach listener now)
        $('#crm-send-btn')?.addEventListener('click', showConfirmation);

        // Tab buttons
        $('#crm-tab-select')?.addEventListener('click', () => switchTab('select'));
        $('#crm-tab-history')?.addEventListener('click', () => switchTab('history'));

        // Call modal controls
        $('#crm-call-cancel')?.addEventListener('click', closeCallModal);
        $('#crm-call-do')?.addEventListener('click', confirmCall);

        // Close modal on backdrop click
        $('#crm-call-modal')?.addEventListener('click', (e) => {
            if (e.target === $('#crm-call-modal')) closeCallModal();
        });

        // Make floating box draggable
        makeDraggable($('#crm-float-box'), $('#crm-float-header'));

        // Hook into row clicks
        document.addEventListener('click', onRowClick);

        // ── Drag-select for SMS mode ─────────────────────────────────
        document.addEventListener('mousedown', onDragStart);
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);

        // ── Hook into virtual scroller: sync crm-selected on freshly rendered rows ──
        if (typeof VirtualScroller !== 'undefined' && VirtualScroller.onRowRendered) {
            VirtualScroller.onRowRendered((tr) => {
                if (mode !== 'sms' && mode !== 'sms-custom') {
                    tr.classList.remove('crm-selected');
                    return;
                }
                const pno = _getPolicyFromRow(tr);
                const isSelected = pno && selectedContacts.some(c => c.policy_no === pno);
                tr.classList.toggle('crm-selected', isSelected);
            });
        }

        // Gateway status polling (60s — avoids log flooding)
        pollGateway();
        gatewayTimer = setInterval(pollGateway, 60000);
    }

    // ── Drag-select handlers ────────────────────────────────────────
    let _renderRaf = null;
    function _scheduleRender() {
        if (_renderRaf) return;
        _renderRaf = requestAnimationFrame(() => {
            _renderRaf = null;
            renderFloatBox();
        });
    }

    // ── Constants ────────────────────────────────────────────────────
    const EDGE_ZONE = 60;          // px from container edge to trigger scroll
    const MAX_SCROLL_SPEED = 14;   // px per frame at the very edge

    function _getScrollContainer() {
        return document.getElementById('scroll-container');
    }

    function _getVisibleRows() {
        const tbody = document.getElementById('spreadsheet-body');
        if (!tbody) return [];
        return Array.from(tbody.querySelectorAll('tr[data-entry-id]'));
    }

    function _getPolicyFromRow(tr) {
        const td = tr.querySelector('.col-policyno');
        const span = td?.querySelector('.cell-content');
        return span?.textContent?.trim() || '';
    }

    /**
     * Compute the data index from mouse Y position + scroll offset.
     * Uses VirtualScroller.getRowHeight() (32px) for math — no DOM lookup.
     * Subtracts tbody.offsetTop to account for the <thead> height.
     * Clamps to [0, dataLength-1].
     */
    function _dataIdxFromMouseY(mouseY) {
        const sc = _getScrollContainer();
        if (!sc) return -1;
        const tbody = document.getElementById('spreadsheet-body');
        if (!tbody) return -1;
        const rect = sc.getBoundingClientRect();
        const ROW_HEIGHT = (typeof VirtualScroller !== 'undefined')
            ? VirtualScroller.getRowHeight() : 32;
        const dataLen = (typeof VirtualScroller !== 'undefined')
            ? VirtualScroller.getDataLength() : 0;
        if (dataLen === 0) return -1;

        // absY in the scrollable content, minus tbody offset (thead height)
        const absY = sc.scrollTop + (mouseY - rect.top) - tbody.offsetTop;
        const idx = Math.floor(absY / ROW_HEIGHT);
        return Math.max(0, Math.min(dataLen - 1, idx));
    }

    /**
     * Compute scroll speed from mouse position relative to container edges.
     * Returns negative for scroll-up, positive for scroll-down, 0 for no scroll.
     * Speed increases the further outside the edge zone the mouse is.
     */
    function _computeScrollSpeed(mouseY) {
        const sc = _getScrollContainer();
        if (!sc) return 0;
        const rect = sc.getBoundingClientRect();
        const fromTop = mouseY - rect.top;
        const fromBottom = rect.bottom - mouseY;

        if (fromTop < EDGE_ZONE) {
            // Mouse near/above top edge — scroll up
            const dist = EDGE_ZONE - Math.max(0, fromTop);
            return -Math.ceil(MAX_SCROLL_SPEED * (dist / EDGE_ZONE));
        } else if (fromBottom < EDGE_ZONE) {
            // Mouse near/below bottom edge — scroll down
            const dist = EDGE_ZONE - Math.max(0, fromBottom);
            return Math.ceil(MAX_SCROLL_SPEED * (dist / EDGE_ZONE));
        }
        return 0;
    }

    /**
     * Build a contact object from VirtualScroller data (no DOM needed).
     */
    function _contactFromData(dataIdx) {
        if (typeof VirtualScroller === 'undefined') return null;
        const entry = VirtualScroller.getRow(dataIdx);
        if (!entry) return null;
        const pno = entry.policyno || '';
        if (!pno) return null;
        const mobile = entry.mobileno || '';
        if (!mobile) return null;
        const statusRaw = (entry.status || '').trim().toLowerCase();
        const statusLabel = (statusRaw === 'autodebit' || statusRaw === 'auto debit')
            ? 'Auto Debit' : 'Due';
        const contact = {
            policy_no: pno,
            name: entry.name || '',
            mobile,
            premium: entry.premium || '',
            fup: entry.fup || '',
            doc: entry.doc || '',
            status: statusLabel,
            rowEl: null, // no DOM ref needed
        };
        // Enrich with extra fields for custom mode
        if (mode === 'sms-custom') {
            contact.due_months = entry.due_months || '';
            contact.mode = entry.mode || '';
        }
        return contact;
    }

    /**
     * Core rAF tick loop — runs every frame while dragging.
     * Handles auto-scroll AND selection recompute in one loop.
     */
    function _dragTick() {
        if (!_dragging) return;

        const sc = _getScrollContainer();
        if (sc && _scrollSpeed !== 0) {
            sc.scrollTop += _scrollSpeed;
        }

        // Recompute current data index from last mouse position + scroll
        _currentDataIdx = _dataIdxFromMouseY(_lastMouseY);

        // Rebuild selection from data
        _rebuildSelectionFromData();

        _dragRAF = requestAnimationFrame(_dragTick);
    }

    // ── Event handlers ──────────────────────────────────────────────

    function onDragStart(e) {
        if (mode !== 'sms' && mode !== 'sms-custom' || isSending) return;
        if (App.state.activeTab !== 'list') return;
        if (e.button !== 0) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;

        const tr = e.target.closest('tbody tr[data-entry-id]');
        if (!tr) return;

        e.preventDefault();

        _dragging = true;
        _anchorDataIdx = parseInt(tr.dataset.vsIdx) || 0;
        _lastMouseX = e.clientX;
        _lastMouseY = e.clientY;
        _currentDataIdx = _anchorDataIdx;

        // Snapshot current selection
        _preDragContacts = selectedContacts.map(c => ({ ...c }));
        _preDragPnos = new Set(selectedContacts.map(c => c.policy_no));

        // Determine action: if anchor row was already selected → deselect mode
        const pno = _getPolicyFromRow(tr);
        _dragAction = _preDragPnos.has(pno) ? 'deselect' : 'select';

        // Block text selection
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        document.addEventListener('selectstart', _preventSelect);

        // Compute initial selection (just the anchor row)
        _scrollSpeed = _computeScrollSpeed(e.clientY);
        _rebuildSelectionFromData();

        // NOTE: rAF loop starts on first mousemove, not here.
        // A simple click (no movement) only selects the anchor row.
    }

    function _preventSelect(e) { e.preventDefault(); }

    function onDragMove(e) {
        if (!_dragging) return;
        _lastMouseX = e.clientX;
        _lastMouseY = e.clientY;
        _scrollSpeed = _computeScrollSpeed(e.clientY);

        // Recompute current index immediately on mouse move
        _currentDataIdx = _dataIdxFromMouseY(e.clientY);

        // Start rAF loop on first move (not on mousedown — avoids double-select)
        if (!_dragRAF) {
            _dragRAF = requestAnimationFrame(_dragTick);
        }

        // Rebuild selection
        _rebuildSelectionFromData();
    }

    function onDragEnd() {
        if (!_dragging) return;
        _dragging = false;
        _anchorDataIdx = -1;
        _currentDataIdx = -1;
        _scrollSpeed = 0;
        _preDragContacts = [];
        _preDragPnos.clear();
        if (_dragRAF) {
            cancelAnimationFrame(_dragRAF);
            _dragRAF = null;
        }
        _lastRangeLo = -1;
        _lastRangeHi = -1;
        document.removeEventListener('selectstart', _preventSelect);
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
        window.getSelection()?.removeAllRanges();
        // Suppress the upcoming click event so onRowClick doesn't double-process
        _suppressNextClick = true;
        // Final full render of float box now that drag is done
        renderFloatBox();
    }

    /**
     * Core selection logic — recomputes selectedContacts from data indices.
     * Selection = all rows between anchor and current data index.
     * Reads from VirtualScroller.getRow(i), not from DOM.
     */
    function _rebuildSelectionFromData() {
        if (_anchorDataIdx < 0 || _currentDataIdx < 0) return;

        const lo = Math.min(_anchorDataIdx, _currentDataIdx);
        const hi = Math.max(_anchorDataIdx, _currentDataIdx);

        // Skip if range hasn't changed
        if (lo === _lastRangeLo && hi === _lastRangeHi) return;
        _lastRangeLo = lo;
        _lastRangeHi = hi;

        // 1. Reset to pre-drag snapshot
        selectedContacts.length = 0;
        for (const c of _preDragContacts) selectedContacts.push({ ...c });

        // 2. Apply drag action to ALL rows in [lo..hi] (from data, not DOM)
        for (let i = lo; i <= hi; i++) {
            const contact = _contactFromData(i);
            if (!contact) continue;
            const pno = contact.policy_no;

            if (_dragAction === 'select') {
                if (!selectedContacts.some(c => c.policy_no === pno)) {
                    selectedContacts.push(contact);
                }
            } else {
                const idx = selectedContacts.findIndex(c => c.policy_no === pno);
                if (idx >= 0) selectedContacts.splice(idx, 1);
            }
        }

        // 3. Sync CSS on visible DOM rows
        const selectedPnos = new Set(selectedContacts.map(c => c.policy_no));
        const visibleRows = _getVisibleRows();
        for (const row of visibleRows) {
            const pno = _getPolicyFromRow(row);
            row.classList.toggle('crm-selected', selectedPnos.has(pno));
        }

        // 4. During drag: only update count badge (cheap). Full list render on dragEnd.
        const header = $('#crm-float-count');
        if (header) header.textContent = `Selected (${selectedContacts.length})`;

        if (selectedContacts.length > 0) {
            const box = $('#crm-float-box');
            if (box && !box.classList.contains('visible')) {
                box.classList.add('visible');
                if (activeTab !== 'select') switchTab('select');
            }
        }
    }

    // ── Tabs ──────────────────────────────────────────────────────────
    function switchTab(tab) {
        activeTab = tab;
        $('#crm-tab-select')?.classList.toggle('active', tab === 'select');
        $('#crm-tab-history')?.classList.toggle('active', tab === 'history');

        if (tab === 'history') {
            // Show cache instantly, refresh in background
            if (_historyCache) {
                const list = $('#crm-float-list');
                if (list) list.innerHTML = _historyCache;
            }
            loadHistory();
            $('#crm-float-footer').style.display = 'none';
            $('#crm-clear-all').style.display = 'none';
        } else {
            renderFloatBox();
            $('#crm-float-footer').style.display = '';
            $('#crm-clear-all').style.display = '';
        }
    }

    // ── History ──────────────────────────────────────────────────────
    let _historyFilter = 'queue'; // 'queue' | 'sms' | 'call'
    let _smsLogs = [];
    let _callLogs = [];
    let _queueData = null;

    async function loadHistory() {
        const list = $('#crm-float-list');
        if (!list) return;

        _renderHistoryShell(list);

        try {
            const [smsData, callData, queueData] = await Promise.all([
                App.api('GET', '/api/sms/logs'),
                App.api('GET', '/api/calls/logs'),
                App.api('GET', '/api/sms/queue/status'),
            ]);

            _smsLogs = (smsData.logs || []).map(l => ({ ...l, type: 'sms' }));
            _callLogs = (callData.logs || []).map(l => ({ ...l, type: 'call', sent_at: l.triggered_at }));
            _queueData = queueData;

            _smsLogs.sort((a, b) => (b.sent_at || '').localeCompare(a.sent_at || ''));
            _callLogs.sort((a, b) => (b.sent_at || '').localeCompare(a.sent_at || ''));

            _renderHistoryContent();
            _historyCache = list.innerHTML;
        } catch (err) {
            const content = list.querySelector('.crm-history-content');
            if (content) content.innerHTML = `<div style="text-align:center;padding:20px;color:#d04040;font-size:12px">Failed to load</div>`;
        }
    }

    /** Refresh only queue data (for auto-refresh timer) */
    async function _refreshQueueData() {
        try {
            _queueData = await App.api('GET', '/api/sms/queue/status');
            if (_historyFilter === 'queue') _renderHistoryContent();
        } catch {}
    }

    function _renderHistoryShell(list) {
        const queueSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/><polyline points="12 7 12 12 15 15"/></svg>`;
        const smsSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="10" r="0.5" fill="currentColor"/><circle cx="12" cy="10" r="0.5" fill="currentColor"/><circle cx="15" cy="10" r="0.5" fill="currentColor"/></svg>`;
        const callSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;

        list.innerHTML = `
            <div class="crm-history-toggles">
                <button class="crm-history-toggle ${_historyFilter === 'queue' ? 'active' : ''}" data-filter="queue">${queueSvg} Queue</button>
                <button class="crm-history-toggle ${_historyFilter === 'sms' ? 'active' : ''}" data-filter="sms">${smsSvg} SMS</button>
                <button class="crm-history-toggle ${_historyFilter === 'call' ? 'active' : ''}" data-filter="call">${callSvg} Calls</button>
            </div>
            <div class="crm-history-content"><div style="text-align:center;padding:20px;color:#8b92a5;font-size:12px">Loading...</div></div>
        `;

        list.querySelectorAll('.crm-history-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                _historyFilter = btn.dataset.filter;
                list.querySelectorAll('.crm-history-toggle').forEach(b => b.classList.toggle('active', b.dataset.filter === _historyFilter));
                _renderHistoryContent();
                _historyCache = list.innerHTML;
            });
        });
    }

    function _renderHistoryContent() {
        const content = document.querySelector('.crm-history-content');
        if (!content) return;

        if (_historyFilter === 'queue') {
            _renderQueueContent(content);
        } else {
            const logs = _historyFilter === 'sms' ? _smsLogs : _callLogs;
            if (logs.length === 0) {
                content.innerHTML = `<div style="text-align:center;padding:30px;color:#8b92a5;font-size:12px">No ${_historyFilter === 'sms' ? 'SMS' : 'call'} history yet</div>`;
                return;
            }
            const frag = document.createDocumentFragment();
            _buildLogSection(frag, logs);
            content.innerHTML = '';
            content.appendChild(frag);
        }
    }

    function _renderQueueContent(content) {
        if (!_queueData) {
            content.innerHTML = '<div style="text-align:center;padding:20px;color:#8b92a5;font-size:12px">Loading...</div>';
            return;
        }
        const data = _queueData;
        const items = data.items || [];
        const logs = data.logs || [];
        const pending = items.filter(i => i.status === 'pending' || i.status === 'processing');
        const done = data.done || 0;
        const failed = data.failed || 0;
        const sentToday = data.sent_today || 0;
        const dailyLimit = data.daily_limit || 50;

        const frag = document.createDocumentFragment();

        // Stats bar
        const stats = document.createElement('div');
        stats.className = 'crm-queue-stats';
        stats.innerHTML = `
            <div class="crm-stat"><span class="crm-stat-num">${pending.length}</span><span class="crm-stat-label">Pending</span></div>
            <div class="crm-stat"><span class="crm-stat-num crm-stat-done">${done}</span><span class="crm-stat-label">Sent</span></div>
            <div class="crm-stat"><span class="crm-stat-num crm-stat-fail">${failed}</span><span class="crm-stat-label">Failed</span></div>
            <div class="crm-stat"><span class="crm-stat-num">${sentToday}/${dailyLimit}</span><span class="crm-stat-label">Today</span></div>
        `;
        frag.appendChild(stats);

        // Pending items with cancel
        if (pending.length > 0) {
            const lbl = document.createElement('div');
            lbl.className = 'crm-queue-section-label';
            lbl.textContent = 'Pending (' + pending.length + ')';
            frag.appendChild(lbl);

            pending.forEach(item => {
                const div = document.createElement('div');
                div.className = 'crm-float-item';
                div.innerHTML = '<div class="crm-float-item-info"><div class="crm-float-item-name">' + esc(item.name) + '</div><div class="crm-float-item-meta">' + esc(item.policy_no) + ' · <span class="crm-badge-pending">' + item.status + '</span></div></div><button class="crm-cancel-item" title="Cancel">✕</button>';
                div.querySelector('.crm-cancel-item').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        await App.api('DELETE', '/api/sms/queue/' + item.id);
                        App.toast('Cancelled: ' + item.name, 'success', 2000);
                        _refreshQueueData();
                    } catch (err) { App.toast('Cancel failed', 'error'); }
                });
                frag.appendChild(div);
            });
        }

        // Recent logs
        if (logs.length > 0) {
            const lbl2 = document.createElement('div');
            lbl2.className = 'crm-queue-section-label';
            lbl2.textContent = 'Recent (' + logs.length + ')';
            frag.appendChild(lbl2);

            logs.forEach(log => {
                const div = document.createElement('div');
                div.className = 'crm-float-item';
                const badge = log.status === 'sent' ? '<span class="crm-badge-sent">sent</span>' : '<span class="crm-badge-failed">failed</span>';
                const time = formatTime(log.sent_at || '');
                div.innerHTML = '<div class="crm-float-item-info"><div class="crm-float-item-name">' + esc(log.name) + '</div><div class="crm-float-item-meta">' + esc(log.policy_no) + ' · ' + badge + ' · <span style="color:#8b92a5">' + time + '</span></div></div>';
                frag.appendChild(div);
            });
        }

        if (pending.length === 0 && logs.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align:center;padding:20px;color:#8b92a5;font-size:12px';
            empty.textContent = 'No messages in queue';
            frag.appendChild(empty);
        }

        content.innerHTML = '';
        content.appendChild(frag);

        // Cancel all button in footer
        const footer = $('#crm-float-footer');
        if (footer && pending.length > 0) {
            footer.style.display = '';
            footer.innerHTML = '<button class="crm-send-btn crm-cancel-all-btn" id="crm-cancel-all">Cancel All (' + pending.length + ')</button>';
            document.getElementById('crm-cancel-all').addEventListener('click', async () => {
                try {
                    await App.api('DELETE', '/api/sms/queue');
                    App.toast('All pending cancelled', 'success', 2000);
                    _refreshQueueData();
                } catch (err) { App.toast('Cancel failed', 'error'); }
            });
        } else if (footer) {
            footer.innerHTML = '';
        }
    }

    /** Build date-grouped log entries into a DocumentFragment */
    function _buildLogSection(frag, logs) {
        // Group by date
        const groups = {};
        logs.forEach(log => {
            const dateKey = getDateLabel(log.sent_at || log.triggered_at || '');
            if (!groups[dateKey]) groups[dateKey] = [];
            groups[dateKey].push(log);
        });

        Object.entries(groups).forEach(([dateLabel, items]) => {
            const header = document.createElement('div');
            header.className = 'crm-history-date';
            header.textContent = dateLabel;
            frag.appendChild(header);

            items.forEach(log => {
                const div = document.createElement('div');
                div.className = 'crm-float-item';
                const time = formatTime(log.sent_at || log.triggered_at || '');
                const statusBadge = log.type === 'sms'
                    ? `<span class="${log.status === 'sent' ? 'crm-badge-sent' : 'crm-badge-failed'}">${log.status}</span>`
                    : '<span class="crm-badge-sent">called</span>';

                // Message preview for SMS (truncated)
                const msgPreview = log.type === 'sms' && log.message
                    ? `<div class="crm-history-preview">${esc(log.message.substring(0, 80))}${log.message.length > 80 ? '...' : ''}</div>`
                    : '';

                div.innerHTML = `
                    <div class="crm-float-item-info">
                        <div class="crm-float-item-name">${esc(log.name)}</div>
                        <div class="crm-float-item-meta">
                            ${esc(log.policy_no)} · ${esc(log.mobile || '')} · ${statusBadge} · <span style="color:#8b92a5">${time}</span>
                        </div>
                        ${msgPreview}
                    </div>
                `;
                frag.appendChild(div);
            });
        });
    }

    function getDateLabel(ts) {
        if (!ts) return 'Unknown';
        try {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
            const entryDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            if (entryDate.getTime() === today.getTime()) return 'Today';
            if (entryDate.getTime() === yesterday.getTime()) return 'Yesterday';
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch { return 'Unknown'; }
    }

    function formatTime(ts) {
        if (!ts) return '';
        try {
            // Append 'Z' so SQLite's UTC CURRENT_TIMESTAMP is parsed as UTC
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
            return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        } catch { return ts; }
    }

    // ── Mode toggle ──────────────────────────────────────────────────
    function toggleMode(newMode) {
        // Close queue if open
        if (queueOpen) {
            queueOpen = false;
            $('#crm-queue-btn')?.classList.remove('active-queue');
            const tabs = document.querySelector('.crm-float-tabs');
            if (tabs) tabs.style.display = '';
            if (queueRefreshTimer) { clearInterval(queueRefreshTimer); queueRefreshTimer = null; }
        }

        if (mode === newMode || newMode === null) {
            mode = null;
        } else {
            mode = newMode;
        }
        clearAll();
        updateModeUI();
    }

    /** Close float box and deselect active CRM mode entirely */
    function closeAndDeselect() {
        clearAll();
        // Deselect current mode
        mode = null;
        queueOpen = false;
        if (queueRefreshTimer) { clearInterval(queueRefreshTimer); queueRefreshTimer = null; }
        updateModeUI();
        $('#crm-float-box')?.classList.remove('visible');
    }

    function updateModeUI() {
        const smsBtn = $('#crm-sms-btn');
        const callBtn = $('#crm-call-btn');
        const queueBtn = $('#crm-queue-btn');

        // Remove all active states + close badges
        [smsBtn, callBtn, queueBtn].forEach(btn => {
            if (!btn) return;
            btn.classList.remove('active-sms', 'active-custom', 'active-call', 'active-queue');
            const oldX = btn.querySelector('.crm-close-x');
            if (oldX) oldX.remove();
        });

        // Add active state + ✕ badge
        const addCloseBadge = (btn) => {
            if (!btn) return;
            const x = document.createElement('span');
            x.className = 'crm-close-x';
            x.textContent = '✕';
            x.addEventListener('click', (e) => {
                e.stopPropagation();
                closeAndDeselect();
            });
            btn.appendChild(x);
        };

        if (mode === 'sms') { smsBtn?.classList.add('active-sms'); addCloseBadge(smsBtn); }
        if (mode === 'sms-custom') { smsBtn?.classList.add('active-sms', 'active-custom'); addCloseBadge(smsBtn); }
        if (mode === 'call') { callBtn?.classList.add('active-call'); addCloseBadge(callBtn); }
        if (queueOpen) { queueBtn?.classList.add('active-queue'); addCloseBadge(queueBtn); }

        // Toggle body class to suppress spreadsheet row highlight during SMS mode
        document.body.classList.toggle('crm-sms-active', mode === 'sms' || mode === 'sms-custom');
        document.body.classList.toggle('crm-call-active', mode === 'call');

        // Clear call row highlights when leaving call mode
        if (mode !== 'call') {
            document.querySelectorAll('.crm-call-highlight').forEach(r => r.classList.remove('crm-call-highlight'));
        }

        // Toggle wrapper class to hide flyout when mode is active
        const wrapper = $('#crm-sms-wrapper');
        if (wrapper) wrapper.classList.toggle('mode-active', mode === 'sms' || mode === 'sms-custom');

        if (mode !== 'sms' && mode !== 'sms-custom' && !queueOpen) {
            $('#crm-float-box')?.classList.remove('visible');
        }
    }

    // ── Row click handler ────────────────────────────────────────────
    function onRowClick(e) {
        if (!mode) return;
        if (App.state.activeTab !== 'list') return;

        const tr = e.target.closest('tbody tr[data-entry-id]');
        if (!tr) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

        // Skip if drag-select just handled this click
        if (_suppressNextClick) {
            _suppressNextClick = false;
            return;
        }

        // Always read from DOM (reflects edits + newly added rows)
        let entry = readEntryFromRow(tr);

        // Fallback to DataStore if DOM read failed
        if (!entry) {
            const entryId = parseInt(tr.dataset.entryId);
            const entries = typeof App.getEntries === 'function' ? App.getEntries() : [];
            entry = entries.find(en => (en._monthlyId || en.id) === entryId);
        }
        if (!entry) return;

        if (mode === 'sms' || mode === 'sms-custom') {
            handleSmsRowClick(tr, entry);
        } else if (mode === 'call') {
            handleCallRowClick(tr, entry);
        }
    }

    /** Read entry fields from DOM cells as fallback */
    function readEntryFromRow(tr) {
        const cells = tr.querySelectorAll('td');
        const getText = (cls) => {
            const td = tr.querySelector(`.col-${cls}`);
            const span = td?.querySelector('.cell-content');
            return span?.textContent?.trim() || '';
        };
        const pno = getText('policyno');
        if (!pno) return null;
        return {
            id: parseInt(tr.dataset.entryId) || 0,
            policyno: pno,
            name: getText('name'),
            mobileno: getText('mobileno'),
            premium: getText('premium'),
            fup: getText('fup'),
            doc: getText('doc'),
            status: getText('status'),
            due_months: getText('due_months'),
            mode: getText('mode'),
        };
    }

    // ── SMS mode: row selection ──────────────────────────────────────
    function handleSmsRowClick(tr, entry) {
        if (isSending) return;

        // Force to select tab when selecting rows
        if (activeTab !== 'select') switchTab('select');

        const pno = entry.policyno || '';
        const idx = selectedContacts.findIndex(c => c.policy_no === pno);

        if (idx >= 0) {
            selectedContacts.splice(idx, 1);
            tr.classList.remove('crm-selected');
        } else {
            const mobile = entry.mobileno || '';
            if (!mobile) {
                App.toast('No mobile number for this policy', 'error', 2000);
                return;
            }
            const statusRaw = (entry.status || '').trim().toLowerCase();
            const statusLabel = (statusRaw === 'autodebit' || statusRaw === 'auto debit')
                ? 'Auto Debit' : 'Due';

            selectedContacts.push({
                policy_no: pno,
                name: entry.name || '',
                mobile: mobile,
                premium: entry.premium || '',
                fup: entry.fup || '',
                doc: entry.doc || '',
                status: statusLabel,
                rowEl: tr,
                // Extra fields for custom mode
                due_months: entry.due_months || '',
                mode: entry.mode || entry.mobileno_mode || '',
            });
            tr.classList.add('crm-selected');
        }

        _scheduleRender();
    }

    // ── Floating box render ──────────────────────────────────────────
    // Track which policy_nos are currently rendered in the float list
    let _renderedPolicies = new Map(); // policy_no -> DOM element

    function renderFloatBox() {
        const box = $('#crm-float-box');
        if (!box) return;

        if (selectedContacts.length === 0 && !isSending) {
            box.classList.remove('visible');
            _renderedPolicies.clear();
            const list = $('#crm-float-list');
            if (list) list.innerHTML = '';
            return;
        }
        box.classList.add('visible');

        const header = $('#crm-float-count');
        if (header) header.textContent = `Selected (${selectedContacts.length})`;

        const list = $('#crm-float-list');
        if (!list) return;

        // Build set of current policy_nos for fast lookup
        const currentSet = new Set(selectedContacts.map(c => c.policy_no));

        // Remove DOM nodes for deselected contacts
        for (const [pno, el] of _renderedPolicies) {
            if (!currentSet.has(pno)) {
                el.remove();
                _renderedPolicies.delete(pno);
            }
        }

        // Add DOM nodes for newly selected contacts (only those not already rendered)
        selectedContacts.forEach((c) => {
            if (_renderedPolicies.has(c.policy_no)) return; // already in DOM

            const item = document.createElement('div');
            item.className = 'crm-float-item';
            const badgeClass = c.status === 'Auto Debit' ? 'crm-badge-autodebit' : 'crm-badge-due';
            item.innerHTML = `
                <div class="crm-float-item-info">
                    <div class="crm-float-item-name">${esc(c.name)}</div>
                    <div class="crm-float-item-meta">
                        ${esc(c.policy_no)} · <span class="${badgeClass}">${esc(c.status)}</span>
                    </div>
                </div>
                <button class="crm-remove" title="Remove">×</button>
            `;
            const pno = c.policy_no;
            item.querySelector('.crm-remove').addEventListener('click', () => {
                const idx = selectedContacts.findIndex(sc => sc.policy_no === pno);
                if (idx >= 0) removeContact(idx);
            });
            list.appendChild(item);
            _renderedPolicies.set(c.policy_no, item);
        });

        // Auto-scroll to show latest selection
        list.scrollTop = list.scrollHeight;

        // Ensure footer send button exists and has listener
        const footer = $('#crm-float-footer');
        if (footer && !isSending) {
            let sendBtn = $('#crm-send-btn');
            if (!sendBtn) {
                footer.innerHTML = '<button id="crm-send-btn" class="crm-send-btn">Send SMS</button>';
                sendBtn = $('#crm-send-btn');
            }
            // Always (re-)attach listener — innerHTML replacement strips old listeners
            sendBtn.onclick = mode === 'sms-custom' ? showCustomConfirmation : showConfirmation;
        }
    }

    function removeContact(idx) {
        const c = selectedContacts[idx];
        selectedContacts.splice(idx, 1);
        // Remove CSS from visible row if present
        if (c) {
            const visibleRows = _getVisibleRows();
            for (const row of visibleRows) {
                if (_getPolicyFromRow(row) === c.policy_no) {
                    row.classList.remove('crm-selected');
                    break;
                }
            }
        }
        renderFloatBox();
    }

    function clearAll() {
        // Remove crm-selected from ALL rows in the tbody (not just visible)
        const tbody = document.getElementById('spreadsheet-body');
        if (tbody) {
            tbody.querySelectorAll('tr.crm-selected').forEach(r => r.classList.remove('crm-selected'));
        }
        selectedContacts = [];
        _renderedPolicies.clear();
        isSending = false;
        batchId = null;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        renderFloatBox();
    }

    // ── Styled Confirmation (replaces browser confirm()) ─────────────
    function showConfirmation() {
        if (selectedContacts.length === 0) return;

        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const header = $('#crm-float-count');

        const count = selectedContacts.length;
        if (header) header.textContent = 'Confirm Send';

        if (list) {
            list.innerHTML = `
                <div class="crm-confirm-view">
                    <div class="crm-confirm-icon">
                        <svg width="40" height="40" viewBox="0 0 640 640" fill="#5b6abf"><path d="M267.7 576.9C267.7 576.9 267.7 576.9 267.7 576.9L229.9 603.6C222.6 608.8 213 609.4 205 605.3C197 601.2 192 593 192 584L192 512L160 512C107 512 64 469 64 416L64 192C64 139 107 96 160 96L480 96C533 96 576 139 576 192L576 416C576 469 533 512 480 512L359.6 512L267.7 576.9zM332 472.8C340.1 467.1 349.8 464 359.7 464L480 464C506.5 464 528 442.5 528 416L528 192C528 165.5 506.5 144 480 144L160 144C133.5 144 112 165.5 112 192L112 416C112 442.5 133.5 464 160 464L216 464C226.4 464 235.3 470.6 238.6 479.9C239.5 482.4 240 485.1 240 488L240 537.7C272.7 514.6 303.3 493 331.9 472.8z"/></svg>
                    </div>
                    <div class="crm-confirm-text">
                        Send SMS to <strong>${count}</strong> contact${count > 1 ? 's' : ''}?
                    </div>
                    <div class="crm-confirm-sub">
                        Messages will be queued and sent via gateway
                    </div>
                </div>
            `;
        }

        if (footer) {
            footer.innerHTML = `
                <div class="crm-confirm-actions">
                    <button id="crm-confirm-no" class="crm-confirm-cancel">Cancel</button>
                    <button id="crm-confirm-yes" class="crm-confirm-send">Send ${count} SMS</button>
                </div>
            `;
            $('#crm-confirm-no')?.addEventListener('click', () => {
                renderFloatBox(); // Go back to selection view
            });
            $('#crm-confirm-yes')?.addEventListener('click', doSendSMS);
        }
    }

    // ── Custom SMS Confirmation + Template Chooser ────────────────────
    function showCustomConfirmation() {
        if (selectedContacts.length === 0) return;

        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const header = $('#crm-float-count');

        const count = selectedContacts.length;
        if (header) header.textContent = 'Confirm Send';

        if (list) {
            list.innerHTML = `
                <div class="crm-confirm-view">
                    <div class="crm-confirm-icon">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#5b6abf" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </div>
                    <div class="crm-confirm-text">
                        Send Custom SMS to <strong>${count}</strong> contact${count > 1 ? 's' : ''}?
                    </div>
                    <div class="crm-confirm-sub">
                        Choose a template on next step
                    </div>
                </div>
            `;
        }

        if (footer) {
            footer.innerHTML = `
                <div class="crm-confirm-actions">
                    <button id="crm-custom-cancel" class="crm-confirm-cancel">Cancel</button>
                    <button id="crm-custom-yes" class="crm-confirm-send">Choose Template</button>
                </div>
            `;
            $('#crm-custom-cancel')?.addEventListener('click', () => renderFloatBox());
            $('#crm-custom-yes')?.addEventListener('click', showTemplateChooser);
        }
    }

    function showTemplateChooser() {
        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const header = $('#crm-float-count');

        if (header) header.textContent = 'Choose Template';

        if (list) {
            list.innerHTML = `
                <div class="crm-template-chooser">
                    <div class="crm-template-card" data-template="overdue">
                        <div class="crm-template-icon">📋</div>
                        <div class="crm-template-info">
                            <div class="crm-template-title">Overdue</div>
                            <div class="crm-template-desc">Auto-generated from Due Months column. Calculates month names from mode.</div>
                        </div>
                    </div>
                    <div class="crm-template-card" data-template="custom">
                        <div class="crm-template-icon">✏️</div>
                        <div class="crm-template-info">
                            <div class="crm-template-title">Blank (Custom)</div>
                            <div class="crm-template-desc">Write your own message with tags like {Name}, {POL-NUM}.</div>
                        </div>
                    </div>
                </div>
            `;

            list.querySelector('[data-template="overdue"]')?.addEventListener('click', showOverduePreview);
            list.querySelector('[data-template="custom"]')?.addEventListener('click', showBlankEditor);
        }

        if (footer) {
            footer.innerHTML = `
                <div class="crm-confirm-actions">
                    <button id="crm-tpl-back" class="crm-confirm-cancel">Back</button>
                </div>
            `;
            $('#crm-tpl-back')?.addEventListener('click', showCustomConfirmation);
        }
    }

    // ── Overdue Preview ──────────────────────────────────────────────
    async function showOverduePreview() {
        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const header = $('#crm-float-count');

        if (header) header.textContent = 'Overdue Preview';

        // Show loading
        if (list) {
            list.innerHTML = '<div style="text-align:center;padding:30px;color:#8b92a5;font-size:12px">Generating preview...</div>';
        }
        if (footer) footer.innerHTML = '';

        // Fetch previews from backend
        try {
            const payload = {
                contacts: selectedContacts.map(c => ({
                    policy_no: c.policy_no,
                    name: c.name,
                    mobile: c.mobile,
                    premium: c.premium,
                    fup: c.fup,
                    mode: c.mode,
                    due_months: c.due_months,
                }))
            };
            const data = await App.api('POST', '/api/sms/preview-overdue', payload);
            const previews = data.previews || [];

            if (!list) return;

            const frag = document.createDocumentFragment();

            // Count valid / error
            const valid = previews.filter(p => p.message);
            const errors = previews.filter(p => p.error);

            // Stats
            const stats = document.createElement('div');
            stats.className = 'crm-queue-stats';
            stats.style.marginBottom = '8px';
            stats.innerHTML = `
                <div class="crm-stat"><span class="crm-stat-num crm-stat-done">${valid.length}</span><span class="crm-stat-label">Ready</span></div>
                <div class="crm-stat"><span class="crm-stat-num crm-stat-fail">${errors.length}</span><span class="crm-stat-label">Skipped</span></div>
                <div class="crm-stat"><span class="crm-stat-num">${selectedContacts.length}</span><span class="crm-stat-label">Total</span></div>
            `;
            frag.appendChild(stats);

            // Preview cards
            previews.forEach(p => {
                const card = document.createElement('div');
                card.className = 'crm-preview-card';

                if (p.error) {
                    card.innerHTML = `
                        <div class="crm-preview-card-header">
                            <span class="crm-preview-card-name">${esc(p.name || p.policy_no)}</span>
                            <span class="crm-badge-failed">skip</span>
                        </div>
                        <div class="crm-preview-error">${esc(p.error)}</div>
                    `;
                } else {
                    card.innerHTML = `
                        <div class="crm-preview-card-header">
                            <span class="crm-preview-card-name">${esc(p.name || p.policy_no)}</span>
                            <span class="crm-preview-card-chars ${p.chars > 160 ? 'over-limit' : ''}">${p.chars} chars</span>
                        </div>
                        <div class="crm-preview-bubble">${esc(p.message)}</div>
                    `;
                }
                frag.appendChild(card);
            });

            list.innerHTML = '';
            list.appendChild(frag);

            // Footer with Back + Send
            if (footer) {
                footer.innerHTML = `
                    <div class="crm-confirm-actions">
                        <button id="crm-od-back" class="crm-confirm-cancel">Back</button>
                        <button id="crm-od-send" class="crm-confirm-send" ${valid.length === 0 ? 'disabled' : ''}>
                            Send ${valid.length} SMS
                        </button>
                    </div>
                `;
                $('#crm-od-back')?.addEventListener('click', showTemplateChooser);
                $('#crm-od-send')?.addEventListener('click', () => doSendCustomSMS('overdue'));
            }
        } catch (err) {
            if (list) list.innerHTML = `<div style="text-align:center;padding:20px;color:#ef4444;font-size:12px">Preview failed: ${esc(err.message || err)}</div>`;
        }
    }

    function showBlankEditor() {
        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const header = $('#crm-float-count');

        if (header) header.textContent = 'Write SMS';

        // Get the last selected contact for live preview
        const previewContact = selectedContacts.length > 0
            ? selectedContacts[selectedContacts.length - 1]
            : null;

        if (list) {
            list.innerHTML = `
                <div class="crm-blank-editor">
                    <textarea id="crm-custom-msg" class="crm-custom-textarea" rows="5"
                        placeholder="Type your message here..."></textarea>
                    <div class="crm-char-counter"><span id="crm-char-count">0</span> / 160 chars</div>
                    <div class="crm-tag-hints">
                        <span class="crm-tag-label">Tags:</span>
                        <button class="crm-tag-btn" data-tag="{Name}">{Name}</button>
                        <button class="crm-tag-btn" data-tag="{POL-NUM}">{POL-NUM}</button>
                        <button class="crm-tag-btn" data-tag="{Premium}">{Premium}</button>
                        <button class="crm-tag-btn" data-tag="{FUP}">{FUP}</button>
                        <button class="crm-tag-btn" data-tag="{Mode}">{Mode}</button>
                    </div>
                    <div class="crm-live-preview" id="crm-live-preview">
                        <div class="crm-preview-label">📱 Preview${previewContact ? ' — ' + esc(previewContact.name || previewContact.policy_no) : ''}</div>
                        <div class="crm-preview-bubble" id="crm-preview-bubble">
                            <span class="crm-preview-placeholder">Start typing to see preview...</span>
                        </div>
                    </div>
                </div>
            `;

            const textarea = $('#crm-custom-msg');
            const counter = $('#crm-char-count');
            const bubble = $('#crm-preview-bubble');

            /** Replace tags with real contact data for preview */
            function renderPreview(text) {
                if (!text.trim()) {
                    bubble.innerHTML = '<span class="crm-preview-placeholder">Start typing to see preview...</span>';
                    return;
                }
                if (!previewContact) {
                    bubble.textContent = text;
                    return;
                }
                let preview = text
                    .replace(/\{Name\}/gi, previewContact.name || '—')
                    .replace(/\{POL-NUM\}/gi, previewContact.policy_no || '—')
                    .replace(/\{Premium\}/gi, previewContact.premium || '—')
                    .replace(/\{FUP\}/gi, previewContact.fup || '—')
                    .replace(/\{Mode\}/gi, previewContact.mode || '—');
                bubble.textContent = preview;
            }

            // ── Tag Autocomplete ─────────────────────────────────────
            const TAG_DEFS = [
                { tag: '{Name}',    desc: 'Holder name' },
                { tag: '{POL-NUM}', desc: 'Policy number' },
                { tag: '{Premium}', desc: 'Premium amt' },
                { tag: '{FUP}',     desc: 'FUP date' },
                { tag: '{Mode}',    desc: 'Payment mode' },
            ];
            // Normalized lookup for fuzzy match on close-brace
            const TAG_NORM = {};
            TAG_DEFS.forEach(t => { TAG_NORM[t.tag.replace(/[{}]/g, '').toLowerCase().replace(/[\s\-_]/g, '')] = t.tag; });

            let acDropdown = null;
            let acActiveIdx = -1;
            let acBracePos = -1;  // cursor position of the opening `{`

            function createDropdown() {
                if (acDropdown) return;
                acDropdown = document.createElement('div');
                acDropdown.className = 'crm-autocomplete';
                // Position relative to the editor container
                const editor = list.querySelector('.crm-blank-editor');
                if (editor) {
                    editor.style.position = 'relative';
                    editor.appendChild(acDropdown);
                }
            }

            function showAC(filter) {
                createDropdown();
                const q = filter.toLowerCase().replace(/[\s\-_]/g, '');
                const matches = TAG_DEFS.filter(t => {
                    const norm = t.tag.replace(/[{}]/g, '').toLowerCase().replace(/[\s\-_]/g, '');
                    return norm.includes(q) || q.includes(norm.substring(0, Math.max(1, q.length)));
                });
                if (matches.length === 0) { hideAC(); return; }

                acDropdown.innerHTML = matches.map((m, i) =>
                    `<div class="crm-ac-item${i === 0 ? ' active' : ''}" data-idx="${i}" data-tag="${m.tag}">
                        <span class="crm-ac-tag">${m.tag}</span>
                        <span class="crm-ac-desc">${m.desc}</span>
                    </div>`
                ).join('');
                acActiveIdx = 0;

                // Position below textarea
                const taRect = textarea.getBoundingClientRect();
                const editorRect = textarea.closest('.crm-blank-editor').getBoundingClientRect();
                acDropdown.style.top = (taRect.bottom - editorRect.top + 4) + 'px';
                acDropdown.style.left = '0px';
                acDropdown.classList.add('visible');

                // Click handlers on items
                acDropdown.querySelectorAll('.crm-ac-item').forEach(item => {
                    item.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        insertACTag(item.dataset.tag);
                    });
                });
            }

            function hideAC() {
                if (acDropdown) acDropdown.classList.remove('visible');
                acActiveIdx = -1;
                acBracePos = -1;
            }

            function insertACTag(tag) {
                if (acBracePos < 0) { hideAC(); return; }
                const cursor = textarea.selectionStart;
                const before = textarea.value.slice(0, acBracePos);
                const after = textarea.value.slice(cursor);
                textarea.value = before + tag + after;
                textarea.selectionStart = textarea.selectionEnd = acBracePos + tag.length;
                hideAC();
                textarea.focus();
                textarea.dispatchEvent(new Event('input'));
            }

            /** Fuzzy-match: normalize what the user typed and find the closest tag */
            function fuzzyMatchTag(raw) {
                const norm = raw.toLowerCase().replace(/[\s\-_]/g, '');
                // Exact normalized match
                if (TAG_NORM[norm]) return TAG_NORM[norm];
                // Partial match: find best
                let best = null, bestScore = 0;
                for (const [key, tag] of Object.entries(TAG_NORM)) {
                    // Check if key starts with what user typed or vice versa
                    if (key.startsWith(norm) || norm.startsWith(key)) {
                        const score = Math.min(key.length, norm.length) / Math.max(key.length, norm.length);
                        if (score > bestScore && score > 0.4) { best = tag; bestScore = score; }
                    }
                }
                return best;
            }

            textarea?.addEventListener('input', () => {
                const len = textarea.value.length;
                counter.textContent = len;
                counter.closest('.crm-char-counter')?.classList.toggle('over-limit', len > 160);
                renderPreview(textarea.value);

                // Autocomplete: detect `{...` being typed
                const cursor = textarea.selectionStart;
                const text = textarea.value;
                // Find the last unclosed `{` before cursor
                const beforeCursor = text.slice(0, cursor);
                const lastOpen = beforeCursor.lastIndexOf('{');
                const lastClose = beforeCursor.lastIndexOf('}');

                if (lastOpen > lastClose) {
                    // We're inside an unclosed `{`
                    acBracePos = lastOpen;
                    const partial = beforeCursor.slice(lastOpen + 1);
                    showAC(partial);
                } else {
                    hideAC();
                }

                // Auto-correct on closing brace: check if user just typed `}`
                if (cursor > 0 && text[cursor - 1] === '}') {
                    // Find matching `{`
                    const segment = text.slice(0, cursor);
                    const openIdx = segment.lastIndexOf('{', cursor - 2);
                    if (openIdx >= 0) {
                        const raw = text.slice(openIdx + 1, cursor - 1); // content between { and }
                        const matched = fuzzyMatchTag(raw);
                        if (matched && matched !== '{' + raw + '}') {
                            // Replace the wrong tag with the correct one
                            textarea.value = text.slice(0, openIdx) + matched + text.slice(cursor);
                            textarea.selectionStart = textarea.selectionEnd = openIdx + matched.length;
                            textarea.dispatchEvent(new Event('input'));
                        }
                        hideAC();
                    }
                }
            });

            textarea?.addEventListener('keydown', (e) => {
                if (!acDropdown || !acDropdown.classList.contains('visible')) return;
                const items = acDropdown.querySelectorAll('.crm-ac-item');
                if (items.length === 0) return;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    acActiveIdx = (acActiveIdx + 1) % items.length;
                    items.forEach((it, i) => it.classList.toggle('active', i === acActiveIdx));
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    acActiveIdx = (acActiveIdx - 1 + items.length) % items.length;
                    items.forEach((it, i) => it.classList.toggle('active', i === acActiveIdx));
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    const active = items[acActiveIdx];
                    if (active) insertACTag(active.dataset.tag);
                } else if (e.key === 'Escape') {
                    hideAC();
                }
            });

            textarea?.addEventListener('blur', () => setTimeout(hideAC, 150));

            // Tag buttons: insert tag at cursor
            list.querySelectorAll('.crm-tag-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const tag = btn.dataset.tag;
                    if (!textarea) return;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(end);
                    textarea.selectionStart = textarea.selectionEnd = start + tag.length;
                    textarea.focus();
                    textarea.dispatchEvent(new Event('input'));
                });
            });

            textarea?.focus();
        }

        if (footer) {
            footer.innerHTML = `
                <div class="crm-confirm-actions">
                    <button id="crm-blank-back" class="crm-confirm-cancel">Back</button>
                    <button id="crm-blank-send" class="crm-confirm-send">Send SMS</button>
                </div>
            `;
            $('#crm-blank-back')?.addEventListener('click', showTemplateChooser);
            $('#crm-blank-send')?.addEventListener('click', () => {
                const msg = ($('#crm-custom-msg')?.value || '').trim();
                if (!msg) {
                    App.toast('Please write a message', 'error', 2000);
                    return;
                }
                doSendCustomSMS('custom', msg);
            });
        }
    }

    // ── Send Custom SMS ──────────────────────────────────────────────
    async function doSendCustomSMS(templateType, customMessage) {
        if (selectedContacts.length === 0 || isSending) return;

        // For overdue, validate that at least some contacts have due_months
        if (templateType === 'overdue') {
            const withDue = selectedContacts.filter(c => c.due_months && c.due_months.trim());
            if (withDue.length === 0) {
                App.toast('No contacts have Due Months filled', 'error', 3000);
                return;
            }
        }

        isSending = true;

        try {
            const payload = {
                template_type: templateType,
                custom_message: customMessage || '',
                contacts: selectedContacts.map(c => ({
                    policy_no: c.policy_no,
                    name: c.name,
                    mobile: c.mobile,
                    premium: c.premium,
                    fup: c.fup,
                    doc: c.doc,
                    status: c.status,
                    due_months: c.due_months || '',
                    mode: c.mode || '',
                }))
            };

            const res = await App.api('POST', '/api/sms/send-custom', payload);

            let msg = `${res.queued} SMS queued`;
            if (res.skipped && res.skipped.length > 0) {
                msg += ` (${res.skipped.length} skipped — missing due months data)`;
            }
            App.toast(msg, 'success', 4000);

            showProgressView();
            pollTimer = setInterval(pollProgress, 5000);
        } catch (err) {
            App.toast(`Send failed: ${err.message}`, 'error');
            isSending = false;
            renderFloatBox();
        }
    }

    // ── Send SMS ─────────────────────────────────────────────────────
    async function doSendSMS() {
        if (selectedContacts.length === 0 || isSending) return;

        isSending = true;

        try {
            const payload = {
                contacts: selectedContacts.map(c => ({
                    policy_no: c.policy_no,
                    name: c.name,
                    mobile: c.mobile,
                    premium: c.premium,
                    fup: c.fup,
                    doc: c.doc,
                    status: c.status,
                }))
            };

            const res = await App.api('POST', '/api/sms/send', payload);
            batchId = res.batch_id;
            App.toast(`${res.queued} SMS queued`, 'success', 3000);

            showProgressView();
            pollTimer = setInterval(pollProgress, 5000);
        } catch (err) {
            App.toast(`Send failed: ${err.message}`, 'error');
            isSending = false;
            renderFloatBox();
        }
    }

    // ── Progress view ────────────────────────────────────────────────
    function showProgressView() {
        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const header = $('#crm-float-count');
        if (header) header.textContent = 'Sending...';

        if (list) {
            list.innerHTML = '';
            selectedContacts.forEach(c => {
                const div = document.createElement('div');
                div.className = 'crm-progress-item pending';
                div.dataset.policyNo = c.policy_no;
                div.innerHTML = `<span class="crm-progress-icon">·</span> ${esc(c.name)} — ${esc(c.policy_no)}`;
                list.appendChild(div);
            });
        }

        if (footer) {
            footer.innerHTML = '<div class="crm-countdown">Waiting for gateway...</div>';
        }
    }

    async function pollProgress() {
        try {
            const data = await App.api('GET', '/api/sms/queue/status');
            updateProgressView(data);

            if (data.total === 0 || (data.pending === 0 && data.processing === 0)) {
                clearInterval(pollTimer);
                pollTimer = null;
                showDoneView(data);
            }
        } catch (err) {
            console.error('Progress poll error:', err);
        }
    }

    function updateProgressView(data) {
        const header = $('#crm-float-count');
        const done = data.done || 0;
        const total = data.total || 0;
        if (header) header.textContent = `Sending... (${done} of ${total})`;

        (data.items || []).forEach(item => {
            const el = $(`.crm-progress-item[data-policy-no="${item.policy_no}"]`);
            if (!el) return;
            el.className = 'crm-progress-item ' + item.status;
            const icon = item.status === 'done' ? '✓' :
                         item.status === 'processing' ? '⟳' :
                         item.status === 'failed' ? '✗' : '·';
            el.querySelector('.crm-progress-icon').textContent = icon;
        });

        const footer = $('#crm-float-footer');
        if (footer) {
            const remaining = data.daily_remaining ?? '';
            const sentToday = data.sent_today ?? 0;
            let msg = `Next send in ~60s · Today: ${sentToday}/50`;
            if (remaining <= 0 && data.pending > 0) {
                msg = `⚠ Daily limit reached (50/day). ${data.pending} queued for tomorrow.`;
            }
            footer.innerHTML = `<div class="crm-countdown">${msg}</div>`;
        }
    }

    function showDoneView(data) {
        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const header = $('#crm-float-count');

        if (header) header.textContent = 'Done';

        if (list) {
            const sent = data.done || selectedContacts.length;
            const failed = data.failed || 0;
            list.innerHTML = `
                <div class="crm-done-summary">
                    <div class="done-icon">✓</div>
                    <div class="done-stats">${sent} sent · ${failed} failed</div>
                </div>
            `;
        }

        if (footer) {
            footer.innerHTML = '<button class="crm-send-btn" id="crm-close-done">Close</button>';
            $('#crm-close-done')?.addEventListener('click', clearAll);
        }
    }

    // ── Call mode ────────────────────────────────────────────────────
    let pendingCall = null;

    function handleCallRowClick(tr, entry) {
        // Block calls when gateway is offline
        if (!gatewayOnline) {
            App.toast('Gateway is offline — calls unavailable', 'error', 3000);
            return;
        }

        const mobile = entry.mobileno || '';
        if (!mobile) {
            App.toast('No mobile number for this policy', 'error', 2000);
            return;
        }

        pendingCall = {
            policy_no: entry.policyno || '',
            name: entry.name || '',
            mobile: mobile,
        };

        // Highlight the clicked row
        document.querySelectorAll('.crm-call-highlight').forEach(r => r.classList.remove('crm-call-highlight'));
        if (tr) tr.classList.add('crm-call-highlight');

        const modal = $('#crm-call-modal');
        $('#crm-call-name').textContent = pendingCall.name;
        $('#crm-call-pno').textContent = pendingCall.policy_no;
        $('#crm-call-mobile').textContent = pendingCall.mobile;
        modal?.classList.add('visible');
    }

    function closeCallModal() {
        $('#crm-call-modal')?.classList.remove('visible');
        // Remove row highlight
        document.querySelectorAll('.crm-call-highlight').forEach(r => r.classList.remove('crm-call-highlight'));
        pendingCall = null;
    }

    async function confirmCall() {
        if (!pendingCall) return;
        const callData = { ...pendingCall };
        const callName = pendingCall.name;
        closeCallModal();

        try {
            await App.api('POST', '/api/calls/trigger', callData);
            App.toast(`Calling ${callName}...`, 'success', 3000);
        } catch (err) {
            App.toast(`Call failed: ${err.message}`, 'error');
        }
    }

    // ── Gateway status ───────────────────────────────────────────────
    async function pollGateway() {
        try {
            const data = await App.api('GET', '/api/gateway/status');
            gatewayOnline = !!data.online;
            const dot = $('#crm-gateway-dot');
            if (!dot) return;

            if (gatewayOnline) {
                dot.classList.add('online');
                const lbl = dot.querySelector('.gateway-label');
                if (lbl) lbl.textContent = '# Gateway online';
            } else {
                dot.classList.remove('online');
                const lbl = dot.querySelector('.gateway-label');
                if (lbl) lbl.textContent = '# Gateway offline';
            }
        } catch {
            gatewayOnline = false;
        }
    }

    // ── Draggable ────────────────────────────────────────────────────
    function makeDraggable(box, handle) {
        if (!box || !handle) return;
        let isDragging = false, startX, startY, startRight, startBottom;

        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = box.getBoundingClientRect();
            startRight = window.innerWidth - rect.right;
            startBottom = window.innerHeight - rect.bottom;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            box.style.right = Math.max(0, startRight - dx) + 'px';
            box.style.bottom = Math.max(0, startBottom - dy) + 'px';
        });

        document.addEventListener('mouseup', () => { isDragging = false; });
    }

    // ── Queue Mode ───────────────────────────────────────────────────
    let queueOpen = false;
    let queueRefreshTimer = null;

    function toggleQueue() {
        queueOpen = !queueOpen;
        const box = $('#crm-float-box');
        const btn = $('#crm-queue-btn');

        if (queueOpen) {
            mode = null;
            updateModeUI();
            btn?.classList.add('active-queue');
            // Add close badge to queue btn
            const oldX = btn?.querySelector('.crm-close-x');
            if (!oldX && btn) {
                const x = document.createElement('span');
                x.className = 'crm-close-x';
                x.textContent = '✕';
                x.addEventListener('click', (e) => { e.stopPropagation(); closeAndDeselect(); });
                btn.appendChild(x);
            }
            box?.classList.add('visible');
            // Switch to history tab with queue filter
            _historyFilter = 'queue';
            switchTab('history');
            queueRefreshTimer = setInterval(_refreshQueueData, 5000);
        } else {
            btn?.classList.remove('active-queue');
            const oldX2 = btn?.querySelector('.crm-close-x');
            if (oldX2) oldX2.remove();
            box?.classList.remove('visible');
            if (queueRefreshTimer) { clearInterval(queueRefreshTimer); queueRefreshTimer = null; }
        }
    }

    // ── Escape HTML ──────────────────────────────────────────────────
    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    // ── Public ───────────────────────────────────────────────────────
    return { init };
})();

document.addEventListener('DOMContentLoaded', () => CRM.init());
