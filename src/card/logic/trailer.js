/* Trailer resolution shared by the home hero (hero.js) and the title-info modal
   (title-info.js): a Plex "extras" trailer first, falling back to a YouTube search when
   there's no Plex-hosted trailer and the caller has opted into the YouTube fallback
   (youtubeEnabled) with an API key configured. Extracted here once title-info.js needed
   the exact same two-step lookup rather than duplicating it - each caller still owns its
   own resolve cap/count and item-eligibility gating (e.g. hero's per-page-load quota
   cap, title-info's title_trailers_enabled toggle). */
export async function resolveTrailerVideo(item, { plexFetch, config, youtubeEnabled }) {
  try {
    const data = await plexFetch(`/library/metadata/${item.ratingKey}/extras`);
    const extras = data?.MediaContainer?.Metadata || [];
    const trailer = extras.find((e) => e.subtype === "trailer");
    const part = trailer?.Media?.[0]?.Part?.[0];
    if (part?.key) {
      /* item.__server (raw hero pool items) / item.server (mapped title-info items) is
         the server this item's own fetch was tagged with - falls back to the single
         global config for the rare case an item somehow has none. */
      const s = item.__server || item.server || { url: config.plex_url, token: config.plex_token };
      return { type: "plex", url: `${s.url}${part.key}?X-Plex-Token=${s.token}` };
    }
  } catch (e) {
    // fall through to the youtube fallback below
  }
  if (!youtubeEnabled || !config.youtube_api_key) return null;
  const title = item.title || item.grandparentTitle || "";
  const query = `${title} ${item.year || ""} trailer`.trim();
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "5");
    url.searchParams.set("q", query);
    url.searchParams.set("key", config.youtube_api_key);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const videoIds = (data?.items || []).map((it) => it?.id?.videoId).filter(Boolean);
    if (!videoIds.length) return null;
    const videoId = await pickEmbeddableVideo(videoIds, config.youtube_api_key);
    if (!videoId) return null;
    /* enablejsapi=1 is required for the postMessage mute/unMute commands used by the
       mute button; embedding a specific known videoId (vs. the old listType=search
       trick) is fully supported and doesn't hit YouTube's "Error 153". */
    return {
      type: "youtube",
      embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&enablejsapi=1`,
    };
  } catch (e) {
    return null;
  }
}

/* Age-restricted videos refuse to actually play in an embedded iframe - YouTube shows a
   "Sign in to confirm your age" wall instead, and the embed just sits there dead with no
   error event either caller listens for. Filter those (and embedding-disabled videos)
   out via videos.list's status/contentDetails before picking one, rather than
   discovering it after the trailer is already stuck. */
async function pickEmbeddableVideo(videoIds, apiKey) {
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "status,contentDetails");
    url.searchParams.set("id", videoIds.join(","));
    url.searchParams.set("key", apiKey);
    const res = await fetch(url);
    if (!res.ok) return videoIds[0];
    const data = await res.json();
    const byId = new Map((data?.items || []).map((it) => [it.id, it]));
    for (const id of videoIds) {
      const info = byId.get(id);
      if (!info) continue;
      if (info.status?.embeddable === false) continue;
      if (info.contentDetails?.contentRating?.ytRating === "ytAgeRestricted") continue;
      return id;
    }
    return null;
  } catch (e) {
    return videoIds[0];
  }
}
