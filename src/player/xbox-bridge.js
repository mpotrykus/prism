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
/* Circular with shader-pipeline.js/content-analysis.js/ambient-pipeline.js (each imports a "post"
   helper from this file; this file imports their "update"/"apply" functions back) - safe for the
   same "function-body-only reference" reason documented in each of those files' own import
   comments. */
import { updateShaderPipeline } from "./shader-pipeline.js";
import { updateContentAnalysis, applyXboxContentAnalysis } from "./content-analysis.js";
import { updateAmbientPipeline, applyXboxAmbientColors, teardownAmbient } from "./ambient-pipeline.js";

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
       the whole transparent-WebView2 architecture is for. gpuPipelines:false because shader-pipeline.js's
       WebGL canvas and content-analysis.js's 2D canvas both read pixels out of a real <video> via
       texImage2D/drawImage, which a native surface cannot provide - ShaderVideoEffect
       (uwp/PrismUwpEffects) does that work natively instead (see the three calls below). */
    mountPlayerChrome(controller, facade, { gpuPipelines: false });
    /* Mirrors mountPlayerChrome's own gpuPipelines-gated startup calls (web) - applies whatever
       shader/Color-Boost/ambient/auto settings were already resolved from storage in play(), so a
       session that starts with an effect already on takes effect immediately rather than waiting
       for the viewer to open the Effects menu. Each of these three internally branches on Xbox to
       relay settings over the bridge instead of building a canvas. */
    updateShaderPipeline(controller);
    updateAmbientPipeline(controller);
    updateContentAnalysis(controller);
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
       controls and an open options sheet on screen after backing out of native playback. Ambient's
       glow panels are torn down explicitly here (not inside unmountPlayerChrome, which is shared
       with a leg that never mounts them) - see teardownAmbient's own comment for why web instead
       tears them down from teardownWeb. */
    unmountPlayerChrome(controller);
    teardownAmbient(controller);
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
    controller._xboxWakeHandler = () => {
        /* Gamepad D-pad input reaches the page as ordinary keydown events (see comment above), which
           means navigating the More sheet/episode list/etc with the gamepad fires this on every
           press. Without this guard it would re-show the transport bar out from under whichever
           overlay openHamburgerMenu's hideControls() just hid it for - the same overlay set
           scheduleHideControls already keys off in chrome-controls.js. */
        if (controller._inlineMenuEl || controller._episodeListEl || controller._chapterListEl || controller._audioSubtitlesEl) return;
        controller._showControls();
    };
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

/* --- JS -> native, Effects (shader-pipeline.js/ambient-pipeline.js call these; see each file's
   own postXboxShaderSettings/postXboxColorBoostSettings/updateAmbientPipeline). Native's
   ShaderVideoEffect keeps its own copy of these values (EffectSettings, uwp/PrismUwpEffects) -
   see that class's own header comment for why settings flow this way rather than through
   MediaPlayer.AddVideoEffect's IPropertySet. --- */

export function postShaderEffect({ enabled, shaderType, strength, auto }) {
    post("setShaderEffect", { enabled, shaderType, strength, auto });
}

/* Saturation and Contrast are fully independent now (own enabled/auto, own Auto|On|Off mode
   - see shader-pipeline.js's postXboxColorBoostSettings) - no shared "enabled"/"auto" left to
   send, just the two components' own pairs. */
export function postColorBoost({ saturationEnabled, contrastEnabled, saturationStrength, contrastStrength, saturationAuto, contrastAuto }) {
    post("setColorBoost", { saturationEnabled, contrastEnabled, saturationStrength, contrastStrength, saturationAuto, contrastAuto });
}

export function postAmbientLighting(enabled) {
    post("setAmbientLighting", { enabled });
}

/* "HDR - Stay On During Playback" (settings.js, Xbox-only) - makes NativePlayerHost.Play and
   SwitchTitle switch the display to (or keep it in) HDR10 for every title in a playback session,
   not just genuinely HDR ones, so SDR video also gets Microsoft's documented SDR-in-HDR-mode
   auto-boost and a binge session's TV never renegotiates between an HDR and SDR episode.
   Deliberately does NOT touch Stop (always a return to the dashboard) or app suspend/background -
   real hardware testing found the WebView2 app chrome's contrast blows out while the display sits
   in HDR10, which Microsoft's own Xbox HDR doc actually documents as expected for app UI, so the
   display always restores to SDR the moment playback ends, keeping that exposure scoped to active
   playback only. Sent from app.js at boot and again on every settings save - never from inside a
   playback session, since the Settings modal lives in the card DOM, which is hidden for the whole
   duration of native Xbox playback (see mountBackdrop above). */
export function postAlwaysOnHdr(enabled) {
    post("setAlwaysOnHdr", { enabled });
}

