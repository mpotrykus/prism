/* Picks which subtitle backend to use, per Settings' Subtitle Provider dropdown - the
   default (plex-subtitles.js, proxied through the user's own PMS, no credentials needed)
   or the opt-in direct alternative (opensubtitles.js, talks to OpenSubtitles.com itself,
   needs the user's own API key, but puts zero extra load on PMS). chrome.js/
   native-bridge.js both call through here instead of importing either module directly,
   so neither has to branch on the setting itself.

   Both search() and download() are cached (subtitle-store.js, keyed by the title's own
   ratingKey) so reopening the search panel, or replaying a title whose subtitle was
   already fetched, never repeats a search/download that already happened - this is
   what actually eliminates the extra PMS load, more than the polling backoff in
   plex-subtitles.js alone did.

   Each search() result is tagged with which provider produced it, rather than having
   download() re-read the setting - a result travels through the Android bridge as a
   JSON-stringified blob (see native-bridge.js) and back, so re-checking a possibly
   since-changed setting at download time could disagree with what actually produced
   this particular result. */
import * as PlexSubtitles from "../../../plex-subtitles.js";
import * as OpenSubtitles from "../../../opensubtitles.js";
import { loadFull } from "../../../settings.js";
import * as subtitleStore from "./subtitle-store.js";

export async function search(session, { title, languageCode = "en" } = {}) {
  const config = await loadFull();
  const provider = config.subtitle_provider === "opensubtitles" ? "opensubtitles" : "plex";

  const cached = subtitleStore.getCachedSearch(session?.ratingKey, provider, title, languageCode);
  if (cached) return cached;

  let results;
  if (provider === "opensubtitles") {
    const raw = await OpenSubtitles.search({
      title,
      languageCode,
      year: session?.year,
      seasonNumber: session?.seasonNumber,
      episodeNumber: session?.episodeNumber,
    });
    results = raw.map((r) => ({ ...r, provider: "opensubtitles" }));
  } else {
    const raw = await PlexSubtitles.search(session, { title, languageCode });
    results = raw.map((r) => ({ ...r, provider: "plex" }));
  }
  subtitleStore.setCachedSearch(session?.ratingKey, provider, title, languageCode, results);
  return results;
}

export async function download(session, result) {
  const cached = subtitleStore.getCachedDownload(session?.ratingKey, result);
  if (cached) return cached;

  const downloaded =
    result.provider === "opensubtitles"
      ? { text: await OpenSubtitles.download(result.fileId), languageCode: result.languageCode, codec: "srt" }
      : await PlexSubtitles.download(session, result);
  subtitleStore.setCachedDownload(session?.ratingKey, result, downloaded);
  return downloaded;
}
