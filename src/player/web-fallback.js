import Hls from "hls.js";
import { ZOOM_LEVELS, storedVolume } from "./ui/shared.js";
import { releaseBifIndex } from "./core/bif.js";
import { setMediaFacade } from "./core/media-facade.js";
import { closeEpisodeListOverlay, closeChapterListOverlay } from "./ui/episode-list.js";
import { updateAbrMonitor, stopAbrLoop, notifyStall, setBandwidthSource } from "./core/abr.js";
import { reloadTranscodeSession } from "./core/session-reload.js";
import { mountPlayerChrome, unmountPlayerChrome } from "./ui/player-chrome.js";
/* Circular with chrome.js (which already imports reloadWebSource from this file) - safe
   here for the same reason that one is: closeAudioSubtitlesOverlay is only ever called
   from inside teardownWeb's own function body below, never at module-top-level
   evaluation time. */
import { closeAudioSubtitlesOverlay, stopSubtitleLoop } from "./ui/chrome.js";

/* <video>+hls.js fallback path - used everywhere WebView2/Chrome/Xbox/Android-web has
   no native player available (see native-bridge.js for the Android/ExoPlayer leg).
   Takes the StreamingPlayerController instance as an explicit first argument (see
   native-bridge.js's header comment for why) and calls back into the controller's own
   UI-chrome/shader-pipeline methods (still defined on the class as thin delegates) for
   everything that isn't this path's own concern - the transport bar, shader pipeline,
   and skip-marker UI aren't separable from a playback session's own lifecycle. */
/* Shared by playWeb (cold start) and reloadWebSource (audio/version/quality-cap
   switch) - every listener below checks controller._videoEl against its own closed-
   over `video` before acting, the same guard _switchTitle's teardown-then-rebegin
   already relied on for its own outgoing element (see the old comment this replaced):
   hls.js's destroy() (or, on a native-HLS browser, the plain <video> "error" event)
   can fire asynchronously on an element that's already been superseded, and that
   stray event must not reach back into the controller for a title/switch it's no
   longer about. */
function createVideoElement(controller) {
    const video = document.createElement("video");
    video.className = "streaming-player-video";
    video.controls = false;
    video.autoplay = true;
    Object.assign(video.style, {
        position: "fixed",
        inset: "0",
        width: "100%",
        height: "100%",
        /* Same "replaced element defaults to object-fit:fill" issue as the shader
           canvas above - without this, the video stretches to the window's own aspect
           ratio instead of letterboxing/pillarboxing against its #000 background
           whenever the two don't match. */
        objectFit: "contain",
        background: "#000",
        zIndex: "10000",
    });
    video.addEventListener("timeupdate", () => {
        if (controller._videoEl !== video || !controller._session) return;
        controller._session.lastTimeMs = Math.round(video.currentTime * 1000);
        if (video.duration) controller._session.durationMs = Math.round(video.duration * 1000);
        const marker = controller._activeMarkerAt(controller._session.lastTimeMs);
        if (marker !== controller._activeSkipMarker) controller._updateSkipButton(marker);
    });
    video.addEventListener("ended", () => {
        if (controller._videoEl !== video) return;
        controller._handlePlaybackEnded();
    });
    video.addEventListener("pause", () => {
        if (controller._videoEl === video && controller._session) controller._session.state = "paused";
    });
    video.addEventListener("play", () => {
        if (controller._videoEl === video && controller._session) controller._session.state = "playing";
    });
    video.addEventListener("error", () => {
        if (controller._videoEl !== video) return;
        const err = video.error;
        console.error("StreamingPlayer: <video> error -", err?.code, err?.message);
        controller.stop();
    });
    video.volume = storedVolume();

    /* Tapping the video itself toggles play/pause, matching every mainstream player -
       only when not zoomed in, since zoomed-in drag is already claimed by pan (see
       _wireZoomPan) and would otherwise fight this for the same gesture. */
    video.addEventListener("click", () => {
        if (ZOOM_LEVELS[controller._zoomIndex] > 1) return;
        if (video.paused) video.play();
        else video.pause();
    });
    video.addEventListener("mousemove", () => controller._showControls());
    video.addEventListener("touchstart", () => controller._showControls());
    return video;
}

/* Assigning video.currentTime immediately after attachSource() (the previous approach here and in
   reloadWebSource below) is unreliable: readyState is still HAVE_NOTHING at that point - hls.js's
   loadSource()/attachMedia() and the plain `video.src =` assignment both resolve asynchronously - and
   a seek requested that early is a well-known case browsers silently drop rather than queue. The
   symptom is exactly "playback (and therefore the scrub bar, which just reads video.currentTime/
   video.duration) starts from true zero every time," regardless of the real resume position, since
   the dropped seek never gets retried. loadedmetadata is the first point a seek is spec-guaranteed to
   actually take effect. `once: true` needs no manual removal - the listener is used up after firing
   once, same lifetime as the seek it performs. */
