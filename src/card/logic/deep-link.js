/* Plex Android deep links (plex://libraries/<machine_id>/...) - solved for movie/show/
   episode/collection/playlist. No "play now" intent exists on Android, the ceiling is
   landing on the item's details page. These links are Android-app-specific - gate on a
   UA check and fall back to a plain web link otherwise. */

import { MEDIA_TYPE } from "../../../constants.js";

export function slugify(text) {
  return (
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

export function isAndroidUserAgent(userAgent) {
  return /Android/i.test(userAgent || "");
}

export function tapUrl(item, source, { machineId, plexUrl, userAgent }) {
  const isAndroid = isAndroidUserAgent(userAgent);
  if (source === "watchlist" && item.key) {
    return `https://app.plex.tv/desktop/#!/provider/tv.plex.provider.discover/details?key=${encodeURIComponent(item.key)}`;
  }
  if (item.type === MEDIA_TYPE.MOVIE && item.ratingKey && isAndroid) {
    return `plex://libraries/${machineId}/movie/${slugify(item.title)}/${item.ratingKey}`;
  }
  if (item.type === MEDIA_TYPE.SHOW && item.ratingKey && isAndroid) {
    return `plex://libraries/${machineId}/show/${slugify(item.title)}/${item.ratingKey}`;
  }
  if (
    item.type === MEDIA_TYPE.EPISODE &&
    item.ratingKey &&
    item.showKey &&
    item.seasonKey &&
    item.seasonNumber != null &&
    item.episodeNumber != null &&
    isAndroid
  ) {
    return `plex://libraries/${machineId}/show/${slugify(item.title)}/${item.showKey}/s/${item.seasonNumber}/${item.seasonKey}/e/${item.episodeNumber}/${item.ratingKey}`;
  }
  if (item.type === MEDIA_TYPE.COLLECTION && item.ratingKey && isAndroid) {
    return `plex://libraries/${machineId}/collection/${item.ratingKey}`;
  }
  if (item.type === MEDIA_TYPE.PLAYLIST && item.ratingKey && isAndroid) {
    return `plex://libraries/${machineId}/playlist/${item.ratingKey}`;
  }
  if (item.type === MEDIA_TYPE.COLLECTION && item.ratingKey) {
    return `${plexUrl}/web/index.html#!/server/${machineId}/details?key=${encodeURIComponent("/library/collections/" + item.ratingKey)}`;
  }
  if (item.type === MEDIA_TYPE.PLAYLIST && item.ratingKey) {
    return `${plexUrl}/web/index.html#!/server/${machineId}/playlist?key=${encodeURIComponent("/playlists/" + item.ratingKey)}`;
  }
  return `${plexUrl}/web/index.html#!/server/${machineId}/details?key=${encodeURIComponent("/library/metadata/" + item.ratingKey)}`;
}
