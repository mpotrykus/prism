import Hls from "hls.js";
import { ZOOM_LEVELS, storedVolume } from "./ui/shared.js";
import { updateContentAnalysis } from "./content-analysis.js";
import { releaseBifIndex } from "./core/bif.js";
import { episodeListIconMarkup } from "./ui/shared.js";
import { closeEpisodeListOverlay } from "./ui/episode-list.js";

/* <video>+hls.js fallback path - used everywhere WebView2/Chrome/Xbox/Android-web has
   no native player available (see native-bridge.js for the Android/ExoPlayer leg).
   Takes the StreamingPlayerController instance as an explicit first argument (see
   native-bridge.js's header comment for why) and calls back into the controller's own
   UI-chrome/shader-pipeline methods (still defined on the class as thin delegates) for
   everything that isn't this path's own concern - the transport bar, shader pipeline,
   and skip-marker UI aren't separable from a playback session's own lifecycle. */
/* Plain bold white-on-transparent cues instead of the browser's default boxed caption
   style - only affects <track> rendering (attachSubtitleTrack in chrome.js), no change
   to which captions load or when. */
if (!document.getElementById("streaming-player-cue-style")) {
    const style = document.createElement("style");
    style.id = "streaming-player-cue-style";
    style.textContent = `
        .streaming-player-video::cue {
            background: transparent;
            color: rgba(235,235,235,0.95);
            font-family: "Roboto", sans-serif;
            font-weight: 700;
            font-size: 1.05em;
            text-shadow: 0 2px 6px rgba(0,0,0,0.85);
        }
    `;
    document.head.appendChild(style);
}

