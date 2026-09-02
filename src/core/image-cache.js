/* Settings for public/sw.js's image cache (see its cacheFirstImage). Lives in Cache
   Storage, not localStorage - the service worker can't reach localStorage, but Cache
   Storage is shared between window and SW contexts on the same origin. sw.js is a
   classic (non-module) script and can't import this file, so the cache/key names below
   are duplicated there as literal strings - keep the two in sync by hand. */
const IMAGE_CACHE = "prism-plex-images-v1";
const IMAGE_META_CACHE = "prism-plex-image-meta-v1";
const SETTINGS_CACHE = "prism-image-cache-settings-v1";
const TTL_KEY = `${location.origin}/__prism__/image-cache-ttl-ms`;

export const DEFAULT_IMAGE_CACHE_TTL_DAYS = 7;

export async function getImageCacheTtlDays() {
    try {
        const cache = await caches.open(SETTINGS_CACHE);
        const res = await cache.match(TTL_KEY);
        if (!res) return DEFAULT_IMAGE_CACHE_TTL_DAYS;
        const ms = Number(await res.text());
        return Number.isFinite(ms) && ms > 0 ? ms / 86400000 : DEFAULT_IMAGE_CACHE_TTL_DAYS;
    } catch {
        return DEFAULT_IMAGE_CACHE_TTL_DAYS;
    }
}

export async function setImageCacheTtlDays(days) {
    const ms = Math.max(1, Number(days) || DEFAULT_IMAGE_CACHE_TTL_DAYS) * 86400000;
    const cache = await caches.open(SETTINGS_CACHE);
    await cache.put(TTL_KEY, new Response(String(ms)));
}

/* Only drops the images + their per-image timestamps, never SETTINGS_CACHE - clearing
   the cache shouldn't reset the lifespan the user just configured. */
export async function clearImageCache() {
    await Promise.all([caches.delete(IMAGE_CACHE), caches.delete(IMAGE_META_CACHE)]);
}
