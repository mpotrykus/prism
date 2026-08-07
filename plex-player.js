/* plex-player.js

   Shared playback module used by plex-netflix-card.js's title-info overlay Play
   button. Picks a native path (Android's NativePlayerPlugin, via Capacitor) when
   available, falling back to a full-screen <video>+hls.js overlay everywhere else
   (web, and the Xbox WebView2 shell until it has its own native bridge - WebView2 has
   no native HLS support, same limitation as desktop Chrome). Both paths report
   progress to Plex's /:/timeline endpoint from here, not from native code, so there's
   one Plex-protocol implementation instead of one per platform.

   Playback is pushed as a real history entry (see play()/`_onPopState`) rather than
   just an absolutely-positioned overlay, so the hardware/gesture back button on every
   platform (Android back gesture, browser back, eventually Xbox nav) closes it the
   same way leaving any other page would - not a separate "dismiss this popup" affordance
   the rest of the app doesn't have.

   The class below is intentionally still one StreamingPlayerController - native-bridge.js/
   web-fallback.js/shader-pipeline.js/ui/chrome.js each hold one concern's worth of
   functions that take this controller instance as an explicit first argument (see each
   file's own header comment for why), and this class keeps a same-named thin delegate
   method for every one of them so every existing internal cross-reference between
   concerns (e.g. the shader pipeline reaching into applyZoomTransform, the web fallback
   reaching into the shared control-row/menu chrome) keeps working unchanged. */
import { Capacitor } from "@capacitor/core";
import { registerNavHandler } from "./focus-nav.js";
import { lockScroll, unlockScroll } from "./scroll-lock.js";
import { detectShaderType } from "./src/player/shader/shaders.js";
import { buildStreamUrl } from "./src/player/core/stream-url.js";
import { playNative, stopNative, pauseNative, resumeNative } from "./src/player/native-bridge.js";
import { playWeb, attachSource, reloadWebSource, teardownWeb } from "./src/player/web-fallback.js";
import { setShaderStrength, setColorBoostStrength, updateShaderPipeline, ensureShaderPipeline, stopShaderLoop } from "./src/player/shader-pipeline.js";
import { setAmbientEnabled, setAmbientOpacity, updateAmbientPipeline, stopAmbientLoop } from "./src/player/ambient-pipeline.js";
import { setStatsOverlayEnabled, updateStatsOverlayPipeline } from "./src/player/stats-overlay.js";
import {
    storedAmbientEnabled,
    storedAmbientOpacity,
    storedShaderEnabled,
    storedShaderStrength,
    storedUpscaleAuto,
    storedColorBoostEnabled,
    storedColorBoostStrength,
    storedColorBoostAuto,
    storedStatsOverlayEnabled,
} from "./src/player/ui/shared.js";
import {
    makeControlButton,
    registerControlButton,
    showControls,
    scheduleHideControls,
    buildLoadingSpinner,
    buildCenterControls,
    buildTransportBar,
    openHamburgerMenu,
    applyZoomTransform,
    closeInlineMenu,
    wireZoomPan,
    activeMarkerAt,
    skipLabelFor,
    updateSkipButton,
} from "./src/player/ui/chrome.js";

const TIMELINE_PING_MS = 10000;
const CLIENT_ID_KEY = "prism_plex_client_identifier";

function clientIdentifier() {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
}

