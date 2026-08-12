/* Builds the Plex universal-transcode HLS start URL. clientIdentifier and platform are
   passed in already-resolved rather than read from localStorage/Capacitor here, so this
   stays a pure function of its inputs. */
export function buildStreamUrl({
  plexUrl,
  plexToken,
  key,
  sessionId,
  startOffsetMs,
  mediaIndex = 0,
  partIndex = 0,
  qualityCapKbps = null,
  audioStreamID = null,
  clientIdentifier,
  platform,
}) {
  const url = new URL(`${plexUrl}/video/:/transcode/universal/start.m3u8`);
  url.searchParams.set("path", key);
  url.searchParams.set("mediaIndex", String(mediaIndex));
  url.searchParams.set("partIndex", String(partIndex));
  url.searchParams.set("protocol", "hls");
  url.searchParams.set("fastSeek", "1");
  /* directPlay=0 is deliberate, not a missed optimization: this same URL always
     requests an .m3u8 HLS playlist, and asking Plex for a literal direct-play
     response (the raw file, no container/playlist at all) from an .m3u8-suffixed
     endpoint is self-contradictory - empirically, it produces a player that opens
     but never gets anything to actually play. directStream=1 still lets Plex skip
     video re-encoding when the codec is HLS-compatible, remuxing into HLS segments
     without a full transcode - true zero-cost direct play would need a separate
     /video/:/transcode/universal/decision call and a fork to the raw
     /library/parts/... URL, not implemented here yet. */
  url.searchParams.set("directPlay", "0");
  url.searchParams.set("directStream", "1");
  url.searchParams.set("subtitleSize", "100");
  /* Prism never wants Plex's own transcode session touching subtitles - they're
     fetched (plex-subtitles.js) and rendered entirely client-side (chrome.js's
     attachSubtitleTrack, native-bridge.js's setNativeSubtitle) as a sidecar track.
     Without this, Plex defaults to whatever subtitle stream is currently "selected"
     on the Part (an embedded default track, or the one plex-subtitles.js's download()
     just added) and - since this client's transcode request never advertises soft/
     sidecar subtitle support - burns it into the video instead of leaving it out. */
  url.searchParams.set("subtitleStreamID", "0");
  url.searchParams.set("audioBoost", "100");
  /* maxVideoBitrate is the best-known candidate for this Plex endpoint's bitrate-cap
     param but unconfirmed against a real request from this codebase - verify via
     Plex Web's own network tab before relying on this for anything user-facing. */
  if (qualityCapKbps) url.searchParams.set("maxVideoBitrate", String(qualityCapKbps));
  /* audioStreamID is the same "best-known param name for this endpoint, unverified
     against a live request" situation as maxVideoBitrate above - only ever sent when
     the user actively switches tracks, never on first load, so an initial play() is
     unaffected if this assumption turns out to be wrong. */
  if (audioStreamID != null) url.searchParams.set("audioStreamID", String(audioStreamID));
  url.searchParams.set("offset", String(Math.floor(startOffsetMs / 1000)));
  url.searchParams.set("session", sessionId);
  url.searchParams.set("X-Plex-Client-Identifier", clientIdentifier);
  url.searchParams.set("X-Plex-Product", "Prism");
  url.searchParams.set("X-Plex-Version", "1.0");
  url.searchParams.set("X-Plex-Platform", platform);
  url.searchParams.set("X-Plex-Token", plexToken);
  return url.toString();
}
