import { updateContentAnalysis } from "../content-analysis.js";
import { closeEpisodeListOverlay, closeChapterListOverlay } from "./episode-list.js";
import { closeAudioSubtitlesOverlay, stopSubtitleLoop } from "./chrome-subtitles.js";
import { ensurePlayerFocusStyle } from "./shared.js";
import { platformTag } from "../core/platform.js";

/* Circular with web-fallback.js (which imports mountPlayerChrome/unmountPlayerChrome from here, while
   chrome-subtitles.js above imports trySwitchAudioTrackLocal from it) - safe for the same reason the
   other cycles in this directory are: every reference across the cycle is used inside a function body
   at call time, never at module-evaluation time. */

/* Mounts the player's on-screen chrome: the idle-fade control row (close + options), the transport
   bar, the floating center play/pause button, the buffering spinner, and the per-session pipelines.

   Extracted from web-fallback.js's playWeb so the Xbox leg can mount the identical chrome over native
   video. That is the whole point of the Xbox architecture - the video surface is a sibling of a
   transparent WebView2 in one XAML page, so the ~2,900 lines of chrome in this directory render over
   it unchanged, instead of being re-implemented natively the way Android had to.

   `mediaEl` is whatever core/media-facade.js registered: the real <video> on web, a NativeMediaFacade
   on Xbox. Everything below only uses the <video>-shaped playback surface, never DOM specifics.

   `gpuPipelines` is false on a native backend. Shader upscaling, Color Boost, ambient lighting and
   the content-analysis sampler all need to read pixels out of a real <video> element (texImage2D /
   drawImage), which a native surface cannot provide - those get native equivalents in a later phase.
   The stats overlay is included either way: it is plain DOM reading the facade. */
export function mountPlayerChrome(controller, mediaEl, { gpuPipelines }) {
    ensurePlayerFocusStyle();
    controller._buildLoadingSpinner(mediaEl);

    /* Not just a convenience: on the Xbox WebView2 shell there's no browser chrome and no back button
       to fall back on at all, so an explicit close control isn't optional the way it might seem on
       desktop web. Styled as a back chevron, top-left, rather than an "✕" - same close-the-player
       action, just matching where a streaming app's own back affordance normally sits. */
    const closeBtn = controller._makeControlButton({
        ariaLabel: "Close player",
        content: "‹",
        onClick: () => controller.stop(),
    });
    controller._registerControlButton(closeBtn, { side: "left" });

    /* Every custom option (speed, sleep timer, zoom, chapters, subtitles) lives behind this single
       button instead of one circular button each - see openHamburgerMenu. Opposite corner from the
       close button. Toggles closed on a second tap - re-opening would otherwise be the only reachable
       outcome of tapping this button again, since openHamburgerMenu (like every submenu) closes and
       immediately rebuilds the flyout rather than no-op'ing when one is already open. */
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
    /* Kept on the controller so gamepad navigation can open this menu without a pointer - it is the
       only route to Chapters/Version/Quality/Effects/Extras, so on a console it has to be reachable
       from a button press. See plex-player.js's nav handler. */
    controller._menuButtonEl = menuBtn;

    controller._zoomIndex = 0;
    controller._zoomPanX = 0;
    controller._zoomPanY = 0;
    controller._sleepMinutes = 0;
    if (gpuPipelines) controller._wireZoomPan();
    controller._buildTransportBar(mediaEl);
    /* Xbox only - web builds its own in-row play/pause instead (see chrome-transport.js's
       buildCenterControls, called from within buildTransportBar), so there's never two
       play/pause buttons on screen at once. */
    if (platformTag() === "xbox") controller._buildFloatingPlayButton(mediaEl);

    if (gpuPipelines) {
        /* _shaderType/_shaderStrength were already resolved in play() (global setting + this title's
           auto-detected type) before this ran - this just spins up the WebGL pipeline for that starting
           state, same as any other change made through the hamburger menu later in the session. */
        controller._updateShaderPipeline();
        /* Same "already-resolved global default, just spin up the pipeline" reasoning as the shader call
           above - controller._ambientEnabled was set from storedAmbientEnabled() in play(). */
        controller._updateAmbientPipeline();
        /* Same reasoning - controller._upscaleAuto/_colorBoostAuto were set from
           storedUpscaleAuto()/storedColorBoostAuto() in play(). */
        updateContentAnalysis(controller);
    }
    /* Same reasoning - controller._statsOverlayEnabled was set from storedStatsOverlayEnabled() in
       play(). Reads the facade, so it works on either backend. */
    controller._updateStatsOverlayPipeline();

    controller._scheduleHideControls();
}

/* Removes everything mountPlayerChrome put on screen, plus the overlays and transient bits the chrome
   can spawn during a session. Extracted from web-fallback.js's teardownWeb for the same reason the
   mount was: both legs must tear down exactly what they mounted. Leaving this out on the Xbox leg left
   the transport bar, center controls and open options sheet on screen after backing out - the player
   "closed" but its UI stayed.

   Everything <video>- or GPU-specific (hls.js, the shader canvas, ambient panels, the content-analysis
   sampler) stays in teardownWeb: this leg never mounted those. */
export function unmountPlayerChrome(controller) {
    /* Mounted by mountPlayerChrome on both legs, so it has to come down here rather than in
       teardownWeb - the stats overlay reads the media facade, not a <video>. */
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
    closeChapterListOverlay(controller);
    closeAudioSubtitlesOverlay(controller);
    clearTimeout(controller._controlsHideTimer);
    controller._controlsHideTimer = null;
    controller._controlsHovering = false;
    controller._controlButtons.forEach((b) => b.remove());
    controller._controlButtons = [];
    /* Web-only (platformTag() !== "xbox" - see chrome-transport.js's buildTransportBar):
       the fullscreen button requests fullscreen on document.documentElement, not a
       player-scoped container - leaving the player without exiting fullscreen first would
       strand the whole app fullscreen behind the now-gone player chrome. The listener lives
       on `document` too, outside the transport bar's own DOM subtree, so removing the bar
       above doesn't clean it up on its own. */
    if (controller._fullscreenChangeHandler) {
        document.removeEventListener("fullscreenchange", controller._fullscreenChangeHandler);
        document.removeEventListener("webkitfullscreenchange", controller._fullscreenChangeHandler);
        controller._fullscreenChangeHandler = null;
    }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
    /* Web-only volume flyout - appended to document.body directly (not inside the
       transport bar's own DOM box, see buildTransportBar), so it isn't swept up by the
       _controlButtons removal above either. */
    if (controller._volumePopoutEl) {
        controller._volumePopoutEl.remove();
        controller._volumePopoutEl = null;
    }
    if (controller._skipBtnEl) {
        controller._skipBtnEl.remove();
        controller._skipBtnEl = null;
    }
    controller._activeSkipMarker = null;
    if (controller._spinnerEl) {
        controller._spinnerEl.remove();
        controller._spinnerEl = null;
    }
    stopSubtitleLoop(controller);
    controller._subtitleCues = null;
    controller._subtitleRenderedKey = null;
    if (controller._subtitleOverlayEl) {
        controller._subtitleOverlayEl.remove();
        controller._subtitleOverlayEl = null;
    }
}