class StreamingPlayerController {
    constructor() {
        this._session = null;
        this._videoEl = null;
        this._hls = null;
        this._nativeListenerHandles = [];
        this._pingTimer = null;
        this._sleepTimer = null;
        this._pushedHistoryState = false;
        this._zoomIndex = 0;
        this._zoomPanX = 0;
        this._zoomPanY = 0;
        this._activeSkipMarker = null;
        this._skipBtnEl = null;
        this._controlButtons = [];
        this._controlsHovering = false;
        this._controlsHideTimer = null;
        this._inlineMenuEl = null;
        this._inlineMenuAnchor = null;
        this._inlineMenuCleanup = null;
        this._bifIndex = null;
        this._ambientEnabled = false;
        this._ambientOpacity = 0.5;
        this._ambientGlowContainer = null;
        this._ambientGlowPanels = null;
        this._ambientSampleCanvas = null;
        this._ambientSampleCtx = null;
        this._ambientLastSampleAt = 0;
        this._ambientRafId = null;
        this._shaderType = "off";
        this._shaderEnabled = false;
        this._shaderStrength = 0;
        this._shaderAutoType = "live_action";
        this._shaderCanvas = null;
        this._shaderGl = null;
        this._shaderPrograms = null;
        this._shaderQuadBuffer = null;
        this._shaderTexture = null;
        this._shaderRafId = null;
        this._colorBoostEnabled = false;
        this._colorBoostStrength = 0.5;
        this._upscaleAuto = false;
        this._colorBoostAuto = false;
        this._autoUpscaleStrength = null;
        this._autoColorBoostStrength = null;
        this._contentSampleCanvas = null;
        this._contentSampleCtx = null;
        this._contentLastSampleAt = 0;
        this._contentSmoothedSaturation = null;
        this._contentSmoothedEdgeEnergy = null;
        this._contentRafId = null;
        this._statsOverlayEnabled = false;
        this._statsOverlayEl = null;
        this._statsOverlayIntervalId = null;
        this._onPopState = this._onPopState.bind(this);
        /* A player has no sidenav/rows to navigate - the only D-pad/gamepad action it
           needs is an exit, same effect as the visible close button. Registered once,
           for the module's lifetime, and simply no-ops whenever nothing is playing. */
        registerNavHandler((command) => {
            if (command !== "back" || !this._session) return false;
            this.stop();
            return true;
        });
    }

    async play(item) {
        const { ratingKey, plexUrl, plexToken } = item;
        if (!ratingKey || !plexUrl || !plexToken) {
            throw new Error("StreamingPlayer.play requires ratingKey, plexUrl, and plexToken");
        }
        await this.stop();

        this._pushedHistoryState = true;
        history.pushState({ prismPlayer: true }, "", location.href);
        window.addEventListener("popstate", this._onPopState);
        /* The card's hero trailer (video/YouTube iframe) has no idea playback started
           elsewhere on the page - it isn't paused just because a full-screen video now
           covers it. Decoupled via a window event (same pattern as the rest of the app's
           cross-component wiring) rather than reaching into the card's internals directly. */
        window.dispatchEvent(new CustomEvent("streaming-player-open"));

        /* The player itself is a position:fixed overlay, not a real replacement for the
           card underneath it - the card's own content (taller than one viewport, see
           host-reset.css's --hero-h) still leaves <html> scrollable behind it otherwise,
           showing a scrollbar and letting wheel/touch input scroll the hidden page while
           the player is up. Unlocked in _stopInternal. */
        lockScroll();

        await this._beginSession(item);
    }

    /* Tears down whatever's currently playing and starts a new title in its place
       without touching the pushed history entry or the hero-trailer open/close events -
       those belong to the player overlay's own lifecycle, not to any one title inside
       it, so calling play() again here would wrongly push a second history entry (and
       have stop()'s history.back() unwind the first one instead). Used by the title-nav
       prev/next buttons (see chrome.js's seekToAdjacentTitle) to jump to an adjacent
       queued title mid-session. */
    async _switchTitle(item) {
        await this._teardownMedia();
        await this._beginSession(item);
    }

