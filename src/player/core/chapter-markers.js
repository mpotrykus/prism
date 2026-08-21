/* Falls back to Plex Chapter data for the intro/credits skip button (chrome-skip.js)
   when meta.Marker is empty - Plex's own intro/credits detection is Plex Pass-gated,
   but its chapter generation lands on the same cut points regardless, sometimes with
   the boundary's real name embedded as the chapter's tag (anime-style rips) and
   sometimes with no tag at all (see below).

   Verified against real server data (2026-08-21), not assumed:
   - Samurai Champloo (Plex ratingKey 21381): chapters carry literal tags like
     "5 Opening"/"8 Ending". A tiny (~1s) leftover "Ending" sliver often sits at
     start=0 of the NEXT episode's chapter list (a carry-over artifact from a
     multi-episode source file) - MIN_TAGGED_CHAPTER_MS filters that out.
   - House (Plex ratingKey 4620): chapters have no tag at all. The last chapter is a
     reliable credits region (36-66s, always within the last few minutes) across
     every sampled episode. The FIRST chapter is NOT a reliable intro region -
     it's the pre-title-card teaser, and its duration (100-304s across 5 episodes)
     overlaps real intro lengths too much to distinguish, so there is deliberately
     no untagged "first chapter = intro" fallback here - only tagged chapters ever
     produce a derived intro marker. */

const TAG_INTRO_RE = /\b(opening|intro)\b/i;
const TAG_CREDITS_RE = /\b(ending|credits?|outro)\b/i;
const MIN_TAGGED_CHAPTER_MS = 5000;
const MAX_UNTAGGED_CREDITS_CHAPTER_MS = 90 * 1000;
const MAX_UNTAGGED_CREDITS_LOOKBACK_MS = 5 * 60 * 1000;

export function deriveChapterMarkers(chapters, durationMs, itemType) {
    if (itemType !== "episode" || !durationMs || !(chapters || []).length) return [];

    const normalized = chapters
        .map((c) => ({
            tag: (c.tag || c.title || "").trim(),
            start: c.startTimeOffset ?? 0,
            end: c.endTimeOffset ?? 0,
        }))
        .filter((c) => c.end > c.start);
    if (!normalized.length) return [];

    const derived = [];

    const intro = normalized.find((c) => TAG_INTRO_RE.test(c.tag) && c.end - c.start >= MIN_TAGGED_CHAPTER_MS);
    if (intro) derived.push({ type: "intro", startTimeOffset: intro.start, endTimeOffset: intro.end });

    const taggedCredits = normalized
        .filter((c) => TAG_CREDITS_RE.test(c.tag) && c.end - c.start >= MIN_TAGGED_CHAPTER_MS)
        .pop();
    if (taggedCredits) {
        derived.push({ type: "credits", startTimeOffset: taggedCredits.start, endTimeOffset: taggedCredits.end });
    } else {
        const last = normalized[normalized.length - 1];
        const lastDurationMs = last.end - last.start;
        if (lastDurationMs <= MAX_UNTAGGED_CREDITS_CHAPTER_MS && durationMs - last.start <= MAX_UNTAGGED_CREDITS_LOOKBACK_MS) {
            derived.push({ type: "credits", startTimeOffset: last.start, endTimeOffset: last.end });
        }
    }

    return derived;
}
