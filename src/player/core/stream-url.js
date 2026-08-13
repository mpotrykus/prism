/* Shared query-param builder behind buildStreamUrl and buildDecisionUrl below - both
   endpoints need the exact same params to get a consistent answer out of Plex's Media
   Decision Engine (confirmed empirically: a /decision call with a DIFFERENT param set
   than the /start call that follows it doesn't reliably predict what /start actually
   does), so there is deliberately one place these are built, not two copies drifting
   apart. clientIdentifier and platform are passed in already-resolved rather than read
   from localStorage/Capacitor here, so this stays a pure function of its inputs. */
function buildTranscodeUrl(endpoint, {
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
  const url = new URL(`${plexUrl}${endpoint}`);
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
  /* Without this, Plex bakes only the single audioStreamID below into the transcode at
     session start, so switching tracks means restarting the whole HLS session with a
     new one - the exact restart Plex's own transcode-session cache kept serving stale
     (see the stopOldSession gotcha in web-fallback.js's reloadWebSource and
     PlayerActivity.switchAudioStream). Plezy (github.com/edde746/plezy) sends this same
     flag unconditionally and never restarts a session for an audio switch at all - with
     it set, Plex remuxes (not re-encodes) EVERY embedded audio track into the running
     HLS session's segments as its own EXT-X-MEDIA rendition, so every track is already
     present in the one session and a switch is a local player-side track selection
     (hls.js's audioTrack setter, ExoPlayer's TrackSelectionParameters) instead of a new
     request. audioStreamID below still matters as the session's initial/default track. */
  url.searchParams.set("directStreamAudio", "1");
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

export function buildStreamUrl(opts) {
  return buildTranscodeUrl("/video/:/transcode/universal/start.m3u8", opts);
}

/* Every real Plex client (Plex Web, Plezy, etc.) calls /video/:/transcode/universal/
   decision before /start on a fresh audioStreamID/mediaIndex/qualityCapKbps choice -
   Prism skipped straight to /start alone. Confirmed empirically against a real server
   (raspi-server) that this is not just protocol politeness: re-requesting /start alone
   with a new audioStreamID - even from a brand-new session id, even after explicitly
   stopping the old session and marking the new stream "selected" via the Part PUT -
   kept transcoding the PREVIOUS audio selection. Issuing a /decision call with the
   exact same params first (see buildTranscodeUrl's own comment on why the two share one
   param builder) is what makes the Media Decision Engine actually re-evaluate; the
   /start call right after it then honors the new selection immediately. Callers should
   fire-and-await this (best-effort - a failed decision call shouldn't block the /start
   attempt that follows) before rebuilding the stream on any reload. */
export function buildDecisionUrl(opts) {
  return buildTranscodeUrl("/video/:/transcode/universal/decision", opts);
}
