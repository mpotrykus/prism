/* Shared query-param builder behind buildStreamUrl and buildDecisionUrl below - both
   endpoints need the exact same params to get a consistent answer out of Plex's Media
   Decision Engine (confirmed empirically: a /decision call with a DIFFERENT param set
   than the /start call that follows it doesn't reliably predict what /start actually
   does), so there is deliberately one place these are built, not two copies drifting
   apart. clientIdentifier and platform are passed in already-resolved rather than read
   from localStorage/Capacitor here, so this stays a pure function of its inputs. */
/* What this client tells Plex it can decode. Plex's Media Decision Engine uses it to choose between
   direct play, direct stream (remux, video copied) and a full transcode - so it is the single thing
   that decides whether HDR survives.

   The baseline is deliberately conservative: h264 High up to 1080p. That is what every existing leg
   sends, and it is why Plex tone-maps and re-encodes 4K HEVC HDR down to 1080p SDR before any player
   ever sees it - no renderer can recover HDR from that.

   `hdr` widens it to HEVC Main 10 at 2160p and declares the BT.2020/PQ colour support Plex looks for,
   which is what makes the MDE choose direct stream and copy the video untouched. Only passed on a
   backend that can actually present HDR (see core/platform.js's supportsHdr) - advertising it from a
   player that cannot would make Plex hand over HDR frames to be displayed as washed-out SDR, which is
   worse than the tone-mapped transcode it replaces.

   `hevcMain10_2160` (see core/platform.js's getDecodeCapabilities) widens it to plain SDR HEVC 2160p
   even when `hdr` is false - a real per-device decode-capability signal, not a static platform fact
   like `hdr` is. This is what lets Plex direct-play/direct-stream a genuine 4K HEVC SDR source instead
   of forcing it down to 1080p h264, on any browser/device that can actually decode it. */
function clientCapabilities({ hdr, hevcMain10_2160 } = {}) {
  const protocols =
    "protocols=http-live-streaming,http-mp4-streaming,http-mp4-video,http-mp4-video-720p,http-mp4-video-1080p";
  const audio = "audioDecoders=mp3,aac,ac3,eac3,dts,truehd";
  const h264 = "h264{profile:high&resolution:1080&level:51}";
  if (hdr) {
    /* hevc listed before h264: Plex takes the order as preference, and the point of this branch is to
       have HEVC chosen when the source is HEVC rather than falling back to an h264 transcode. */
    return (
      `${protocols},http-mp4-video-2160p` +
      "&videoDecoders=hevc{profile:main10&resolution:2160&level:153&colorSpace:bt2020nc&colorTrc:smpte2084}," +
      "hevc{profile:main&resolution:2160&level:153}," +
      `${h264}` +
      `&${audio}`
    );
  }
  if (hevcMain10_2160) {
    /* No colorSpace/colorTrc here - this is the SDR-tone-mapped HEVC case, distinct from the hdr
       branch above. Still listed before h264 for the same preference-ordering reason. */
    return (
      `${protocols},http-mp4-video-2160p` +
      `&videoDecoders=hevc{profile:main10&resolution:2160&level:153},${h264}&${audio}`
    );
  }
  return `${protocols}&videoDecoders=${h264}&${audio}`;
}

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
  progressive = false,
  hdr = false,
  hevcMain10_2160 = false,
}) {
  const url = new URL(`${plexUrl}${endpoint}`);
  url.searchParams.set("path", key);
  url.searchParams.set("mediaIndex", String(mediaIndex));
  url.searchParams.set("partIndex", String(partIndex));
  /* protocol=http is Plex's progressive (single continuous response) output; protocol=hls is the
     segmented playlist one. Passed in by the caller rather than derived here, so this stays a pure
     function of its inputs like clientIdentifier/platform above.

     Xbox uses progressive because HLS does not work there, measured on hardware: Plex serves empty
     single-packet TS segments for a fresh session regardless of token, and UWP's AdaptiveMediaSource
     additionally mis-seeks on Plex's #EXT-X-START:TIME-OFFSET (reading an absolute media position as
     an offset into a playlist that already begins there). Progressive plays and sustains. Full
     evidence in docs/xbox-native-hdr-player/05-phase0-spike-results.md. */
  url.searchParams.set("protocol", progressive ? "http" : "hls");
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
  url.searchParams.set("X-Plex-Client-Capabilities", clientCapabilities({ hdr, hevcMain10_2160 }));
  url.searchParams.set("X-Plex-Token", plexToken);
  return url.toString();
}

