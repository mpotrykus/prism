/* Plex's watchlist ("My List") and this server's local library are two different ID
   spaces (discover.provider.plex.tv ratingKeys vs. this server's /library/metadata
   ones) with no shared identifier, so watchlist membership is matched by normalized
   title (+ year, when known) instead. Punctuation/whitespace differences between the
   two sources (e.g. a colon or an apostrophe) make an exact string match silently fail
   on these, so comparisons strip everything but alphanumerics. */

export function normalizeTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/* Same normalized-title(+year) comparison as isInWatchlist, but returns the matched pool
   item itself rather than a boolean - lets a caller borrow that item's own __server/
   __section stamp (which a watchlist item never has - see the note above) to decide
   whether the watchlist item belongs to a given server/library tab. */
export function findLocalMatch(item, pool) {
  const norm = normalizeTitle(item.title);
  return (pool || []).find((w) => normalizeTitle(w.title) === norm && (!item.year || w.year === item.year));
}

export function isInWatchlist(item, watchlistRaw) {
  return !!findLocalMatch(item, watchlistRaw);
}