/* Loudness normalization (see audio-leveling.js's updateAudioLevelingPipeline, which posts this
   instead of building a Web Audio graph on this leg - there is no <video> element here to hook
   one onto). Native counterpart: AudioLevelingEffect (PrismUwpEffects), attached to the
   MediaPlayer unconditionally for the whole session by NativePlayerHost's constructor - this
   message only flips whether it actually adjusts gain, same "always attached, just no-ops when
   off" shape as the video effect pipeline. UNVERIFIED ON REAL HARDWARE - see that C# class's own
   header comment for the two specific things to check when testing this on a console/PC. */
export function postAudioLeveling(enabled) {
    post("setAudioLeveling", { enabled });
}

/* preset is the family key ("anime4k"/"live_action", i.e. controller._shaderAutoType) - native
   maps it to its own anime4k_cnn/live_action_fsr chain, mirroring how upgradeTo resolves the same
   family key on the web leg. See shader-pipeline.js's postXboxAiUpscalingSettings. */
export function postAiUpscaling({ enabled, preset }) {
    post("setAiUpscaling", { enabled, preset });
}

/* "fit"/"cover"/"stretch" - see chrome-menu-options.js's applyFitMode. There is no
   controller._videoEl on this leg to set a CSS object-fit on, so the equivalent
   (MediaPlayerElement.Stretch) is applied natively instead - see
   NativePlayerHost.SetStretch. */
export function postAspectMode(mode) {
    post("setStretch", { mode });
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

/* Local, in-place audio-track switch for a direct-played title (see stream-url.js's
   resolvePlaybackUrl) - no session/URL rebuild, mirroring web-fallback.js's
   trySwitchAudioTrackLocal for the transcode/HLS case, but via NativePlayerHost's own
   MediaPlaybackItem.AudioTracks (see PlayerBridge.cs's "switchAudioTrackLocally" case)
   since there is no hls.js object on this leg at all. Only attempted during direct play -
   the existing transcode-path audio switch (via _reloadSource) is already
   hardware-confirmed and untouched by this.

   Maps by Stream ORDER, not id - the local player's AudioTracks list has its own index,
   unrelated to Plex's own stream ids. Unverified against a real multi-audio-track file
   that Plex's Part.Stream order always matches the container's own track order - see
   this feature's own risk notes. Returns whether the local switch was even attempted
   (fire-and-forget over the bridge - there is no reply confirming the native side found a
   matching index), so a genuine mismatch is only visible as "audio didn't change",
   nothing worse. */
export function trySwitchAudioTrackLocallyXbox(controller, audioStreamID) {
    const s = controller._session;
    if (!s || !s.isDirectPlay) return false;
    const streams = s.audioStreams || [];
    const index = streams.findIndex((stream) => stream.id === audioStreamID);
    if (index < 0) return false;
    post("switchAudioTrackLocally", { index });
    s.audioStreamId = audioStreamID;
    /* Fire-and-forget, same as trySwitchAudioTrackLocal's own PUT - keeps Plex's
       server-side "selected" bookkeeping in sync for other clients/the next launch. */
    if (s.partId) {
        const putUrl = new URL(`${s.plexUrl}/library/parts/${s.partId}`);
        putUrl.searchParams.set("audioStreamID", String(audioStreamID));
        putUrl.searchParams.set("allParts", "1");
        putUrl.searchParams.set("X-Plex-Token", s.plexToken);
        fetch(putUrl, { method: "PUT" }).catch(() => {});
    }
    return true;
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
        case "aiUpscaleStatus":
            /* From AiUpscaleFrameServer - the web leg's own _shaderChains (what
               stats-overlay.js's aiUpscalingStatusLine normally checks) is never built on Xbox,
               so native reports its own state here instead. See stats-overlay.js's
               xboxAiUpscalingStatusLine. */
            controller._xboxAiUpscaleStatus = params;
            break;
        case "effectLoadStatus":
            /* From ShaderVideoEffect's own windowed fps/avgFrameMs (Sharpening/Color Boost/
               Ambient's pipeline) - see stats-overlay.js's xboxFrameLoadLine. Distinct from
               aiUpscaleStatus above: this pipeline is attached whenever EffectSettings.ShouldAttach
               is true, independent of whether AI Upscaling's separate frame-server pipeline is
               running at all. */
            controller._xboxEffectLoadStatus = params;
            break;
        case "contentAnalysis":
            applyXboxContentAnalysis(controller, params.avgSaturation, params.edgeEnergy, params.lumaStdDev);
            break;
        case "ambientColors":
            applyXboxAmbientColors(controller, {
                top: params.top,
                bottom: params.bottom,
                left: params.left,
                right: params.right,
            });
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
