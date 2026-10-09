// Halo service worker: keeps the app shell available offline.
// Network first (so updates you push to GitHub show up straight away), with a
// short timeout, then falls back to the cached copy. Only same-origin GETs are
// handled - calls to your relay or bridge are never cached.
const PREFIX = 'halo-';
const CACHE = `${PREFIX}v1`;
const SHELL = ['./', 'index.html', 'config.js', 'css/styles.css', 'js/app.js', 'js/hue.js', 'icons/favicon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500)),
      ]);
      if (net && net.ok) cache.put(req, net.clone());
      return net;
    } catch (err) {
      const hit = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('./') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
