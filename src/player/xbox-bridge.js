/* Xbox leg of playback: the WebView2 message bridge between the JS player and the UWP shell's
   native MediaPlayer. Sibling of native-bridge.js (Android/Capacitor), deliberately mirroring its
   method and event names so the two contracts can be compared line by line and don't drift.

   Takes the StreamingPlayerController as an explicit first argument, same as every other module in
   src/player/ - see native-bridge.js's header for why.

   Two ways this differs from Android's leg, both consequences of the Phase 0 hardware spikes
   (docs/xbox-native-hdr-player/05-phase0-spike-results.md):

   1. **The chrome stays in JS.** Android re-implemented the whole player UI natively because its
      player is a separate Activity. Here the native video surface is a sibling of the WebView2 in
      one XAML page, with the WebView2 transparent on top, so the existing ~2,900 lines of chrome in
      src/player/ui/ render over native video untouched. That means this file has no equivalent of
      showEpisodeList/showSubtitleResults/showSkipButton - JS draws all of that itself.
   2. **JS keeps owning the Plex protocol.** Android had to move /:/timeline reporting into native
      Java because WebView.onPause() suspended all network loading while PlayerActivity was
      foregrounded. Measured here: JS timers and fetch keep running throughout native playback
      (nothing is ever backgrounded - there is no second Activity), so timeline reporting stays in
      plex-player.js where the rest of the Plex protocol lives. */

import { media, setMediaFacade, NativeMediaFacade } from "./core/media-facade.js";
import { notifyStall, notifyReload, setStallDrivenAbr, updateAbrMonitor } from "./core/abr.js";
import { reloadTranscodeSession } from "./core/session-reload.js";
import { mountPlayerChrome, unmountPlayerChrome } from "./ui/player-chrome.js";

function bridge() {
    return typeof window !== "undefined" ? window.chrome?.webview : null;
}

/* Every message is JSON.stringify'd rather than posted as an object. This is not stylistic: an
   object payload silently never arrives at CoreWebView2.WebMessageReceived on the Xbox WebView2
   runtime - not from app code, and not from a probe injected before any app module evaluated, with no
   error raised on either side. A string payload arrives immediately. Confirmed on hardware; see the
   spike results.

   The Android bridge's rule still applies on top of this: any Plex-sourced numeric id (partId,
   audioStreams[].id) must be String()-coerced before it crosses, because a JSON number arriving where
   a string is expected became null on the native side and cost five rounds of debugging. The payload
   is therefore built by native-bridge.js's buildPlaybackPayload and passed in by the caller, rather
   than reassembled here, so those coercions keep living in exactly one place. */
function post(method, params) {
    const wv = bridge();
    if (!wv) return;
    try {
        wv.postMessage(JSON.stringify({ method, params: params || {} }));
    } catch (e) {
        console.error("StreamingPlayer: xbox bridge post failed -", method, e);
    }
}

/* --- JS -> native. Names match native-bridge.js's NativePlayer.* surface. --- */

export function playXbox(controller, streamUrl, startOffsetMs, payload, payloadFor) {
    registerListeners(controller);
    const facade = attachFacade(controller, payloadFor);
    mountBackdrop(controller);
    /* The same chrome the web leg mounts, over native video instead of a <video> element - this is what
       the whole transparent-WebView2 architecture is for. gpuPipelines:false because the shader,
       Color Boost, ambient-lighting and content-analysis passes all read pixels out of a real <video>
       via texImage2D/drawImage, which a native surface cannot provide. */
    mountPlayerChrome(controller, facade, { gpuPipelines: false });
    /* Stall-driven rather than bandwidth-driven: the native player hands HTTP fetching to
       MediaFoundation, so there are no per-segment byte/duration callbacks to derive kbps from. See
       core/abr.js's setStallDrivenAbr. */
    setStallDrivenAbr(controller, true);
    updateAbrMonitor(controller);
    post("play", { ...payload, url: streamUrl, startPositionMs: startOffsetMs });
}

export function switchXbox(controller, streamUrl, startOffsetMs, payload) {
    /* Listeners are NOT re-registered: the native player stays alive across an in-place title swap,
       exactly as PlayerActivity does on Android, so the handlers wired up by playXbox keep firing for
       the new title. */
    post("switchTitle", { ...payload, url: streamUrl, startPositionMs: startOffsetMs });
    notifyReload(controller);
}

