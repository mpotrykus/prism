/* Row-building logic: turning raw Plex metadata (genre listings, watch history, AI-row
   ideas, collections) into the row shapes the UI renders. Kept free of DOM/network so
   it can be tested directly - callers (plex-netflix-card.js) supply the small set of
   collaborators each function needs (config lookups, mapItem, shuffle) explicitly
   rather than this module reaching into card state itself. */

export function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* plexImageUrl: (path) => absolute Plex image URL, full source resolution - used for
   `art` (hero/backdrop, meant to fill the screen). plexThumbUrl: (path) => same but
   resized via Plex's /photo/:/transcode - used for `image` (poster grid, always
   displayed small); defaults to plexImageUrl so existing callers/tests that don't pass
   it keep working unresized rather than throwing. episodeFallbackGenres: genre tags to
   use for an episode item, whose own Plex metadata carries no Genre of its own (that
   lives on the show) - see plex-netflix-card.js's _mapItem for why this matters to
   plex-player.js's shader auto-detection. */
export function mapItem(m, withProgress, { plexImageUrl, plexThumbUrl = plexImageUrl, episodeFallbackGenres = [] }) {
  const thumbPath = m.thumb || m.grandparentThumb || m.composite || m.art || "";
  const image = plexThumbUrl(thumbPath);
  const art = plexImageUrl(m.art || m.grandparentArt || thumbPath);
  const title = m.grandparentTitle || m.title || "Untitled";
  const subtitle = m.grandparentTitle ? m.title : m.year ? String(m.year) : "";
  /* A show/season has no viewOffset/viewCount of its own the way a movie or episode
     does - Plex's own "watched" checkmark for one means every episode has been seen
     (viewedLeafCount === leafCount). The container's viewCount field is really a rough
     tally of episode-view events, not a completion signal (e.g. 4 of a 7-episode
     season watched can still read viewCount: 4, which a bare "viewCount > 0" check
     would wrongly read as fully watched). */
  const isShowLike = m.type === "show" || m.type === "season";
  const item = {
    ratingKey: m.ratingKey,
    key: m.key,
    type: m.type,
    title,
    subtitle,
    image,
    art,
    year: m.year,
    showKey: m.grandparentRatingKey,
    seasonKey: m.parentRatingKey,
    seasonNumber: m.parentIndex,
    episodeNumber: m.index,
    viewCount: m.viewCount || 0,
    watched: isShowLike ? m.leafCount > 0 && m.viewedLeafCount === m.leafCount : (m.viewCount || 0) > 0,
    hasHistory: isShowLike ? (m.viewedLeafCount || 0) > 0 : (m.viewCount || 0) > 0,
    genres: m.Genre?.length ? m.Genre.map((g) => (g.tag || "").trim()).filter(Boolean) : m.type === "episode" ? episodeFallbackGenres || [] : [],
  };
  if (withProgress && m.duration) {
    item.progress = Math.max(0, Math.min(1, (m.viewOffset || 0) / m.duration));
  }
  return item;
}

export function mergeGenreRows(sections, { genreBySection, mapItem: mapItemFn, shuffle: shuffleFn, rowSize }) {
  const merged = new Map();
  for (const s of sections) {
    const entries = (genreBySection && genreBySection.get(s.key)) || [];
    for (const g of entries) {
      const norm = g.title.trim().toLowerCase();
      if (!merged.has(norm)) merged.set(norm, { title: g.title, items: [], totalSize: 0 });
      const bucket = merged.get(norm);
      bucket.items.push(...g.items);
      bucket.totalSize += g.totalSize;
    }
  }

  const eligible = Array.from(merged.values())
    .map((g) => {
      const items = [...g.items].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, rowSize);
      return {
        title: g.title,
        source: "local",
        totalSize: g.totalSize,
        items: items.map((m) => mapItemFn(m, false)),
      };
    })
    .filter((r) => r.totalSize >= 5 && r.items.length);

  return shuffleFn(eligible);
}

/* Genre-affinity recommender: scores every unwatched library item by how much its
   genres overlap with genres pulled from watch history, weighted so more-recently-
   watched items count for more. Pure local-PMS data (history + genre listings already
   fetched elsewhere) - no Plex cloud/Discover dependency, unlike the watchlist fetch. */
