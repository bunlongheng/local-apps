// Deploy-safe PWA service worker: NETWORK-FIRST, so it never serves stale content -
// it always tries the network and only falls back to cache when offline.
// skipWaiting + clientsClaim + old-cache cleanup means updates apply at once.
// Shared, unchanged, across every bunlongheng app.
const CACHE = "app-cache-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // Never touch the API: /api/status and /api/apps are live state and must not be replayed
  // stale, and /api/events is an infinite SSE stream that Cache.put would try to buffer.
  if (new URL(request.url).pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response &&
          response.status === 200 &&
          new URL(request.url).origin === self.location.origin
        ) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
