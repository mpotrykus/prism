/* Persists two things per title (keyed by ratingKey) in plain localStorage:

   1. Search results, keyed by provider+query+language too - subtitle-provider.js reads/
      writes this so a search already run this session (or a previous one) never repeats
      the same network round trip, on either the Plex-brokered or direct-OpenSubtitles
      path.
   2. Which result the user actually applied, if any, plus its Sync +/- offset (see
      getAppliedOffsetMs/setAppliedOffsetMs) - chrome.js's applySubtitleResult and
      native-bridge.js's subtitleSelectRequested handler record the result;
      chrome.js's adjustSubtitleOffset (web/Xbox) and native-bridge.js's
      subtitleOffsetChanged listener (Android, notified from PlayerActivity's own
      Sync +/- buttons via onSubtitleOffsetChanged - those apply fully natively, but
      still tell JS afterward the same way onSubtitleCleared does for the "Off" row)
      both record the offset. plex-player.js re-reads all of this at the start of
      every session (see applyRememberedSubtitle in chrome.js) so the same title
      auto-reapplies its subtitle and sync offset without the user redoing either, on
      either platform. Downloading the actual text for that remembered result still
      goes through subtitle-provider.js's download() - normally served from this same
      cache, not a fresh network call - rather than duplicating the raw text here too.

   Not versioned/expired per-entry beyond MAX_ENTRIES' LRU-ish eviction - subtitle
   search results for a given title essentially never change, and a wrong/stale pick is
   always one manual re-search away. */

const STORAGE_KEY = "prism.subtitleCache";
const MAX_ENTRIES = 60;

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function persist(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

/* Caps total titles tracked rather than letting this grow unbounded across a large
   library - evicts whichever entries were touched longest ago first. */
function prune(store) {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .sort((a, b) => (store[a].touchedAt || 0) - (store[b].touchedAt || 0))
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach((k) => delete store[k]);
}

function entryFor(store, ratingKey) {
  return store[String(ratingKey)] || {};
}

function searchKey(provider, query, languageCode) {
  return `${provider}::${(query || "").trim().toLowerCase()}::${languageCode || "en"}`;
}

/* A search result's own identity - the same {provider, key|fileId} pair
   subtitle-provider.js's download() branches on. */
function resultKey(result) {
  return result.provider === "opensubtitles" ? `opensubtitles::${result.fileId}` : `plex::${result.key}`;
}

export function getCachedSearch(ratingKey, provider, query, languageCode) {
  if (!ratingKey) return null;
  return entryFor(load(), ratingKey).searches?.[searchKey(provider, query, languageCode)] || null;
}

export function setCachedSearch(ratingKey, provider, query, languageCode, results) {
  if (!ratingKey) return;
  const store = load();
  const entry = (store[String(ratingKey)] = entryFor(store, ratingKey));
  entry.searches = entry.searches || {};
  entry.searches[searchKey(provider, query, languageCode)] = results;
  entry.touchedAt = Date.now();
  prune(store);
  persist(store);
}

export function getCachedDownload(ratingKey, result) {
  if (!ratingKey) return null;
  return entryFor(load(), ratingKey).downloads?.[resultKey(result)] || null;
}

export function setCachedDownload(ratingKey, result, downloaded) {
  if (!ratingKey) return;
  const store = load();
  const entry = (store[String(ratingKey)] = entryFor(store, ratingKey));
  entry.downloads = entry.downloads || {};
  entry.downloads[resultKey(result)] = downloaded;
  entry.touchedAt = Date.now();
  prune(store);
  persist(store);
}

export function getAppliedSubtitle(ratingKey) {
  if (!ratingKey) return null;
  return entryFor(load(), ratingKey).applied || null;
}

/* Lets a search-results row check "is this me?" against whatever's currently applied,
   without needing its own copy of resultKey's provider/key-vs-fileId branching - a
   fresh search's results are never the same object reference as whatever got applied
   (even a re-run of the exact same search), so this can't just be `===`. */
export function isAppliedResult(ratingKey, result) {
  const applied = getAppliedSubtitle(ratingKey);
  return !!applied && resultKey(applied) === resultKey(result);
}

/* A freshly applied result always starts at offset 0 - carrying over whatever the
   previous file (if any) was synced to would misalign this one from its first cue,
   same reasoning attachSubtitleTrack's own reset already follows for the in-session
   case. */
export function setAppliedSubtitle(ratingKey, result) {
  if (!ratingKey) return;
  const store = load();
  const entry = (store[String(ratingKey)] = entryFor(store, ratingKey));
  entry.applied = result;
  entry.appliedOffsetMs = 0;
  entry.touchedAt = Date.now();
  prune(store);
  persist(store);
}

export function clearAppliedSubtitle(ratingKey) {
  if (!ratingKey) return;
  const store = load();
  if (!store[String(ratingKey)]) return;
  delete store[String(ratingKey)].applied;
  delete store[String(ratingKey)].appliedOffsetMs;
  persist(store);
}

export function getAppliedOffsetMs(ratingKey) {
  if (!ratingKey) return 0;
  return entryFor(load(), ratingKey).appliedOffsetMs || 0;
}

/* Written on every Sync +/- click (see chrome.js's adjustSubtitleOffset), not just on
   apply - a small, frequent write, same trade-off applyRememberedSubtitle's caller
   already accepts elsewhere in this file. */
export function setAppliedOffsetMs(ratingKey, offsetMs) {
  if (!ratingKey) return;
  const store = load();
  const entry = store[String(ratingKey)];
  if (!entry || !entry.applied) return;
  entry.appliedOffsetMs = offsetMs;
  entry.touchedAt = Date.now();
  persist(store);
}
