/* ══════════════════════════════════════════════════════════════════════
   OfflineQueue — IndexedDB-backed action queue for offline writes
   
   When offline:
     • API writes (PUT, POST, DELETE) are queued in IndexedDB
     • DataStore is updated locally (in-memory + localStorage)
     • Footer shows pending count
   
   When back online:
     • Queue is flushed sequentially (FIFO)
     • Each action retried up to 3 times
     • Footer updates as items sync
   ══════════════════════════════════════════════════════════════════════ */

const OfflineQueue = (() => {
    const DB_NAME = 'os_offline_queue';
    const STORE_NAME = 'actions';
    const DB_VERSION = 1;
    let _db = null;

    // ── Open / create IndexedDB ──────────────────────────────────────
    function openDB() {
        return new Promise((resolve, reject) => {
            if (_db) { resolve(_db); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    // ── Enqueue an action ────────────────────────────────────────────
    async function enqueue(method, url, body) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.add({
                method,
                url,
                body: body ? JSON.stringify(body) : null,
                timestamp: Date.now(),
                retries: 0,
            });
            tx.oncomplete = () => { updateIndicator(); resolve(); };
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    // ── Get all queued actions ────────────────────────────────────────
    async function getAll() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    // ── Remove a single action by id ─────────────────────────────────
    async function remove(id) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    // ── Update retry count ───────────────────────────────────────────
    async function incrementRetry(id) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = () => {
                const action = req.result;
                if (action) {
                    action.retries = (action.retries || 0) + 1;
                    store.put(action);
                }
                tx.oncomplete = () => resolve();
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    // ── Flush queue (called when back online) ────────────────────────
    async function flush() {
        if (!navigator.onLine) return;
        const actions = await getAll();
        if (actions.length === 0) return;

        let synced = 0;
        for (const action of actions) {
            try {
                const opts = {
                    method: action.method,
                    headers: {},
                };
                if (action.body) {
                    opts.headers['Content-Type'] = 'application/json';
                    opts.body = action.body;
                }
                const resp = await fetch(action.url, opts);
                if (resp.ok) {
                    await remove(action.id);
                    synced++;
                } else if (action.retries >= 3) {
                    // Give up after 3 retries
                    await remove(action.id);
                    console.warn('OfflineQueue: dropped action after 3 retries', action);
                } else {
                    await incrementRetry(action.id);
                }
            } catch {
                // Network error — stop flushing (still offline)
                break;
            }
        }

        if (synced > 0 && typeof App !== 'undefined') {
            App.toast(`✓ ${synced} change${synced > 1 ? 's' : ''} synced`, 'success', 2500);
        }
        updateIndicator();
    }

    // ── Count pending actions ────────────────────────────────────────
    async function count() {
        try {
            const actions = await getAll();
            return actions.length;
        } catch { return 0; }
    }

    // ── Update footer sync indicator ─────────────────────────────────
    async function updateIndicator() {
        const dot = document.querySelector('#footer-sync .sync-dot');
        const text = document.getElementById('sync-text');
        if (!dot || !text) return;

        const pending = await count();
        const online = navigator.onLine;

        // Remove all state classes
        dot.classList.remove('sync-online', 'sync-offline', 'sync-pending');

        if (online && pending === 0) {
            dot.classList.add('sync-online');
            text.textContent = 'Synced';
        } else if (online && pending > 0) {
            dot.classList.add('sync-pending');
            text.textContent = `${pending} pending`;
        } else if (!online && pending > 0) {
            dot.classList.add('sync-pending');
            text.textContent = `Offline · ${pending} pending`;
        } else {
            dot.classList.add('sync-offline');
            text.textContent = 'Offline';
        }
    }

    // ── Init: open DB + set indicator ────────────────────────────────
    openDB().then(() => updateIndicator()).catch(() => {});

    return {
        enqueue,
        flush,
        count,
        updateIndicator,
        getAll,
    };
})();
