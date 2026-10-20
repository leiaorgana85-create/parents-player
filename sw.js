const CACHE_PREFIX = 'parents-player-v';
const CACHE = 'parents-player-v31';
const MEDIA_CONTROLS_JS = './media-session-controls.js?v=3';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=11',
  './background.css?v=1',
  './playlist.css?v=4',
  './buddha-bg.png',
  './audio-storage.js?v=2',
  './oauth-gesture.js?v=5',
  './reliability-guard.js?v=2',
  './playlist.js?v=2',
  './app.js?v=5',
  './ui-fixes.js?v=2',
  MEDIA_CONTROLS_JS,
  './reset.html',
  './manifest.json?v=6',
  './app-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function injectMediaControls(response) {
  if (!response) return response;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('etag');
  const html = text.includes('media-session-controls.js')
    ? text
    : text.replace('</body>', '  <script src="./media-session-controls.js?v=3" defer></script>\n</body>');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response && response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
      }
      return event.request.mode === 'navigate' ? injectMediaControls(response) : response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached) return event.request.mode === 'navigate' ? injectMediaControls(cached) : cached;

      if (event.request.mode === 'navigate') {
        const fallback = (await caches.match('./index.html')) || (await caches.match('./'));
        return injectMediaControls(fallback);
      }

      throw error;
    }
  })());
});
