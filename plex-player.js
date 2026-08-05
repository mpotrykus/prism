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
const VOLUME_STORAGE_KEY = "prism_player_volume";
const CONTROLS_HIDE_DELAY_MS = 1000;
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];
const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60];
const ZOOM_LEVELS = [1, 1.25, 1.5, 2];

/* Web port of the Android shader-upscaling feature (ShaderType/ShaderTuning/
   ShaderUpscaleShaderProgram in android/.../PlayerActivity's Java sources) - same two
   GLSL algorithms and the same min/max tuning endpoints a 0-100% strength slider
   interpolates between, just running as a WebGL pass over the <video> element instead
   of inside ExoPlayer's native pipeline. See _ensureShaderPipeline for how frames get
   from <video> to this shader. */
const SHADER_TYPES = {
    anime4k: {
        label: "Anime4K",
        useCas: false,
        min: { scale: 1.8, sharpen: 1.8, kernel: 1.5, saturation: 1.1, contrast: 1.05 },
        max: { scale: 2.4, sharpen: 3.8, kernel: 2.8, saturation: 1.35, contrast: 1.18 },
    },
    live_action: {
        label: "Live-Action (CAS)",
        useCas: true,
        /* saturation/contrast are a small compensating boost, not the anime shader's
           exaggeration - CAS's per-channel anti-ringing clamp (see SHADER_FRAGMENT_CAS)
           pulls sharpened pixels back toward the local neighborhood's own min/max, which
           has the side effect of slightly flattening contrast/saturation along with the
           ringing it's actually guarding against. This nudges both back up rather than
           leaving the picture looking duller than the source. */
        min: { scale: 1.3, sharpen: 1.0, kernel: 1.2, saturation: 1, contrast: 1 },
        max: { scale: 1.6, sharpen: 2.2, kernel: 1.8, saturation: 1.12, contrast: 1.06 },
        /* CAS ramps to its max tuning by 15% strength instead of 100% - the old full
           0-100% range made the slider's first ~2/3 barely perceptible (see the weight-gate
           fix above), so the previous "100%" tuning now arrives at "Light" instead of only
           at "Strong". Strength above 0.15 just stays at max, same as reaching 100% used to. */
        rampToMaxAt: 0.15,
    },
};

function shaderTuningAt(shaderKey, strength) {
    const type = SHADER_TYPES[shaderKey];
    const rampToMaxAt = type.rampToMaxAt ?? 1;
    const t = Math.max(0, Math.min(1, strength / rampToMaxAt));
    const lerp = (a, b) => a + (b - a) * t;
    return {
        scale: lerp(type.min.scale, type.max.scale),
        sharpen: lerp(type.min.sharpen, type.max.sharpen),
        kernel: lerp(type.min.kernel, type.max.kernel),
        saturation: lerp(type.min.saturation, type.max.saturation),
        contrast: lerp(type.min.contrast, type.max.contrast),
    };
}

/* Settings' global "Upscaling" strength preset (settings.js's upscale_strength field) -
   "off" skips the shader entirely, the other three map to this session's initial
   strength slider position. Medium (0.65) is the pre-existing default the slider used
   to always start at. */
const UPSCALE_STRENGTH_PRESETS = { off: 0, light: 0.15, medium: 0.65, strong: 0.9 };

/* Picks which of the two SHADER_TYPES algorithms suits a title, from its Plex genre
   tags - Anime4K's edge-gated line-art shader for anything animated (matches "Animation"
   and "Anime" alike, Western or Japanese), CAS everywhere else. Both platforms (this
   file and Android's PlayerActivity) get this same result computed once here rather
   than duplicating the genre check in Java - see _playNative. */
function detectShaderType(genres) {
    const isAnimated = (genres || []).some((g) => (g || "").toLowerCase().includes("anim"));
    return isAnimated ? "anime4k" : "live_action";
}

