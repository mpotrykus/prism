const SHELL_CACHE = "prism-shell-v1";
const IMAGE_CACHE = "prism-plex-images-v1";
/* Per-image fetch timestamps and the configurable TTL below - kept out of IMAGE_CACHE
   itself since opaque (no-cors) image responses can't have custom headers attached to
   carry a timestamp. Names/keys here are duplicated in image-cache.js (an ES module
   settings.js can import; this classic-script SW can't) - keep both in sync by hand. */
const IMAGE_META_CACHE = "prism-plex-image-meta-v1";
const SETTINGS_CACHE = "prism-image-cache-settings-v1";
const TTL_KEY = `${self.location.origin}/__prism__/image-cache-ttl-ms`;
const DEFAULT_IMAGE_CACHE_TTL_MS = 7 * 86400000;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./vault.js",
  "./settings.js",
  "./plex-netflix-card.js",
  "./manifest.webmanifest",
  "./assets/prism-logo.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== IMAGE_CACHE && k !== IMAGE_META_CACHE && k !== SETTINGS_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
});

function getImageCacheTtlMs() {
  return caches
    .open(SETTINGS_CACHE)
    .then((cache) => cache.match(TTL_KEY))
    .then((res) => (res ? res.text() : null))
    .then((text) => {
      const ms = Number(text);
      return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_IMAGE_CACHE_TTL_MS;
    })
    .catch(() => DEFAULT_IMAGE_CACHE_TTL_MS);
}

/* Network-first for the app shell, not cache-first: this app changes often during
   development, and a cache-first policy silently serves a stale plex-netflix-card.js
   even after the on-disk file is edited (bit us once already). Falling back to cache
   only on network failure still gets the offline-install benefit without that trap. */
function networkFirstShell(request) {
  return fetch(request)
    .then((res) => {
      const clone = res.clone();
      caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
      return res;
    })
    .catch(() => caches.match(request));
}

/* Cache-first with background revalidate, scoped to image requests only. This app has no
   backend/proxy (see CLAUDE.md) - Plex poster/art <img> tags are the only cross-origin
   images it ever loads, so gating on request.destination === "image" reaches exactly those
   without needing to know the user's configured plex_url host or guess at Plex's path shapes.
   These <img> tags don't set crossorigin, so the request is no-cors and the Response the SW
   sees back is opaque (status 0, unreadable) - that's expected, and opaque responses are
   still valid to store/replay via the Cache API, just never inspect their status/body. */
function cacheFirstImage(event) {
  const request = event.request;
  return Promise.all([caches.open(IMAGE_CACHE), caches.open(IMAGE_META_CACHE), getImageCacheTtlMs()]).then(
    ([cache, metaCache, ttlMs]) => {
      const refresh = fetch(request).then((res) => {
        cache.put(request, res.clone());
        metaCache.put(request, new Response(String(Date.now())));
        return res;
      });
      return cache.match(request).then((cached) => {
        if (!cached) return refresh;
        return metaCache
          .match(request)
          .then((metaRes) => (metaRes ? metaRes.text() : null))
          .then((tsText) => {
            const age = tsText ? Date.now() - Number(tsText) : Infinity;
            if (age <= ttlMs) {
              event.waitUntil(refresh.catch(() => {}));
              return cached;
            }
            /* Past its TTL - wait for a fresh copy rather than serving the stale one
               outright, but still fall back to it if the network fetch itself fails
               (offline), same as any other cache-first-with-fallback pattern. */
            return refresh.catch(() => cached);
          });
      });
    }
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirstShell(event.request));
    return;
  }
  if (event.request.destination === "image") {
    event.respondWith(cacheFirstImage(event));
    return;
  }
  // Everything else cross-origin (Plex/YouTube/OpenRouter API calls) bypasses the SW entirely.
});
