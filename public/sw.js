const CACHE_NAME = "streaming-dashboard-shell-v1";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./vault.js",
  "./settings.js",
  "./plex-netflix-card.js",
  "./manifest.webmanifest",
  "./assets/plex-logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
});

/* Network-first for the app shell, not cache-first: this app changes often during
   development, and a cache-first policy silently serves a stale plex-netflix-card.js
   even after the on-disk file is edited (bit us once already). Falling back to cache
   only on network failure still gets the offline-install benefit without that trap.
   Plex/YouTube/OpenRouter calls are untouched either way (different origin, never
   reaches this handler at all). */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