const SHADER_VERTEX_SRC = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vUv = aPosition * 0.5 + 0.5;
}
`;

/* Anime4K/RAVU-lite-inspired variant - Sobel-edge-gated unsharp mask, so only real
   line-art contours pick up the crispness boost. Ports ShaderUpscaleShaderProgram's
   FRAGMENT_SHADER_ANIME almost verbatim - see that Java file for why this makes a hard
   edge/no-edge decision rather than CAS's contrast-range weighting below. */
const SHADER_FRAGMENT_ANIME = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform float uKernelScale;
uniform float uSharpenStrength;
uniform float uSaturationBoost;
uniform float uContrastBoost;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 uv = vUv;
  vec2 off = uTexelSize * uKernelScale;
  vec3 center = texture2D(uTex, uv).rgb;
  vec3 n  = texture2D(uTex, uv + vec2(0.0, -off.y)).rgb;
  vec3 s  = texture2D(uTex, uv + vec2(0.0,  off.y)).rgb;
  vec3 w  = texture2D(uTex, uv + vec2(-off.x, 0.0)).rgb;
  vec3 e  = texture2D(uTex, uv + vec2( off.x, 0.0)).rgb;
  vec3 nw = texture2D(uTex, uv + vec2(-off.x, -off.y)).rgb;
  vec3 ne = texture2D(uTex, uv + vec2( off.x, -off.y)).rgb;
  vec3 sw = texture2D(uTex, uv + vec2(-off.x,  off.y)).rgb;
  vec3 se = texture2D(uTex, uv + vec2( off.x,  off.y)).rgb;
  float lN = luma(n); float lS = luma(s); float lW = luma(w); float lE = luma(e);
  float lNW = luma(nw); float lNE = luma(ne); float lSW = luma(sw); float lSE = luma(se);
  float gx = (lNE + 2.0 * lE + lSE) - (lNW + 2.0 * lW + lSW);
  float gy = (lSW + 2.0 * lS + lSE) - (lNW + 2.0 * lN + lNE);
  float edge = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
  vec3 blurredNeighborhood = (n + s + w + e) * 0.25;
  vec3 outColor = center + (center - blurredNeighborhood) * uSharpenStrength * edge;
  outColor = clamp(outColor, 0.0, 1.0);
  outColor = (outColor - 0.5) * uContrastBoost + 0.5;
  outColor = mix(vec3(luma(outColor)), outColor, uSaturationBoost);
  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
`;

/* Contrast Adaptive Sharpening-inspired variant, better suited to live-action footage -
   sharpen weight comes from local contrast range rather than a binary edge decision, and
   the result is clamped to the neighborhood's own min/max as an anti-ringing guard. Ports
   ShaderUpscaleShaderProgram's FRAGMENT_SHADER_CAS. */