    async _beginSession(item) {
        const { ratingKey, plexUrl, plexToken } = item;
        const key = item.key || `/library/metadata/${ratingKey}`;
        const sessionId = crypto.randomUUID();
        const startOffsetMs = item.startOffsetMs || 0;
        const streamUrl = this._buildStreamUrl({
            plexUrl,
            plexToken,
            key,
            sessionId,
            startOffsetMs,
            mediaIndex: item.mediaIndex || 0,
            qualityCapKbps: item.qualityCapKbps ?? null,
        });
        const audioStreams = item.audioStreams || [];
        this._session = {
            ratingKey,
            key,
            plexUrl,
            plexToken,
            durationMs: item.durationMs || 0,
            lastTimeMs: startOffsetMs,
            state: "playing",
            markers: item.markers || [],
            chapters: item.chapters || [],
            bifIndexPath: item.bifIndexPath || null,
            title: item.title || "",
            year: item.year || null,
            seasonNumber: item.seasonNumber ?? null,
            episodeNumber: item.episodeNumber ?? null,
            mediaIndex: item.mediaIndex || 0,
            qualityCapKbps: item.qualityCapKbps ?? null,
            audioStreams,
            audioStreamId: audioStreams.find((s) => s.selected)?.id ?? null,
            /* Ordered sibling ratingKeys (a show's full episode order, or a playlist/
               collection's own order) this title came from, if any - see title-info.js's
               _getShowEpisodeQueue/_flatQueueContext. Powers the title-prev/title-next
               buttons in src/player/ui/chrome.js; null/absent means "no title nav". */
            queueRatingKeys: item.queueRatingKeys || null,
            queueIndex: item.queueIndex ?? null,
        };
        this._activeSkipMarker = null;

        /* detectShaderType still resolves fresh per-video from this title's own genre
           tags - the only part of this that's genuinely per-video. shaderEnabled/
           shaderStrength/upscaleAuto below follow the same immediate-persistence model
           as colorBoostEnabled/colorBoostStrength/colorBoostAuto just below - whatever
           the in-player menu was last set to (see shader-pipeline.js's setUpscaleMode/
           setColorBoostMode), not a Settings-modal default reset every video. */
        this._shaderAutoType = detectShaderType(item.genres);
        this._shaderEnabled = storedShaderEnabled();
        this._shaderStrength = storedShaderStrength();
        /* _upscaleAuto has to be read before resolving _shaderType below - in Auto mode
           the manual strength is irrelevant to whether the shader is "off" (see
           shader-pipeline.js's resolveShaderType), so this order matters, not just the
           values themselves. */
        this._upscaleAuto = storedUpscaleAuto();
        this._shaderType = this._shaderEnabled && (this._upscaleAuto || this._shaderStrength > 0) ? this._shaderAutoType : "off";
        this._autoUpscaleStrength = null;
        /* Unlike the shader fields above, ambient lighting has no per-video/genre
           concern to resolve here - storedAmbientEnabled() is the whole answer, the
           same on-disk source of truth the in-player toggle writes back to (see
           ambient-pipeline.js's setAmbientEnabled). */
        this._ambientEnabled = storedAmbientEnabled();
        this._ambientOpacity = storedAmbientOpacity();
        /* Same no-per-video-concern reasoning as ambient lighting above - Color Boost's
           contrast/saturation lift has nothing genre-specific to resolve either. */
        this._colorBoostEnabled = storedColorBoostEnabled();
        this._colorBoostStrength = storedColorBoostStrength();
        this._colorBoostAuto = storedColorBoostAuto();
        this._autoColorBoostStrength = null;
        this._statsOverlayEnabled = storedStatsOverlayEnabled();

        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
            await this._playNative(streamUrl, startOffsetMs);
        } else {
            this._playWeb(streamUrl, startOffsetMs);
        }
        this._reportTimeline("playing");
        this._pingTimer = setInterval(() => this._reportTimeline(this._session?.state || "playing"), TIMELINE_PING_MS);
    }

    async stop() {
        return this._stopInternal({ viaHistoryPop: false });
    }

    _onPopState() {
        this._stopInternal({ viaHistoryPop: true });
    }

    /* The media/chrome teardown shared by a full stop() and a mid-session title switch -
       everything EXCEPT the sleep timer and the overlay-level scroll-lock/open-close
       event, which belong to the player session as a whole rather than to whichever
       title happens to be playing inside it right now (see _switchTitle/_stopInternal). */
    async _teardownMedia() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this._session) {
            this._reportTimeline("stopped");
            if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
                await stopNative(this);
            } else {
                this._teardownWeb();
            }
            this._session = null;
        }
    }

    async _stopInternal({ viaHistoryPop }) {
        clearTimeout(this._sleepTimer);
        this._sleepTimer = null;
        const wasPlaying = !!this._session;
        await this._teardownMedia();
        if (wasPlaying) {
            unlockScroll();
            window.dispatchEvent(new CustomEvent("streaming-player-close"));
        }
        if (this._pushedHistoryState) {
            window.removeEventListener("popstate", this._onPopState);
            this._pushedHistoryState = false;
            /* Only pop history ourselves when *we* initiated the stop (e.g. playback ended,
               an error closed the player) - if the user's own back action got us here,
               the browser already popped this entry and calling history.back() again would
               navigate one screen too far. */
            if (!viaHistoryPop) history.back();
        }
    }

    _buildStreamUrl(opts) {
        return buildStreamUrl({
            ...opts,
            clientIdentifier: clientIdentifier(),
            platform: Capacitor.isNativePlatform() ? "Android" : "Chrome",
        });
    }

    _playNative(streamUrl, startOffsetMs) {
        return playNative(this, streamUrl, startOffsetMs);
    }

    _playWeb(streamUrl, startOffsetMs) {
        return playWeb(this, streamUrl, startOffsetMs);
    }

    _attachSource(video, streamUrl) {
        return attachSource(this, video, streamUrl);
    }

    _reloadWebSource(newStreamId) {
        return reloadWebSource(this, newStreamId);
    }

    _teardownWeb() {
        return teardownWeb(this);
    }

    _setShaderStrength(strength) {
        return setShaderStrength(this, strength);
    }

    _updateShaderPipeline() {
        return updateShaderPipeline(this);
    }

    _ensureShaderPipeline() {
        return ensureShaderPipeline(this);
    }

    _stopShaderLoop() {
        return stopShaderLoop(this);
    }

    _setAmbientEnabled(enabled) {
        return setAmbientEnabled(this, enabled);
    }

    _setAmbientOpacity(opacity) {
        return setAmbientOpacity(this, opacity);
    }

    _setColorBoostStrength(strength) {
        return setColorBoostStrength(this, strength);
    }

    _setStatsOverlayEnabled(enabled) {
        return setStatsOverlayEnabled(this, enabled);
    }

    _updateStatsOverlayPipeline() {
        return updateStatsOverlayPipeline(this);
    }

    _updateAmbientPipeline() {
        return updateAmbientPipeline(this);
    }

    _stopAmbientLoop() {
        return stopAmbientLoop(this);
    }

    _makeControlButton(opts) {
        return makeControlButton(opts);
    }

    _registerControlButton(el, opts) {
        return registerControlButton(this, el, opts);
    }

    _showControls() {
        return showControls(this);
    }

    _scheduleHideControls() {
        return scheduleHideControls(this);
    }

    _buildLoadingSpinner(video) {
        return buildLoadingSpinner(this, video);
    }

    _buildCenterControls(video) {
        return buildCenterControls(this, video);
    }

    _buildTransportBar(video) {
        return buildTransportBar(this, video);
    }

    _openHamburgerMenu(anchor) {
        return openHamburgerMenu(this, anchor);
    }

    _applyZoomTransform() {
        return applyZoomTransform(this);
    }

    _closeInlineMenu() {
        return closeInlineMenu(this);
    }

    _wireZoomPan() {
        return wireZoomPan(this);
    }

    _activeMarkerAt(timeMs) {
        return activeMarkerAt(this, timeMs);
    }

    _skipLabelFor(marker) {
        return skipLabelFor(marker);
    }

    _updateSkipButton(marker) {
        return updateSkipButton(this, marker);
    }

    async pause() {
        if (!this._session) return;
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
            await pauseNative();
        } else if (this._videoEl) {
            this._videoEl.pause();
        }
    }

    async resume() {
        if (!this._session) return;
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
            await resumeNative();
        } else if (this._videoEl) {
            this._videoEl.play();
        }
    }

    _reportTimeline(state) {
        const s = this._session;
        if (!s) return;
        const url = new URL(`${s.plexUrl}/:/timeline`);
        url.searchParams.set("ratingKey", s.ratingKey);
        url.searchParams.set("key", s.key);
        url.searchParams.set("state", state);
        url.searchParams.set("time", String(s.lastTimeMs || 0));
        url.searchParams.set("duration", String(s.durationMs || 0));
        url.searchParams.set("X-Plex-Client-Identifier", clientIdentifier());
        url.searchParams.set("X-Plex-Token", s.plexToken);
        /* Fire-and-forget: a dropped timeline ping just means Plex's own "continue
           watching" progress is briefly stale, not a playback failure worth surfacing. */
        fetch(url, { method: "GET" }).catch(() => {});
    }
}

export const player = new StreamingPlayerController();
