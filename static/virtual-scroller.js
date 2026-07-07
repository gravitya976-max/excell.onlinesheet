/* ══════════════════════════════════════════════════════════════════════
   VirtualScroller — Renders only visible rows for maximum performance

   How it works:
     1. Container has overflow-y: auto with fixed height
     2. Spacer div maintains correct scrollbar via total height
     3. On scroll → recalculate visible window → render only those rows
     4. Row elements are recycled (DOM reuse) for zero GC pressure
     5. Extra rows (blank) are always rendered below virtual area

   Usage:
     VirtualScroller.init(container, renderRowFn, extraRowsFn)
     VirtualScroller.setData(rows)    // full dataset for current view
     VirtualScroller.refresh()        // re-render visible rows
   ══════════════════════════════════════════════════════════════════════ */

const VirtualScroller = (() => {
    // ── Config ───────────────────────────────────────────────────────
    const ROW_HEIGHT = 32;      // Fixed row height in px
    const BUFFER = 8;           // Extra rows above/below visible area
    const EXTRA_ROWS = 10;      // Blank rows at bottom

    // ── State ────────────────────────────────────────────────────────
    let _container = null;      // Scroll container div
    let _spacer = null;         // Height spacer div
    let _viewport = null;       // Visible area div (holds rendered rows)
    let _tbody = null;          // The actual <tbody> element
    let _data = [];             // Full dataset for current view
    let _renderRowFn = null;    // Function: (rowData, rowIndex) => <tr>
    let _renderExtraFn = null;  // Function: (extraIdx, startSn) => <tr>
    let _renderedRange = { start: -1, end: -1 };
    let _scrollRAF = null;      // requestAnimationFrame ID
    let _visibleCount = 0;      // How many rows fit in viewport

    // ── Init ─────────────────────────────────────────────────────────

    /**
     * Initialize the virtual scroller.
     * @param {HTMLElement} scrollContainer - The div with overflow-y:auto
     * @param {HTMLElement} tbody - The <tbody> to render rows into
     * @param {Function} renderRowFn - (rowData, rowIndex) => <tr> element
     * @param {Function} renderExtraFn - (extraIdx, startSn) => <tr> element
     */
    function init(scrollContainer, tbody, renderRowFn, renderExtraFn) {
        _container = scrollContainer;
        _tbody = tbody;
        _renderRowFn = renderRowFn;
        _renderExtraFn = renderExtraFn;

        // Create spacer (invisible div that sets total scroll height)
        _spacer = document.createElement('div');
        _spacer.className = 'vs-spacer';
        _spacer.style.cssText = 'width:1px;pointer-events:none;position:relative;';
        
        // Insert spacer before tbody's table or use container
        // We'll set height on the spacer based on data length

        // Calculate visible count
        _recalcVisibleCount();

        // Attach scroll listener with RAF throttle
        _container.addEventListener('scroll', _onScroll, { passive: true });
        
        // Recalculate on resize
        window.addEventListener('resize', _onResize);
    }

    function _recalcVisibleCount() {
        if (!_container) return;
        const h = _container.clientHeight;
        _visibleCount = Math.ceil(h / ROW_HEIGHT) + 1;
    }

    // ── Data ─────────────────────────────────────────────────────────

    /**
     * Set the full dataset. Triggers re-render.
     */
    function setData(data) {
        _data = data || [];
        _renderedRange = { start: -1, end: -1 };
        _updateSpacerHeight();
        _renderVisible();
    }

    /**
     * Get current data length.
     */
    function getDataLength() {
        return _data.length;
    }

    /**
     * Get a data row by index.
     */
    function getRow(index) {
        return _data[index] || null;
    }

    // ── Spacer height ────────────────────────────────────────────────

    function _updateSpacerHeight() {
        const totalHeight = (_data.length + EXTRA_ROWS) * ROW_HEIGHT;
        // We need to set the total scrollable height on the table container
        // Using a min-height on tbody or a spacer approach
        if (_tbody) {
            // Set a CSS custom property for total content height
            _tbody.style.minHeight = totalHeight + 'px';
            _tbody.style.position = 'relative';
        }
    }

    // ── Scroll handling ──────────────────────────────────────────────

    function _onScroll() {
        if (_scrollRAF) return; // Already scheduled
        _scrollRAF = requestAnimationFrame(() => {
            _scrollRAF = null;
            _renderVisible();
        });
    }

    function _onResize() {
        _recalcVisibleCount();
        _renderVisible();
    }

    // ── Core render ──────────────────────────────────────────────────

    function _renderVisible() {
        if (!_container || !_tbody || !_renderRowFn) return;

        const scrollTop = _container.scrollTop;
        const totalDataRows = _data.length;

        // Calculate visible range
        let start = Math.floor(scrollTop / ROW_HEIGHT) - BUFFER;
        let end = start + _visibleCount + BUFFER * 2;

        // Clamp to valid range (data + extra rows)
        const totalRows = totalDataRows + EXTRA_ROWS;
        start = Math.max(0, start);
        end = Math.min(totalRows, end);

        // Skip if range hasn't changed
        if (start === _renderedRange.start && end === _renderedRange.end) return;
        _renderedRange = { start, end };

        // Build fragment with only visible rows
        const frag = document.createDocumentFragment();

        // Top spacer (pushes rendered rows to correct scroll position)
        const topPad = document.createElement('tr');
        topPad.className = 'vs-pad-top';
        topPad.style.cssText = `height:${start * ROW_HEIGHT}px;display:block;`;
        // Single cell that spans all columns
        const topTd = document.createElement('td');
        topTd.style.cssText = 'padding:0;border:none;height:inherit;display:block;';
        topPad.appendChild(topTd);
        frag.appendChild(topPad);

        // Render visible data rows
        for (let i = start; i < Math.min(end, totalDataRows); i++) {
            const tr = _renderRowFn(_data[i], i);
            tr.style.height = ROW_HEIGHT + 'px';
            frag.appendChild(tr);
        }

        // Render visible extra (blank) rows
        for (let i = Math.max(start, totalDataRows); i < end; i++) {
            const extraIdx = i - totalDataRows;
            const tr = _renderExtraFn(extraIdx, totalDataRows + extraIdx + 1);
            tr.style.height = ROW_HEIGHT + 'px';
            frag.appendChild(tr);
        }

        // Bottom spacer (maintains total scroll height)
        const bottomPad = document.createElement('tr');
        bottomPad.className = 'vs-pad-bottom';
        const remainingRows = totalRows - end;
        bottomPad.style.cssText = `height:${remainingRows * ROW_HEIGHT}px;display:block;`;
        const bottomTd = document.createElement('td');
        bottomTd.style.cssText = 'padding:0;border:none;height:inherit;display:block;';
        bottomPad.appendChild(bottomTd);
        frag.appendChild(bottomPad);

        // Single DOM swap
        _tbody.innerHTML = '';
        _tbody.appendChild(frag);
    }

    // ── Public utilities ─────────────────────────────────────────────

    /**
     * Force re-render (e.g., after edit or filter change).
     */
    function refresh() {
        _renderedRange = { start: -1, end: -1 };
        _renderVisible();
    }

    /**
     * Scroll to a specific row index.
     */
    function scrollToRow(index) {
        if (!_container) return;
        const targetTop = index * ROW_HEIGHT;
        _container.scrollTop = targetTop;
    }

    /**
     * Get the currently visible range.
     */
    function getVisibleRange() {
        const scrollTop = _container ? _container.scrollTop : 0;
        const start = Math.floor(scrollTop / ROW_HEIGHT);
        return {
            start,
            end: Math.min(start + _visibleCount, _data.length + EXTRA_ROWS)
        };
    }

    /**
     * Update a single row without full re-render.
     */
    function updateRow(index) {
        if (index < _renderedRange.start || index >= _renderedRange.end) return;
        // Row is visible — find it in the DOM and replace
        const rows = _tbody.querySelectorAll('tr:not(.vs-pad-top):not(.vs-pad-bottom)');
        const domIdx = index - _renderedRange.start;
        if (domIdx >= 0 && domIdx < rows.length && _data[index]) {
            const newTr = _renderRowFn(_data[index], index);
            newTr.style.height = ROW_HEIGHT + 'px';
            rows[domIdx].replaceWith(newTr);
        }
    }

    /**
     * Get the row height constant.
     */
    function getRowHeight() {
        return ROW_HEIGHT;
    }

    /**
     * Get extra rows count.
     */
    function getExtraRowCount() {
        return EXTRA_ROWS;
    }

    /**
     * Destroy: remove listeners.
     */
    function destroy() {
        if (_container) _container.removeEventListener('scroll', _onScroll);
        window.removeEventListener('resize', _onResize);
        if (_scrollRAF) cancelAnimationFrame(_scrollRAF);
        _container = _tbody = _data = null;
    }

    // ── Public API ───────────────────────────────────────────────────
    return {
        init,
        setData,
        refresh,
        scrollToRow,
        getVisibleRange,
        updateRow,
        getDataLength,
        getRow,
        getRowHeight,
        getExtraRowCount,
        destroy,
    };
})();
