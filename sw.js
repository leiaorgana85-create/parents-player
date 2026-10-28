// App version: 2026.10.27.1
const CACHE_PREFIX = 'parents-player-v';
const CACHE_NAME = 'parents-player-v42';
const SHELL = ['./', './index.html', './manifest.json?v=6', './app-icon.png', './styles.css?v=11', './background.css?v=1', './playlist.css?v=4', './audio-storage.js?v=3', './playlist.js?v=3', './drive-key-bootstrap.js?v=1', './app.js?v=9', './ui-fixes.js?v=3', './media-session-controls.js?v=5', './now-playing-fullscreen.js?v=2', './buddha-bg.png', './reset.html'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL.map(path => new Request(new URL(path, self.location.href), { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const scope = new URL('./', self.location.href);
  if (request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Use this complete installed shell immediately, even on a stalled network.
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    try {
      const response = await fetch(request);
      if (response.ok) event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
      if (response.ok || request.mode !== 'navigate') return response;
    } catch (error) {
      if (request.mode !== 'navigate') return Response.error();
    }
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  })());
});
