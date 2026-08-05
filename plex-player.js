/* plex-player.js (window.StreamingPlayer)

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
   the rest of the app doesn't have. */
import { Capacitor, registerPlugin } from "@capacitor/core";
import Hls from "hls.js";
import { registerNavHandler } from "./focus-nav.js";
import "./opensubtitles.js";

const NativePlayer = registerPlugin("NativePlayer");
const TIMELINE_PING_MS = 10000;
const CLIENT_ID_KEY = "prism_plex_client_identifier";
const CONTROLS_HIDE_DELAY_MS = 1000;
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];
const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60];
const ZOOM_LEVELS = [1, 1.25, 1.5, 2];

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
        this._inlineMenuCleanup = null;
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
            title: item.title || "",
            year: item.year || null,
            seasonNumber: item.seasonNumber ?? null,
            episodeNumber: item.episodeNumber ?? null,
        };
        this._activeSkipMarker = null;

        this._pushedHistoryState = true;
        history.pushState({ prismPlayer: true }, "", location.href);
        window.addEventListener("popstate", this._onPopState);
        /* The card's hero trailer (video/YouTube iframe) has no idea playback started
           elsewhere on the page - it isn't paused just because a full-screen video now
           covers it. Decoupled via a window event (same pattern as the rest of the app's
           cross-component wiring) rather than reaching into the card's internals directly. */
        window.dispatchEvent(new CustomEvent("streaming-player-open"));

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

    async _stopInternal({ viaHistoryPop }) {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        clearTimeout(this._sleepTimer);
        this._sleepTimer = null;
        if (this._session) {
            this._reportTimeline("stopped");
            if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
                this._nativeListenerHandles.forEach((h) => h.remove());
                this._nativeListenerHandles = [];
                try {
                    await NativePlayer.stop();
                } catch (e) {
                    // the native player may already be closed (user backed out of PlayerActivity)
                }
            } else {
                this._teardownWeb();
            }
            this._session = null;
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

    _buildStreamUrl({ plexUrl, plexToken, key, sessionId, startOffsetMs, mediaIndex = 0, partIndex = 0, qualityCapKbps = null }) {
        const url = new URL(`${plexUrl}/video/:/transcode/universal/start.m3u8`);
        url.searchParams.set("path", key);
        url.searchParams.set("mediaIndex", String(mediaIndex));
        url.searchParams.set("partIndex", String(partIndex));
        url.searchParams.set("protocol", "hls");
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
        url.searchParams.set("subtitleSize", "100");
        url.searchParams.set("audioBoost", "100");
        /* maxVideoBitrate is the best-known candidate for this Plex endpoint's bitrate-cap
           param but unconfirmed against a real request from this codebase - verify via
           Plex Web's own network tab before relying on this for anything user-facing. */
        if (qualityCapKbps) url.searchParams.set("maxVideoBitrate", String(qualityCapKbps));
        url.searchParams.set("offset", String(Math.floor(startOffsetMs / 1000)));
        url.searchParams.set("session", sessionId);
        url.searchParams.set("X-Plex-Client-Identifier", clientIdentifier());
        url.searchParams.set("X-Plex-Product", "Prism");
        url.searchParams.set("X-Plex-Version", "1.0");
        url.searchParams.set("X-Plex-Platform", Capacitor.isNativePlatform() ? "Android" : "Chrome");
        url.searchParams.set("X-Plex-Token", plexToken);
        return url.toString();
    }

    async _playNative(streamUrl, startOffsetMs) {
        this._nativeListenerHandles.push(
            await NativePlayer.addListener("progress", ({ positionMs, durationMs }) => {
                if (!this._session) return;
                this._session.lastTimeMs = positionMs;
                if (durationMs) this._session.durationMs = durationMs;
                const marker = this._activeMarkerAt(positionMs);
                if (marker !== this._activeSkipMarker) {
                    this._activeSkipMarker = marker;
                    if (marker) {
                        NativePlayer.showSkipButton({ label: this._skipLabelFor(marker), seekToMs: marker.endTimeOffset ?? 0 });
                    } else {
                        NativePlayer.hideSkipButton();
                    }
                }
            })
        );
        this._nativeListenerHandles.push(
            await NativePlayer.addListener("ended", () => this.stop())
        );
        this._nativeListenerHandles.push(
            await NativePlayer.addListener("error", ({ message }) => {
                console.error("StreamingPlayer: native playback error -", message);
                this.stop();
            })
        );
        this._nativeListenerHandles.push(
            await NativePlayer.addListener("stopped", () => this.stop())
        );
        await NativePlayer.play({
            url: streamUrl,
            startPositionMs: startOffsetMs,
            /* Native code only ever sees {title, startTimeOffsetMs} - it doesn't need to
               know Plex's own Chapter field names, keeping that one Plex-protocol
               interpretation here instead of duplicated into Java. */
            chapters: (this._session.chapters || []).map((c) => ({
                title: c.title || c.tag || "",
                startTimeOffsetMs: c.startTimeOffset ?? 0,
            })),
        });
    }

    _playWeb(streamUrl, startOffsetMs) {
        const video = document.createElement("video");
        video.className = "streaming-player-video";
        video.controls = false;
        video.autoplay = true;
        Object.assign(video.style, {
            position: "fixed",
            inset: "0",
            width: "100%",
            height: "100%",
            background: "#000",
            zIndex: "10000",
        });
        video.addEventListener("timeupdate", () => {
            if (!this._session) return;
            this._session.lastTimeMs = Math.round(video.currentTime * 1000);
            if (video.duration) this._session.durationMs = Math.round(video.duration * 1000);
            const marker = this._activeMarkerAt(this._session.lastTimeMs);
            if (marker !== this._activeSkipMarker) this._updateSkipButton(marker);
        });
        video.addEventListener("ended", () => this.stop());
        video.addEventListener("pause", () => {
            if (this._session) this._session.state = "paused";
        });
        video.addEventListener("play", () => {
            if (this._session) this._session.state = "playing";
        });
        video.addEventListener("error", () => {
            const err = video.error;
            console.error("StreamingPlayer: <video> error -", err?.code, err?.message);
            this.stop();
        });

        if (streamUrl.includes(".m3u8") && !video.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
            const hls = new Hls();
            hls.on(Hls.Events.ERROR, (event, data) => {
                console.error("StreamingPlayer: hls.js error -", data.type, data.details, data.fatal ? "(fatal)" : "");
                if (data.fatal) this.stop();
            });
            hls.loadSource(streamUrl);
            hls.attachMedia(video);
            this._hls = hls;
        } else {
            video.src = streamUrl;
        }
        video.currentTime = startOffsetMs / 1000;
        document.body.appendChild(video);
        this._videoEl = video;
        this._buildLoadingSpinner(video);

        /* Not just a convenience: on the Xbox WebView2 shell there's no browser chrome
           and no back button to fall back on at all, so an explicit close control isn't
           optional the way it might seem on desktop web. */
        const closeBtn = this._makeControlButton({
            ariaLabel: "Close player",
            content: "✕",
            onClick: () => this.stop(),
        });
        this._registerControlButton(closeBtn);

        /* Every custom option (speed, sleep timer, zoom, chapters, subtitles) lives behind
           this single button instead of one circular button each - see _openHamburgerMenu.
           Opposite corner from the close button, matching the Android leg's layout
           (hamburger top-left, close top-right). */
        const menuBtn = this._makeControlButton({
            ariaLabel: "Player options",
            content: "☰",
            onClick: () => this._openHamburgerMenu(menuBtn),
        });
        this._registerControlButton(menuBtn, { side: "left" });

        this._zoomIndex = 0;
        this._zoomPanX = 0;
        this._zoomPanY = 0;
        this._sleepMinutes = 0;
        this._wireZoomPan();
        this._buildCenterControls(video);
        this._buildTransportBar(video);

        /* Tapping the video itself toggles play/pause, matching every mainstream player -
           only when not zoomed in, since zoomed-in drag is already claimed by pan (see
           _wireZoomPan) and would otherwise fight this for the same gesture. */
        video.addEventListener("click", () => {
            if (ZOOM_LEVELS[this._zoomIndex] > 1) return;
            if (video.paused) video.play();
            else video.pause();
        });

        /* Mirrors how native player chrome behaves - visible on activity, fades after a
           few seconds idle. This custom chrome (transport bar + top buttons) replaces
           video.controls entirely now, so it owns show/hide itself rather than trying to
           piggyback on the browser's own (now-disabled) control bar. */
        video.addEventListener("mousemove", () => this._showControls());
        video.addEventListener("touchstart", () => this._showControls());
        this._scheduleHideControls();
    }

    /* One 44px circular button matching this player's existing inline-style chrome
       convention. Doesn't position or register itself - callers pass the result to
       _registerControlButton so every button shares one fade timer instead of each
       reinventing idle-hide logic (see the removed per-button version this replaced). */
    _makeControlButton({ ariaLabel, content, onClick }) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = content;
        btn.setAttribute("aria-label", ariaLabel);
        Object.assign(btn.style, {
            position: "fixed",
            top: "20px",
            zIndex: "10001",
            width: "44px",
            height: "44px",
            borderRadius: "50%",
            border: "none",
            background: "rgba(20,20,20,0.7)",
            color: "#fff",
            fontSize: "16px",
            cursor: "pointer",
            opacity: "1",
            transition: "opacity 0.25s ease",
        });
        if (onClick) btn.addEventListener("click", onClick);
        return btn;
    }

    /* Registers an element into the shared fade-timer row: anchored to the given corner
       (stacking further from the edge as more buttons join that same side) unless
       anchor:false (used by the full-width transport bar, which positions itself), and
       wired so hovering/focusing *any* registered element keeps the whole row visible -
       not just itself - matching how a single physical control bar behaves. */
    _registerControlButton(el, { anchor = true, side = "right" } = {}) {
        if (anchor) {
            const stacked = this._controlButtons.filter((b) => b.dataset.anchorSide === side).length;
            el.dataset.anchorSide = side;
            el.style[side] = `${20 + stacked * 56}px`;
        }
        this._controlButtons.push(el);
        document.body.appendChild(el);
        const onEnter = () => {
            this._controlsHovering = true;
            clearTimeout(this._controlsHideTimer);
            this._showControls();
        };
        const onLeave = () => {
            this._controlsHovering = false;
            this._scheduleHideControls();
        };
        el.addEventListener("mouseenter", onEnter);
        el.addEventListener("focus", onEnter);
        el.addEventListener("mouseleave", onLeave);
        el.addEventListener("blur", onLeave);
        return el;
    }

    _showControls() {
        this._controlButtons.forEach((b) => {
            b.style.opacity = "1";
            b.style.pointerEvents = "auto";
        });
        this._scheduleHideControls();
    }

    /* pointerEvents is toggled alongside opacity, not just opacity alone - a faded-out
       transport bar spanning the full screen width would otherwise still intercept clicks
       (opacity:0 doesn't remove a hit target), swallowing taps on the video underneath that
       are meant to toggle play/pause or reshow the controls. */
    _scheduleHideControls() {
        clearTimeout(this._controlsHideTimer);
        if (this._controlsHovering) return;
        this._controlsHideTimer = setTimeout(() => {
            this._controlButtons.forEach((b) => {
                b.style.opacity = "0";
                b.style.pointerEvents = "none";
            });
        }, CONTROLS_HIDE_DELAY_MS);
    }

    /* Buffering indicator - independent of the idle-fade control row (same "contextual,
       not ambient chrome" reasoning as the skip button): it reflects actual network/decode
       state, not user activity, so it has to stay visible even while the rest of the
       chrome has faded out from inactivity. pointerEvents:none so it never blocks clicks
       on the center play/pause button or video underneath it while overlapping them. */
    _buildLoadingSpinner(video) {
        if (!document.getElementById("streaming-player-spinner-style")) {
            const style = document.createElement("style");
            style.id = "streaming-player-spinner-style";
            style.textContent = "@keyframes streaming-player-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }";
            document.head.appendChild(style);
        }

        const spinner = document.createElement("div");
        Object.assign(spinner.style, {
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: "10002",
            width: "48px",
            height: "48px",
            borderRadius: "50%",
            border: "4px solid rgba(255,255,255,0.25)",
            borderTopColor: "#fff",
            animation: "streaming-player-spin 0.8s linear infinite",
            pointerEvents: "none",
        });
        document.body.appendChild(spinner);
        this._spinnerEl = spinner;

        const show = () => {
            spinner.style.display = "block";
        };
        const hide = () => {
            spinner.style.display = "none";
        };
        video.addEventListener("waiting", show);
        video.addEventListener("seeking", show);
        video.addEventListener("playing", hide);
        video.addEventListener("canplay", hide);
        video.addEventListener("pause", hide);
        video.addEventListener("seeked", () => {
            if (!video.paused) hide();
        });
        show();
    }

    /* Center overlay: play/pause flanked by previous/next-chapter buttons, matching
       YouTube's mobile layout - only built when the session actually has chapters, same
       "never an empty/dead affordance" rule the hamburger's Chapters entry follows. */
    _buildCenterControls(video) {
        const row = document.createElement("div");
        Object.assign(row.style, {
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: "10001",
            display: "flex",
            alignItems: "center",
            gap: "24px",
            opacity: "1",
            transition: "opacity 0.25s ease",
        });

        const chapters = this._session?.chapters || [];
        if (chapters.length) row.appendChild(this._makeChapterNavButton("prev", video));

        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.setAttribute("aria-label", "Play/Pause");
        Object.assign(playBtn.style, {
            width: "64px",
            height: "64px",
            borderRadius: "50%",
            border: "none",
            background: "rgba(20,20,20,0.55)",
            color: "#fff",
            fontSize: "24px",
            cursor: "pointer",
        });
        const syncPlayIcon = () => {
            playBtn.textContent = video.paused ? "▶" : "⏸";
        };
        syncPlayIcon();
        playBtn.addEventListener("click", () => {
            if (video.paused) video.play();
            else video.pause();
        });
        video.addEventListener("play", syncPlayIcon);
        video.addEventListener("pause", syncPlayIcon);
        row.appendChild(playBtn);

        if (chapters.length) row.appendChild(this._makeChapterNavButton("next", video));

        this._registerControlButton(row, { anchor: false });
        return row;
    }

    _makeChapterNavButton(direction, video) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("aria-label", direction === "prev" ? "Previous chapter" : "Next chapter");
        btn.textContent = direction === "prev" ? "⏮" : "⏭";
        Object.assign(btn.style, {
            width: "48px",
            height: "48px",
            borderRadius: "50%",
            border: "none",
            background: "rgba(20,20,20,0.55)",
            color: "#fff",
            fontSize: "18px",
            cursor: "pointer",
        });
        btn.addEventListener("click", () => this._seekToAdjacentChapter(direction, video));
        return btn;
    }

    /* "Previous" restarts the current chapter once more than a few seconds into it (rather
       than always jumping two chapters at once) - the same convention as prev-track buttons
       on physical media remotes. */
    _seekToAdjacentChapter(direction, video) {
        const chapters = this._session?.chapters || [];
        if (!chapters.length) return;
        const position = video.currentTime * 1000;
        if (direction === "next") {
            const next = chapters.find((c) => (c.startTimeOffset ?? 0) > position);
            if (next) video.currentTime = (next.startTimeOffset ?? 0) / 1000;
            return;
        }
        let current = null;
        let previous = null;
        for (const c of chapters) {
            if ((c.startTimeOffset ?? 0) <= position) {
                previous = current;
                current = c;
            } else break;
        }
        if (current && position - (current.startTimeOffset ?? 0) > 3000) {
            video.currentTime = (current.startTimeOffset ?? 0) / 1000;
        } else {
            video.currentTime = (previous?.startTimeOffset ?? 0) / 1000;
        }
    }

    /* Bottom transport bar: scrub bar and elapsed/total time - replaces the browser's
       native <video controls> chrome (disabled in _playWeb) so the transport looks and
       behaves the same on every platform instead of whatever bar the host browser/OS
       ships. Registered anchor:false since it spans the full width itself rather than
       stacking as a small right-anchored button like the others. */
    _buildTransportBar(video) {
        const bar = document.createElement("div");
        Object.assign(bar.style, {
            position: "fixed",
            left: "0",
            right: "0",
            bottom: "0",
            zIndex: "10001",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "10px 20px",
            background: "linear-gradient(transparent, rgba(0,0,0,0.75))",
            opacity: "1",
            transition: "opacity 0.25s ease",
            boxSizing: "border-box",
        });

        const timeCurrent = document.createElement("span");
        const timeDuration = document.createElement("span");
        [timeCurrent, timeDuration].forEach((el) => {
            Object.assign(el.style, {
                flex: "0 0 auto",
                color: "#fff",
                fontSize: "13px",
                fontFamily: '"Roboto", sans-serif',
                fontVariantNumeric: "tabular-nums",
            });
        });
        timeCurrent.textContent = "0:00";
        timeDuration.textContent = "0:00";

        /* The lingering focus ring on a <input type=range> lives on its internal
           ::-webkit-slider-thumb/::-moz-range-thumb shadow part, not the input element
           itself - setting outline:none as an inline style on the input can't reach it, it
           has to come from a real stylesheet rule. Chromium's own form-control refresh also
           draws this ring via box-shadow rather than outline, so both need resetting. */
        if (!document.getElementById("streaming-player-seek-style")) {
            const style = document.createElement("style");
            style.id = "streaming-player-seek-style";
            style.textContent = `
                .streaming-player-seek, .streaming-player-seek:focus, .streaming-player-seek:focus-visible {
                    outline: none;
                    box-shadow: none;
                }
                .streaming-player-seek::-webkit-slider-thumb { outline: none; box-shadow: none; }
                .streaming-player-seek::-moz-range-thumb { outline: none; box-shadow: none; }
                .streaming-player-seek::-moz-focus-outer { border: 0; }
            `;
            document.head.appendChild(style);
        }

        const seek = document.createElement("input");
        seek.type = "range";
        seek.className = "streaming-player-seek";
        seek.min = "0";
        seek.max = "1000";
        seek.value = "0";
        /* #e5a00d matches the app's existing amber accent (see plex-netflix-card.js's
           poster/title-info progress bars) rather than the browser-default white fill. */
        Object.assign(seek.style, { flex: "1 1 auto", accentColor: "#e5a00d", cursor: "pointer" });

        /* Scrubbing is tracked so the timeupdate-driven sync below doesn't fight the
           user's own drag - without it, every timeupdate tick would snap the thumb back
           to the actual playback position mid-drag. */
        let scrubbing = false;
        seek.addEventListener("pointerdown", () => {
            scrubbing = true;
        });
        const endScrub = () => {
            scrubbing = false;
        };
        seek.addEventListener("pointerup", endScrub);
        seek.addEventListener("pointercancel", endScrub);
        seek.addEventListener("input", () => {
            if (!video.duration) return;
            const time = (Number(seek.value) / 1000) * video.duration;
            video.currentTime = time;
            timeCurrent.textContent = this._formatTime(time);
        });

        video.addEventListener("timeupdate", () => {
            if (scrubbing || !video.duration) return;
            seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
            timeCurrent.textContent = this._formatTime(video.currentTime);
        });
        const syncDuration = () => {
            timeDuration.textContent = this._formatTime(video.duration || 0);
        };
        video.addEventListener("durationchange", syncDuration);
        video.addEventListener("loadedmetadata", syncDuration);

        bar.appendChild(timeCurrent);
        bar.appendChild(seek);
        bar.appendChild(timeDuration);
        document.body.appendChild(bar);
        this._registerControlButton(bar, { anchor: false });
        return bar;
    }

    _formatTime(seconds) {
        const total = Math.max(0, Math.floor(seconds || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
    }

    /* Every custom option lives behind one hamburger button instead of one circular
       button each (see _playWeb) - this is its top-level list; each entry either opens a
       submenu (with its own "← Back" row back to here) or, for subtitles, the search panel. */
    _openHamburgerMenu(anchor) {
        const rate = this._session?.playbackRate || 1;
        const zoomLevel = ZOOM_LEVELS[this._zoomIndex];
        const items = [
            { label: `Playback Speed  (${rate}x)`, onSelect: () => this._openSpeedMenu(anchor) },
            {
                label: `Sleep Timer${this._sleepMinutes ? `  (${this._sleepMinutes}m)` : ""}`,
                onSelect: () => this._openSleepMenu(anchor),
            },
            { label: `Zoom  (${zoomLevel}x)`, onSelect: () => this._openZoomMenu(anchor) },
        ];
        if (this._session?.chapters?.length) {
            items.push({ label: "Chapters", onSelect: () => this._openChapterMenu(anchor) });
        }
        items.push({ label: "Subtitles", onSelect: () => this._openSubtitleSearch(anchor) });
        this._openInlineMenu({ anchor, items });
    }

    _openSpeedMenu(anchor) {
        const current = this._session?.playbackRate || 1;
        this._openInlineMenu({
            anchor,
            items: [
                { label: "← Back", onSelect: () => this._openHamburgerMenu(anchor) },
                ...PLAYBACK_RATES.map((rate) => ({
                    label: `${rate}x${rate === current ? "  ✓" : ""}`,
                    onSelect: () => this._setPlaybackRate(rate),
                })),
            ],
        });
    }

    async _setPlaybackRate(rate) {
        if (!this._session) return;
        this._session.playbackRate = rate;
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
            await NativePlayer.setPlaybackSpeed({ speed: rate });
        } else if (this._videoEl) {
            this._videoEl.playbackRate = rate;
        }
    }

    _openSleepMenu(anchor) {
        this._openInlineMenu({
            anchor,
            items: [
                { label: "← Back", onSelect: () => this._openHamburgerMenu(anchor) },
                { label: `Off${!this._sleepMinutes ? "  ✓" : ""}`, onSelect: () => this._setSleepTimer(0) },
                ...SLEEP_TIMER_PRESETS_MIN.map((min) => ({
                    label: `${min} min${this._sleepMinutes === min ? "  ✓" : ""}`,
                    onSelect: () => this._setSleepTimer(min * 60000),
                })),
                { label: "End of episode", onSelect: () => this._setSleepTimer(0) },
            ],
        });
    }

    /* ms=0 clears any pending timer - used by both "Off" (don't pause early) and "End of
       episode" (rely on the existing `ended` handling instead of a timer at all). */
    _setSleepTimer(ms) {
        clearTimeout(this._sleepTimer);
        this._sleepTimer = ms > 0 ? setTimeout(() => this.pause(), ms) : null;
        this._sleepMinutes = ms > 0 ? Math.round(ms / 60000) : 0;
    }

    _openZoomMenu(anchor) {
        this._openInlineMenu({
            anchor,
            items: [
                { label: "← Back", onSelect: () => this._openHamburgerMenu(anchor) },
                ...ZOOM_LEVELS.map((level, idx) => ({
                    label: `${level}x${idx === this._zoomIndex ? "  ✓" : ""}`,
                    onSelect: () => {
                        this._zoomIndex = idx;
                        this._zoomPanX = 0;
                        this._zoomPanY = 0;
                        this._applyZoomTransform();
                    },
                })),
            ],
        });
    }

    _applyZoomTransform() {
        if (!this._videoEl) return;
        const scale = ZOOM_LEVELS[this._zoomIndex];
        this._videoEl.style.transform = `translate(${this._zoomPanX}px, ${this._zoomPanY}px) scale(${scale})`;
    }

    /* Pan only engages once zoomed past 1x, and only within the padding introduced by
       that zoom - clamped against the video's own unscaled box size so the frame can
       never be dragged edge-past-edge and leave black space. */
    _wireZoomPan() {
        const video = this._videoEl;
        if (!video) return;
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        video.addEventListener("pointerdown", (e) => {
            if (ZOOM_LEVELS[this._zoomIndex] <= 1) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            originX = this._zoomPanX;
            originY = this._zoomPanY;
            video.setPointerCapture(e.pointerId);
        });
        video.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const scale = ZOOM_LEVELS[this._zoomIndex];
            const maxX = ((scale - 1) * video.clientWidth) / 2;
            const maxY = ((scale - 1) * video.clientHeight) / 2;
            this._zoomPanX = Math.max(-maxX, Math.min(maxX, originX + (e.clientX - startX)));
            this._zoomPanY = Math.max(-maxY, Math.min(maxY, originY + (e.clientY - startY)));
            this._applyZoomTransform();
        });
        const endDrag = () => {
            dragging = false;
        };
        video.addEventListener("pointerup", endDrag);
        video.addEventListener("pointercancel", endDrag);
    }

    /* Reuses _openInlineMenu (same scrollable tap-to-pick list as the speed/sleep-timer
       presets) rather than a bespoke list UI - title + timestamp only, no thumbnails,
       per this feature's scope. Only offered from the hamburger menu when the session
       actually has chapters (see _openHamburgerMenu), so there's never an empty list. */
    _openChapterMenu(anchor) {
        this._openInlineMenu({
            anchor,
            items: [
                { label: "← Back", onSelect: () => this._openHamburgerMenu(anchor) },
                ...(this._session?.chapters || []).map((chapter) => ({
                    label: this._chapterLabel(chapter),
                    onSelect: () => {
                        if (this._videoEl) this._videoEl.currentTime = (chapter.startTimeOffset ?? 0) / 1000;
                    },
                })),
            ],
        });
    }

    _chapterLabel(chapter) {
        const time = this._formatTime((chapter.startTimeOffset ?? 0) / 1000);
        const title = chapter.title || chapter.tag || "";
        return title ? `${time}  ${title}` : time;
    }

    /* Lives in the player chrome, not the title-info modal - subtitle search is
       realistically a mid-playback action ("I'm already watching, there's no subs, let
       me search") more than a pre-playback picker step. Reuses the anchor/menu-cleanup
       bookkeeping _openInlineMenu already tracks, even though this panel has an input
       and dynamic results rather than a fixed item list. */
    _openSubtitleSearch(anchor) {
        this._closeInlineMenu();
        const rect = anchor.getBoundingClientRect();
        const panel = document.createElement("div");
        Object.assign(panel.style, {
            position: "fixed",
            top: `${rect.bottom + 8}px`,
            right: `${window.innerWidth - rect.right}px`,
            zIndex: "10002",
            background: "rgba(20,20,20,0.95)",
            borderRadius: "8px",
            padding: "12px",
            width: "280px",
            maxHeight: "60vh",
            overflowY: "auto",
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
            boxSizing: "border-box",
        });

        const backBtn = document.createElement("button");
        backBtn.type = "button";
        backBtn.textContent = "← Back";
        Object.assign(backBtn.style, {
            display: "block",
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.7)",
            fontSize: "12px",
            cursor: "pointer",
            padding: "0 0 8px",
        });
        backBtn.addEventListener("click", () => this._openHamburgerMenu(anchor));
        panel.appendChild(backBtn);

        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Search subtitles…";
        input.value = this._session?.title || "";
        Object.assign(input.style, {
            width: "100%",
            padding: "8px 10px",
            borderRadius: "6px",
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(255,255,255,0.06)",
            color: "#fff",
            fontSize: "13px",
            marginBottom: "8px",
            boxSizing: "border-box",
        });

        const searchBtn = document.createElement("button");
        searchBtn.type = "button";
        searchBtn.textContent = "Search";
        Object.assign(searchBtn.style, {
            width: "100%",
            padding: "8px",
            marginBottom: "10px",
            borderRadius: "6px",
            border: "none",
            background: "#fff",
            color: "#161619",
            fontSize: "13px",
            fontWeight: "600",
            cursor: "pointer",
        });

        const resultsEl = document.createElement("div");
        resultsEl.style.fontSize = "13px";
        resultsEl.style.color = "rgba(255,255,255,0.7)";

        const runSearch = async () => {
            if (!input.value.trim()) {
                resultsEl.textContent = "Type something to search for.";
                return;
            }
            resultsEl.textContent = "Searching…";
            try {
                const results = await window.StreamingSubtitles.search({
                    title: input.value,
                    year: this._session?.year,
                    seasonNumber: this._session?.seasonNumber,
                    episodeNumber: this._session?.episodeNumber,
                });
                resultsEl.innerHTML = "";
                if (!results.length) {
                    resultsEl.textContent = "No results.";
                    return;
                }
                results.forEach((r) => {
                    const row = document.createElement("button");
                    row.type = "button";
                    row.textContent = `${r.label} (${r.languageCode})`;
                    Object.assign(row.style, {
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 10px",
                        background: "transparent",
                        color: "#fff",
                        border: "none",
                        borderRadius: "6px",
                        cursor: "pointer",
                        fontSize: "13px",
                        marginBottom: "4px",
                    });
                    row.addEventListener("mouseenter", () => {
                        row.style.background = "rgba(255,255,255,0.12)";
                    });
                    row.addEventListener("mouseleave", () => {
                        row.style.background = "transparent";
                    });
                    row.addEventListener("click", () => this._applySubtitleResult(r, row));
                    resultsEl.appendChild(row);
                });
            } catch (e) {
                resultsEl.textContent = e.message;
            }
        };
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") runSearch();
        });
        searchBtn.addEventListener("click", runSearch);

        panel.appendChild(input);
        panel.appendChild(searchBtn);
        panel.appendChild(resultsEl);
        document.body.appendChild(panel);
        this._inlineMenuEl = panel;
        input.focus();

        const onOutsideClick = (e) => {
            if (panel.contains(e.target) || anchor.contains(e.target)) return;
            this._closeInlineMenu();
        };
        setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
        this._inlineMenuCleanup = () => document.removeEventListener("click", onOutsideClick);

        if (input.value) runSearch();
    }

    /* rowEl gets an inline status update on failure instead of the previous
       console.error-only handling - a swallowed error here looked indistinguishable
       from "the click didn't register" since nothing on screen ever changed. */
    async _applySubtitleResult(result, rowEl) {
        const originalLabel = rowEl?.textContent;
        if (rowEl) {
            rowEl.textContent = "Applying…";
            rowEl.disabled = true;
        }
        try {
            if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
                const link = await window.StreamingSubtitles.resolveDownloadLink(result.fileId);
                await NativePlayer.setSubtitle({ url: link, languageCode: result.languageCode, mimeType: "application/x-subrip" });
            } else {
                const srtText = await window.StreamingSubtitles.download(result.fileId);
                this._attachSubtitleTrack(srtText, result.languageCode, result.label);
            }
            this._closeInlineMenu();
        } catch (e) {
            console.error("StreamingPlayer: subtitle download failed -", e);
            if (rowEl) {
                rowEl.disabled = false;
                rowEl.textContent = `${originalLabel} — failed: ${e.message}`;
            }
        }
    }

    /* Only the web/Xbox leg needs this - <video><track> requires WebVTT, while Android's
       Media3 leg (see _applySubtitleResult) hands ExoPlayer the raw .srt URL directly,
       since SubripDecoder parses .srt natively and converting it there would be wasted
       work. Revokes the previous track's blob URL rather than leaking one per search. */
    _attachSubtitleTrack(srtText, langCode, label) {
        if (!this._videoEl) return;
        if (this._subtitleTrackUrl) URL.revokeObjectURL(this._subtitleTrackUrl);
        const vtt = this._srtToVtt(srtText);
        const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        this._subtitleTrackUrl = url;
        this._videoEl.querySelectorAll("track").forEach((t) => t.remove());
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.srclang = langCode || "en";
        track.label = label || langCode || "Subtitles";
        track.src = url;
        track.default = true;
        this._videoEl.appendChild(track);
        if (this._videoEl.textTracks[0]) this._videoEl.textTracks[0].mode = "showing";
    }

    _srtToVtt(srtText) {
        return "WEBVTT\n\n" + srtText.replace(/\r+/g, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
    }

    /* Shared by both playback paths so the marker-range check isn't duplicated even
       though web/native render totally different skip-button UI. Assumes Plex's Marker
       objects use startTimeOffset/endTimeOffset in ms, consistent with duration/viewOffset
       elsewhere in this codebase - unverified against a real response, see this phase's
       open risks. */
    _activeMarkerAt(timeMs) {
        const markers = this._session?.markers || [];
        return markers.find((m) => timeMs >= (m.startTimeOffset ?? 0) && timeMs <= (m.endTimeOffset ?? 0)) || null;
    }

    _skipLabelFor(marker) {
        return marker?.type === "credits" ? "Skip Credits" : "Skip Intro";
    }

    /* Bottom-center, separate from the top-right fading control row (matching where
       Plex/Netflix conventionally put this) - force-shown for as long as a marker is
       active rather than joining the idle-fade timer, since it's a contextual action
       ("this is available right now"), not ambient chrome. */
    _updateSkipButton(marker) {
        this._activeSkipMarker = marker;
        if (!marker) {
            if (this._skipBtnEl) this._skipBtnEl.style.display = "none";
            return;
        }
        if (!this._skipBtnEl) {
            const btn = document.createElement("button");
            btn.type = "button";
            Object.assign(btn.style, {
                position: "fixed",
                bottom: "110px",
                right: "40px",
                zIndex: "10001",
                padding: "10px 20px",
                borderRadius: "6px",
                border: "none",
                background: "rgba(20,20,20,0.85)",
                color: "#fff",
                fontSize: "14px",
                fontWeight: "600",
                cursor: "pointer",
            });
            btn.addEventListener("click", () => {
                if (this._videoEl && this._activeSkipMarker) {
                    this._videoEl.currentTime = (this._activeSkipMarker.endTimeOffset ?? 0) / 1000;
                }
            });
            document.body.appendChild(btn);
            this._skipBtnEl = btn;
        }
        this._skipBtnEl.textContent = this._skipLabelFor(marker);
        this._skipBtnEl.style.display = "block";
    }

    async pause() {
        if (!this._session) return;
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
            await NativePlayer.pause();
        } else if (this._videoEl) {
            this._videoEl.pause();
        }
    }

    async resume() {
        if (!this._session) return;
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
            await NativePlayer.resume();
        } else if (this._videoEl) {
            this._videoEl.play();
        }
    }

    /* Shared by every control button that needs a small tap-to-pick list (speed presets,
       sleep timer presets, and future picker buttons) instead of each building its own
       floating menu. Only one menu is ever open at a time. */
    _openInlineMenu({ anchor, items }) {
        this._closeInlineMenu();
        const rect = anchor.getBoundingClientRect();
        const menu = document.createElement("div");
        Object.assign(menu.style, {
            position: "fixed",
            top: `${rect.bottom + 8}px`,
            right: `${window.innerWidth - rect.right}px`,
            zIndex: "10002",
            background: "rgba(20,20,20,0.92)",
            borderRadius: "8px",
            padding: "6px",
            minWidth: "140px",
            maxHeight: "60vh",
            overflowY: "auto",
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
        });
        items.forEach((item) => {
            const row = document.createElement("button");
            row.type = "button";
            row.textContent = item.label;
            Object.assign(row.style, {
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                background: "transparent",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "14px",
            });
            row.addEventListener("mouseenter", () => {
                row.style.background = "rgba(255,255,255,0.12)";
            });
            row.addEventListener("mouseleave", () => {
                row.style.background = "transparent";
            });
            row.addEventListener("click", () => {
                item.onSelect();
                this._closeInlineMenu();
            });
            menu.appendChild(row);
        });
        document.body.appendChild(menu);
        this._inlineMenuEl = menu;

        const onOutsideClick = (e) => {
            if (menu.contains(e.target) || anchor.contains(e.target)) return;
            this._closeInlineMenu();
        };
        /* Deferred by a tick so the same click that opened this menu (which is already
           bubbling toward document) doesn't immediately close it again. */
        setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
        this._inlineMenuCleanup = () => document.removeEventListener("click", onOutsideClick);
    }

    _closeInlineMenu() {
        if (this._inlineMenuCleanup) {
            this._inlineMenuCleanup();
            this._inlineMenuCleanup = null;
        }
        if (this._inlineMenuEl) {
            this._inlineMenuEl.remove();
            this._inlineMenuEl = null;
        }
    }

    _teardownWeb() {
        if (this._hls) {
            this._hls.destroy();
            this._hls = null;
        }
        this._closeInlineMenu();
        clearTimeout(this._controlsHideTimer);
        this._controlsHideTimer = null;
        this._controlsHovering = false;
        this._controlButtons.forEach((b) => b.remove());
        this._controlButtons = [];
        if (this._skipBtnEl) {
            this._skipBtnEl.remove();
            this._skipBtnEl = null;
        }
        this._activeSkipMarker = null;
        if (this._spinnerEl) {
            this._spinnerEl.remove();
            this._spinnerEl = null;
        }
        if (this._subtitleTrackUrl) {
            URL.revokeObjectURL(this._subtitleTrackUrl);
            this._subtitleTrackUrl = null;
        }
        if (this._videoEl) {
            this._videoEl.pause();
            this._videoEl.remove();
            this._videoEl = null;
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

window.StreamingPlayer = new StreamingPlayerController();