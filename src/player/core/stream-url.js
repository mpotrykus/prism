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
  if (audioStreamID != null) url.searchParams.set("audioStreamID", String(audioStreamID));
  url.searchParams.set("offset", String(Math.floor(startOffsetMs / 1000)));
  url.searchParams.set("session", sessionId);
  url.searchParams.set("X-Plex-Client-Identifier", clientIdentifier);
  url.searchParams.set("X-Plex-Product", "Prism");
  url.searchParams.set("X-Plex-Version", "1.0");
  url.searchParams.set("X-Plex-Platform", platform);
  /* This was the actual, whole reason audio-track switching silently never worked -
     confirmed by reading Plex Media Server's own logs on the real box (raspi-server):
     without this param, its Media Decision Engine falls back to some broken default
     that ignores audioStreamID AND the Part's own "selected" Stream flag entirely - it
     built the literal same ffmpeg command (mapping the same hardcoded source stream,
     force-downmixed to mono) no matter which track was requested, despite correctly
     parsing and logging the requested id first. Adding this - the capabilities
     declaration every real Plex client sends and Prism never did - made the same MDE
     log line resolve to the actually-requested stream instead. Every symptom chased
     before finding this (checkmark not updating, stale transcode sessions, the video
     element needing a hard reset) was chasing effects of this one missing param, not
     separate bugs. */
  url.searchParams.set(
    "X-Plex-Client-Capabilities",
    "protocols=http-live-streaming,http-mp4-streaming,http-mp4-video,http-mp4-video-720p,http-mp4-video-1080p&videoDecoders=h264{profile:high&resolution:1080&level:51}&audioDecoders=mp3,aac,ac3,eac3,dts"
  );
  url.searchParams.set("X-Plex-Token", plexToken);
  return url.toString();
}
