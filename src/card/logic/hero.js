/* Pure calculation helpers for the hero banner. The stateful half (autoplay
   advance/crossfade, trailer resolution, DOM wiring) stays on the card for now - it's
   entangled with timers and directly-wired DOM listeners (mute/play buttons,
   IntersectionObserver, window focus/visibility) in a way that isn't worth forcing into
   a stateless shape until the shell itself is untangled (see the modularization plan's
   Phase 8). Only the parts with clear inputs/outputs move here. */

function pickRandom(pool, excludeKey) {
  if (excludeKey && pool.length > 1) pool = pool.filter((m) => m.ratingKey !== excludeKey);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* genreBySection may not be populated yet - it's fetched in the background, after first
   paint (see data.js's loadBackgroundData), so advance() can in principle fire (trailer
   ended, or the static-backdrop dwell timer) before it lands. Treat that as "no
   candidates yet" rather than throwing. */
export function pickHeroItem(excludeKey, sections, { genreBySection }) {
  const keys = sections ? new Set(sections.map((s) => s.key)) : null;
  const seen = new Map();
  for (const [sectionKey, entries] of (genreBySection || new Map()).entries()) {
    if (keys && !keys.has(sectionKey)) continue;
    for (const g of entries) {
      for (const m of g.items) {
        if (m.ratingKey && !seen.has(m.ratingKey)) seen.set(m.ratingKey, m);
      }
    }
  }
  return pickRandom(Array.from(seen.values()), excludeKey);
}

/* Cheap alternative to pickHeroItem for the very first hero pick - draws from
   already-fetched, no-fan-out data (on deck/watchlist/recently added) instead of the full
   per-genre fan-out (N sections x M genres), so the hero no longer has to wait on that
   before first paint. Narrower pool than pickHeroItem's "anything in the library", but
   avoids gating first render on the fan-out just to pick one item. */
export function pickHeroItemFromPool(excludeKey, pool) {
  const seen = new Map();
  for (const m of pool) {
    if (m.ratingKey && !seen.has(m.ratingKey)) seen.set(m.ratingKey, m);
  }
  return pickRandom(Array.from(seen.values()), excludeKey);
}

export function formatDuration(ms) {
  if (!ms) return "";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function heroArtUrl(item, plexImageUrl) {
  return plexImageUrl(item.art || item.grandparentArt || "");
}

export function heroSubtitleText(item) {
  const parts = [];
  if (item.year) parts.push(item.year);
  if (item.contentRating) parts.push(item.contentRating);
  if (item.Genre && item.Genre.length) parts.push(item.Genre.slice(0, 3).map((g) => g.tag).join(", "));
  const runtime = formatDuration(item.duration);
  if (runtime) parts.push(runtime);
  return parts.join("   •   ");
}

export function heroShouldPlay({ heroUserPaused, heroInView, heroPageVisible, heroWindowFocused }) {
  return !heroUserPaused && heroInView && heroPageVisible && heroWindowFocused;
}
