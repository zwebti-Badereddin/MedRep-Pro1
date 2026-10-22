// MedRep Pro installed web app: keeps the app shell on the phone so it opens at once.
// It never stores data: every request to the Apps Script server (POST) and every map tile / search goes straight to the network.
// VERSION is filled in by tools/build-web.js; a new build gets a new cache and the old one is deleted.
'use strict';
const VERSION = '__VERSION__', CACHE = 'medrep-' + VERSION;
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
// Versioned third-party files the page loads (map library, font). Cached after first use.
const CDN = /^https:\/\/(unpkg\.com\/leaflet@1\.9\.4\/|fonts\.googleapis\.com\/css2|fonts\.gstatic\.com\/)/;
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.indexOf('medrep-') === 0 && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // server calls are POST: never touched
  const url = new URL(req.url), same = url.origin === self.location.origin;
  if (same && req.mode === 'navigate') { e.respondWith(page(req)); return; }
  if (same && SHELL.some(p => new URL(p, self.location).pathname === url.pathname)) { e.respondWith(cacheFirst(req)); return; }
  if (CDN.test(req.url)) { e.respondWith(cacheFirst(req)); return; }
  // everything else (map tiles, place search, Apps Script) uses the network as usual
});
// The page: newest version from the network when it answers within 3 s, else the copy on the phone (opens with no signal).
function page(req) {
  const fromNet = fetch(req).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./', copy)); } return r; });
  const timeout = new Promise(res => setTimeout(res, NAV_TIMEOUT_MS));
  return Promise.race([fromNet.catch(() => null), timeout]).then(r => r || caches.match('./').then(c => c || fromNet));
}
function cacheFirst(req) {
  return caches.match(req).then(hit => hit || fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }));
}
