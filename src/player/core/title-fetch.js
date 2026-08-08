import { extractAudioStreams, extractMediaVersions, bifIndexPath } from "../../card/title-info.js";

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
        mediaVersions: extractMediaVersions(meta.Media),
        audioStreams: extractAudioStreams(meta.Media, 0),
        bifIndexPath: bifIndexPath(meta.Media, 0),
        title: meta.grandparentTitle || meta.title || "",
        /* Only set for a genuine episode (grandparentTitle present) - same convention
           plex-netflix-card.js's _playItem uses (episodeTitle: item.seasonNumber != null
           ? item.subtitle : null), since meta.title IS already the whole title for a
           movie, not a second "episode name" on top of it. Without this, chrome.js's
           transport-bar subtitle (see buildTransportBar's subtitleParts) would silently
           drop the episode's own name and show just "S# E#" for any title reached via
           the title-nav prev/next buttons, unlike a title opened normally from the info
           modal. */
        episodeTitle: meta.grandparentTitle ? meta.title : null,
        year: meta.year || null,
        seasonNumber: meta.parentIndex ?? null,
        episodeNumber: meta.index ?? null,
        genres: (meta.Genre || []).map((g) => (g.tag || "").trim()).filter(Boolean),
    };
}

/* Fetches display metadata (thumb/title/progress/watched) for every ratingKey in a
   session's queue - used by the in-player episode/queue list overlay (chrome.js's
   openEpisodeListOverlay) to render cards for the whole queue at once, unlike
   fetchQueuedTitle above which resolves one adjacent title for an immediate title-nav
   jump. Same per-item fetch idiom as title-info.js's _fetchShowEpisodeQueue
   (Promise.all, no manual chunking - the browser's own per-origin connection cap
   already throttles very long queues). A missing/failed item maps to null and is
   filtered out rather than breaking the whole list. */
export async function fetchQueueItemsMetadata(plexUrl, plexToken, ratingKeys) {
    const results = await Promise.all(
        ratingKeys.map(async (ratingKey) => {
            try {
                const url = new URL(`${plexUrl}/library/metadata/${ratingKey}`);
                url.searchParams.set("X-Plex-Token", plexToken);
                const res = await fetch(url, { headers: { Accept: "application/json" } });
                if (!res.ok) return null;
                const data = await res.json();
                const meta = data?.MediaContainer?.Metadata?.[0];
                return meta ? mapQueueItemMetadata(meta) : null;
            } catch (e) {
                return null;
            }
        })
    );
    return results.filter(Boolean);
}

/* Same progress/watched calculation as title-info.js's episode row rendering
   (showSeason) - a fully-watched item has viewCount set and no in-progress offset. */
function mapQueueItemMetadata(meta) {
    const durationMs = meta.duration || 0;
    const progress = durationMs ? Math.max(0, Math.min(1, (meta.viewOffset || 0) / durationMs)) : 0;
    return {
        ratingKey: meta.ratingKey,
        title: meta.title || "",
        index: meta.index ?? null,
        seasonNumber: meta.parentIndex ?? null,
        thumb: meta.thumb || meta.grandparentThumb || null,
        summary: meta.summary || "",
        progress,
        watched: !!meta.viewCount && progress <= 0,
        contentRating: meta.contentRating || null,
        durationMs,
        releaseDate: meta.originallyAvailableAt || null,
    };
}