function seekOnceReady(video, offsetMs) {
    if (!offsetMs) return;
    video.addEventListener("loadedmetadata", () => {
        video.currentTime = offsetMs / 1000;
    }, { once: true });
}

export function playWeb(controller, streamUrl, startOffsetMs) {
    const video = createVideoElement(controller);
    attachSource(controller, video, streamUrl);
    seekOnceReady(video, startOffsetMs);
    document.body.appendChild(video);
    controller._videoEl = video;
    /* The element itself is the media facade on this leg - it already satisfies the whole
       playback-state surface the chrome reads (see core/media-facade.js), so registering it
       is the entire web-side implementation. Everything below that still wants the real
       DOM element (the GPU pipelines, the zoom transform) keeps using controller._videoEl. */
    setMediaFacade(controller, video);
    /* The chrome itself lives in ui/player-chrome.js so the Xbox leg can mount the identical thing
       over native video - see that file's header. gpuPipelines:true because this leg has a real
       <video> element for the shader/ambient/content-analysis passes to read pixels from. */
    mountPlayerChrome(controller, video, { gpuPipelines: true });
    /* Auto Quality's monitor is started here rather than inside mountPlayerChrome because what it
       depends on is this leg's bandwidth source (the hls.js instance attachSource just created), not
       the chrome. No-ops on the native-HLS branch, which registers no source - see core/abr.js. */
    updateAbrMonitor(controller);
}

/* Shared by the initial load (playWeb) and reloadWebSource (audio-track switch) so the
   hls.js-vs-native-HLS branching only lives in one place. Destroys any previous hls.js
   instance first - attachMedia() on a video that already has one attached is not a
   supported re-attach path. */
