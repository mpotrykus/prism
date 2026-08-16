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
import { registerNavHandler } from "./focus-nav.js";
import { lockScroll, unlockScroll } from "./scroll-lock.js";
import { detectShaderType } from "./src/player/shader/shaders.js";
import { hasNativePlayer, platformTag, plexPlatformTag, usesProgressiveStream, supportsHdr } from "./src/player/core/platform.js";
import { media } from "./src/player/core/media-facade.js";
import { buildStreamUrl, buildDecisionUrl } from "./src/player/core/stream-url.js";
import { playNative, switchNative, stopNative, pauseNative, resumeNative, buildPlaybackPayload } from "./src/player/native-bridge.js";
import { playXbox, switchXbox, stopXbox, pauseXbox, resumeXbox, reloadXboxSource } from "./src/player/xbox-bridge.js";
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
    storedAutoPlayEnabled,
    storedAutoQualityEnabled,
    AUTO_PLAY_STORAGE_KEY,
} from "./src/player/ui/shared.js";
import {
    makeControlButton,
    registerControlButton,
    showControls,
    hideControls,
    scheduleHideControls,
    buildLoadingSpinner,
    buildFloatingPlayButton,
    buildTransportBar,
    openHamburgerMenu,
    applyZoomTransform,
    closeInlineMenu,
    wireZoomPan,
    activeMarkerAt,
    skipLabelFor,
    updateSkipButton,
    playQueuedTitle,
    applyRememberedSubtitle,
    seekToAdjacentChapter,
    updateTransportBarInfo,
} from "./src/player/ui/chrome.js";
import { openEpisodeListOverlay, closeEpisodeListOverlay } from "./src/player/ui/episode-list.js";

/* native-bridge.js keeps its own local copy of this value (NATIVE_TIMELINE_PING_MS) for
   its "progress"-listener piggyback ping rather than importing it from here - see that
   file's own comment for why a circular import back into this module isn't safe here. */
const TIMELINE_PING_MS = 10000;
/* 10s per press, matching the transport bar's own +/- seek buttons. */
const NAV_SEEK_STEP_MS = 10000;
/* Long enough to absorb a burst of trigger-held repeats into one transcode restart, short enough not
   to feel like lag on a single press. */
const NAV_SEEK_COMMIT_MS = 600;
/* Once the left stick has been held in one direction for SCRUB_SPEEDUP_INTERVAL_MS straight,
   _adjustScrub jumps its per-tick step to SCRUB_MAX_SPEED_MULTIPLIER (configurable if that
   ceiling needs to move later). SCRUB_HOLD_GAP_MS is how big a gap between consecutive
   left/right nav commands still counts as "held through" rather than a fresh press - see
   _adjustScrubHoldStep's own comment for why this needs to be bigger than focus-nav.js's
   REPEAT_DELAY_MS (400ms). */
