// Service Worker — Online Sheet
// Version string changes force cache invalidation on deploy
const CACHE_VERSION = 'v3-' + '20261005';
const CACHE_NAME = 'os-cache-' + CACHE_VERSION;

self.addEventListener('install', (e) => {
    // Force immediate activation — don't wait for old SW tabs to close
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    // Delete ALL old caches (any cache name that doesn't match current)
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// ── Message channel: app can force cache clear / SW update ──
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data === 'CLEAR_CACHE') {
        caches.keys().then(keys =>
            Promise.all(keys.map(k => caches.delete(k)))
        ).then(() => {
            // Notify all clients that cache was cleared
            self.clients.matchAll().then(clients => {
                clients.forEach(client => client.postMessage({ type: 'CACHE_CLEARED' }));
            });
        });
    }
    if (event.data === 'GET_VERSION') {
        event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
    }
});

self.addEventListener('fetch', (e) => {
    // Skip API calls — ALWAYS go to network, never cache
    if (e.request.url.includes('/api/')) return;
    // Only cache GET requests
    if (e.request.method !== 'GET') return;

    // For HTML pages (navigation requests): network-first, cache only as offline fallback
    if (e.request.mode === 'navigate' || e.request.headers.get('accept')?.includes('text/html')) {
        e.respondWith(
            fetch(e.request).then(resp => {
                if (resp.ok) {
                    const clone = resp.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                }
                return resp;
            }).catch(() => caches.match(e.request))
        );
        return;
    }

    // For static assets (JS/CSS/images): network-first with cache fallback
    // Assets use ?v=XX cache-busting, so different versions = different cache keys
    e.respondWith(
        fetch(e.request).then(resp => {
            if (resp.ok) {
                const clone = resp.clone();
                caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
            }
            return resp;
        }).catch(() => caches.match(e.request))
    );
});
