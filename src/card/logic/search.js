/* Pure hub-building logic shared by the search page. Hubs that need a live Plex fetch
   (year range, studio/collection facets) stay as methods on the card - only the parts
   that need no network access live here. */

export const SEARCH_REASON_LABELS = { actor: "Actor", director: "Director" };

export function parseYearQuery(query) {
  const q = query.trim();
  if (/^(19|20)\d{2}$/.test(q)) {
    const y = parseInt(q, 10);
    return [y, y];
  }
  const m = q.match(/^((?:19|20)\d{2})\s*-\s*((?:19|20)\d{2})$/);
  if (!m) return null;
  let a = parseInt(m[1], 10);
  let b = parseInt(m[2], 10);
  return a <= b ? [a, b] : [b, a];
}

/* genreBySection: Map<sectionKey, Array<{ title, items }>> - the same per-section genre
   listing used by the genre rows. */
export function buildGenreMatchHubs(query, limit, { genreBySection }) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const merged = new Map();
  /* genreBySection is undefined until loadBackgroundData finishes (search is wired up
     and usable well before that resolves) - treating it as empty here lets title/actor/
     year/facet matches still come back correctly instead of the whole search throwing
     and showing "Search failed". */
  for (const entries of (genreBySection || new Map()).values()) {
    for (const g of entries) {
      if (!g.title.toLowerCase().includes(q)) continue;
      const norm = g.title.trim().toLowerCase();
      if (!merged.has(norm)) merged.set(norm, { title: g.title, items: [] });
      merged.get(norm).items.push(...g.items);
    }
  }
  return Array.from(merged.values())
    .filter((g) => g.items.length)
    .map((g) => ({
      title: `Genre "${g.title}"`,
      Metadata: [...g.items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, limit),
      hasMore: g.items.length > limit,
    }));
}

export function buildReasonMatchHubs(hubs, hubLimit) {
  const byReason = new Map();
  for (const hub of hubs) {
    /* Reason-matched rows are carved out of a hub /hubs/search already truncated to
       hubLimit - if that source hub was capped, some actor/director matches could be
       sitting past the cutoff, so treat every reason group sourced from it as
       possibly incomplete too (can't tell more precisely without a per-actor fetch). */
    const hubCapped = (hub.Metadata || []).length >= hubLimit;
    for (const m of hub.Metadata || []) {
      const label = SEARCH_REASON_LABELS[m.reason];
      if (!label || !m.reasonTitle) continue;
      const key = `${m.reason}:${m.reasonTitle}`;
      if (!byReason.has(key)) byReason.set(key, { label, name: m.reasonTitle, items: [], hasMore: false });
      const entry = byReason.get(key);
      entry.items.push(m);
      if (hubCapped) entry.hasMore = true;
    }
  }
  return Array.from(byReason.values()).map(({ label, name, items, hasMore }) => ({
    title: `${label} "${name}"`,
    Metadata: items,
    hasMore,
  }));
}