const SCRUB_SPEEDUP_INTERVAL_MS = 3000;
const SCRUB_MAX_SPEED_MULTIPLIER = 8;
const SCRUB_HOLD_GAP_MS = 500;
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
        /* Whatever object core/abr.js reads `bandwidthEstimate` off for Auto Quality -
           the hls.js instance itself on web, null on a backend that can't measure
           bandwidth. Registered via setBandwidthSource, never assigned directly. */
        this._bandwidthSource = null;
        this._nativeListenerHandles = [];
        this._pingTimer = null;
        /* Piggybacked timeline-ping throttle for native playback - see
           native-bridge.js's "progress" listener for why this exists alongside
           _pingTimer's own setInterval instead of replacing it. */
        this._lastNativeTimelinePingAt = 0;
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
        this._episodeListEl = null;
        this._episodeListCache = null;
        this._bifIndex = null;
        /* Left-stick gamepad scrub-preview state (Xbox only, see _adjustScrub/_commitScrub/
           _cancelScrub below) - _transportScrub itself is assigned by chrome-transport.js's
           buildTransportBar, rebuilt fresh each time the transport bar is. */
        this._transportScrub = null;
        this._scrubActive = false;
        this._scrubTargetMs = null;
        /* Tracks how long left/right has been held in one direction, purely for the
           speed-up in _adjustScrub - see that method's own comment. */
        this._scrubHoldDirection = 0;
        this._scrubHoldStartAt = 0;
        this._scrubHoldLastAt = 0;
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
        this._autoPlayEnabled = false;
        this._autoQualityEnabled = false;
        this._abrIntervalId = null;
        this._abrLastSwitchAt = 0;
        this._abrDowngradeStreak = 0;
        this._abrStableStreak = 0;
        this._abrHasRealSample = false;
        this._onPopState = this._onPopState.bind(this);
        /* Registered once, for the module's lifetime, and no-ops whenever nothing is playing.
           `back` applies on every platform - same effect as the visible close button. The rest is
           gated to the Xbox leg for now, because that is the only platform where the player has no
           pointer at all: the chrome is mouse/touch-driven on web, and native on Android. Without it
           a console can start playback and then reach nothing but the exit.

           Not enabled everywhere yet purely to avoid slipping a keyboard-behaviour change into the web
           player as a side effect; some equivalent (arrow-key chrome navigation, a keyboard seek
           shortcut) would be reasonable to offer there too, but that is a deliberate decision to make
           on its own. */
        registerNavHandler((command) => {
            if (!this._session) return false;
            /* Yield entirely while one of the player's own overlays is open. focus-nav.js consults every
               registered handler for the same keypress (it memoizes the cooldown on the event so no
               handler can starve another), so without this the player would act on the same press the
               open overlay is acting on: `back` would stop playback instead of closing the sheet -
               which left the chrome orphaned on screen - and up/down would scrub while also moving the
               menu selection. The convention this module is following is focus-nav.js's own: only the
               handler whose scope currently owns focus should act. */
            if (this._inlineMenuEl || this._audioSubtitlesEl || this._episodeListEl || this._chapterListEl) return false;
            if (command === "back") {
                /* B cancels an in-progress left-stick scrub instead of stopping playback -
                   only ever true on Xbox, since that's the only place _adjustScrub ever sets
                   it (see _handlePlayerNavCommand). */
                if (this._scrubActive) {
                    this._cancelScrub();
                    return true;
                }
                this.stop();
                return true;
            }
            if (platformTag() !== "xbox") return false;
            return this._handlePlayerNavCommand(command);
        });
    }

    /* Same "is playback up" test the nav handler above uses, exposed for the card's own
       app-level shortcuts (see nav.js's wireSearchToggle), which have to stay inert while
       the player overlay covers the app. */
    isOpen() {
        return !!this._session;
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
       have stop()'s history.back() unwind the first one instead). Used by
       episode-list.js's playQueuedTitle to jump to an adjacent/selected queued title
       mid-session.

       Android native takes its own path (_switchTitleNative) rather than this
       teardown-then-rebegin one - _teardownMedia's stopNative finish()es the running
       PlayerActivity, and _beginSession's _playNative would then launch a fresh one for
       the next title, a visible swipe-out/in Activity transition for what should read as
       one continuous player staying on screen. */
    async _switchTitle(item) {
        if (hasNativePlayer()) {
            await this._switchTitleNative(item);
            return;
        }
        await this._teardownMedia();
        await this._beginSession(item);
    }

    async _switchTitleNative(item) {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this._session) this._reportTimeline("stopped");
        const { streamUrl, startOffsetMs } = this._prepareSession(item);
        /* This leg reuses the transport bar mounted for the previous title (see
           _switchTitle's own comment on why native takes this in-place path instead of
           web's teardown-then-rebegin) - nothing else repaints its title/subtitle text
           for the session _prepareSession just swapped in. */
        updateTransportBarInfo(this);
        await this._switchNative(streamUrl, startOffsetMs);
        this._reportTimeline("playing");
        /* See native-bridge.js's "progress" listener for why native playback can't rely
           on _pingTimer's own setInterval below - this just avoids that listener's
           throttled piggyback ping firing again immediately for the same "playing"
           report this line already just sent. */
        this._lastNativeTimelinePingAt = Date.now();
        this._pingTimer = setInterval(() => this._reportTimeline(this._session?.state || "playing"), TIMELINE_PING_MS);
    }

    async _beginSession(item) {
        const { streamUrl, startOffsetMs } = this._prepareSession(item);
        if (hasNativePlayer()) {
            await this._playNative(streamUrl, startOffsetMs);
            /* Native's own equivalent lives in native-bridge.js's "progress" listener
               instead of right here - _videoEl exists synchronously the instant
               _playWeb below returns, but the native player isn't guaranteed ready the
               instant NativePlayer.play()'s bridge call resolves (a fresh Activity
               launch, not just an in-place title swap), so it waits for the first real
               progress tick as proof the native side actually has something to attach
               a subtitle to. */
        } else {
            this._playWeb(streamUrl, startOffsetMs);
            applyRememberedSubtitle(this);
        }
        this._reportTimeline("playing");
        /* See native-bridge.js's "progress" listener for why native playback can't rely
           on _pingTimer's own setInterval below - this just avoids that listener's
           throttled piggyback ping firing again immediately for the same "playing"
           report this line already just sent. */
        this._lastNativeTimelinePingAt = Date.now();
        this._pingTimer = setInterval(() => this._reportTimeline(this._session?.state || "playing"), TIMELINE_PING_MS);
    }

    /* The session-state build shared by a cold _beginSession and an in-place
       _switchTitleNative - everything about resolving `item` into `this._session` plus
       the per-video shader/ambient/color-boost/stats-overlay state, with no opinion on
       how playback actually gets started (native Activity launch, native in-place swap,
       or the <video>+hls.js fallback each handle that themselves). */
    _prepareSession(item) {
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
            /* The `session` query param baked into the transcode URL above - needed by
               reloadWebSource (web-fallback.js) to explicitly stop THIS transcode
               session before starting the next one on an audio/version/quality-cap
               switch. Confirmed against a real server that skipping this matters: Plex
               kept serving the still-warm old session's audio selection to an in-place
               reload even though a brand new `session` id and a successful Part-
               selection PUT were both already in place - only actually switched once
               the old session had died off (e.g. after a full stop()+replay gave it
               time to expire), so an explicit stop is what makes it immediate. */
            transcodeSessionId: sessionId,
            durationMs: item.durationMs || 0,
            lastTimeMs: startOffsetMs,
            state: "playing",
            markers: item.markers || [],
            chapters: item.chapters || [],
            bifIndexPath: item.bifIndexPath || null,
            title: item.title || "",
            episodeTitle: item.episodeTitle || null,
            year: item.year || null,
            seasonNumber: item.seasonNumber ?? null,
            episodeNumber: item.episodeNumber ?? null,
            mediaIndex: item.mediaIndex || 0,
            qualityCapKbps: item.qualityCapKbps ?? null,
            /* {mediaIndex, label} per Plex Media[] entry (see title-info.js's
               extractMediaVersions) - feeds chrome.js's in-player "Video Quality"
               menu's Version submenu, only shown there when this has more than one
               entry. */
            mediaVersions: item.mediaVersions || [],
            audioStreams,
            audioStreamId: audioStreams.find((s) => s.selected)?.id ?? null,
            /* The Part id backing audioStreams above - needed to actually apply an
               audio-track switch (see web-fallback.js's reloadWebSource and
               native-bridge.js's buildPlaybackPayload), not just request one. */
            partId: item.partId ?? null,
            /* Read from Plex's own video-stream metadata before playback starts (title-info.js's
               isHdrVideo). The Xbox leg needs it up front to switch the console's HDMI output into an
               HDR mode before the first frame - see HdrDisplayController. Harmless everywhere else. */
            isHdr: !!item.isHdr,
            /* Ordered sibling ratingKeys (a show's full episode order, or a playlist/
               collection's own order) this title came from, if any - see title-info.js's
               _getShowEpisodeQueue/_flatQueueContext. Powers the title-prev/title-next
               buttons in src/player/ui/chrome.js; null/absent means "no title nav". */
            queueRatingKeys: item.queueRatingKeys || null,
            queueIndex: item.queueIndex ?? null,
        };
        this._activeSkipMarker = null;
        /* Reset per session, not just left to differ naturally from the new ratingKey -
           replaying the exact same title later would otherwise still equal the value
           left over from that earlier playback, and native-bridge.js's progress-based
           auto-reapply check (_subtitleAutoApplyRatingKey !== session.ratingKey) would
           wrongly read that as "already handled this session" and skip it entirely. */
        this._subtitleAutoApplyRatingKey = null;

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
        this._autoPlayEnabled = storedAutoPlayEnabled();
        /* No per-video/genre concern to resolve either - see core/abr.js. Reset every
           session's own bookkeeping (not just the flag) since a brand-new transcode
           session has no relationship to whatever streak/cooldown state the previous
           title's monitor left behind. */
        this._autoQualityEnabled = storedAutoQualityEnabled();
        this._abrLastSwitchAt = 0;
        this._abrDowngradeStreak = 0;
        this._abrStableStreak = 0;
        this._abrHasRealSample = false;

        return { streamUrl, startOffsetMs };
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
        /* Reset here (not just on B/A) so a session torn down mid-scrub by some other path
           (e.g. an error, or a title switch) can't leave the next session's constructor-level
           registerNavHandler thinking a scrub is still active before it's ever pressed left/right. */
        this._scrubActive = false;
        this._scrubTargetMs = null;
        this._scrubHoldDirection = 0;
        if (this._session) {
            /* Awaited (unlike the periodic pings during playback) so Plex's own
               viewOffset/viewCount are committed before streaming-player-close fires below -
               listeners that refetch metadata on that event (e.g. title-info.js's own-item
               refresh, the card's Continue Watching row refresh) would otherwise race the
               fire-and-forget ping and read the pre-stop position. */
            await this._reportTimeline("stopped");
            if (hasNativePlayer()) {
                await (platformTag() === "xbox" ? stopXbox(this) : stopNative(this));
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
            platform: plexPlatformTag(),
            progressive: usesProgressiveStream(),
            hdr: supportsHdr(),
        });
    }

    /* Same opts shape as _buildStreamUrl above (deliberately - see buildDecisionUrl's
       own comment on why /decision and /start need identical params to agree). Used by
       web-fallback.js's reloadWebSource right before it rebuilds the stream on an audio/
       version/quality-cap switch. */
    _buildDecisionUrl(opts) {
        return buildDecisionUrl({
            ...opts,
            clientIdentifier: clientIdentifier(),
            platform: plexPlatformTag(),
            progressive: usesProgressiveStream(),
            hdr: supportsHdr(),
        });
    }

    /* The two native backends are dispatched here rather than behind one abstraction, because they
       genuinely differ in transport (Capacitor plugin vs WebView2 messages) while sharing the method
       and event NAMES - see xbox-bridge.js's header. buildPlaybackPayload is Android's, reused
       deliberately: it owns the String() coercions for Plex's numeric ids that a bridge must not lose. */
    _playNative(streamUrl, startOffsetMs) {
        if (platformTag() === "xbox") {
            return playXbox(
                this,
                streamUrl,
                startOffsetMs,
                buildPlaybackPayload(this, streamUrl, startOffsetMs),
                (url, offsetMs) => buildPlaybackPayload(this, url, offsetMs)
            );
        }
        return playNative(this, streamUrl, startOffsetMs);
    }

    _switchNative(streamUrl, startOffsetMs) {
        if (platformTag() === "xbox") {
            return switchXbox(this, streamUrl, startOffsetMs, buildPlaybackPayload(this, streamUrl, startOffsetMs));
        }
        return switchNative(this, streamUrl, startOffsetMs);
    }

    _playWeb(streamUrl, startOffsetMs) {
        return playWeb(this, streamUrl, startOffsetMs);
    }

    _attachSource(video, streamUrl) {
        return attachSource(this, video, streamUrl);
    }

    /* Restarts the Plex transcode session with new mediaIndex/qualityCapKbps/audioStreamID, or (on the
       progressive path only) a new position. Dispatches per platform because only the final "hand the
       new URL to the player" step differs - the Plex protocol sequence itself lives once in
       core/session-reload.js. Called by core/abr.js, chrome-menu.js's Version/Quality menus and
       chrome-subtitles.js's audio picker, none of which need to know which backend is playing. */
    /* Gamepad control for a player whose chrome is DOM built for mouse/touch. Standard console
       transport scheme: bumpers skip chapters, triggers rewind/fast-forward, Start opens the
       options menu, A plays/pauses, left stick traverses the scrub bar with a BIF preview (see
       _adjustScrub below) - every action reachable from the bare player screen already has its
       own dedicated button/stick, so nothing here is left for D-pad to navigate between; that's
       only meaningful once a menu/overlay is open, where wireLinearNav (focus-nav.js) already
       handles it independently of this handler (see the constructor's registerNavHandler call,
       which yields to those overlays entirely before ever reaching here).

       "back" (B) is handled one level up, in that same constructor call - it cancels an
       in-progress scrub if one is active, otherwise stops playback, but yields first to
       whichever of the player's own overlays (hamburger menu, Audio & Subtitles, episode/chapter
       list) is currently open, closing or backing that overlay up a screen instead. */
    _handlePlayerNavCommand(command) {
        const el = media(this);
        if (!el) return false;
        this._showControls();
        switch (command) {
            case "activate":
                if (this._scrubActive) {
                    this._commitScrub();
                    return true;
                }
                if (el.paused) this.resume();
                else this.pause();
                return true;
            case "left":
                this._adjustScrub(-NAV_SEEK_STEP_MS);
                return true;
            case "right":
                this._adjustScrub(NAV_SEEK_STEP_MS);
                return true;
            case "chapterPrev":
                this._seekToAdjacentChapter("prev");
                return true;
            case "chapterNext":
                this._seekToAdjacentChapter("next");
                return true;
            case "rewind":
                this._queueNavSeek(-NAV_SEEK_STEP_MS);
                return true;
            case "forward":
                this._queueNavSeek(NAV_SEEK_STEP_MS);
                return true;
            case "menu":
                if (this._menuButtonEl) this._openHamburgerMenu(this._menuButtonEl);
                return true;
            default:
                return false;
        }
    }

    /* Left-stick scrub-preview: unlike _queueNavSeek's trigger-driven coalesced jump (which
       always commits itself after a short idle), holding left/right only advances a pending
       preview position - the transport bar's BIF tooltip and seek fill move (see
       chrome-transport.js's controller._transportScrub), but video.currentTime is never
       touched until commitScrub (A). B (_cancelScrub, wired one level up in the constructor)
       drops the pending position without seeking at all. focus-nav.js already repeats
       left/right at a steady rate while the stick/D-pad is held (see its REPEATABLE_COMMANDS),
       so each call here only needs to advance by one step, not implement its own repeat timer -
       it just jumps that step to SCRUB_MAX_SPEED_MULTIPLIER once the same direction has been
       held continuously for SCRUB_SPEEDUP_INTERVAL_MS, tracked via _adjustScrubHoldStep below. */
    _adjustScrub(deltaMs) {
        const el = media(this);
        if (!el) return;
        const durationMs = (el.duration || 0) * 1000;
        const fromMs = this._scrubActive ? this._scrubTargetMs : (el.currentTime || 0) * 1000;
        const step = this._adjustScrubHoldStep(deltaMs);
        this._scrubTargetMs = Math.max(0, durationMs ? Math.min(fromMs + step, durationMs - 1000) : fromMs + step);
        this._scrubActive = true;
        this._transportScrub?.setPreview(this._scrubTargetMs);
    }

    /* Multiplies deltaMs by SCRUB_MAX_SPEED_MULTIPLIER once left/right has been held in the
       same direction for SCRUB_SPEEDUP_INTERVAL_MS straight (1x, then straight to max - no
       intermediate tiers). A gap between calls bigger than SCRUB_HOLD_GAP_MS - larger than
       focus-nav.js's own repeat cadence (REPEAT_DELAY_MS/REPEAT_RATE_MS) - means the stick was
       released and re-pressed rather than held through, so the hold timer restarts; so does a
       direction reversal. */
    _adjustScrubHoldStep(deltaMs) {
        const now = performance.now();
        const direction = deltaMs > 0 ? 1 : -1;
        const gapMs = now - this._scrubHoldLastAt;
        if (direction !== this._scrubHoldDirection || gapMs > SCRUB_HOLD_GAP_MS) {
            this._scrubHoldStartAt = now;
        }
        this._scrubHoldDirection = direction;
        this._scrubHoldLastAt = now;
        const held = now - this._scrubHoldStartAt >= SCRUB_SPEEDUP_INTERVAL_MS;
        return held ? deltaMs * SCRUB_MAX_SPEED_MULTIPLIER : deltaMs;
    }

    /* A: commits the pending scrub position - seeks there (a full transcode restart on the
       progressive/Xbox path, same as any other seek - see reloadXboxSource) and resumes
       playback if it was paused, matching "plays from the selected spot". */
    _commitScrub() {
        const el = media(this);
        const targetMs = this._scrubTargetMs;
        this._scrubActive = false;
        this._scrubTargetMs = null;
        this._scrubHoldDirection = 0;
        this._transportScrub?.endPreview();
        if (!el || targetMs == null) return;
        const wasPaused = el.paused;
        el.currentTime = targetMs / 1000;
        if (wasPaused) this.resume();
    }

    /* B: drops the pending scrub position and snaps the transport bar back to wherever
       playback actually is, without ever touching video.currentTime. */
    _cancelScrub() {
        this._scrubActive = false;
        this._scrubTargetMs = null;
        this._scrubHoldDirection = 0;
        this._transportScrub?.endPreview();
    }

    _seekToAdjacentChapter(direction) {
        return seekToAdjacentChapter(this, direction, media(this));
    }

    /* Seeks are accumulated and committed after a short idle rather than applied per press. On the
       progressive path every seek is a full Plex transcode restart (see xbox-bridge.js's
       reloadXboxSource), so holding a trigger would otherwise fire a restart per repeat and thrash
       the server - the exact orphaned-session problem the Phase 0 spikes ran into, but self-inflicted
       and once per keypress. */
    _queueNavSeek(deltaMs) {
        const el = media(this);
        if (!el) return;
        const durationMs = (el.duration || 0) * 1000;
        const fromMs = this._navSeekTargetMs != null ? this._navSeekTargetMs : (el.currentTime || 0) * 1000;
        const target = Math.max(0, durationMs ? Math.min(fromMs + deltaMs, durationMs - 1000) : fromMs + deltaMs);
        this._navSeekTargetMs = target;
        /* Reflected immediately so the scrub bar tracks each press even though the actual seek is still
           pending - otherwise the UI looks frozen for the whole coalescing window. */
        this._session.lastTimeMs = Math.round(target);
        clearTimeout(this._navSeekTimer);
        this._navSeekTimer = setTimeout(() => {
            const commitMs = this._navSeekTargetMs;
            this._navSeekTargetMs = null;
            if (commitMs != null && media(this)) media(this).currentTime = commitMs / 1000;
        }, NAV_SEEK_COMMIT_MS);
    }

    _reloadSource(overrides) {
        if (platformTag() === "xbox") {
            return reloadXboxSource(this, overrides, (streamUrl, offsetMs) =>
                buildPlaybackPayload(this, streamUrl, offsetMs)
            );
        }
        return reloadWebSource(this, overrides);
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

    /* Same "toggle IS the persisted setting" immediate-persistence model as
       _setStatsOverlayEnabled - no pipeline/DOM to rebuild, just the flag itself, read
       back by _handlePlaybackEnded below whenever a title actually finishes. */
    _setAutoPlayEnabled(enabled) {
        this._autoPlayEnabled = enabled;
        localStorage.setItem(AUTO_PLAY_STORAGE_KEY, enabled ? "1" : "0");
    }

    /* Used by web-fallback.js's <video> "ended" listener - advances to the next queued
       title (episode-list.js's playQueuedTitle) when Auto-Play is on and one exists,
       falling back to the normal stop() otherwise.
       Android's native-bridge.js doesn't go through this: PlayerActivity's own
       STATE_ENDED handler makes the same decision natively, before its own finish()
       call, using its own SharedPreferences-persisted autoPlayEnabled flag - see that
       file's "ended" listener comment for why this can't be decided reactively in JS
       there. */
    async _handlePlaybackEnded() {
        const queue = this._session?.queueRatingKeys || [];
        const index = this._session?.queueIndex ?? -1;
        if (this._autoPlayEnabled && index >= 0 && index < queue.length - 1) {
            await playQueuedTitle(this, queue, index + 1);
            return;
        }
        await this.stop();
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

    _hideControls() {
        return hideControls(this);
    }

    _scheduleHideControls() {
        return scheduleHideControls(this);
    }

    _buildLoadingSpinner(video) {
        return buildLoadingSpinner(this, video);
    }

    _buildFloatingPlayButton(video) {
        return buildFloatingPlayButton(this, video);
    }

    _buildTransportBar(video) {
        return buildTransportBar(this, video);
    }

    _openHamburgerMenu(anchor) {
        return openHamburgerMenu(this, anchor);
    }

    _openEpisodeListOverlay() {
        return openEpisodeListOverlay(this);
    }

    _closeEpisodeListOverlay() {
        return closeEpisodeListOverlay(this);
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
        if (hasNativePlayer()) {
            await (platformTag() === "xbox" ? pauseXbox() : pauseNative());
        } else {
            media(this)?.pause();
        }
    }

    async resume() {
        if (!this._session) return;
        if (hasNativePlayer()) {
            await (platformTag() === "xbox" ? resumeXbox() : resumeNative());
        } else {
            media(this)?.play();
        }
    }

    _reportTimeline(state) {
        const s = this._session;
        if (!s) return Promise.resolve();
        const url = new URL(`${s.plexUrl}/:/timeline`);
        url.searchParams.set("ratingKey", s.ratingKey);
        url.searchParams.set("key", s.key);
        url.searchParams.set("state", state);
        url.searchParams.set("time", String(s.lastTimeMs || 0));
        url.searchParams.set("duration", String(s.durationMs || 0));
        url.searchParams.set("X-Plex-Client-Identifier", clientIdentifier());
        url.searchParams.set("X-Plex-Token", s.plexToken);
        /* A dropped ping just means Plex's own "continue watching" progress is briefly
           stale, not a playback failure worth surfacing - callers that don't await this
           (every periodic ping during playback) still get that fire-and-forget behavior,
           since the returned promise already swallows its own rejection. */
        return fetch(url, { method: "GET" }).catch(() => {});
    }
}

export const player = new StreamingPlayerController();
