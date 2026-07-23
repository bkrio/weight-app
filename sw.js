// sw.js — offline-first service worker. Precaches the whole app shell and
// serves cache-first, so the app opens with no network at all.
//
// IMPORTANT: bump CACHE_VERSION whenever you change any file in ASSETS,
// otherwise installed phones keep serving the old cached copy.

const CACHE_VERSION = 'weight-tracker-v11';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/app.js',
  './js/storage.js',
  './js/stats.js',
  './js/units.js',
  './js/chart.js',
  './vendor/chart.umd.js',
  './vendor/chartjs-adapter-date-fns.bundle.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the browser HTTP cache — otherwise a version bump
  // can precache a stale copy (GitHub Pages serves max-age=600) and cache-first
  // would then pin it until the NEXT bump.
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Cache successful same-origin responses so future loads work offline too.
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Offline navigation to any path falls back to the app shell.
          if (request.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
    })
  );
});
