// Minimal offline shell cache. Map tiles, OSM/Overpass and elevation data are
// intentionally not cached.
const CACHE = 'deadreckon-v2';
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
  './js/chart.js',
  './js/map.js',
  './js/geo.js',
  './js/utils.js',
  './js/roadgraph.js',
  './js/mapmatch.js',
  './js/terrain.js',
  './js/netfix.js',
  './js/loop.js',
  './js/model.js',
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
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
