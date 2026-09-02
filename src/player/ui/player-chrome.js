import { updateContentAnalysis } from "../content-analysis.js";
import { closeEpisodeListOverlay, closeChapterListOverlay } from "./episode-list.js";
import { closeAudioSubtitlesOverlay, stopSubtitleLoop } from "./chrome-subtitles.js";
import { teardownSeekFlash } from "./chrome-transport.js";
import { ensurePlayerStyles } from "./styles.js";
import { usesGamepadChrome } from "../core/platform.js";
import { makeControlButton, registerControlButton, buildLoadingSpinner, scheduleHideControls } from "./chrome-controls.js";
import { buildTransportBar, buildFloatingPlayButton } from "./chrome-transport.js";
import { openHamburgerMenu, closeInlineMenu } from "./chrome-menu.js";
import { updateShaderPipeline } from "../shader-pipeline.js";
import { updateAmbientPipeline } from "../ambient-pipeline.js";
import { updateAudioLevelingPipeline } from "../audio-leveling.js";
import { updateAutoCropPipeline } from "../auto-crop.js";
import { updateStatsOverlayPipeline } from "../stats-overlay.js";

/* Circular with web-fallback.js (which imports mountPlayerChrome/unmountPlayerChrome from here, while
   chrome-subtitles.js above imports trySwitchAudioTrackLocal from it) - safe for the same reason the
   other cycles in this directory are: every reference across the cycle is used inside a function body
   at call time, never at module-evaluation time. */

/* Mounts the player's on-screen chrome: the idle-fade control row (close + options), the transport
   bar, the floating center play/pause button, the buffering spinner, and the per-session pipelines.

   Shared by the web and Xbox legs, which is the whole point of the Xbox architecture: the native
   video surface is a sibling of a transparent WebView2 in one XAML page, so everything in this
   directory renders over it unchanged rather than being re-implemented natively the way Android
   had to.

   `mediaEl` is whatever core/media-facade.js registered - the real <video> on web, a
   NativeMediaFacade on Xbox. Nothing below uses DOM specifics, only the <video>-shaped surface.

   `gpuPipelines` is false on a native backend: shader upscaling, Color Boost, ambient lighting and
   the content-analysis sampler all read pixels out of a real <video> (texImage2D/drawImage), which
   a native surface can't provide. The stats overlay is mounted either way - it's plain DOM reading
   the facade. */
