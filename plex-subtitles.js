/* plex-subtitles.js

   Subtitle search/download proxied entirely through the user's own Plex Media Server,
   the same approach Plezy (github.com/edde746/plezy) uses - GET/PUT
   /library/metadata/<ratingKey>/subtitles. PMS's own subtitle agent (OpenSubtitles.com,
   configured server-side under PMS's Agent settings) does the actual third-party API
   work and holds the actual credentials; this app never sees an OpenSubtitles API
   key/username/password at all, replacing the old opensubtitles.js's direct
   api.opensubtitles.com calls.

   The PUT download is asynchronous - it returns as soon as PMS has queued the job, and
   the new subtitle stream shows up in the item's own metadata a few seconds later.
   download() below polls for it (backing off from 2s up to 6s, 20s deadline) rather
   than trusting a fixed delay - PMS itself does the actual provider fetch + library
   write + re-analyze, so this only minimizes the extra polling load we add on top. */
import { plexAssetUrl } from "./src/player/core/plex-asset-url.js";

function subtitlesUrl(session, params) {
    const url = new URL(`${session.plexUrl}/library/metadata/${session.ratingKey}/subtitles`);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
    url.searchParams.set("X-Plex-Token", session.plexToken);
    return url;
}

export async function search(session, { title, languageCode = "en" } = {}) {
    const res = await fetch(subtitlesUrl(session, { language: languageCode, title }), {
        headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Subtitle search failed: HTTP ${res.status}`);
    const data = await res.json();
    const streams = data?.MediaContainer?.Stream || [];
    return streams
        .map((s) => ({
            key: s.key,
            codec: s.codec || "srt",
            languageCode: s.languageCode || s.language || languageCode,
            /* `title` is the actual per-result release/file name (e.g.
               "Movie.2020.1080p-GROUP") - `displayTitle` is just a generic per-language
               string ("English") repeated across every result for that language, so it
               has to lose this priority order or every row collapses to the same label. */
            label: s.title || s.providerTitle || s.displayTitle || s.language || languageCode,
            providerTitle: s.providerTitle || "",
            hearingImpaired: !!s.hearingImpaired,
            forced: !!s.forced,
        }))
        .filter((r) => r.key);
}

/* Diffed on Plex's own numeric Stream `id` (the same field extractAudioStreams/
   selectStreams elsewhere in this app already treat as the reliable per-stream
   identifier), NOT `key` - an embedded subtitle stream has no `key` at all, so with
   multiple embedded streams already on the item every one of them collapses to the same
   `undefined` "key", permanently hiding the real new stream and timing out every poll
   regardless of whether Plex actually finished the download. */
async function fetchSubtitleStreams(session) {
    const url = new URL(`${session.plexUrl}/library/metadata/${session.ratingKey}`);
    url.searchParams.set("X-Plex-Token", session.plexToken);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Plex metadata fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    const meta = data?.MediaContainer?.Metadata?.[0];
    const streams = (meta?.Media || []).flatMap((m) => m.Part || []).flatMap((p) => p.Stream || []);
    return streams.filter((s) => s.streamType === 3);
}

/* Backs off (2s, 3s, 4.5s, 6s, 6s, ...) instead of a flat 2s interval - PMS is already
   doing the expensive part of this request (fetching from the subtitle provider,
   writing the new stream into the library, re-analyzing the part to register it), so
   this only controls how many *extra* full-item-metadata GETs we pile on top of that
   while it's in flight. Fixed 2s/15s was ~7 polls; this covers a longer window in ~5. */
const POLL_INTERVAL_START_MS = 2000;
const POLL_INTERVAL_MAX_MS = 6000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_TIMEOUT_MS = 20000;

/* Requests the download, then polls metadata for the newly-added stream. Returns the
   raw subtitle text (fetched from the new stream's own asset URL) so existing callers
   (chrome.js's attachSubtitleTrack, native-bridge.js's setNativeSubtitle) keep consuming
   a result the same way they did from the old opensubtitles.js's download(). */
export async function download(session, result) {
    const before = new Set((await fetchSubtitleStreams(session)).map((s) => s.id));

    const putRes = await fetch(
        subtitlesUrl(session, {
            key: result.key,
            codec: result.codec || "srt",
            language: result.languageCode,
            hearingImpaired: result.hearingImpaired ? "1" : "0",
            forced: result.forced ? "1" : "0",
            providerTitle: result.providerTitle || "",
        }),
        { method: "PUT" }
    );
    if (!putRes.ok) throw new Error(`Subtitle download failed: HTTP ${putRes.status}`);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let interval = POLL_INTERVAL_START_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        interval = Math.min(interval * POLL_BACKOFF_FACTOR, POLL_INTERVAL_MAX_MS);
        let streams;
        try {
            streams = await fetchSubtitleStreams(session);
        } catch (e) {
            continue;
        }
        const newStream = streams.find((s) => !before.has(s.id));
        if (!newStream) continue;
        const fileRes = await fetch(plexAssetUrl(session, newStream.key));
        if (!fileRes.ok) throw new Error(`Failed fetching subtitle file: HTTP ${fileRes.status}`);
        return {
            text: await fileRes.text(),
            languageCode: newStream.languageCode || result.languageCode,
            codec: newStream.codec || result.codec,
        };
    }
    throw new Error("Timed out waiting for Plex to finish downloading the subtitle.");
}
