/* TraceGym offline shell.
 *
 * Python is the part that must work with no network at all: the interpreter and
 * stdlib are served from this origin and cached here on first use. Model weights
 * are cached separately by WebLLM's own Cache API storage, so this worker never
 * touches cross-origin requests.
 */
const CACHE = 'tracegym-shell-v1';
const PRECACHE = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function put(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return;
  const copy = response.clone();
  void caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isImmutable = url.pathname.startsWith('/pyodide/') || url.pathname.startsWith('/assets/');
  if (isImmutable) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            put(request, response);
            return response;
          }),
      ),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          put(request, response);
          return response;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || caches.match('/'))),
    );
  }
});
