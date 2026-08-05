/* Pure calculation helpers for the hero banner. The stateful half (autoplay
   advance/crossfade, trailer resolution, DOM wiring) stays on the card for now - it's
   entangled with timers and directly-wired DOM listeners (mute/play buttons,
   IntersectionObserver, window focus/visibility) in a way that isn't worth forcing into
   a stateless shape until the shell itself is untangled (see the modularization plan's
   Phase 8). Only the parts with clear inputs/outputs move here. */

export function pickHeroItem(excludeKey, sections, { genreBySection, isBlockedGenreName, passesKidsMode }) {
  const keys = sections ? new Set(sections.map((s) => s.key)) : null;
  const seen = new Map();
  for (const [sectionKey, entries] of genreBySection.entries()) {
    if (keys && !keys.has(sectionKey)) continue;
    for (const g of entries) {
      if (isBlockedGenreName(g.title)) continue;
      for (const m of g.items) {
        if (m.ratingKey && !seen.has(m.ratingKey) && passesKidsMode(m)) seen.set(m.ratingKey, m);
      }
    }
  }
  let pool = Array.from(seen.values());
  if (excludeKey && pool.length > 1) pool = pool.filter((m) => m.ratingKey !== excludeKey);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
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