export function mountPlayerChrome(controller, mediaEl, { gpuPipelines }) {
    ensurePlayerStyles();
    buildLoadingSpinner(controller, mediaEl);

    /* Not just a convenience: on the Xbox WebView2 shell there's no browser chrome and no back button
       to fall back on at all, so an explicit close control isn't optional the way it might seem on
       desktop web. Styled as a back chevron, top-left, rather than an "✕" - same close-the-player
       action, just matching where a streaming app's own back affordance normally sits. */
    const closeBtn = makeControlButton({
        ariaLabel: "Close player",
        content: "‹",
        onClick: () => controller.stop(),
    });
    registerControlButton(controller, closeBtn, { side: "left" });

    /* Every custom option (speed, sleep timer, zoom, chapters, subtitles) lives behind this single
       button instead of one circular button each - see openHamburgerMenu. Opposite corner from the
       close button. Toggles closed on a second tap - re-opening would otherwise be the only reachable
       outcome of tapping this button again, since openHamburgerMenu (like every submenu) closes and
       immediately rebuilds the flyout rather than no-op'ing when one is already open. */
    const menuBtn = makeControlButton({
        ariaLabel: "Player options",
        content: "☰",
        onClick: () => {
            if (controller._inlineMenuEl && controller._inlineMenuAnchor === menuBtn) {
                closeInlineMenu(controller);
            } else {
                openHamburgerMenu(controller, menuBtn);
            }
        },
    });
    registerControlButton(controller, menuBtn, { side: "right" });
    /* Kept on the controller so gamepad navigation can open this menu without a pointer - it is the
       only route to Chapters/Version/Quality/Effects/Options, so on a console it has to be reachable
       from a button press. See player.js's nav handler. */
    controller._menuButtonEl = menuBtn;

    controller._fitMode = "fit";
    controller._sleepMinutes = 0;
    buildTransportBar(controller, mediaEl);
    /* Gamepad-chrome only (real Xbox, not PC - see usesGamepadChrome()) - web builds its own
       in-row play/pause instead (see chrome-transport.js's buildCenterControls, called from
       within buildTransportBar), so there's never two play/pause buttons on screen at once. */
    if (usesGamepadChrome()) buildFloatingPlayButton(controller, mediaEl);

    /* Spacebar play/pause - web/Android/PC only, same "mouse+keyboard vs. gamepad-only" split
       as the floating-vs-in-row play button above. Excludes BUTTON so this doesn't
       double-toggle when a play/pause button itself has focus (space already activates a
       focused button's own click on keyup), and INPUT/TEXTAREA/SELECT so it doesn't hijack
       the seek bar, volume slider, or the subtitle search box. */
    if (!usesGamepadChrome()) {
        controller._spacebarHandler = (e) => {
            if (e.code !== "Space" && e.key !== " ") return;
            const tag = e.target?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
            e.preventDefault();
            if (mediaEl.paused) mediaEl.play();
            else mediaEl.pause();
        };
        document.addEventListener("keydown", controller._spacebarHandler);
    }

    if (gpuPipelines) {
        /* _shaderType/_shaderStrength were already resolved in play() (global setting + this title's
           auto-detected type) before this ran - this just spins up the WebGL pipeline for that starting
           state, same as any other change made through the hamburger menu later in the session. */
        updateShaderPipeline(controller);
        /* Same "already-resolved global default, just spin up the pipeline" reasoning as the shader call
           above - controller._ambientEnabled was set from storedAmbientEnabled() in play(). */
        updateAmbientPipeline(controller);
        /* Same reasoning - controller._upscaleAuto/_colorBoostSaturationAuto/
           _colorBoostContrastAuto were set from storedUpscaleAuto()/
           storedColorBoostSaturationAuto()/storedColorBoostContrastAuto() in play(). */
        updateContentAnalysis(controller);
        /* Same reasoning - controller._audioLevelingEnabled was set from
           storedAudioLevelingEnabled() in play(). Needs a real <video> element
           (AudioContext.createMediaElementSource), same as shader/ambient above, so it
           belongs behind this same gpuPipelines gate rather than the stats overlay's
           unconditional call below. */
        updateAudioLevelingPipeline(controller);
        /* Same reasoning - controller._autoCropEnabled was set from storedAutoCropEnabled()
           in play(), but unlike the flags above there's no remembered per-video state to
           resume here: detection itself (not just spinning up an existing pipeline) only
           starts once this call runs, since it needs the real <video> element to sample a
           frame from. */
        updateAutoCropPipeline(controller);
    }
    /* Same reasoning - controller._statsOverlayEnabled was set from storedStatsOverlayEnabled() in
       play(). Reads the facade, so it works on either backend. */
    updateStatsOverlayPipeline(controller);

    scheduleHideControls(controller);
}

/* Removes everything mountPlayerChrome put on screen, plus the overlays and transient bits the
   chrome can spawn during a session. Shared for the same reason the mount is: both legs must tear
   down exactly what they mounted. Without it the Xbox leg left the transport bar, center controls
   and any open options sheet on screen after backing out - the player "closed" but its UI stayed.

   Everything <video>- or GPU-specific (hls.js, the shader canvas, ambient panels, the
   content-analysis sampler) stays in teardownWeb: this leg never mounted those. */
export function unmountPlayerChrome(controller) {
    /* Lives on `document`, outside this chrome's own DOM subtree, so removing the buttons
       below wouldn't clean it up on its own - same reasoning as the fullscreenchange
       listener further down. */
    if (controller._spacebarHandler) {
        document.removeEventListener("keydown", controller._spacebarHandler);
        controller._spacebarHandler = null;
    }
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
    closeInlineMenu(controller);
    closeEpisodeListOverlay(controller);
    closeChapterListOverlay(controller);
    closeAudioSubtitlesOverlay(controller);
    clearTimeout(controller._controlsHideTimer);
    controller._controlsHideTimer = null;
    controller._controlsHovering = false;
    controller._controlButtons.forEach((b) => b.remove());
    controller._controlButtons = [];
    /* Mouse/hover chrome only (!usesGamepadChrome() - see chrome-transport.js's
       buildTransportBar): the fullscreen button requests fullscreen on document.documentElement, not a
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
    /* Appended to document.body directly by chrome-skip.js's ensureSkipButtonEl (kept out
       of the idle-fade control row on purpose - see that file's header comment), so it
       isn't swept up by the _controlButtons removal above either. */
    if (controller._skipBtnEl) {
        controller._skipBtnEl.remove();
        controller._skipBtnEl = null;
    }
    teardownSeekFlash(controller);
    controller._activeSkipMarker = null;
    controller._autoSkippedMarker = null;
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
