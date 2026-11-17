// App-shell cache. Money never touches this file: every /api call goes straight
// to the network, so balances and transfer states are never served stale.
const VERSION = 'easy-send-v2';
const SHELL = [
  '/',
  '/styles.css',
  '/fonts/geist.woff2',
  '/fonts/instrument-serif.woff2',
  '/fonts/instrument-serif-italic.woff2',
  '/js/app.js',
  '/js/lib.js',
  '/js/webauthn.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  // Network first so a deploy shows up on the next load; the cache is the offline fallback.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/');
        return Response.error();
      })
  );
});
