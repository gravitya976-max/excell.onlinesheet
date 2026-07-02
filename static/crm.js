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
    let activeTab = 'select'; // 'select' | 'history'

    // ── DOM refs ──────────────────────────────────────────────────────
    const $  = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    // ── Init ──────────────────────────────────────────────────────────
    function init() {
        // Mode buttons
        $('#crm-sms-btn')?.addEventListener('click', () => toggleMode('sms'));
        $('#crm-call-btn')?.addEventListener('click', () => toggleMode('call'));
        $('#crm-queue-btn')?.addEventListener('click', () => toggleQueue());

        // Floating box controls
        $('#crm-clear-all')?.addEventListener('click', clearAll);

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

        // Gateway status polling (15s for snappier online/offline updates)
        pollGateway();
        gatewayTimer = setInterval(pollGateway, 15000);
    }

    // ── Tabs ──────────────────────────────────────────────────────────
    function switchTab(tab) {
        activeTab = tab;
        $('#crm-tab-select')?.classList.toggle('active', tab === 'select');
        $('#crm-tab-history')?.classList.toggle('active', tab === 'history');

        if (tab === 'history') {
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
    async function loadHistory() {
        const list = $('#crm-float-list');
        if (!list) return;
        list.innerHTML = '<div style="text-align:center;padding:20px;color:#8b92a5;font-size:12px">Loading...</div>';

        try {
            const [smsData, callData] = await Promise.all([
                App.api('GET', '/api/sms/logs'),
                App.api('GET', '/api/calls/logs'),
            ]);

            const smsLogs = (smsData.logs || []).map(l => ({ ...l, type: 'sms' }));
            const callLogs = (callData.logs || []).map(l => ({ ...l, type: 'call', sent_at: l.triggered_at }));

            // Merge and sort by time desc
            const all = [...smsLogs, ...callLogs].sort((a, b) => {
                const ta = a.sent_at || a.triggered_at || '';
                const tb = b.sent_at || b.triggered_at || '';
                return tb.localeCompare(ta);
            });

            list.innerHTML = '';

            if (all.length === 0) {
                list.innerHTML = '<div style="text-align:center;padding:30px;color:#8b92a5;font-size:12px">No history yet</div>';
                return;
            }

            // Group by date
            const groups = {};
            all.forEach(log => {
                const dateKey = getDateLabel(log.sent_at || log.triggered_at || '');
                if (!groups[dateKey]) groups[dateKey] = [];
                groups[dateKey].push(log);
            });

            Object.entries(groups).forEach(([dateLabel, logs]) => {
                // Date group header
                const header = document.createElement('div');
                header.className = 'crm-history-date';
                header.textContent = dateLabel;
                list.appendChild(header);

                logs.forEach(log => {
                    const div = document.createElement('div');
                    div.className = 'crm-float-item';
                    const time = formatTime(log.sent_at || log.triggered_at || '');
                    const icon = log.type === 'sms' ? '💬' : '📞';
                    const statusBadge = log.type === 'sms'
                        ? `<span class="${log.status === 'sent' ? 'crm-badge-sent' : 'crm-badge-failed'}">${log.status}</span>`
                        : '<span class="crm-badge-sent">called</span>';

                    // Message preview for SMS (truncated)
                    const msgPreview = log.type === 'sms' && log.message
                        ? `<div class="crm-history-preview">${esc(log.message.substring(0, 80))}${log.message.length > 80 ? '...' : ''}</div>`
                        : '';

                    div.innerHTML = `
                        <div class="crm-float-item-info">
                            <div class="crm-float-item-name">${icon} ${esc(log.name)}</div>
                            <div class="crm-float-item-meta">
                                ${esc(log.policy_no)} · ${esc(log.mobile || '')} · ${statusBadge} · <span style="color:#8b92a5">${time}</span>
                            </div>
                            ${msgPreview}
                        </div>
                    `;
                    list.appendChild(div);
                });
            });
        } catch (err) {
            list.innerHTML = `<div style="text-align:center;padding:20px;color:#d04040;font-size:12px">Failed to load</div>`;
        }
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
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'));
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

        if (mode === newMode) {
            mode = null;
        } else {
            mode = newMode;
        }
        clearAll();
        updateModeUI();
    }

    function updateModeUI() {
        const smsBtn = $('#crm-sms-btn');
        const callBtn = $('#crm-call-btn');
        smsBtn?.classList.remove('active-sms');
        callBtn?.classList.remove('active-call');

        if (mode === 'sms') smsBtn?.classList.add('active-sms');
        if (mode === 'call') callBtn?.classList.add('active-call');
        const queueBtn = $('#crm-queue-btn');
        queueBtn?.classList.remove('active-queue');

        if (mode !== 'sms') {
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

        // Always read from DOM (reflects edits + newly added rows)
        let entry = readEntryFromRow(tr);

        // Fallback to cached state if DOM read failed
        if (!entry) {
            const entryId = parseInt(tr.dataset.entryId);
            entry = App.state.entries?.find(en => en.id === entryId);
        }
        if (!entry) return;

        if (mode === 'sms') {
            handleSmsRowClick(tr, entry);
        } else if (mode === 'call') {
            handleCallRowClick(entry);
        }
    }

    /** Read entry fields from DOM cells when not in App.state.entries */
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
            });
            tr.classList.add('crm-selected');
        }

        renderFloatBox();
    }

    // ── Floating box render ──────────────────────────────────────────
    function renderFloatBox() {
        const box = $('#crm-float-box');
        if (!box) return;

        if (selectedContacts.length === 0 && !isSending) {
            box.classList.remove('visible');
            return;
        }
        box.classList.add('visible');

        const header = $('#crm-float-count');
        if (header) header.textContent = `Selected (${selectedContacts.length})`;

        const list = $('#crm-float-list');
        if (!list) return;
        list.innerHTML = '';

        selectedContacts.forEach((c, i) => {
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
                <button class="crm-remove" data-idx="${i}" title="Remove">×</button>
            `;
            item.querySelector('.crm-remove').addEventListener('click', () => removeContact(i));
            list.appendChild(item);
        });

        // Auto-scroll to show latest selection
        list.scrollTop = list.scrollHeight;

        // Restore footer with send button
        const footer = $('#crm-float-footer');
        if (footer && !isSending) {
            footer.innerHTML = '<button id="crm-send-btn" class="crm-send-btn">Send SMS</button>';
            $('#crm-send-btn')?.addEventListener('click', showConfirmation);
        }
    }

    function removeContact(idx) {
        const c = selectedContacts[idx];
        if (c?.rowEl) c.rowEl.classList.remove('crm-selected');
        selectedContacts.splice(idx, 1);
        renderFloatBox();
    }

    function clearAll() {
        selectedContacts.forEach(c => c.rowEl?.classList.remove('crm-selected'));
        selectedContacts = [];
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
            let msg = `Next send in ~60s · Today: ${sentToday}/60`;
            if (remaining <= 0 && data.pending > 0) {
                msg = `⚠ Daily limit reached (60/day). ${data.pending} queued for tomorrow.`;
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

    function handleCallRowClick(entry) {
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

        const modal = $('#crm-call-modal');
        $('#crm-call-name').textContent = pendingCall.name;
        $('#crm-call-pno').textContent = pendingCall.policy_no;
        $('#crm-call-mobile').textContent = pendingCall.mobile;
        modal?.classList.add('visible');
    }

    function closeCallModal() {
        $('#crm-call-modal')?.classList.remove('visible');
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
            const dot = $('#crm-gateway-dot');
            if (!dot) return;

            if (data.online) {
                dot.className = 'gateway-dot online';
                dot.innerHTML = '<span class="dot"></span> Gateway Online';
            } else {
                dot.className = 'gateway-dot';
                dot.innerHTML = '<span class="dot"></span> Gateway Offline';
            }
        } catch { /* silent */ }
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
            box?.classList.add('visible');
            loadQueueView();
            queueRefreshTimer = setInterval(loadQueueView, 5000);
        } else {
            btn?.classList.remove('active-queue');
            box?.classList.remove('visible');
            if (queueRefreshTimer) { clearInterval(queueRefreshTimer); queueRefreshTimer = null; }
        }
    }

    async function loadQueueView() {
        const header = $('#crm-float-count');
        const list = $('#crm-float-list');
        const footer = $('#crm-float-footer');
        const tabs = document.querySelector('.crm-float-tabs');

        if (header) header.textContent = 'Queue';
        if (tabs) tabs.style.display = 'none';

        try {
            const data = await App.api('GET', '/api/sms/queue/status');
            const items = data.items || [];
            const logs = data.logs || [];
            const pending = items.filter(i => i.status === 'pending' || i.status === 'processing');
            const done = data.done || 0;
            const failed = data.failed || 0;
            const sentToday = data.sent_today || 0;
            const dailyLimit = data.daily_limit || 60;

            if (list) {
                list.innerHTML = '';

                // Stats bar
                const stats = document.createElement('div');
                stats.className = 'crm-queue-stats';
                stats.innerHTML = `
                    <div class="crm-stat"><span class="crm-stat-num">${pending.length}</span><span class="crm-stat-label">Pending</span></div>
                    <div class="crm-stat"><span class="crm-stat-num crm-stat-done">${done}</span><span class="crm-stat-label">Sent</span></div>
                    <div class="crm-stat"><span class="crm-stat-num crm-stat-fail">${failed}</span><span class="crm-stat-label">Failed</span></div>
                    <div class="crm-stat"><span class="crm-stat-num">${sentToday}/${dailyLimit}</span><span class="crm-stat-label">Today</span></div>
                `;
                list.appendChild(stats);

                // Pending items with cancel
                if (pending.length > 0) {
                    const lbl = document.createElement('div');
                    lbl.className = 'crm-queue-section-label';
                    lbl.textContent = 'Pending (' + pending.length + ')';
                    list.appendChild(lbl);

                    pending.forEach(item => {
                        const div = document.createElement('div');
                        div.className = 'crm-float-item';
                        div.innerHTML = '<div class="crm-float-item-info"><div class="crm-float-item-name">' + esc(item.name) + '</div><div class="crm-float-item-meta">' + esc(item.policy_no) + ' · <span class="crm-badge-pending">' + item.status + '</span></div></div><button class="crm-cancel-item" title="Cancel">✕</button>';
                        div.querySelector('.crm-cancel-item').addEventListener('click', async (e) => {
                            e.stopPropagation();
                            try {
                                await App.api('DELETE', '/api/sms/queue/' + item.id);
                                App.toast('Cancelled: ' + item.name, 'success', 2000);
                                loadQueueView();
                            } catch (err) { App.toast('Cancel failed', 'error'); }
                        });
                        list.appendChild(div);
                    });
                }

                // Completed items from logs
                if (logs.length > 0) {
                    const lbl2 = document.createElement('div');
                    lbl2.className = 'crm-queue-section-label';
                    lbl2.textContent = 'Recent (' + logs.length + ')';
                    list.appendChild(lbl2);

                    logs.forEach(log => {
                        const div = document.createElement('div');
                        div.className = 'crm-float-item';
                        const badge = log.status === 'sent' ? '<span class="crm-badge-sent">sent</span>' : '<span class="crm-badge-failed">failed</span>';
                        const time = formatTime(log.sent_at || '');
                        div.innerHTML = '<div class="crm-float-item-info"><div class="crm-float-item-name">' + esc(log.name) + '</div><div class="crm-float-item-meta">' + esc(log.policy_no) + ' · ' + badge + ' · <span style="color:#8b92a5">' + time + '</span></div></div>';
                        list.appendChild(div);
                    });
                }

                if (pending.length === 0 && logs.length === 0) {
                    const empty = document.createElement('div');
                    empty.style.cssText = 'text-align:center;padding:20px;color:#8b92a5;font-size:12px';
                    empty.textContent = 'No messages in queue';
                    list.appendChild(empty);
                }
            }

            if (footer && pending.length > 0) {
                footer.innerHTML = '<button class="crm-send-btn crm-cancel-all-btn" id="crm-cancel-all">Cancel All (' + pending.length + ')</button>';
                document.getElementById('crm-cancel-all').addEventListener('click', async () => {
                    try {
                        await App.api('DELETE', '/api/sms/queue');
                        App.toast('All pending cancelled', 'success', 2000);
                        loadQueueView();
                    } catch (err) { App.toast('Cancel failed', 'error'); }
                });
            } else if (footer) {
                footer.innerHTML = '';
            }
        } catch (err) {
            if (list) list.innerHTML = '<div style="text-align:center;padding:20px;color:#d04040;font-size:12px">Failed to load queue</div>';
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