export function buildRecommendedRaw(historyRaw, { genreBySection, onDeckRaw }) {
  const pool = new Map();
  for (const entries of genreBySection.values()) {
    for (const g of entries) {
      for (const m of g.items) {
        if (m.ratingKey && !pool.has(m.ratingKey)) pool.set(m.ratingKey, m);
      }
    }
  }

  const excluded = new Set((onDeckRaw || []).map((m) => m.grandparentRatingKey || m.ratingKey));
  const genreScore = new Map();
  historyRaw.forEach((h, i) => {
    const key = h.grandparentRatingKey || h.ratingKey;
    if (!key) return;
    excluded.add(key);
    const item = pool.get(key);
    if (!item || !Array.isArray(item.Genre)) return;
    const weight = historyRaw.length - i;
    for (const g of item.Genre) {
      const norm = (g.tag || "").trim().toLowerCase();
      if (!norm) continue;
      genreScore.set(norm, (genreScore.get(norm) || 0) + weight);
    }
  });
  if (!genreScore.size) return [];

  const scored = [];
  for (const [key, item] of pool.entries()) {
    if (excluded.has(key) || !Array.isArray(item.Genre)) continue;
    let score = 0;
    for (const g of item.Genre) {
      score += genreScore.get((g.tag || "").trim().toLowerCase()) || 0;
    }
    if (score > 0) scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score || (b.item.addedAt || 0) - (a.item.addedAt || 0));
  return scored.map((s) => s.item);
}

/* "What's Popular" row: blended recency + audience-rating score computed entirely from
   local Plex metadata (year + audienceRating, sourced from Rotten Tomatoes per the PMS
   agent) - no external API calls. Year is normalized against the library's own min/max
   release year, so "recent" is relative to what's actually in the library, not calendar
   time; weighted 50/50 with rating, adjust freely. */
export function buildPopularRaw({ genreBySection }) {
  const pool = new Map();
  for (const entries of genreBySection.values()) {
    for (const g of entries) {
      for (const m of g.items) {
        if (m.ratingKey && !pool.has(m.ratingKey)) pool.set(m.ratingKey, m);
      }
    }
  }
  const eligible = Array.from(pool.values()).filter((m) => typeof m.year === "number" && typeof m.audienceRating === "number");
  if (!eligible.length) return [];
  const years = eligible.map((m) => m.year);
  const minYear = Math.min(...years);
  const yearRange = Math.max(...years) - minYear || 1;
  const scored = eligible.map((m) => {
    const recencyScore = (m.year - minYear) / yearRange;
    const ratingScore = m.audienceRating / 10;
    return { item: m, score: recencyScore * 0.5 + ratingScore * 0.5 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/* Collection rows: title = a real Plex Collection's name, items = its actual movies -
   picked randomly per real page load (see the card's _collectionRowPicks). No
   totalSize>=5 floor here (unlike mergeGenreRows) - collections are hand-curated and
   small ones (e.g. a 2-film franchise) are still worth showing as-is. typeFilter is the
   view's movie-vs-show predicate, resolved by the caller. */
export function buildCollectionRows(collectionRowsRaw, typeFilter, { mapItem: mapItemFn, rowSize }) {
  return (collectionRowsRaw || [])
    .map((r) => {
      const items = r.items.filter(typeFilter).slice(0, rowSize);
      return { title: r.title, source: "collection", items: items.map((m) => mapItemFn(m, false)) };
    })
    .filter((r) => r.items.length > 0);
}

export function buildAiRows(aiRowsRaw, typeFilter, { mapItem: mapItemFn, rowSize }) {
  return (aiRowsRaw || [])
    .map((r) => {
      const items = r.items
        .filter(typeFilter)
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
        .slice(0, rowSize);
      return { title: r.label, source: "ai", items: items.map((m) => mapItemFn(m, false)) };
    })
    .filter((r) => r.items.length >= 5);
}

/* The model is asked for strict JSON but may still wrap it in a code fence or return
   junk, so this validates everything regardless of source. */
export function parseAiSectionIdeas(raw) {
  const MAX_IDEAS = 15;
  try {
    if (!raw) return [];
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (idea) =>
          idea &&
          typeof idea.label === "string" &&
          idea.label.trim() &&
          Array.isArray(idea.genres) &&
          idea.genres.length >= 1 &&
          idea.genres.length <= 2 &&
          idea.genres.every((g) => typeof g === "string" && g.trim())
      )
      .slice(0, MAX_IDEAS);
  } catch (e) {
    return [];
  }
}