export function buildStreamUrl(opts) {
  /* start.mp4 goes with protocol=http and start.m3u8 with protocol=hls - Plex keys off both, and
     mismatching them produces a response the requesting player can't use. Note the extension is
     nominal: Plex answered start.mp4 with Content-Type: video/x-matroska and MediaFoundation played
     it regardless. */
  const endpoint = opts.progressive
    ? "/video/:/transcode/universal/start.mp4"
    : "/video/:/transcode/universal/start.m3u8";
  return buildTranscodeUrl(endpoint, opts);
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

/* The one place both first-play (plex-player.js's _prepareSession) and reload
   (session-reload.js) resolve a playback URL - the same "one shared helper, not two
   divergent copies" discipline session-reload.js's own header comment already applies to
   everything else in that file.

   Attempts a real, zero-cost Plex direct play (the raw file itself, no transcode/HLS
   session) when the decision engine's response gives an EXPLICIT, unambiguous "directplay"
   signal - never on an absent/ambiguous field. That asymmetry is deliberate: guessing wrong
   in the other direction (treating an absent/unexpected field as "direct play IS possible")
   risks handing the player a raw file it genuinely can't decode, which breaks playback;
   guessing conservatively only costs a missed optimization, never a regression - the
   fallback path below is byte-identical to buildStreamUrl's existing behavior.

   THE EXACT decision-response field/value shape below is NOT YET CONFIRMED against a real
   server - flagged in this feature's own plan as needing empirical verification. The
   console.info left in deliberately surfaces the raw Part every time a decision call
   resolves, so the first real run can confirm (or correct) the field name/value this
   checks. Until confirmed, this only widens behavior when it recognizes something - it
   never narrows or breaks the existing path. */
export async function resolvePlaybackUrl(urlOpts) {
  const fallback = () => ({ streamUrl: buildStreamUrl(urlOpts), isDirectPlay: false });

  /* A user-set quality cap has no meaning against a raw file, and a non-default audio
     track has no server-side mux to fall back on for legs that can't switch it natively
     (see Part 3 of this feature) - both force the existing transcode path. */
  if (urlOpts.qualityCapKbps != null) return fallback();
  if (urlOpts.isDefaultAudioTrack === false) return fallback();
  if (!urlOpts.partKey) return fallback();

  try {
    const res = await Promise.race([
      fetch(buildDecisionUrl(urlOpts), { headers: { Accept: "application/json" } }),
      /* A slow decision response must never stall first-play - same "a failed decision
         call shouldn't block /start" principle this file's own buildDecisionUrl comment
         already documents for the reload case. */
      new Promise((_, reject) => setTimeout(() => reject(new Error("decision timeout")), 1500)),
    ]);
    if (!res.ok) return fallback();
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    const part = data?.MediaContainer?.Metadata?.[0]?.Media?.[0]?.Part?.[0];
    if (!part) return fallback();
    // eslint-disable-next-line no-console
    console.info("[direct-play] decision Part (verify shape against this):", part);
    if (part.decision !== "directplay") return fallback();
    const url = new URL(`${urlOpts.plexUrl}${urlOpts.partKey}`);
    url.searchParams.set("X-Plex-Token", urlOpts.plexToken);
    return { streamUrl: url.toString(), isDirectPlay: true };
  } catch {
    return fallback();
  }
}
