import { extractAudioStreams, bifIndexPath } from "../../card/title-info.js";

/* Fetches full metadata for an adjacent queued title (a title-prev/title-next jump - see
   chrome.js's seekToAdjacentTitle) so the player can hand it straight to
   controller._switchTitle. The queue itself (plex-player.js's queueRatingKeys) only ever
   carries bare ratingKeys - building it happens well before any given title in it is
   actually navigated to - so this is the same "resolve a ratingKey to a playable item"
   fetch title-info.js's _playEpisodeByRatingKey already does, just reachable from inside
   an active player session instead of from the card. Same token-as-query-param
   requirement as every other Plex request in this app (see this repo's CLAUDE.md). */
export async function fetchQueuedTitle(plexUrl, plexToken, ratingKey) {
    const url = new URL(`${plexUrl}/library/metadata/${ratingKey}`);
    url.searchParams.set("includeChapters", "1");
    url.searchParams.set("X-Plex-Token", plexToken);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Plex metadata fetch -> HTTP ${res.status}`);
    const data = await res.json();
    const meta = data?.MediaContainer?.Metadata?.[0];
    if (!meta) return null;
    return {
        ratingKey: meta.ratingKey,
        key: meta.key,
        type: meta.type,
        durationMs: meta.duration || 0,
        markers: meta.Marker || [],
        chapters: meta.Chapter || [],
        audioStreams: extractAudioStreams(meta.Media, 0),
        bifIndexPath: bifIndexPath(meta.Media, 0),
        title: meta.grandparentTitle || meta.title || "",
        year: meta.year || null,
        seasonNumber: meta.parentIndex ?? null,
        episodeNumber: meta.index ?? null,
        genres: (meta.Genre || []).map((g) => (g.tag || "").trim()).filter(Boolean),
    };
}
