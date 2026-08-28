// Offline shell cache. Network-first for same-origin requests so a deploy shows
// up immediately when online; the cache is only a fallback for offline use.
// Map tiles, OSM/Overpass and elevation data are never cached here.
const CACHE = 'deadreckon-v4';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/sensors.js',
  './js/pdr.js',
  './js/ahrs.js',
  './js/magcal.js',
  './js/map.js',
  './js/geo.js',
  './js/utils.js',
  './js/roadgraph.js',
  './js/mapmatch.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return resp;
      })
      .catch(() => caches.match(e.request)),
  );
});
