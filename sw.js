/* ══════════════════════════════════════════════════════════════════════
   Service Worker — Offline-First for Online Sheet
   • Cache-first for static assets (instant loads)
   • Network-first for API calls (fresh data when online, cached when offline)
   ══════════════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'os-cache-v78';
const STATIC_ASSETS = [
    '/',
    '/static/style.css?v=78',
    '/static/crm.css?v=78',
    '/static/datastore.js?v=78',
    '/static/virtual-scroller.js?v=78',
    '/static/offline-queue.js?v=78',
    '/static/app.js?v=78',
    '/static/spreadsheet.js?v=78',
    '/static/crm.js?v=78',
    '/static/favicon.png',
];

// Install — cache all static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) => {
            return Promise.all(
                names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
            );
        })
    );
    self.clients.claim();
});

// Fetch strategy
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests (let them pass through — offline-queue handles writes)
    if (event.request.method !== 'GET') return;

    // API calls: network-first, fall back to cache
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // Cache successful API responses
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, clone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Offline — try cache
                    return caches.match(event.request).then((cached) => {
                        return cached || new Response(
                            JSON.stringify({ error: 'offline', detail: 'No cached data available' }),
                            { status: 503, headers: { 'Content-Type': 'application/json' } }
                        );
                    });
                })
        );
        return;
    }

    // Static assets & pages: cache-first, fall back to network
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            });
        })
    );
});
