/* TMDB-backed trailer discovery - replaces the old YouTube Data API search fallback that
   lived in trailer.js (search.list's 100-unit/day quota was the whole reason users had to
   supply their own YouTube key just to get trailers for titles Plex doesn't already host
   one for). TMDB's own videos endpoint returns YouTube video keys directly, with no search
   involved and no meaningful quota, so Prism bundles its own read-only TMDB API key
   (VITE_TMDB_API_KEY, baked in at build time - see .env.example) instead of asking each
   user to go create one.

   Results are cached in localStorage (see CACHE_KEY) keyed by "movie:<tmdbId>"/"tv:<tmdbId>"
   so a title's trailer is looked up on TMDB once per TTL, not every time its info panel
   opens. A "no trailer found" result is cached too (shorter TTL) so a title TMDB has
   nothing for doesn't get re-queried on every open either. */
const TMDB_API_KEY = (typeof import.meta !== "undefined" && import.meta.env?.VITE_TMDB_API_KEY) || "";
const TMDB_BASE = "https://api.themoviedb.org/3";
const CACHE_KEY = "prism.trailerCache";
const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // best-effort - a full/unavailable localStorage just means no caching this session
  }
}

/* Generic cache used both for a resolved trailer (keyed "movie:<id>"/"tv:<id>") and for a
   legacy-agent imdb->tmdb id translation (keyed "imdb:<imdbId>:<kind>" - see
   resolveTmdbIdFromImdb below). Returns undefined on a cache miss/expired entry (so the
   caller knows it still needs to hit TMDB), as distinct from a cached null, which means
   "TMDB was already asked and had nothing". */
function getCached(cacheKey) {
  const entry = readCache()[cacheKey];
  if (!entry) return undefined;
  const ttl = entry.value ? FOUND_TTL_MS : NOT_FOUND_TTL_MS;
  if (Date.now() - entry.fetchedAt > ttl) return undefined;
  return entry.value;
}

function setCached(cacheKey, value) {
  const cache = readCache();
  cache[cacheKey] = { value, fetchedAt: Date.now() };
  writeCache(cache);
}

/* Plex's list/hub endpoints truncate or omit fields wholesale (same under-populated-
   list-response pattern as the Genre field - see this repo's CLAUDE.md) - only a full
   single-item `/library/metadata/{ratingKey}` fetch reliably returns the `Guid` array, and
   even then only for a library scanned with Plex's current agent (see
   extractLegacyAgentId below for the older per-source agents, which never populate this
   array at all). Entries look like {id: "tmdb://550"}, {id: "imdb://tt0137523"},
   {id: "tvdb://..."}. */
export function extractTmdbId(guids) {
  for (const g of guids || []) {
    const m = /^tmdb:\/\/(\d+)/.exec(g?.id || "");
    if (m) return m[1];
  }
  return null;
}

/* A library scanned with one of Plex's older per-source agents (confirmed against a real
   library still on the legacy IMDb agent - not just a hypothetical) has no `Guid` array at
   all - its single `guid` field is instead a raw agent identifier itself, e.g.
   "com.plexapp.agents.themoviedb://550?lang=en" or "com.plexapp.agents.imdb://tt0137523?lang=en".
   The former gives a tmdb id directly; the latter needs translating via
   resolveTmdbIdFromImdb below. */
export function extractLegacyAgentId(guid) {
  if (!guid) return null;
  let m = /^com\.plexapp\.agents\.themoviedb:\/\/(\d+)/.exec(guid);
  if (m) return { source: "tmdb", id: m[1] };
  m = /^com\.plexapp\.agents\.imdb:\/\/(tt\d+)/.exec(guid);
  if (m) return { source: "imdb", id: m[1] };
  return null;
}

/* site==="YouTube" is a hard requirement (Prism only ever embeds YouTube, never proxies
   or downloads video - see CLAUDE.md's architecture invariant); type==="Trailer" excludes
   Teasers/Clips/Featurettes/Behind the Scenes entries TMDB also lists here. Among the
   remaining candidates: prefer official, then English, then most recently published -
   falling back to a non-official trailer rather than giving up if no official one exists.
   Returns null (not throwing/omitting) when nothing qualifies, so a caller can treat "TMDB
   has videos but none are usable" the same as "TMDB has no videos at all". */
export function pickBestTrailer(videos) {
  const candidates = (videos || []).filter((v) => v?.site === "YouTube" && v?.type === "Trailer" && v?.key);
  if (!candidates.length) return null;
  const official = candidates.filter((v) => v.official);
  const pool = official.length ? official : candidates;
  pool.sort((a, b) => {
    const aEn = a.iso_639_1 === "en" ? 1 : 0;
    const bEn = b.iso_639_1 === "en" ? 1 : 0;
    if (aEn !== bEn) return bEn - aEn;
    return new Date(b.published_at || 0) - new Date(a.published_at || 0);
  });
  const best = pool[0];
  return { youtubeId: best.key, name: best.name || "", official: !!best.official };
}

/* Resolves (and caches) the best YouTube trailer for a TMDB movie/tv id. `kind` is
   "movie" or "tv" - a Plex episode resolves to its parent show's tmdbId/kind before
   calling this (see trailer.js), the same "borrow the show's trailer" behavior the old
   YouTube-search fallback used via grandparentTitle. Never throws - any lookup failure
   (no bundled key, no matching tmdbId, network error, TMDB down) just resolves to null so
   callers fall through to "no trailer" exactly like a missing Plex extra does. */
export async function resolveTmdbTrailer(tmdbId, kind) {
  if (!tmdbId || !kind) return null;
  const cacheKey = `${kind}:${tmdbId}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;
  /* Checked only after the cache lookup, and deliberately not cached itself - an
     unconfigured build (no bundled key) must never write a false "TMDB has no trailer"
     entry that would then block a real lookup once a key is added and the app rebuilt. */
  if (!TMDB_API_KEY) return null;
  try {
    const url = new URL(`${TMDB_BASE}/${kind}/${tmdbId}`);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("append_to_response", "videos");
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const trailer = pickBestTrailer(data?.videos?.results);
    setCached(cacheKey, trailer);
    return trailer;
  } catch (e) {
    return null;
  }
}

/* TMDB's own external-id lookup, used only for a legacy-agent library's IMDb guid (see
   extractLegacyAgentId) - a new-agent library's Guid array already gives a tmdb id
   directly and never needs this. Cached the same way/TTL as a resolved trailer, so a
   legacy-agent library doesn't re-hit this translation step on every open either. */
export async function resolveTmdbIdFromImdb(imdbId, kind) {
  if (!imdbId || !kind) return null;
  const cacheKey = `imdb:${imdbId}:${kind}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;
  if (!TMDB_API_KEY) return null;
  try {
    const url = new URL(`${TMDB_BASE}/find/${imdbId}`);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("external_source", "imdb_id");
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const results = kind === "movie" ? data?.movie_results : data?.tv_results;
    const tmdbId = results?.[0]?.id ? String(results[0].id) : null;
    setCached(cacheKey, tmdbId);
    return tmdbId;
  } catch (e) {
    return null;
  }
}
