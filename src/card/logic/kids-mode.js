/* Kids Mode filtering. Two independent checks, kept separate rather than merged into
   one function - see plex-netflix-card.js's original comments for why:
   - passesKidsMode: per-item, checked against Plex's own truncated .Genre tags plus
     contentRating. Used as the filter predicate wherever raw items become candidates
     for display (genre rows, AI rows, hero picks, search, etc).
   - isBlockedGenreName: whole-row genre blocking. Plex's list endpoints truncate each
     item's own Genre array to ~2 tags, so plenty of titles filed under e.g. Horror
     don't show "Horror" in their own tags - checking the row's own genre name here is
     what actually keeps a "Horror" row from appearing at all in Kids Mode. */

export function passesKidsMode(m, { kidsMode, blockedGenres = [], allowedRatings = [] }) {
  if (!kidsMode || !m) return true;
  const genres = (m.Genre || []).map((g) => (g.tag || "").trim().toLowerCase());
  if (blockedGenres.some((bg) => genres.includes(bg.trim().toLowerCase()))) return false;
  const rating = (m.contentRating || "").trim().toUpperCase();
  return allowedRatings.map((r) => r.toUpperCase()).includes(rating);
}

export function isBlockedGenreName(name, { kidsMode, blockedGenres = [] }) {
  if (!kidsMode) return false;
  const norm = (name || "").trim().toLowerCase();
  return blockedGenres.some((bg) => bg.trim().toLowerCase() === norm);
}