export function stopXbox(controller) {
    post("stop");
    /* Tears down exactly what playXbox mounted. Its absence is what left the transport bar, center
       controls and an open options sheet on screen after backing out of native playback. */
    unmountPlayerChrome(controller);
    removeListeners(controller);
    setStallDrivenAbr(controller, false);
    setMediaFacade(controller, null);
    unmountBackdrop(controller);
}

/* A transparent, full-screen element under the chrome. Two jobs: it makes the page's own background
   see-through so the native video behind the WebView2 is visible at all (the page is otherwise opaque,
   which is what made the Phase 0 overlay test initially show nothing), and it gives the chrome the
   same click-to-toggle-play and pointer-wake behaviour the <video> element provides on web. */
function mountBackdrop(controller) {
    if (controller._xboxBackdropEl) return;
    const backdrop = document.createElement("div");
    backdrop.className = "streaming-player-native-backdrop";
    Object.assign(backdrop.style, {
        position: "fixed",
        inset: "0",
        zIndex: "10000",
        background: "transparent",
    });
    backdrop.addEventListener("click", () => {
        const el = media(controller);
        if (!el) return;
        if (el.paused) el.play();
        else el.pause();
    });
    backdrop.addEventListener("mousemove", () => controller._showControls());

    /* Hiding the app's own UI is not optional here, and transparent backgrounds alone are not enough.
       On the web leg nothing ever explicitly closes the title-info overlay: playWeb's <video> is opaque
       at inset:0 and simply covers it. This leg needs the page see-through so native video is visible,
       which means the card and any open overlay would otherwise remain on screen in front of it - which
       is exactly what happened, and read as "the player never opened".

       Every current body child is hidden, saving its inline display so unmount restores it exactly.
       Done BEFORE the chrome is mounted, so the chrome's own elements (appended after) stay visible. */
    controller._xboxHiddenNodes = Array.from(document.body.children).map((el) => ({
        el,
        display: el.style.display,
    }));
    controller._xboxHiddenNodes.forEach(({ el }) => {
        el.style.display = "none";
    });

    document.body.appendChild(backdrop);
    controller._xboxSavedBodyBackground = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    /* The controls idle-fade after ~1s and the only re-show triggers on the web leg are mousemove and
       touchstart - neither of which exists on a console, where RequiresPointerMode.WhenRequested means
       there is no pointer at all. Without this the transport bar appeared, faded, and could never be
       recovered. Gamepad input reaches the page as ordinary key events (confirmed in Phase 0: WebView2
       delivers it directly, which is also why the shell's own key forwarding turned out to be dead
       code), so any keydown is the right wake signal. */
    controller._xboxWakeHandler = () => controller._showControls();
    document.addEventListener("keydown", controller._xboxWakeHandler);

    controller._xboxBackdropEl = backdrop;
}

function unmountBackdrop(controller) {
    if (controller._xboxBackdropEl) {
        controller._xboxBackdropEl.remove();
        controller._xboxBackdropEl = null;
    }
    if (controller._xboxWakeHandler) {
        document.removeEventListener("keydown", controller._xboxWakeHandler);
        controller._xboxWakeHandler = null;
    }
    if (controller._xboxHiddenNodes) {
        controller._xboxHiddenNodes.forEach(({ el, display }) => {
            el.style.display = display;
        });
        controller._xboxHiddenNodes = null;
    }
    if (controller._xboxSavedBodyBackground != null) {
        document.body.style.background = controller._xboxSavedBodyBackground;
        document.documentElement.style.background = "";
        controller._xboxSavedBodyBackground = null;
    }
}

export function pauseXbox() {
    post("pause");
}

export function resumeXbox() {
    post("resume");
}

/* The Xbox leg's rebuild step, over the same shared sequence the web leg uses
   (core/session-reload.js). Serves three callers that all need the identical thing here: the Version
   and Quality Cap menus, the audio-track picker's restart fallback, and - unlike on web - **seeking**.

   Seeking has to go through here because a Plex transcode session bakes the start position into the
   URL as `offset=`, so a progressive stream is not seekable in place: MediaPlaybackSession.CanSeek is
   false and moving the playhead means asking Plex for a new stream at a new offset. switchTitle rather
   than play, so the native player is reused in place and the page's chrome never sees a teardown. */
export function reloadXboxSource(controller, overrides = {}, payloadFor) {
    if (!controller._session) return;
    reloadTranscodeSession(controller, overrides, (streamUrl, offsetMs) => {
        post("switchTitle", { ...payloadFor(streamUrl, offsetMs), url: streamUrl, startPositionMs: offsetMs });
        /* The facade would otherwise keep interpolating from the pre-seek position until the first
           native progress tick lands, which reads as the scrubber snapping back. */
        media(controller)?.applyProgress({ positionMs: offsetMs });
    });
}

