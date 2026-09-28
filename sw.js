const CACHE_NAME = 'arenastone-static-v20260928-workflow-safety-1';
const CORE_ASSETS = [
  './',
  './index.html',
  './app.css',
  './workflow.js',
  './manifest.webmanifest',
  './favicon.ico',
  './favicon-32.png',
  './favicon-64.png',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './logo-full.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Cloudflare Worker API and all other cross-origin requests are never cached here.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    const update = fetch(request)
      .then(async response => {
        if (response?.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('./index.html', response.clone());
        }
        return response;
      })
      .catch(() => null);

    event.waitUntil(update.then(() => undefined));
    event.respondWith((async () => {
      const online = await update;
      if (online) return online;
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match('./index.html') || await cache.match(request);
      if (cached) return cached;
      return Response.error();
    })());
    return;
  }

  const isCoreAsset = CORE_ASSETS.some(asset => {
    const assetUrl = new URL(asset, self.location.href);
    return assetUrl.pathname === url.pathname;
  });
  if (!isCoreAsset) return;

  const update = fetch(request)
    .then(async response => {
      if (response?.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(update.then(() => undefined));
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const online = await update;
    return online || Response.error();
  })());
});
