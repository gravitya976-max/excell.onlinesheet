/* ══════════════════════════════════════════════════════════════════════
   VirtualScroller v2.2 — 60fps smooth scrolling

   Key technique: Sliding Window DOM Updates
     Instead of destroying and rebuilding all rows on every scroll,
     we only add/remove rows at the edges of the visible window.
     Scrolling down 1 row = remove 1 from top + add 1 at bottom.
     This keeps DOM mutations minimal → 60fps.

   Usage:
     VirtualScroller.init(container, tbody, renderRowFn, extraRowsFn)
     VirtualScroller.setData(rows)
     VirtualScroller.refresh()
   ══════════════════════════════════════════════════════════════════════ */

const VirtualScroller = (() => {
    // ── Config ───────────────────────────────────────────────────────
    const ROW_HEIGHT = 32;
    const BUFFER = 15;          // Rows above/below viewport
    const EXTRA_ROWS = 10;      // Blank rows at bottom

    // ── State ────────────────────────────────────────────────────────
    let _container = null;
    let _tbody = null;
    let _data = [];
    let _renderRowFn = null;
    let _renderExtraFn = null;
    let _renderedRange = { start: -1, end: -1 };
    let _scrollRAF = null;
    let _rowHooks = [];   // callbacks called after each row is built: fn(tr, dataIndex)
    let _visibleCount = 0;

    // ── Init ─────────────────────────────────────────────────────────
    function init(scrollContainer, tbody, renderRowFn, renderExtraFn) {
        _container = scrollContainer;
        _tbody = tbody;
        _renderRowFn = renderRowFn;
        _renderExtraFn = renderExtraFn;

        _recalcVisibleCount();
        _container.addEventListener('scroll', _onScroll, { passive: true });
        window.addEventListener('resize', _onResize);
    }

    function _recalcVisibleCount() {
        if (!_container) return;
        _visibleCount = Math.ceil(_container.clientHeight / ROW_HEIGHT) + 1;
    }

    // ── Data ─────────────────────────────────────────────────────────
    function setData(data) {
        _data = data || [];
        _renderedRange = { start: -1, end: -1 };
        _updateSpacerHeight();
        _fullRender();
    }

    function getDataLength() { return _data.length; }
    function getRow(index) { return _data[index] || null; }

    // ── Spacer height ────────────────────────────────────────────────
    function _updateSpacerHeight() {
        if (_tbody) {
            _tbody.style.minHeight = ((_data.length + EXTRA_ROWS) * ROW_HEIGHT) + 'px';
            _tbody.style.position = 'relative';
        }
    }

    // ── Scroll handling ──────────────────────────────────────────────
    function _onScroll() {
        if (_scrollRAF) return;
        _scrollRAF = requestAnimationFrame(() => {
            _scrollRAF = null;
            _slideRender();
        });
    }

    function _onResize() {
        _recalcVisibleCount();
        _fullRender();
    }

    // ── Build a single row (<tr>) by global index ────────────────────
    function _buildRow(i) {
        const totalDataRows = _data.length;
        let tr;
        if (i < totalDataRows) {
            tr = _renderRowFn(_data[i], i);
        } else {
            const extraIdx = i - totalDataRows;
            tr = _renderExtraFn(extraIdx, totalDataRows + extraIdx + 1);
        }
        tr.style.height = ROW_HEIGHT + 'px';
        tr.style.contain = 'layout style';
        tr.dataset.vsIdx = i;
        // Post-render hooks (e.g. CRM selection state)
        for (const hook of _rowHooks) hook(tr, i);
        return tr;
    }

    // ── Full render (used on setData, refresh, resize) ───────────────
    function _fullRender() {
        if (!_container || !_tbody || !_renderRowFn) return;

        const { start, end } = _calcRange();

        // Skip if identical
        if (start === _renderedRange.start && end === _renderedRange.end) return;
        _renderedRange = { start, end };

        const frag = document.createDocumentFragment();

        // Top spacer
        frag.appendChild(_makeSpacerRow('vs-pad-top', start * ROW_HEIGHT));

        // Visible rows
        for (let i = start; i < end; i++) {
            frag.appendChild(_buildRow(i));
        }

        // Bottom spacer
        const totalRows = _data.length + EXTRA_ROWS;
        frag.appendChild(_makeSpacerRow('vs-pad-bottom', (totalRows - end) * ROW_HEIGHT));

        _tbody.textContent = '';  // Faster than innerHTML = ''
        _tbody.appendChild(frag);
    }

    // ── Slide render (60fps — only add/remove edge rows) ─────────────
    function _slideRender() {
        if (!_container || !_tbody || !_renderRowFn) return;

        const { start, end } = _calcRange();
        const prev = _renderedRange;

        // No change
        if (start === prev.start && end === prev.end) return;

        // If range doesn't overlap at all (big jump), do full render
        if (start >= prev.end || end <= prev.start || prev.start < 0) {
            _renderedRange = { start, end };
            _fullRender();
            return;
        }

        // ── Sliding window update ────────────────────────────────────

        const topSpacer = _tbody.firstElementChild;   // .vs-pad-top
        const bottomSpacer = _tbody.lastElementChild;  // .vs-pad-bottom

        // Scrolled DOWN: start increased → remove from top, add to bottom
        if (start > prev.start) {
            // Remove rows from top (between spacer and first needed row)
            const removeCount = start - prev.start;
            for (let r = 0; r < removeCount; r++) {
                const next = topSpacer.nextElementSibling;
                if (next && next !== bottomSpacer) {
                    _tbody.removeChild(next);
                }
            }
            // Update top spacer
            topSpacer.style.height = (start * ROW_HEIGHT) + 'px';
        }

        if (end > prev.end) {
            // Add new rows at bottom (before bottom spacer)
            for (let i = prev.end; i < end; i++) {
                _tbody.insertBefore(_buildRow(i), bottomSpacer);
            }
            // Update bottom spacer
            const totalRows = _data.length + EXTRA_ROWS;
            bottomSpacer.style.height = ((totalRows - end) * ROW_HEIGHT) + 'px';
        }

        // Scrolled UP: start decreased → add to top, remove from bottom
        if (start < prev.start) {
            // Add new rows at top (after top spacer)
            const ref = topSpacer.nextElementSibling;
            for (let i = start; i < prev.start; i++) {
                _tbody.insertBefore(_buildRow(i), ref);
            }
            // Update top spacer
            topSpacer.style.height = (start * ROW_HEIGHT) + 'px';
        }

        if (end < prev.end) {
            // Remove rows from bottom (before bottom spacer)
            const removeCount = prev.end - end;
            for (let r = 0; r < removeCount; r++) {
                const prev2 = bottomSpacer.previousElementSibling;
                if (prev2 && prev2 !== topSpacer) {
                    _tbody.removeChild(prev2);
                }
            }
            // Update bottom spacer
            const totalRows = _data.length + EXTRA_ROWS;
            bottomSpacer.style.height = ((totalRows - end) * ROW_HEIGHT) + 'px';
        }

        _renderedRange = { start, end };
    }

    // ── Helpers ──────────────────────────────────────────────────────

    function _calcRange() {
        const scrollTop = _container.scrollTop;
        const totalRows = _data.length + EXTRA_ROWS;
        let start = Math.floor(scrollTop / ROW_HEIGHT) - BUFFER;
        let end = start + _visibleCount + BUFFER * 2;
        start = Math.max(0, start);
        end = Math.min(totalRows, end);
        return { start, end };
    }

    function _makeSpacerRow(cls, height) {
        const tr = document.createElement('tr');
        tr.className = cls;
        tr.style.cssText = `height:${Math.max(0, height)}px;display:block;`;
        const td = document.createElement('td');
        td.style.cssText = 'padding:0;border:none;height:inherit;display:block;';
        tr.appendChild(td);
        return tr;
    }

    // ── Public utilities ─────────────────────────────────────────────

    function refresh() {
        _renderedRange = { start: -1, end: -1 };
        _fullRender();
    }

    function scrollToRow(index) {
        if (!_container) return;
        _container.scrollTop = index * ROW_HEIGHT;
    }

    function getVisibleRange() {
        const scrollTop = _container ? _container.scrollTop : 0;
        const start = Math.floor(scrollTop / ROW_HEIGHT);
        return {
            start,
            end: Math.min(start + _visibleCount, _data.length + EXTRA_ROWS)
        };
    }

    function updateRow(index) {
        if (index < _renderedRange.start || index >= _renderedRange.end) return;
        const rows = _tbody.querySelectorAll('tr:not(.vs-pad-top):not(.vs-pad-bottom)');
        const domIdx = index - _renderedRange.start;
        if (domIdx >= 0 && domIdx < rows.length && _data[index]) {
            const newTr = _buildRow(index);
            rows[domIdx].replaceWith(newTr);
        }
    }

    function getRowHeight() { return ROW_HEIGHT; }
    function getExtraRowCount() { return EXTRA_ROWS; }

    function destroy() {
        if (_container) _container.removeEventListener('scroll', _onScroll);
        window.removeEventListener('resize', _onResize);
        if (_scrollRAF) cancelAnimationFrame(_scrollRAF);
        _container = _tbody = _data = null;
    }

    /** Register a callback that fires after each row is rendered: fn(tr, dataIndex) */
    function onRowRendered(fn) { _rowHooks.push(fn); }

    return {
        init, setData, refresh, scrollToRow,
        getVisibleRange, updateRow, getDataLength,
        getRow, getRowHeight, getExtraRowCount, destroy,
        onRowRendered,
    };
})();
