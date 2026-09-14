// Service Worker — Online Sheet
const CACHE_NAME = 'os-cache-v1';

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    // Skip API calls — always network
    if (e.request.url.includes('/api/')) return;
    // Only cache GET requests
    if (e.request.method !== 'GET') return;
    e.respondWith(
        fetch(e.request).then(resp => {
            // Cache successful responses for offline fallback
            if (resp.ok) {
                const clone = resp.clone();
                caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
            }
            return resp;
        }).catch(() => caches.match(e.request))
    );
});