export function playWeb(controller, streamUrl, startOffsetMs) {
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
    /* _switchTitle's teardown-then-rebegin (see plex-player.js) replaces controller._videoEl
       with a fresh element, but the outgoing one's own listeners stay attached - hls.js's
       destroy() clears the old video's src and calls load() on it, which fires this browser's
       'error' event asynchronously, landing after the new title has already started playing.
       Every listener below has to check it's still the current element before acting on the
       controller, or that stray event on the torn-down video kills the title switch it wasn't
       even about. */
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

    attachSource(controller, video, streamUrl);
    video.currentTime = startOffsetMs / 1000;
    document.body.appendChild(video);
    controller._videoEl = video;
    controller._buildLoadingSpinner(video);

    /* Not just a convenience: on the Xbox WebView2 shell there's no browser chrome and
       no back button to fall back on at all, so an explicit close control isn't
       optional the way it might seem on desktop web. Styled as a back chevron,
       top-left, rather than an "✕" - same close-the-player action, just matching where
       a streaming app's own back affordance normally sits. */
    const closeBtn = controller._makeControlButton({
        ariaLabel: "Close player",
        content: "‹",
        onClick: () => controller.stop(),
    });
    controller._registerControlButton(closeBtn, { side: "left" });

    /* Every custom option (speed, sleep timer, zoom, chapters, subtitles) lives behind
       this single button instead of one circular button each - see openHamburgerMenu.
       Opposite corner from the close button. Toggles closed on a second tap - re-opening
       would otherwise be the only reachable outcome of tapping this button again, since
       openHamburgerMenu (like every submenu) closes and immediately rebuilds the flyout
       rather than no-op'ing when one is already open. */
    const menuBtn = controller._makeControlButton({
        ariaLabel: "Player options",
        content: "☰",
        onClick: () => {
            if (controller._inlineMenuEl && controller._inlineMenuAnchor === menuBtn) {
                controller._closeInlineMenu();
            } else {
                controller._openHamburgerMenu(menuBtn);
            }
        },
    });
    controller._registerControlButton(menuBtn, { side: "right" });

    /* Only shown when there's an actual queue to browse - same "never an empty/dead
       affordance" rule the hamburger's Chapters/Audio Track rows already follow. Stacks
       further from the corner than menuBtn automatically (see registerControlButton). */
    if (controller._session?.queueRatingKeys?.length > 1) {
        const episodesBtn = controller._makeControlButton({
            ariaLabel: "Episodes",
            content: "",
            onClick: () => {
                if (controller._episodeListEl) {
                    controller._closeEpisodeListOverlay();
                } else {
                    controller._openEpisodeListOverlay();
                }
            },
        });
        episodesBtn.innerHTML = episodeListIconMarkup();
        controller._registerControlButton(episodesBtn, { side: "right" });
    }

    controller._zoomIndex = 0;
    controller._zoomPanX = 0;
    controller._zoomPanY = 0;
    controller._sleepMinutes = 0;
    controller._wireZoomPan();
    /* Transport bar first: it builds the bottom chrome's center cell that
       _buildCenterControls fills with play/pause + chapter nav (see chrome.js), rather
       than that row floating mid-screen on its own. */
    controller._buildTransportBar(video);
    controller._buildCenterControls(video);
    /* _shaderType/_shaderStrength were already resolved in play() (global setting +
       this title's auto-detected type) before playWeb was called - this just spins up
       the WebGL pipeline for that starting state, same as any other change made
       through the hamburger menu later in the session. */
    controller._updateShaderPipeline();
    /* Same "already-resolved global default, just spin up the pipeline" reasoning as
       the shader call above - controller._ambientEnabled was set from
       storedAmbientEnabled() in play() before playWeb was called. */
    controller._updateAmbientPipeline();
    /* Same "already-resolved global default, just spin up the pipeline" reasoning as
       the calls above - controller._statsOverlayEnabled was set from
       storedStatsOverlayEnabled() in play() before playWeb was called. */
    controller._updateStatsOverlayPipeline();
    /* Same "already-resolved global default, just spin up the pipeline" reasoning as
       the calls above - controller._upscaleAuto/_colorBoostAuto were set from
       storedUpscaleAuto()/storedColorBoostAuto() in play() before playWeb was called. */
    updateContentAnalysis(controller);

    /* Tapping the video itself toggles play/pause, matching every mainstream player -
       only when not zoomed in, since zoomed-in drag is already claimed by pan (see
       _wireZoomPan) and would otherwise fight this for the same gesture. */
    video.addEventListener("click", () => {
        if (ZOOM_LEVELS[controller._zoomIndex] > 1) return;
        if (video.paused) video.play();
        else video.pause();
    });

    /* Mirrors how native player chrome behaves - visible on activity, fades after a few
       seconds idle. This custom chrome (transport bar + top buttons) replaces
       video.controls entirely now, so it owns show/hide itself rather than trying to
       piggyback on the browser's own (now-disabled) control bar. */
    video.addEventListener("mousemove", () => controller._showControls());
    video.addEventListener("touchstart", () => controller._showControls());
    controller._scheduleHideControls();
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
    if (streamUrl.includes(".m3u8") && !video.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
        const hls = new Hls();
        hls.on(Hls.Events.ERROR, (event, data) => {
            console.error("StreamingPlayer: hls.js error -", data.type, data.details, data.fatal ? "(fatal)" : "");
            if (data.fatal) controller.stop();
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        controller._hls = hls;
    } else {
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

/* Restarts the Plex transcode session with a new audioStreamID, resuming at the
   current position - Plex bakes the selected audio stream into the HLS transcode at
   session start, so there's no way to switch tracks without re-requesting the
   playlist. A fresh session id avoids Plex reusing/confusing the just-abandoned
   transcode session's own state. */
export function reloadWebSource(controller, newStreamId) {
    const video = controller._videoEl;
    const s = controller._session;
    if (!video || !s) return;
    const offsetMs = Math.round((video.currentTime || 0) * 1000);
    const streamUrl = controller._buildStreamUrl({
        plexUrl: s.plexUrl,
        plexToken: s.plexToken,
        key: s.key,
        sessionId: crypto.randomUUID(),
        startOffsetMs: offsetMs,
        mediaIndex: s.mediaIndex,
        qualityCapKbps: s.qualityCapKbps,
        audioStreamID: newStreamId,
    });
    attachSource(controller, video, streamUrl);
    video.currentTime = offsetMs / 1000;
    s.audioStreamId = newStreamId;
}

export function teardownWeb(controller) {
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
    if (controller._statsOverlayIntervalId) {
        clearInterval(controller._statsOverlayIntervalId);
        controller._statsOverlayIntervalId = null;
    }
    if (controller._statsOverlayEl) {
        controller._statsOverlayEl.remove();
        controller._statsOverlayEl = null;
    }
    controller._closeInlineMenu();
    closeEpisodeListOverlay(controller);
    clearTimeout(controller._controlsHideTimer);
    controller._controlsHideTimer = null;
    controller._controlsHovering = false;
    controller._controlButtons.forEach((b) => b.remove());
    controller._controlButtons = [];
    if (controller._fullscreenChangeHandler) {
        document.removeEventListener("fullscreenchange", controller._fullscreenChangeHandler);
        document.removeEventListener("webkitfullscreenchange", controller._fullscreenChangeHandler);
        controller._fullscreenChangeHandler = null;
    }
    /* The fullscreen button (chrome.js) requests fullscreen on document.documentElement,
       not a player-scoped container - leaving the player without exiting fullscreen first
       would strand the whole app fullscreen behind the now-gone player chrome. */
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
    if (controller._skipBtnEl) {
        controller._skipBtnEl.remove();
        controller._skipBtnEl = null;
    }
    controller._activeSkipMarker = null;
    if (controller._volumePopoutEl) {
        controller._volumePopoutEl.remove();
        controller._volumePopoutEl = null;
    }
    if (controller._spinnerEl) {
        controller._spinnerEl.remove();
        controller._spinnerEl = null;
    }
    if (controller._subtitleTrackUrl) {
        URL.revokeObjectURL(controller._subtitleTrackUrl);
        controller._subtitleTrackUrl = null;
    }
    if (controller._bifIndex) {
        releaseBifIndex(controller._bifIndex);
        controller._bifIndex = null;
    }
    if (controller._videoEl) {
        controller._videoEl.pause();
        controller._videoEl.remove();
        controller._videoEl = null;
    }
}
