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

const NativePlayer = registerPlugin("NativePlayer");
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
        this._pushedHistoryState = false;
        this._onPopState = this._onPopState.bind(this);
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
        const streamUrl = this._buildStreamUrl({ plexUrl, plexToken, key, sessionId, startOffsetMs });
        this._session = {
            ratingKey,
            key,
            plexUrl,
            plexToken,
            durationMs: item.durationMs || 0,
            lastTimeMs: startOffsetMs,
            state: "playing",
        };

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

    _buildStreamUrl({ plexUrl, plexToken, key, sessionId, startOffsetMs }) {
        const url = new URL(`${plexUrl}/video/:/transcode/universal/start.m3u8`);
        url.searchParams.set("path", key);
        url.searchParams.set("mediaIndex", "0");
        url.searchParams.set("partIndex", "0");
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
        await NativePlayer.play({ url: streamUrl, startPositionMs: startOffsetMs });
    }

    _playWeb(streamUrl, startOffsetMs) {
        const video = document.createElement("video");
        video.className = "streaming-player-video";
        video.controls = true;
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

        /* Not just a convenience: on the Xbox WebView2 shell there's no browser chrome
           and no back button to fall back on at all, so an explicit close control isn't
           optional the way it might seem on desktop web. */
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.setAttribute("aria-label", "Close player");
        Object.assign(closeBtn.style, {
            position: "fixed",
            top: "20px",
            right: "20px",
            zIndex: "10001",
            width: "44px",
            height: "44px",
            borderRadius: "50%",
            border: "none",
            background: "rgba(20,20,20,0.7)",
            color: "#fff",
            fontSize: "18px",
            cursor: "pointer",
            opacity: "1",
            transition: "opacity 0.25s ease",
        });
        closeBtn.addEventListener("click", () => this.stop());
        document.body.appendChild(closeBtn);
        this._closeBtnEl = closeBtn;

        /* Mirrors how native player chrome (and the browser's own <video controls>) behaves -
           visible on activity, fades after a few seconds idle. video.controls hides its own
           bar this way already but exposes no event for it, so this button fades on its own
           timer instead of trying to sync with that. Hovering the button itself cancels the
           timer outright rather than just resetting it, so it never fades mid-hover. */
        const HIDE_DELAY_MS = 1000;
        this._closeBtnHovering = false;
        const scheduleHide = () => {
            clearTimeout(this._closeBtnHideTimer);
            if (this._closeBtnHovering) return;
            this._closeBtnHideTimer = setTimeout(() => {
                if (this._closeBtnEl) this._closeBtnEl.style.opacity = "0";
            }, HIDE_DELAY_MS);
        };
        const showCloseBtn = () => {
            if (this._closeBtnEl) this._closeBtnEl.style.opacity = "1";
            scheduleHide();
        };
        closeBtn.addEventListener("mouseenter", () => {
            this._closeBtnHovering = true;
            clearTimeout(this._closeBtnHideTimer);
            closeBtn.style.opacity = "1";
        });
        closeBtn.addEventListener("mouseleave", () => {
            this._closeBtnHovering = false;
            scheduleHide();
        });
        video.addEventListener("mousemove", showCloseBtn);
        video.addEventListener("touchstart", showCloseBtn);
        scheduleHide();
    }

    _teardownWeb() {
        if (this._hls) {
            this._hls.destroy();
            this._hls = null;
        }
        clearTimeout(this._closeBtnHideTimer);
        if (this._closeBtnEl) {
            this._closeBtnEl.remove();
            this._closeBtnEl = null;
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