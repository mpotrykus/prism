const SHELL_CACHE = "prism-shell-v1";
const IMAGE_CACHE = "prism-plex-images-v1";
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
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== IMAGE_CACHE).map((k) => caches.delete(k)))
    )
  );
});

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
  return caches.open(IMAGE_CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const refresh = fetch(request).then((res) => {
        cache.put(request, res.clone());
        return res;
      });
      if (cached) {
        event.waitUntil(refresh.catch(() => {}));
        return cached;
      }
      return refresh;
    })
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