export function attachSource(controller, video, streamUrl) {
    if (controller._hls) {
        controller._hls.destroy();
        controller._hls = null;
    }
    /* video.canPlayType("application/vnd.apple.mpegurl") is not a reliable "does this
       browser have native HLS" check - confirmed against a real Chrome session, it
       answers the truthy "maybe" despite Chrome having no actual HLS demuxer at all,
       which made the old `!video.canPlayType(...)` condition here false on Chrome and
       silently routed it to the plain <video src> branch below instead of hls.js.
       Playback still displayed (Chrome's own pipeline limped through enough of it to
       look like it worked), but controller._hls was never set, so nothing that depends
       on it - hls.js's own multi-audio-track API (see reloadWebSource's
       trySwitchAudioTrackLocal), the FRAG_LOADED/BUFFER_STALLED_ERROR events
       core/abr.js's Auto Quality reads - was ever wired up either. Real Safari is the
       only browser that answers the stronger "probably" for this mime type, which is
       what actually distinguishes genuine native HLS support from Chromium's false
       positive. */
    if (streamUrl.includes(".m3u8") && Hls.isSupported() && video.canPlayType("application/vnd.apple.mpegurl") !== "probably") {
        const hls = new Hls();
        hls.on(Hls.Events.ERROR, (event, data) => {
            console.error("StreamingPlayer: hls.js error -", data.type, data.details, data.fatal ? "(fatal)" : "");
            if (data.fatal) controller.stop();
            /* Non-fatal buffer-stall - the Auto Quality signal that the current cap is
               too high for the real connection right now (see core/abr.js's notifyStall).
               Fatal errors above already stop() the whole session, so this branch only
               ever matters for the non-fatal case. */
            else if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) notifyStall(controller);
        });
        /* hls.js's own bandwidthEstimate starts at a synthetic default before any real
           fragment has loaded (see core/abr.js's evaluateAbrTick) - registering the
           instance as the bandwidth source also resets the "do we have a real sample yet"
           flag, which this flips once a fragment actually finishes. The Hls instance IS the
           source object here: its bandwidthEstimate property already has exactly the shape
           core/abr.js reads. */
        setBandwidthSource(controller, hls);
        hls.on(Hls.Events.FRAG_LOADED, () => {
            controller._abrHasRealSample = true;
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        controller._hls = hls;
    } else {
        /* Safari's native-HLS path measures nothing abr.js can read, so Auto Quality stays
           correctly unavailable rather than deciding off a stale estimate from the hls.js
           instance a previous reload may have registered. */
        setBandwidthSource(controller, null);
        /* Only this branch needs crossOrigin, not the hls.js branch above - hls.js
           attaches media via a same-origin blob: URL and feeds it segments through
           MediaSource.appendBuffer(), so the video element's own origin (as far as
           canvas/WebGL tainting cares) is the blob URL, never the actual cross-origin
           Plex URL. This branch assigns the real cross-origin URL directly, so
           texImage2D (see the shader pipeline's renderShaderFrame) would taint the
           canvas without this - relies on the CORS invariant noted in this repo's
           CLAUDE.md (Plex answers CORS-clean as long as the token is a query param,
           which stream-url.js's buildStreamUrl already does). */
        video.crossOrigin = "anonymous";
        video.src = streamUrl;
    }
}

/* Switches the audio track without restarting the transcode session at all - the
   Plezy-style fix (see stream-url.js's directStreamAudio comment) for what used to be
   this file's reloadWebSource audio path. Because directStreamAudio=1 makes Plex remux
   every embedded audio track into the running session's HLS segments as its own
   EXT-X-MEDIA rendition, hls.js already knows about all of them - this is a pure
   client-side selection (hls.js's own audioTrack setter), not a new request, so there's
   no new session for Plex's transcode cache to ever go stale on.

   Only usable when hls.js is actually attached (controller._hls) - the native-HLS
   fallback branch (Safari, or any browser without hls.js support) hands the <video> a
   raw src URL with no equivalent multi-audio-track API, so that path has to keep using
   reloadWebSource's session-restart mechanism below. Also only usable when hls.js
   actually exposes as many audio tracks as Plex's Part carries - unverified whether
   Plex's EXT-X-MEDIA group order always matches the Part's own Stream order on every
   server/source combination, so a mismatched count (or an unresolved index) bails out
   and lets the caller fall back to reloadWebSource instead of silently picking the
   wrong track. Returns whether the local switch actually applied. */
export function trySwitchAudioTrackLocal(controller, audioStreamID) {
    const hls = controller._hls;
    const s = controller._session;
    if (!hls || !s) return false;
    const streams = s.audioStreams || [];
    const index = streams.findIndex((stream) => stream.id === audioStreamID);
    if (index < 0 || hls.audioTracks.length !== streams.length) return false;
    hls.audioTrack = index;
    s.audioStreamId = audioStreamID;
    /* Fire-and-forget, same as reloadWebSource's own selectAudio below - keeps Plex's
       server-side "selected" bookkeeping in sync for other clients/the next launch, but
       nothing here waits on it since no new session is being requested. */
    if (s.partId) {
        const putUrl = new URL(`${s.plexUrl}/library/parts/${s.partId}`);
        putUrl.searchParams.set("audioStreamID", String(audioStreamID));
        putUrl.searchParams.set("allParts", "1");
        putUrl.searchParams.set("X-Plex-Token", s.plexToken);
        fetch(putUrl, { method: "PUT" }).catch(() => {});
    }
    return true;
}

/* The web leg's rebuild step for a transcode-session restart. Everything about the restart itself -
   resume position, the Part-selection PUT, stopping the old session, the /decision call that is what
   actually makes Plex re-evaluate - lives in core/session-reload.js, because none of it is
   web-specific and the Xbox leg needs the identical sequence. All this adds is "point the <video> and
   hls.js at the new URL".

   Shared by chrome-menu.js's Version/Quality Cap menus and chrome-subtitles.js's audio picker via the
   controller's _reloadSource delegate, which dispatches per platform - only the override actually
   being changed is passed, everything else falls back to the current session value. */
export function reloadWebSource(controller, overrides = {}) {
    const video = controller._videoEl;
    if (!video || !controller._session) return;
    reloadTranscodeSession(controller, overrides, (streamUrl, offsetMs) => {
        attachSource(controller, video, streamUrl);
        seekOnceReady(video, offsetMs);
    });
}

export function teardownWeb(controller) {
    stopAbrLoop(controller);
    setBandwidthSource(controller, null);
    if (controller._hls) {
        controller._hls.destroy();
        controller._hls = null;
    }
    controller._stopShaderLoop();
    if (controller._shaderCanvas) {
        controller._shaderCanvas.remove();
        controller._shaderCanvas = null;
    }
    controller._shaderGl = null;
    controller._shaderPrograms = null;
    controller._shaderQuadBuffer = null;
    controller._shaderTexture = null;
    controller._stopAmbientLoop();
    if (controller._ambientGlowContainer) {
        controller._ambientGlowContainer.remove();
        controller._ambientGlowContainer = null;
    }
    controller._ambientGlowPanels = null;
    controller._ambientSampleCanvas = null;
    controller._ambientSampleCtx = null;
    controller._ambientSmoothed = null;
    if (controller._contentRafId) {
        cancelAnimationFrame(controller._contentRafId);
        controller._contentRafId = null;
    }
    controller._contentSampleCanvas = null;
    controller._contentSampleCtx = null;
    controller._contentSmoothedSaturation = null;
    controller._contentSmoothedEdgeEnergy = null;
    /* The chrome half of teardown lives in ui/player-chrome.js, so the Xbox leg tears down exactly
       the same things it mounted - a missing unmount there left the transport bar, center controls and
       options sheet on screen after backing out of native playback. */
    unmountPlayerChrome(controller);
    if (controller._bifIndex) {
        releaseBifIndex(controller._bifIndex);
        controller._bifIndex = null;
    }
    setMediaFacade(controller, null);
    if (controller._videoEl) {
        controller._videoEl.pause();
        controller._videoEl.remove();
        controller._videoEl = null;
    }
}
