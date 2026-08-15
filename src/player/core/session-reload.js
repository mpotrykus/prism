import { media } from "./media-facade.js";
import { notifyReload, updateAbrMonitor } from "./abr.js";

/* Restarting a Plex transcode session, minus the part that differs per platform.

   Plex bakes the version, bitrate cap, audio selection AND start offset into a transcode session at
   creation, so changing any of them means re-requesting the stream. Everything about how to do that
   correctly against a real server was learned the hard way (see the comments inline - each one is a
   separately-confirmed failure), and none of it is platform-specific: only the final "hand the new URL
   to the player" step is. So that step is a callback, and this function is shared.

   The alternative was a second copy of this sequence for the Xbox path, which would have meant two
   places to keep five non-obvious Plex behaviours correct. That is exactly the divergence this
   project's plan set out to avoid.

   `rebuild(streamUrl, offsetMs)` is called last, after the decision call has been given its chance. */
export function reloadTranscodeSession(controller, overrides = {}, rebuild) {
    const s = controller._session;
    if (!s || typeof rebuild !== "function") return;

    /* Resume position. An explicit startOffsetMs override is a seek (the caller wants a specific
       position); without one, resume wherever playback currently is. Read through the media facade
       rather than a <video> element so this works for a native backend too. */
    const offsetMs =
        overrides.startOffsetMs != null
            ? Math.max(0, Math.round(overrides.startOffsetMs))
            : Math.round((media(controller)?.currentTime || 0) * 1000);

    const nextMediaIndex = overrides.mediaIndex ?? s.mediaIndex;
    /* qualityCapKbps needs its own `in` check (unlike the others): null is a valid explicit override
       (Quality Cap's "Original" option), so `??`-against-undefined would wrongly treat "clear the cap"
       the same as "don't touch it". */
    const nextQualityCapKbps = "qualityCapKbps" in overrides ? overrides.qualityCapKbps : s.qualityCapKbps;
    const nextAudioStreamID = overrides.audioStreamID ?? s.audioStreamId;
    const oldSessionId = s.transcodeSessionId;
    s.mediaIndex = nextMediaIndex;
    s.qualityCapKbps = nextQualityCapKbps;
    s.audioStreamId = nextAudioStreamID;

    /* Generated once up front, not inside the rebuild - askDecision below needs the exact same session
       id /start will use (see buildDecisionUrl's own comment: a /decision call only reliably predicts
       what /start does when every param, session id included, matches). */
    const sessionId = crypto.randomUUID();
    const urlOpts = {
        plexUrl: s.plexUrl,
        plexToken: s.plexToken,
        key: s.key,
        sessionId,
        startOffsetMs: offsetMs,
        mediaIndex: nextMediaIndex,
        qualityCapKbps: nextQualityCapKbps,
        audioStreamID: nextAudioStreamID,
    };

    /* audioStreamID on the transcode start URL alone doesn't reliably make Plex actually mux the
       requested track - confirmed against a real server, it kept playing the previously-selected audio
       regardless of this param. The verified mechanism (same one python-plexapi's own users landed on)
       is marking the stream "selected" on the Part first via
       PUT /library/parts/<id>?audioStreamID=...&allParts=1 - the transcode decision then honors
       whatever's currently selected there. Only done when actually switching audio (not on a
       mediaIndex/qualityCap/seek-only reload) and only when a partId was resolved at play() time. */
    const selectAudio =
        overrides.audioStreamID != null && s.partId
            ? (() => {
                  const putUrl = new URL(`${s.plexUrl}/library/parts/${s.partId}`);
                  putUrl.searchParams.set("audioStreamID", String(overrides.audioStreamID));
                  putUrl.searchParams.set("allParts", "1");
                  putUrl.searchParams.set("X-Plex-Token", s.plexToken);
                  return fetch(putUrl, { method: "PUT" }).catch(() => {});
              })()
            : Promise.resolve();

    /* A new `session` id alone isn't enough either - confirmed against a real server, an in-place
       reload kept getting served the OLD, still-warm transcode session's audio selection even with a
       fresh session id and a successful Part-selection PUT both in place, and only actually reflected
       the switch once the old session had had time to expire on its own (e.g. a full stop()+replay).
       Explicitly stopping it here makes the switch immediate instead of leaving it to Plex's own
       idle-timeout.

       This also matters for server load, not just correctness: an abandoned session leaves an ffmpeg
       process transcoding on the server. Confirmed on real hardware during the Xbox spikes, where
       orphaned sessions starved the player badly enough to fail it outright. */
    const stopOldSession = oldSessionId
        ? fetch(
              `${s.plexUrl}/video/:/transcode/universal/stop?session=${encodeURIComponent(oldSessionId)}` +
                  `&X-Plex-Token=${encodeURIComponent(s.plexToken)}`
          ).catch(() => {})
        : Promise.resolve();

    /* The actual, whole reason a switch never took effect until backing out and back in - confirmed
       against a real server (raspi-server), reading Plex's own session state via /status/sessions
       mid-switch. Everything above this comment (the Part-selection PUT, the explicit old-session stop,
       a brand-new session id) was already correct and already being done, and STILL wasn't enough on
       its own: a /start request alone - even with all of that in place - kept transcoding the previous
       audio selection. Only once a /video/:/transcode/universal/decision call went out FIRST, with the
       exact same params /start was about to use (see buildDecisionUrl's own comment), did the Media
       Decision Engine actually re-evaluate and the following /start honor the new selection
       immediately. Best-effort like the requests above it - a failed decision call shouldn't block the
       /start attempt that follows, it just means this particular attempt is back to relying on Plex's
       own eventual re-evaluation. */
    const askDecision = () => fetch(controller._buildDecisionUrl(urlOpts)).catch(() => {});

    const finish = () => {
        const streamUrl = controller._buildStreamUrl(urlOpts);
        s.transcodeSessionId = sessionId;
        rebuild(streamUrl, offsetMs);
        /* A fresh transcode session means whatever Auto Quality streak/cooldown state was building
           against the old one no longer applies - see core/abr.js's notifyReload. Also re-checks
           whether the monitor should be running at all, since the rebuild may have replaced the
           bandwidth source. */
        notifyReload(controller);
        updateAbrMonitor(controller);
    };

    Promise.all([selectAudio, stopOldSession]).then(askDecision, askDecision).then(finish, finish);
}
