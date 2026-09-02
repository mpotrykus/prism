import { extractTmdbId, extractLegacyAgentId, resolveTmdbIdFromImdb, resolveTmdbTrailer } from "./tmdb.js";
import { getYoutubeAspectRatio, computeCoverScale } from "./youtube-oembed.js";
import { MEDIA_TYPE } from "../../constants.js";

/* Trailer resolution shared by the home hero (hero.js) and the title-info modal
   (title-info.js): a Plex "extras" trailer first, falling back to a TMDB-discovered
   YouTube trailer when there's no Plex-hosted trailer and the caller has opted into that
   fallback (youtubeEnabled). Extracted here once title-info.js needed the exact same
   two-step lookup rather than duplicating it - each caller still owns its own resolve
   cap/count and item-eligibility gating (e.g. hero's per-page-load quota cap, title-info's
   title_trailers_enabled toggle). See tmdb.js for why TMDB replaced a live YouTube Data
   API search here - no per-user API key requirement, no search quota. */
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
    // fall through to the TMDB fallback below
  }
  if (!youtubeEnabled) return null;
  const videoId = await resolveTmdbVideoId(item, plexFetch);
  if (!videoId) return null;
  /* enablejsapi=1 is required for the postMessage mute/unMute commands used by the mute
     button; embedding a specific known videoId is fully supported and doesn't hit
     YouTube's "Error 153". */
  const aspectRatio = await getYoutubeAspectRatio(videoId);
  return {
    type: "youtube",
    embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&enablejsapi=1`,
    /* Corrective zoom for a non-16:9 upload - see youtube-oembed.js. 1 (a no-op) for the
       overwhelming majority of trailers, which already are ~16:9. */
    coverScale: computeCoverScale(aspectRatio),
  };
}

const TMDB_KIND_BY_ITEM_TYPE = { movie: "movie", show: "tv" };

/* An episode has no trailer of its own on TMDB - it borrows its show's, the same way the
   old YouTube-search fallback borrowed grandparentTitle for its query. Anything else
   (season/collection/playlist) has no well-defined TMDB counterpart here, so this just
   returns null rather than guessing. */
async function resolveTmdbVideoId(item, plexFetch) {
  let kind = TMDB_KIND_BY_ITEM_TYPE[item.type];
  let ratingKey = item.ratingKey;
  if (item.type === MEDIA_TYPE.EPISODE) {
    kind = "tv";
    ratingKey = item.showKey || item.ratingKey;
  }
  if (!kind || !ratingKey) return null;
  try {
    /* A bare /library/metadata/{ratingKey} fetch (no /extras suffix) is what actually
       returns the Guid array - see tmdb.js's extractTmdbId for why list/hub responses
       can't be trusted to carry it. */
    const data = await plexFetch(`/library/metadata/${ratingKey}`);
    const meta = data?.MediaContainer?.Metadata?.[0];
    const tmdbId = await resolveTmdbIdForMeta(meta, kind);
    if (!tmdbId) return null;
    const trailer = await resolveTmdbTrailer(tmdbId, kind);
    return trailer?.youtubeId || null;
  } catch (e) {
    return null;
  }
}

/* A new-agent library's Guid array gives a tmdb id directly. A library still scanned with
   one of Plex's older per-source agents (com.plexapp.agents.themoviedb/imdb) has no Guid
   array at all - confirmed against a real library still on the legacy IMDb agent, not just
   a hypothetical - so this falls back to parsing the item's own opaque `guid` string
   instead. A legacy TMDB guid gives the id directly; a legacy IMDb guid needs one extra
   TMDB lookup (resolveTmdbIdFromImdb) to translate it. */
async function resolveTmdbIdForMeta(meta, kind) {
  const direct = extractTmdbId(meta?.Guid);
  if (direct) return direct;
  const legacy = extractLegacyAgentId(meta?.guid);
  if (!legacy) return null;
  if (legacy.source === "tmdb") return legacy.id;
  return resolveTmdbIdFromImdb(legacy.id, kind);
}