/* --- The media facade the chrome talks to --- */

/* Wires the <video>-shaped surface in core/media-facade.js to bridge calls, so the transport bar,
   scrubber, volume popout, subtitle renderer and everything else in src/player/ui/ work unchanged
   over a native player they know nothing about. */
function attachFacade(controller, payloadFor) {
    const facade = new NativeMediaFacade({
        /* Not a bridge "seek" call: see reloadXboxSource above for why a Plex progressive stream can
           only be repositioned by requesting a new one. The chrome is unaware - it just sets
           currentTime on the facade as it always has. */
        seek: (positionMs) => reloadXboxSource(controller, { startOffsetMs: positionMs }, payloadFor),
        play: () => post("resume"),
        pause: () => post("pause"),
        setVolume: (volume) => post("setVolume", { volume }),
        setMuted: (muted) => post("setMuted", { muted }),
        setPlaybackRate: (speed) => post("setPlaybackSpeed", { speed }),
    });
    setMediaFacade(controller, facade);
    return facade;
}

/* --- native -> JS --- */

function handleMessage(controller, message) {
    const facade = media(controller);
    const params = message.params || {};
    switch (message.event) {
        case "progress":
            facade?.applyProgress({
                positionMs: params.positionMs,
                durationMs: params.durationMs,
                bufferedMs: params.bufferedMs,
            });
            /* Kept as an active push from native rather than a JS interval purely out of caution: the
               measured behaviour is that JS timers survive native playback here (unlike Android), so
               plex-player.js's own _pingTimer does the timeline reporting. This tick only updates
               session position, which the timeline ping then reads. */
            if (controller._session) {
                controller._session.lastTimeMs = params.positionMs ?? controller._session.lastTimeMs;
                if (params.durationMs) controller._session.durationMs = params.durationMs;
            }
            controller._updateSkipButton?.(controller._activeMarkerAt?.(params.positionMs ?? 0));
            break;
        case "stateChanged":
            facade?.applyPaused(params.paused);
            if (controller._session) {
                controller._session.state = params.paused ? "paused" : "playing";
            }
            break;
        case "buffering":
            facade?.applyBuffering(params.buffering);
            /* A real rebuffer is the only degradation signal this backend has, and it is what drives
               a downgrade - see setStallDrivenAbr. Guarded on having played once, mirroring Android's
               everStartedPlaying, so cold-start and post-reload buffering aren't misread as stalls. */
            if (params.buffering && controller._xboxEverPlayed) notifyStall(controller);
            if (!params.buffering) controller._xboxEverPlayed = true;
            break;
        case "seeked":
            facade?.applySeeked(params.positionMs);
            break;
        case "loadedMetadata":
            facade?.applyMetadata({
                videoWidth: params.videoWidth,
                videoHeight: params.videoHeight,
                durationMs: params.durationMs,
            });
            controller._xboxIsHdr = !!params.isHdr;
            break;
        case "stats":
            /* Read by stats-overlay.js. Notably includes real colour-space/transfer state, which the
               web leg can never provide - its HDR line is hardcoded "n/a (browser)". */
            controller._xboxStats = params;
            break;
        case "ended":
            controller._handlePlaybackEnded?.();
            break;
        case "error":
            console.error("StreamingPlayer: native player error -", params.message);
            controller.stop();
            break;
        case "stopped":
            controller.stop();
            break;
        default:
            break;
    }
}

function registerListeners(controller) {
    const wv = bridge();
    if (!wv || controller._xboxMessageHandler) return;
    controller._xboxEverPlayed = false;
    controller._xboxMessageHandler = (event) => {
        let message = event.data;
        if (typeof message === "string") {
            try {
                message = JSON.parse(message);
            } catch {
                return;
            }
        }
        /* Spike-only messages share this channel while the Phase 0 harness still exists; they carry
           `type` rather than `event`, so they fall through harmlessly. */
        if (message?.event) handleMessage(controller, message);
    };
    wv.addEventListener("message", controller._xboxMessageHandler);
}

function removeListeners(controller) {
    const wv = bridge();
    if (wv && controller._xboxMessageHandler) {
        wv.removeEventListener("message", controller._xboxMessageHandler);
    }
    controller._xboxMessageHandler = null;
}