const SHADER_FRAGMENT_CAS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform float uKernelScale;
uniform float uSharpenStrength;
uniform float uSaturationBoost;
uniform float uContrastBoost;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 uv = vUv;
  vec2 off = uTexelSize * uKernelScale;
  vec3 c = texture2D(uTex, uv).rgb;
  vec3 n = texture2D(uTex, uv + vec2(0.0, -off.y)).rgb;
  vec3 s = texture2D(uTex, uv + vec2(0.0,  off.y)).rgb;
  vec3 w = texture2D(uTex, uv + vec2(-off.x, 0.0)).rgb;
  vec3 e = texture2D(uTex, uv + vec2( off.x, 0.0)).rgb;
  float lc = luma(c); float ln = luma(n); float ls = luma(s); float lw = luma(w); float le = luma(e);
  float minL = min(lc, min(min(ln, ls), min(lw, le)));
  float maxL = max(lc, max(max(ln, ls), max(lw, le)));
  float contrastRange = max(maxL - minL, 0.0001);
  /* *10.0 (was *4.0) - the old threshold only ever hit full weight on very high-contrast
     edges, so on already-compressed/softly-filtered streamed video almost the whole frame
     saw near-zero sharpening. This reaches full weight on much subtler mid-detail contrast,
     so the effect is actually visible instead of only kicking in at hard edges. */
  float weight = clamp(contrastRange * 10.0, 0.0, 1.0) * uSharpenStrength;
  /* *0.5 (was *0.25) - doubles how much of the Laplacian kernel gets added once weight is
     triggered, for a visibly crisper result rather than a barely-there one. */
  vec3 sharpened = c + (4.0 * c - n - s - e - w) * weight * 0.5;
  vec3 minRgb = min(c, min(min(n, s), min(w, e)));
  vec3 maxRgb = max(c, max(max(n, s), max(w, e)));
  vec3 outColor = clamp(sharpened, minRgb, maxRgb);
  /* Applied after the anti-ringing clamp above, not folded into it - this is compensating
     for that clamp's own flattening side effect (see SHADER_TYPES.live_action's comment),
     so it needs to run on the already-clamped result rather than change what gets clamped. */
  outColor = (outColor - 0.5) * uContrastBoost + 0.5;
  outColor = mix(vec3(luma(outColor)), outColor, uSaturationBoost);
  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);
}
`;

function clientIdentifier() {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
}

function storedVolume() {
    const raw = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1;
}

/* Drawn as an inline SVG using currentColor rather than a "🔊"/"🔉"/"🔇" emoji glyph -
   those Unicode code points have default emoji presentation on every platform this app
   targets, so they render as full-color pictures the CSS `color` on the button can never
   touch (same font-glyph-rendering problem the Android leg's PlayPauseIconView/
   ChapterSkipIconView already work around by drawing their icons instead of using a
   glyph). */
function volumeIconMarkup(level) {
    const speaker = '<path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>';
    const waveNear = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" fill="currentColor"/>';
    const waveFar =
        '<path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" fill="currentColor"/>';
    const muteSlash = '<line x1="16" y1="7" x2="22" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    let inner = speaker;
    if (level <= 0) inner += muteSlash;
    else if (level < 0.5) inner += waveNear;
    else inner += waveNear + waveFar;
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
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
        this._shaderType = "off";
        this._shaderStrength = 0;
        this._shaderAutoType = "live_action";
        this._shaderCanvas = null;
        this._shaderGl = null;
        this._shaderPrograms = null;
        this._shaderQuadBuffer = null;
        this._shaderTexture = null;
        this._shaderRafId = null;
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
            title: item.title || "",
            year: item.year || null,
            seasonNumber: item.seasonNumber ?? null,
            episodeNumber: item.episodeNumber ?? null,
            mediaIndex: item.mediaIndex || 0,
            qualityCapKbps: item.qualityCapKbps ?? null,
            audioStreams,
            audioStreamId: audioStreams.find((s) => s.selected)?.id ?? null,
        };
        this._activeSkipMarker = null;

        /* Global default for this playback - the in-player Shader Upscaling menu can
           still override the strength for this session (see _setShaderStrength), but
           every video starts from Settings' upscale_strength and its own auto-detected
           type rather than whatever the previous video's session left behind. */
        const upscaleLevel = window.StreamingSettings?.loadPlain().upscale_strength || "off";
        this._shaderAutoType = detectShaderType(item.genres);
        this._shaderStrength = UPSCALE_STRENGTH_PRESETS[upscaleLevel] ?? 0;
        this._shaderType = this._shaderStrength > 0 ? this._shaderAutoType : "off";

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

    _buildStreamUrl({ plexUrl, plexToken, key, sessionId, startOffsetMs, mediaIndex = 0, partIndex = 0, qualityCapKbps = null, audioStreamID = null }) {
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
        /* audioStreamID is the same "best-known param name for this endpoint, unverified
           against a live request" situation as maxVideoBitrate above - only ever sent by
           _reloadWebSource when the user actively switches tracks, never on first load,
           so an initial play() is unaffected if this assumption turns out to be wrong. */
        if (audioStreamID != null) url.searchParams.set("audioStreamID", String(audioStreamID));
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
            /* PlayerActivity only ever sees the already-detected type (never "off" -
               strength 0 is what turns the shader off there, same as the web path's
               _shaderType collapsing to "off" below) and the resolved strength number -
               it doesn't run its own genre detection, so there's one detection
               implementation instead of one per platform. */
            shaderType: this._shaderAutoType,
            upscaleStrength: this._shaderStrength,
            /* Native code only ever sees {title, startTimeOffsetMs} - it doesn't need to
               know Plex's own Chapter field names, keeping that one Plex-protocol
               interpretation here instead of duplicated into Java. */
            chapters: (this._session.chapters || []).map((c) => ({
                title: c.title || c.tag || "",
                startTimeOffsetMs: c.startTimeOffset ?? 0,
            })),
            /* {id, label} only - PlayerActivity rebuilds the transcode URL itself when the
               user picks one (see switchAudioStream), it never needs the raw Plex Stream
               shape. */
            audioStreams: (this._session.audioStreams || []).map((s) => ({
                id: String(s.id),
                label: s.label || "Unknown",
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
            /* Same "replaced element defaults to object-fit:fill" issue as the shader
               canvas above - without this, the video stretches to the window's own
               aspect ratio instead of letterboxing/pillarboxing against its #000
               background whenever the two don't match. */
            objectFit: "contain",
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
        video.volume = storedVolume();

        this._attachSource(video, streamUrl);
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
        /* _shaderType/_shaderStrength were already resolved in play() (global setting +
           this title's auto-detected type) before _playWeb was called - this just spins
           up the WebGL pipeline for that starting state, same as any other change made
           through the hamburger menu later in the session. */
        this._updateShaderPipeline();

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

    /* Shared by the initial load (_playWeb) and _reloadWebSource (audio-track switch) so
       the hls.js-vs-native-HLS branching only lives in one place. Destroys any previous
       hls.js instance first - attachMedia() on a video that already has one attached is
       not a supported re-attach path. */
    _attachSource(video, streamUrl) {
        if (this._hls) {
            this._hls.destroy();
            this._hls = null;
        }
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
            /* Only this branch needs crossOrigin, not the hls.js branch above - hls.js
               attaches media via a same-origin blob: URL and feeds it segments through
               MediaSource.appendBuffer(), so the video element's own origin (as far as
               canvas/WebGL tainting cares) is the blob URL, never the actual cross-origin
               Plex URL. This branch assigns the real cross-origin URL directly, so
               texImage2D (see _renderShaderFrame) would taint the canvas without this -
               relies on the CORS invariant noted in this repo's CLAUDE.md (Plex answers
               CORS-clean as long as the token is a query param, which _buildStreamUrl
               already does). */
            video.crossOrigin = "anonymous";
            video.src = streamUrl;
        }
    }

    /* Restarts the Plex transcode session with a new audioStreamID, resuming at the
       current position - Plex bakes the selected audio stream into the HLS transcode at
       session start, so there's no way to switch tracks without re-requesting the
       playlist. A fresh session id avoids Plex reusing/confusing the just-abandoned
       transcode session's own state. */
    _reloadWebSource(newStreamId) {
        const video = this._videoEl;
        const s = this._session;
        if (!video || !s) return;
        const offsetMs = Math.round((video.currentTime || 0) * 1000);
        const streamUrl = this._buildStreamUrl({
            plexUrl: s.plexUrl,
            plexToken: s.plexToken,
            key: s.key,
            sessionId: crypto.randomUUID(),
            startOffsetMs: offsetMs,
            mediaIndex: s.mediaIndex,
            qualityCapKbps: s.qualityCapKbps,
            audioStreamID: newStreamId,
        });
        this._attachSource(video, streamUrl);
        video.currentTime = offsetMs / 1000;
        s.audioStreamId = newStreamId;
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

        const muteBtn = document.createElement("button");
        muteBtn.type = "button";
        Object.assign(muteBtn.style, {
            flex: "0 0 auto",
            width: "28px",
            height: "28px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "#fff",
            cursor: "pointer",
            padding: "0",
        });

        /* A floating panel above the mute icon - matches the volume-flyout convention
           most desktop/TV players use (drag up for louder) rather than a slider that
           permanently eats transport-bar space. Appended to document.body (not `bar`)
           so its `position: fixed` coordinates, computed off muteBtn's own rect in
           positionVolumePopout, aren't affected by the bar's own opacity/transform
           transitions. */
        const volumePopout = document.createElement("div");
        Object.assign(volumePopout.style, {
            position: "fixed",
            zIndex: "10002",
            background: "rgba(20,20,20,0.92)",
            borderRadius: "8px",
            padding: "14px 10px",
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
            opacity: "0",
            transform: "translate(-50%, 8px)",
            transition: "opacity 0.15s ease, transform 0.15s ease",
            pointerEvents: "none",
        });

        const volumeSlider = document.createElement("input");
        volumeSlider.type = "range";
        volumeSlider.className = "streaming-player-seek";
        volumeSlider.min = "0";
        volumeSlider.max = "100";
        Object.assign(volumeSlider.style, {
            /* writing-mode is the standards-based way to get a vertical range input -
               every target this app ships to (Chrome/Edge, Android WebView, Xbox
               WebView2) is Chromium-based and supports it. direction: rtl puts the
               minimum at the bottom and the maximum at the top, matching a physical
               volume slider. */
            writingMode: "vertical-lr",
            direction: "rtl",
            width: "6px",
            height: "90px",
            accentColor: "#e5a00d",
            cursor: "pointer",
        });
        volumePopout.appendChild(volumeSlider);
        document.body.appendChild(volumePopout);
        this._volumePopoutEl = volumePopout;

        const positionVolumePopout = () => {
            const rect = muteBtn.getBoundingClientRect();
            volumePopout.style.left = `${rect.left + rect.width / 2}px`;
            volumePopout.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        };
        const showVolumePopout = () => {
            positionVolumePopout();
            volumePopout.style.opacity = "1";
            volumePopout.style.pointerEvents = "auto";
            volumePopout.style.transform = "translate(-50%, 0)";
        };
        /* sliderActive covers the duration of a drag - hideVolumePopout would otherwise
           fire mid-drag whenever the pointer momentarily leaves the (narrow) slider or
           popout bounds, yanking the control out from under the user's own gesture. */
        let sliderActive = false;
        let volumeHideTimer = null;
        const hideVolumePopout = () => {
            if (sliderActive) return;
            volumePopout.style.opacity = "0";
            volumePopout.style.pointerEvents = "none";
            volumePopout.style.transform = "translate(-50%, 8px)";
        };
        /* Debounced rather than immediate - moving the mouse from muteBtn up to the
           popout crosses a small real gap between two non-nested elements, and an
           immediate hide-on-leave would close the popout before the cursor arrives. */
        const scheduleHideVolumePopout = () => {
            clearTimeout(volumeHideTimer);
            volumeHideTimer = setTimeout(hideVolumePopout, 150);
        };
        muteBtn.addEventListener("mouseenter", () => {
            clearTimeout(volumeHideTimer);
            showVolumePopout();
        });
        muteBtn.addEventListener("mouseleave", scheduleHideVolumePopout);
        /* The popout sits outside the transport bar's own DOM box (position: fixed off
           document.body), so hovering it alone wouldn't otherwise count toward the bar's
           own idle-fade tracking (see _registerControlButton) - mirrors that method's
           onEnter/onLeave exactly so the rest of the chrome doesn't fade out from under
           the popout while it's in use. */
        volumePopout.addEventListener("mouseenter", () => {
            clearTimeout(volumeHideTimer);
            this._controlsHovering = true;
            clearTimeout(this._controlsHideTimer);
            this._showControls();
        });
        volumePopout.addEventListener("mouseleave", () => {
            scheduleHideVolumePopout();
            this._controlsHovering = false;
            this._scheduleHideControls();
        });
        volumeSlider.addEventListener("focus", showVolumePopout);
        volumeSlider.addEventListener("blur", scheduleHideVolumePopout);
        volumeSlider.addEventListener("pointerdown", () => {
            sliderActive = true;
        });
        const endSliderDrag = () => {
            sliderActive = false;
            scheduleHideVolumePopout();
        };
        volumeSlider.addEventListener("pointerup", endSliderDrag);
        volumeSlider.addEventListener("pointercancel", endSliderDrag);

        /* video.volume is already set from the stored preference before this bar is built
           (see _playWeb) - this only syncs the icon/slider to whatever that (or a later
           user change) actually is, never writes it. */
        const syncVolumeUi = () => {
            const level = video.muted ? 0 : video.volume;
            volumeSlider.value = String(Math.round(level * 100));
            muteBtn.innerHTML = volumeIconMarkup(level);
            muteBtn.setAttribute("aria-label", level <= 0 ? "Unmute" : "Mute");
        };
        syncVolumeUi();

        muteBtn.addEventListener("click", () => {
            video.muted = !video.muted;
            syncVolumeUi();
        });
        volumeSlider.addEventListener("input", () => {
            const level = Number(volumeSlider.value) / 100;
            video.muted = false;
            video.volume = level;
            /* Only a non-zero level is worth remembering as "the last volume the user
               chose" - persisting 0 would make every future session open muted with no
               visible way to tell why. */
            if (level > 0) localStorage.setItem(VOLUME_STORAGE_KEY, String(level));
            syncVolumeUi();
        });
        video.addEventListener("volumechange", syncVolumeUi);

        bar.appendChild(timeCurrent);
        bar.appendChild(seek);
        bar.appendChild(timeDuration);
        bar.appendChild(muteBtn);
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
            {
                label: `Shader Upscaling${this._shaderType !== "off" ? `  (${SHADER_TYPES[this._shaderType].label})` : ""}`,
                onSelect: () => this._openShaderMenu(anchor),
            },
        ];
        if (this._session?.chapters?.length) {
            items.push({ label: "Chapters", onSelect: () => this._openChapterMenu(anchor) });
        }
        if (this._session?.audioStreams?.length > 1) {
            const current = this._session.audioStreams.find((s) => s.id === this._session.audioStreamId);
            items.push({ label: `Audio Track${current ? `  (${current.label})` : ""}`, onSelect: () => this._openAudioMenu(anchor) });
        }
        items.push({ label: "Subtitles", onSelect: () => this._openSubtitleSearch(anchor) });
        this._openInlineMenu({ anchor, items });
    }

    _openAudioMenu(anchor) {
        const streams = this._session?.audioStreams || [];
        const current = this._session?.audioStreamId;
        this._openInlineMenu({
            anchor,
            items: [
                { label: "← Back", onSelect: () => this._openHamburgerMenu(anchor) },
                ...streams.map((stream) => ({
                    label: `${stream.label}${stream.id === current ? "  ✓" : ""}`,
                    onSelect: () => this._reloadWebSource(stream.id),
                })),
            ],
        });
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
        const transform = `translate(${this._zoomPanX}px, ${this._zoomPanY}px) scale(${scale})`;
        this._videoEl.style.transform = transform;
        /* The shader canvas sits exactly on top of the (now-invisible) video at the same
           position/size, so it needs the same transform to stay aligned with it - pan/zoom
           itself is still driven entirely off the video's own pointer events, since the
           canvas is pointer-events:none and lets clicks/drags fall through to it. */
        if (this._shaderCanvas) this._shaderCanvas.style.transform = transform;
    }

    /* Reuses _openSubtitleSearch's custom-panel pattern rather than _openInlineMenu's plain
       item list - a continuous strength slider can't be expressed as tappable menu rows. */
    _openShaderMenu(anchor) {
        this._closeInlineMenu();
        const rect = anchor.getBoundingClientRect();
        const panel = document.createElement("div");
        Object.assign(panel.style, {
            position: "fixed",
            top: `${rect.bottom + 8}px`,
            ...(anchor.dataset.anchorSide === "left" ? { left: `${rect.left}px` } : { right: `${window.innerWidth - rect.right}px` }),
            zIndex: "10002",
            background: "rgba(20,20,20,0.95)",
            borderRadius: "8px",
            padding: "12px",
            width: "240px",
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

        /* No more manual Off/Anime4K/Live-Action picker - _shaderAutoType is decided once
           per video from its Plex genre tags (see detectShaderType) and shown here as
           read-only info. The slider below is the only remaining control, and dragging it
           to 0% is what "Off" used to be. */
        const detectedLabel = document.createElement("div");
        detectedLabel.textContent = `Detected: ${SHADER_TYPES[this._shaderAutoType].label}`;
        Object.assign(detectedLabel.style, { color: "#fff", fontSize: "13px", fontWeight: "600", padding: "2px 0" });
        panel.appendChild(detectedLabel);

        const detectedHint = document.createElement("div");
        detectedHint.textContent = "Auto-detected from this title's genre";
        Object.assign(detectedHint.style, { color: "rgba(255,255,255,0.5)", fontSize: "11px", padding: "0 0 10px" });
        panel.appendChild(detectedHint);

        const strengthLabel = document.createElement("div");
        strengthLabel.textContent = `Strength: ${Math.round(this._shaderStrength * 100)}%`;
        Object.assign(strengthLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "0 0 4px" });
        panel.appendChild(strengthLabel);

        const strengthInput = document.createElement("input");
        strengthInput.type = "range";
        strengthInput.min = "0";
        strengthInput.max = "100";
        strengthInput.value = String(Math.round(this._shaderStrength * 100));
        Object.assign(strengthInput.style, {
            width: "100%",
            accentColor: "#e5a00d",
            cursor: "pointer",
            boxSizing: "border-box",
        });
        strengthInput.addEventListener("input", () => {
            strengthLabel.textContent = `Strength: ${strengthInput.value}%`;
            this._setShaderStrength(Number(strengthInput.value) / 100);
        });
        panel.appendChild(strengthInput);

        document.body.appendChild(panel);
        this._inlineMenuEl = panel;

        const onOutsideClick = (e) => {
            if (panel.contains(e.target) || anchor.contains(e.target)) return;
            this._closeInlineMenu();
        };
        setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
        this._inlineMenuCleanup = () => document.removeEventListener("click", onOutsideClick);
    }

    /* 0% is this session's "Off" now that the menu no longer has a separate type picker -
       _shaderType only ever tracks "off" vs. whichever type detectShaderType picked for
       this video, never a user-chosen algorithm. */
    _setShaderStrength(strength) {
        this._shaderStrength = strength;
        this._shaderType = strength > 0 ? this._shaderAutoType : "off";
        this._updateShaderPipeline();
    }

    /* Off by default - same reasoning as the Android leg (ShaderUpscaleEffect): this
       spends an extra GPU pass every frame, only worth it on already-low-resolution
       sources. Unlike Android, there's no per-drag rebuild hazard here (see PlayerActivity's
       showShaderUpscaleDialog gotcha) - both compiled programs stay resident, so re-running
       this on every drag tick (_setShaderStrength above) is cheap: _ensureShaderPipeline
       no-ops once already built, and start/stop only takes effect when the 0%/>0% boundary
       is actually crossed. */
    _updateShaderPipeline() {
        if (this._shaderType === "off") {
            this._stopShaderLoop();
            if (this._shaderCanvas) this._shaderCanvas.style.display = "none";
            if (this._videoEl) this._videoEl.style.opacity = "1";
            return;
        }
        if (!this._ensureShaderPipeline()) {
            this._shaderType = "off";
            return;
        }
        this._shaderCanvas.style.display = "block";
        this._videoEl.style.opacity = "0";
        this._applyZoomTransform();
        this._startShaderLoop();
    }

    /* Lazily builds the WebGL pipeline on first use rather than in _playWeb - most
       sessions never touch this menu, and compiling two shader programs upfront on every
       playback would be wasted work. Both ShaderType programs are compiled once here and
       kept resident; switching type is just swapping which compiled program renders with,
       not a recompile (see _updateShaderPipeline's comment for why that matters). */
    _ensureShaderPipeline() {
        if (this._shaderGl) return true;
        const video = this._videoEl;
        if (!video) return false;
        const canvas = document.createElement("canvas");
        canvas.className = "streaming-player-shader-canvas";
        Object.assign(canvas.style, {
            position: "fixed",
            inset: "0",
            width: "100%",
            height: "100%",
            /* _renderShaderFrame sizes the canvas's backing buffer (outW/outH) to match
               the video's own aspect ratio, but a canvas is a replaced element like <img> -
               without this, the default object-fit:fill still stretches that correctly-
               proportioned bitmap to fill the 100%/100% box above, undoing the aspect-ratio
               math entirely whenever the window's own aspect ratio doesn't match the video's. */
            objectFit: "contain",
            background: "#000",
            zIndex: "10000",
            pointerEvents: "none",
        });
        const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: false })
            || canvas.getContext("experimental-webgl");
        if (!gl) {
            console.error("StreamingPlayer: WebGL unavailable, shader upscaling disabled");
            return false;
        }

        let programs;
        try {
            programs = {
                anime4k: this._compileShaderProgram(gl, SHADER_FRAGMENT_ANIME),
                live_action: this._compileShaderProgram(gl, SHADER_FRAGMENT_CAS),
            };
        } catch (e) {
            console.error("StreamingPlayer: shader compile failed -", e.message);
            return false;
        }

        const quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        /* Flips the video's top-left-origin rows to WebGL's bottom-left-origin texture
           space - without this the upscaled output renders upside down. */
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

        this._shaderCanvas = canvas;
        this._shaderGl = gl;
        this._shaderPrograms = programs;
        this._shaderQuadBuffer = quadBuffer;
        this._shaderTexture = texture;
        document.body.appendChild(canvas);
        return true;
    }

    _compileShaderProgram(gl, fragmentSrc) {
        const compile = (type, src) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, src);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const info = gl.getShaderInfoLog(shader);
                gl.deleteShader(shader);
                throw new Error(info);
            }
            return shader;
        };
        const vertexShader = compile(gl.VERTEX_SHADER, SHADER_VERTEX_SRC);
        const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSrc);
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(info);
        }
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);

        const uniforms = {
            uTex: gl.getUniformLocation(program, "uTex"),
            uTexelSize: gl.getUniformLocation(program, "uTexelSize"),
            uKernelScale: gl.getUniformLocation(program, "uKernelScale"),
            uSharpenStrength: gl.getUniformLocation(program, "uSharpenStrength"),
            uSaturationBoost: gl.getUniformLocation(program, "uSaturationBoost"),
            uContrastBoost: gl.getUniformLocation(program, "uContrastBoost"),
        };
        const aPosition = gl.getAttribLocation(program, "aPosition");
        return { program, uniforms, aPosition };
    }

    _startShaderLoop() {
        if (this._shaderRafId) return;
        const step = () => {
            this._renderShaderFrame();
            this._shaderRafId = requestAnimationFrame(step);
        };
        this._shaderRafId = requestAnimationFrame(step);
    }

    _stopShaderLoop() {
        if (this._shaderRafId) {
            cancelAnimationFrame(this._shaderRafId);
            this._shaderRafId = null;
        }
    }

    /* Mirrors ShaderUpscaleShaderProgram.configure()'s single-scale-factor-bounded-by-
       both-axes approach - scaling width/height independently would distort the aspect
       ratio whenever the screen and video don't match (the common case). Recomputed every
       frame (cheap - a handful of multiplications) rather than cached, since the window
       can resize mid-playback. */
    _renderShaderFrame() {
        const gl = this._shaderGl;
        const video = this._videoEl;
        if (!gl || !video || !video.videoWidth || video.readyState < video.HAVE_CURRENT_DATA) return;

        const dpr = window.devicePixelRatio || 1;
        const displayW = Math.round((window.innerWidth || document.documentElement.clientWidth) * dpr);
        const displayH = Math.round((window.innerHeight || document.documentElement.clientHeight) * dpr);
        const tuning = shaderTuningAt(this._shaderType, this._shaderStrength);
        const scale = Math.max(1, Math.min(tuning.scale, Math.min(displayW / video.videoWidth, displayH / video.videoHeight)));
        const outW = Math.round(video.videoWidth * scale);
        const outH = Math.round(video.videoHeight * scale);
        const canvas = this._shaderCanvas;
        if (canvas.width !== outW || canvas.height !== outH) {
            canvas.width = outW;
            canvas.height = outH;
        }
        gl.viewport(0, 0, outW, outH);

        const { program, uniforms, aPosition } = this._shaderPrograms[this._shaderType];
        gl.useProgram(program);
        gl.bindTexture(gl.TEXTURE_2D, this._shaderTexture);
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        } catch (e) {
            /* Tainted-canvas SecurityError - the crossOrigin/CORS invariant _playWeb relies
               on didn't hold for this server. Fail by turning the shader back off instead of
               throwing on every animation frame. */
            console.error("StreamingPlayer: shader upscaling disabled - video frame is cross-origin tainted", e);
            this._shaderStrength = 0;
            this._shaderType = "off";
            this._updateShaderPipeline();
            return;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this._shaderQuadBuffer);
        gl.enableVertexAttribArray(aPosition);
        gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1i(uniforms.uTex, 0);
        gl.uniform2f(uniforms.uTexelSize, 1 / video.videoWidth, 1 / video.videoHeight);
        gl.uniform1f(uniforms.uKernelScale, tuning.kernel);
        gl.uniform1f(uniforms.uSharpenStrength, tuning.sharpen);
        if (uniforms.uSaturationBoost) {
            gl.uniform1f(uniforms.uSaturationBoost, tuning.saturation);
            gl.uniform1f(uniforms.uContrastBoost, tuning.contrast);
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
            ...(anchor.dataset.anchorSide === "left"
                ? { left: `${rect.left}px` }
                : { right: `${window.innerWidth - rect.right}px` }),
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
            ...(anchor.dataset.anchorSide === "left"
                ? { left: `${rect.left}px` }
                : { right: `${window.innerWidth - rect.right}px` }),
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
                /* Only auto-close if onSelect() didn't already replace the open menu with a
                   submenu/panel of its own (Zoom, Speed, Sleep, Chapters, Subtitles, Shader
                   Upscaling, and every "← Back" row all do this) - otherwise this would
                   immediately tear down whatever onSelect just opened, before it ever paints. */
                if (this._inlineMenuEl === menu) this._closeInlineMenu();
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
        this._stopShaderLoop();
        if (this._shaderCanvas) {
            this._shaderCanvas.remove();
            this._shaderCanvas = null;
        }
        this._shaderGl = null;
        this._shaderPrograms = null;
        this._shaderQuadBuffer = null;
        this._shaderTexture = null;
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
        if (this._volumePopoutEl) {
            this._volumePopoutEl.remove();
            this._volumePopoutEl = null;
        }
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