import { Capacitor } from "@capacitor/core";
import * as StreamingSubtitles from "../../../opensubtitles.js";
import { SHADER_TYPES } from "../shader/shaders.js";
import { setShaderStrength } from "../shader-pipeline.js";
import { reloadWebSource } from "../web-fallback.js";
import { setNativePlaybackRate, setNativeSubtitle } from "../native-bridge.js";
import { CONTROLS_HIDE_DELAY_MS, PLAYBACK_RATES, SLEEP_TIMER_PRESETS_MIN, ZOOM_LEVELS, VOLUME_STORAGE_KEY, storedVolume, volumeIconMarkup } from "./shared.js";

/* Fullscreen player chrome: the idle-fade control row, transport bar, every hamburger
   submenu, the subtitle search panel, and the skip-intro/credits button. All take the
   StreamingPlayerController instance as an explicit first argument (see native-bridge.js/
   shader-pipeline.js for why) rather than each owning independent state - the idle-fade
   timer, inline-menu bookkeeping, and zoom/session state are genuinely shared across all
   of these, not cleanly separable per element. */

/* One 44px circular button matching this player's existing inline-style chrome
   convention. Doesn't position or register itself - callers pass the result to
   registerControlButton so every button shares one fade timer instead of each
   reinventing idle-hide logic. */
export function makeControlButton({ ariaLabel, content, onClick }) {
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
   wired so hovering/focusing *any* registered element keeps the whole row visible - not
   just itself - matching how a single physical control bar behaves. */
export function registerControlButton(controller, el, { anchor = true, side = "right" } = {}) {
    if (anchor) {
        const stacked = controller._controlButtons.filter((b) => b.dataset.anchorSide === side).length;
        el.dataset.anchorSide = side;
        el.style[side] = `${20 + stacked * 56}px`;
    }
    controller._controlButtons.push(el);
    document.body.appendChild(el);
    const onEnter = () => {
        controller._controlsHovering = true;
        clearTimeout(controller._controlsHideTimer);
        showControls(controller);
    };
    const onLeave = () => {
        controller._controlsHovering = false;
        scheduleHideControls(controller);
    };
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("focus", onEnter);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("blur", onLeave);
    return el;
}

export function showControls(controller) {
    controller._controlButtons.forEach((b) => {
        b.style.opacity = "1";
        b.style.pointerEvents = "auto";
    });
    scheduleHideControls(controller);
}

/* pointerEvents is toggled alongside opacity, not just opacity alone - a faded-out
   transport bar spanning the full screen width would otherwise still intercept clicks
   (opacity:0 doesn't remove a hit target), swallowing taps on the video underneath that
   are meant to toggle play/pause or reshow the controls. */
export function scheduleHideControls(controller) {
    clearTimeout(controller._controlsHideTimer);
    if (controller._controlsHovering) return;
    controller._controlsHideTimer = setTimeout(() => {
        controller._controlButtons.forEach((b) => {
            b.style.opacity = "0";
            b.style.pointerEvents = "none";
        });
    }, CONTROLS_HIDE_DELAY_MS);
}

/* Buffering indicator - independent of the idle-fade control row (same "contextual, not
   ambient chrome" reasoning as the skip button): it reflects actual network/decode
   state, not user activity, so it has to stay visible even while the rest of the chrome
   has faded out from inactivity. pointerEvents:none so it never blocks clicks on the
   center play/pause button or video underneath it while overlapping them. */
export function buildLoadingSpinner(controller, video) {
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
    controller._spinnerEl = spinner;

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
export function buildCenterControls(controller, video) {
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

    const chapters = controller._session?.chapters || [];
    if (chapters.length) row.appendChild(makeChapterNavButton(controller, "prev", video));

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

    if (chapters.length) row.appendChild(makeChapterNavButton(controller, "next", video));

    registerControlButton(controller, row, { anchor: false });
    return row;
}

function makeChapterNavButton(controller, direction, video) {
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
    btn.addEventListener("click", () => seekToAdjacentChapter(controller, direction, video));
    return btn;
}

/* "Previous" restarts the current chapter once more than a few seconds into it (rather
   than always jumping two chapters at once) - the same convention as prev-track buttons
   on physical media remotes. */
function seekToAdjacentChapter(controller, direction, video) {
    const chapters = controller._session?.chapters || [];
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

export function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/* Bottom transport bar: scrub bar and elapsed/total time - replaces the browser's native
   <video controls> chrome (disabled in playWeb) so the transport looks and behaves the
   same on every platform instead of whatever bar the host browser/OS ships. Registered
   anchor:false since it spans the full width itself rather than stacking as a small
   right-anchored button like the others. */
export function buildTransportBar(controller, video) {
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

    /* Scrubbing is tracked so the timeupdate-driven sync below doesn't fight the user's
       own drag - without it, every timeupdate tick would snap the thumb back to the
       actual playback position mid-drag. */
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
        timeCurrent.textContent = formatTime(time);
    });

    video.addEventListener("timeupdate", () => {
        if (scrubbing || !video.duration) return;
        seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
        timeCurrent.textContent = formatTime(video.currentTime);
    });
    const syncDuration = () => {
        timeDuration.textContent = formatTime(video.duration || 0);
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

    /* A floating panel above the mute icon - matches the volume-flyout convention most
       desktop/TV players use (drag up for louder) rather than a slider that permanently
       eats transport-bar space. Appended to document.body (not `bar`) so its `position:
       fixed` coordinates, computed off muteBtn's own rect in positionVolumePopout,
       aren't affected by the bar's own opacity/transform transitions. */
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
        /* writing-mode is the standards-based way to get a vertical range input - every
           target this app ships to (Chrome/Edge, Android WebView, Xbox WebView2) is
           Chromium-based and supports it. direction: rtl puts the minimum at the bottom
           and the maximum at the top, matching a physical volume slider. */
        writingMode: "vertical-lr",
        direction: "rtl",
        width: "6px",
        height: "90px",
        accentColor: "#e5a00d",
        cursor: "pointer",
    });
    volumePopout.appendChild(volumeSlider);
    document.body.appendChild(volumePopout);
    controller._volumePopoutEl = volumePopout;

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
    /* sliderActive covers the duration of a drag - hideVolumePopout would otherwise fire
       mid-drag whenever the pointer momentarily leaves the (narrow) slider or popout
       bounds, yanking the control out from under the user's own gesture. */
    let sliderActive = false;
    let volumeHideTimer = null;
    const hideVolumePopout = () => {
        if (sliderActive) return;
        volumePopout.style.opacity = "0";
        volumePopout.style.pointerEvents = "none";
        volumePopout.style.transform = "translate(-50%, 8px)";
    };
    /* Debounced rather than immediate - moving the mouse from muteBtn up to the popout
       crosses a small real gap between two non-nested elements, and an immediate
       hide-on-leave would close the popout before the cursor arrives. */
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
       document.body), so hovering it alone wouldn't otherwise count toward the bar's own
       idle-fade tracking (see registerControlButton) - mirrors that function's
       onEnter/onLeave exactly so the rest of the chrome doesn't fade out from under the
       popout while it's in use. */
    volumePopout.addEventListener("mouseenter", () => {
        clearTimeout(volumeHideTimer);
        controller._controlsHovering = true;
        clearTimeout(controller._controlsHideTimer);
        showControls(controller);
    });
    volumePopout.addEventListener("mouseleave", () => {
        scheduleHideVolumePopout();
        controller._controlsHovering = false;
        scheduleHideControls(controller);
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
       (see playWeb) - this only syncs the icon/slider to whatever that (or a later user
       change) actually is, never writes it. */
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
    registerControlButton(controller, bar, { anchor: false });
    return bar;
}

/* Every custom option lives behind one hamburger button instead of one circular button
   each (see web-fallback.js's playWeb) - this is its top-level list; each entry either
   opens a submenu (with its own "← Back" row back to here) or, for subtitles, the
   search panel. */
export function openHamburgerMenu(controller, anchor) {
    const rate = controller._session?.playbackRate || 1;
    const zoomLevel = ZOOM_LEVELS[controller._zoomIndex];
    const items = [
        { label: `Playback Speed  (${rate}x)`, onSelect: () => openSpeedMenu(controller, anchor) },
        {
            label: `Sleep Timer${controller._sleepMinutes ? `  (${controller._sleepMinutes}m)` : ""}`,
            onSelect: () => openSleepMenu(controller, anchor),
        },
        { label: `Zoom  (${zoomLevel}x)`, onSelect: () => openZoomMenu(controller, anchor) },
        {
            label: `Shader Upscaling${controller._shaderType !== "off" ? `  (${SHADER_TYPES[controller._shaderType].label})` : ""}`,
            onSelect: () => openShaderMenu(controller, anchor),
        },
    ];
    if (controller._session?.chapters?.length) {
        items.push({ label: "Chapters", onSelect: () => openChapterMenu(controller, anchor) });
    }
    if (controller._session?.audioStreams?.length > 1) {
        const current = controller._session.audioStreams.find((s) => s.id === controller._session.audioStreamId);
        items.push({ label: `Audio Track${current ? `  (${current.label})` : ""}`, onSelect: () => openAudioMenu(controller, anchor) });
    }
    items.push({ label: "Subtitles", onSelect: () => openSubtitleSearch(controller, anchor) });
    openInlineMenu(controller, { anchor, items });
}

function openAudioMenu(controller, anchor) {
    const streams = controller._session?.audioStreams || [];
    const current = controller._session?.audioStreamId;
    openInlineMenu(controller, {
        anchor,
        items: [
            { label: "← Back", onSelect: () => openHamburgerMenu(controller, anchor) },
            ...streams.map((stream) => ({
                label: `${stream.label}${stream.id === current ? "  ✓" : ""}`,
                onSelect: () => reloadWebSource(controller, stream.id),
            })),
        ],
    });
}

function openSpeedMenu(controller, anchor) {
    const current = controller._session?.playbackRate || 1;
    openInlineMenu(controller, {
        anchor,
        items: [
            { label: "← Back", onSelect: () => openHamburgerMenu(controller, anchor) },
            ...PLAYBACK_RATES.map((rate) => ({
                label: `${rate}x${rate === current ? "  ✓" : ""}`,
                onSelect: () => setPlaybackRate(controller, rate),
            })),
        ],
    });
}

async function setPlaybackRate(controller, rate) {
    if (!controller._session) return;
    controller._session.playbackRate = rate;
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
        await setNativePlaybackRate(rate);
    } else if (controller._videoEl) {
        controller._videoEl.playbackRate = rate;
    }
}

function openSleepMenu(controller, anchor) {
    openInlineMenu(controller, {
        anchor,
        items: [
            { label: "← Back", onSelect: () => openHamburgerMenu(controller, anchor) },
            { label: `Off${!controller._sleepMinutes ? "  ✓" : ""}`, onSelect: () => setSleepTimer(controller, 0) },
            ...SLEEP_TIMER_PRESETS_MIN.map((min) => ({
                label: `${min} min${controller._sleepMinutes === min ? "  ✓" : ""}`,
                onSelect: () => setSleepTimer(controller, min * 60000),
            })),
            { label: "End of episode", onSelect: () => setSleepTimer(controller, 0) },
        ],
    });
}

/* ms=0 clears any pending timer - used by both "Off" (don't pause early) and "End of
   episode" (rely on the existing `ended` handling instead of a timer at all). */
function setSleepTimer(controller, ms) {
    clearTimeout(controller._sleepTimer);
    controller._sleepTimer = ms > 0 ? setTimeout(() => controller.pause(), ms) : null;
    controller._sleepMinutes = ms > 0 ? Math.round(ms / 60000) : 0;
}

function openZoomMenu(controller, anchor) {
    openInlineMenu(controller, {
        anchor,
        items: [
            { label: "← Back", onSelect: () => openHamburgerMenu(controller, anchor) },
            ...ZOOM_LEVELS.map((level, idx) => ({
                label: `${level}x${idx === controller._zoomIndex ? "  ✓" : ""}`,
                onSelect: () => {
                    controller._zoomIndex = idx;
                    controller._zoomPanX = 0;
                    controller._zoomPanY = 0;
                    applyZoomTransform(controller);
                },
            })),
        ],
    });
}

export function applyZoomTransform(controller) {
    if (!controller._videoEl) return;
    const scale = ZOOM_LEVELS[controller._zoomIndex];
    const transform = `translate(${controller._zoomPanX}px, ${controller._zoomPanY}px) scale(${scale})`;
    controller._videoEl.style.transform = transform;
    /* The shader canvas sits exactly on top of the (now-invisible) video at the same
       position/size, so it needs the same transform to stay aligned with it - pan/zoom
       itself is still driven entirely off the video's own pointer events, since the
       canvas is pointer-events:none and lets clicks/drags fall through to it. */
    if (controller._shaderCanvas) controller._shaderCanvas.style.transform = transform;
}

/* Reuses openSubtitleSearch's custom-panel pattern rather than openInlineMenu's plain
   item list - a continuous strength slider can't be expressed as tappable menu rows. */
function openShaderMenu(controller, anchor) {
    closeInlineMenu(controller);
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
    backBtn.addEventListener("click", () => openHamburgerMenu(controller, anchor));
    panel.appendChild(backBtn);

    /* No more manual Off/Anime4K/Live-Action picker - controller._shaderAutoType is
       decided once per video from its Plex genre tags (see detectShaderType) and shown
       here as read-only info. The slider below is the only remaining control, and
       dragging it to 0% is what "Off" used to be. */
    const detectedLabel = document.createElement("div");
    detectedLabel.textContent = `Detected: ${SHADER_TYPES[controller._shaderAutoType].label}`;
    Object.assign(detectedLabel.style, { color: "#fff", fontSize: "13px", fontWeight: "600", padding: "2px 0" });
    panel.appendChild(detectedLabel);

    const detectedHint = document.createElement("div");
    detectedHint.textContent = "Auto-detected from this title's genre";
    Object.assign(detectedHint.style, { color: "rgba(255,255,255,0.5)", fontSize: "11px", padding: "0 0 10px" });
    panel.appendChild(detectedHint);

    const strengthLabel = document.createElement("div");
    strengthLabel.textContent = `Strength: ${Math.round(controller._shaderStrength * 100)}%`;
    Object.assign(strengthLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "0 0 4px" });
    panel.appendChild(strengthLabel);

    const strengthInput = document.createElement("input");
    strengthInput.type = "range";
    strengthInput.min = "0";
    strengthInput.max = "100";
    strengthInput.value = String(Math.round(controller._shaderStrength * 100));
    Object.assign(strengthInput.style, {
        width: "100%",
        accentColor: "#e5a00d",
        cursor: "pointer",
        boxSizing: "border-box",
    });
    strengthInput.addEventListener("input", () => {
        strengthLabel.textContent = `Strength: ${strengthInput.value}%`;
        setShaderStrength(controller, Number(strengthInput.value) / 100);
    });
    panel.appendChild(strengthInput);

    document.body.appendChild(panel);
    controller._inlineMenuEl = panel;

    const onOutsideClick = (e) => {
        if (panel.contains(e.target) || anchor.contains(e.target)) return;
        closeInlineMenu(controller);
    };
    setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
    controller._inlineMenuCleanup = () => document.removeEventListener("click", onOutsideClick);
}

/* Reuses openInlineMenu (same scrollable tap-to-pick list as the speed/sleep-timer
   presets) rather than a bespoke list UI - title + timestamp only, no thumbnails, per
   this feature's scope. Only offered from the hamburger menu when the session actually
   has chapters (see openHamburgerMenu), so there's never an empty list. */
function openChapterMenu(controller, anchor) {
    openInlineMenu(controller, {
        anchor,
        items: [
            { label: "← Back", onSelect: () => openHamburgerMenu(controller, anchor) },
            ...(controller._session?.chapters || []).map((chapter) => ({
                label: chapterLabel(chapter),
                onSelect: () => {
                    if (controller._videoEl) controller._videoEl.currentTime = (chapter.startTimeOffset ?? 0) / 1000;
                },
            })),
        ],
    });
}

function chapterLabel(chapter) {
    const time = formatTime((chapter.startTimeOffset ?? 0) / 1000);
    const title = chapter.title || chapter.tag || "";
    return title ? `${time}  ${title}` : time;
}

/* Shared by every control button that needs a small tap-to-pick list (speed presets,
   sleep timer presets, and future picker buttons) instead of each building its own
   floating menu. Only one menu is ever open at a time. */
export function openInlineMenu(controller, { anchor, items }) {
    closeInlineMenu(controller);
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
               immediately tear down whatever onSelect just opened, before it ever
               paints. */
            if (controller._inlineMenuEl === menu) closeInlineMenu(controller);
        });
        menu.appendChild(row);
    });
    document.body.appendChild(menu);
    controller._inlineMenuEl = menu;

    const onOutsideClick = (e) => {
        if (menu.contains(e.target) || anchor.contains(e.target)) return;
        closeInlineMenu(controller);
    };
    /* Deferred by a tick so the same click that opened this menu (which is already
       bubbling toward document) doesn't immediately close it again. */
    setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
    controller._inlineMenuCleanup = () => document.removeEventListener("click", onOutsideClick);
}

export function closeInlineMenu(controller) {
    if (controller._inlineMenuCleanup) {
        controller._inlineMenuCleanup();
        controller._inlineMenuCleanup = null;
    }
    if (controller._inlineMenuEl) {
        controller._inlineMenuEl.remove();
        controller._inlineMenuEl = null;
    }
}

/* Pan only engages once zoomed past 1x, and only within the padding introduced by that
   zoom - clamped against the video's own unscaled box size so the frame can never be
   dragged edge-past-edge and leave black space. */
export function wireZoomPan(controller) {
    const video = controller._videoEl;
    if (!video) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    video.addEventListener("pointerdown", (e) => {
        if (ZOOM_LEVELS[controller._zoomIndex] <= 1) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        originX = controller._zoomPanX;
        originY = controller._zoomPanY;
        video.setPointerCapture(e.pointerId);
    });
    video.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const scale = ZOOM_LEVELS[controller._zoomIndex];
        const maxX = ((scale - 1) * video.clientWidth) / 2;
        const maxY = ((scale - 1) * video.clientHeight) / 2;
        controller._zoomPanX = Math.max(-maxX, Math.min(maxX, originX + (e.clientX - startX)));
        controller._zoomPanY = Math.max(-maxY, Math.min(maxY, originY + (e.clientY - startY)));
        applyZoomTransform(controller);
    });
    const endDrag = () => {
        dragging = false;
    };
    video.addEventListener("pointerup", endDrag);
    video.addEventListener("pointercancel", endDrag);
}

/* Lives in the player chrome, not the title-info modal - subtitle search is
   realistically a mid-playback action ("I'm already watching, there's no subs, let me
   search") more than a pre-playback picker step. Reuses the anchor/menu-cleanup
   bookkeeping openInlineMenu already tracks, even though this panel has an input and
   dynamic results rather than a fixed item list. */
export function openSubtitleSearch(controller, anchor) {
    closeInlineMenu(controller);
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
    backBtn.addEventListener("click", () => openHamburgerMenu(controller, anchor));
    panel.appendChild(backBtn);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search subtitles…";
    input.value = controller._session?.title || "";
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
            const results = await StreamingSubtitles.search({
                title: input.value,
                year: controller._session?.year,
                seasonNumber: controller._session?.seasonNumber,
                episodeNumber: controller._session?.episodeNumber,
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
                row.addEventListener("click", () => applySubtitleResult(controller, r, row));
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
    controller._inlineMenuEl = panel;
    input.focus();

    const onOutsideClick = (e) => {
        if (panel.contains(e.target) || anchor.contains(e.target)) return;
        closeInlineMenu(controller);
    };
    setTimeout(() => document.addEventListener("click", onOutsideClick), 0);
    controller._inlineMenuCleanup = () => document.removeEventListener("click", onOutsideClick);

    if (input.value) runSearch();
}

/* rowEl gets an inline status update on failure instead of the previous
   console.error-only handling - a swallowed error here looked indistinguishable from
   "the click didn't register" since nothing on screen ever changed. */
async function applySubtitleResult(controller, result, rowEl) {
    const originalLabel = rowEl?.textContent;
    if (rowEl) {
        rowEl.textContent = "Applying…";
        rowEl.disabled = true;
    }
    try {
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
            const link = await StreamingSubtitles.resolveDownloadLink(result.fileId);
            await setNativeSubtitle(link, result.languageCode, "application/x-subrip");
        } else {
            const srtText = await StreamingSubtitles.download(result.fileId);
            attachSubtitleTrack(controller, srtText, result.languageCode, result.label);
        }
        closeInlineMenu(controller);
    } catch (e) {
        console.error("StreamingPlayer: subtitle download failed -", e);
        if (rowEl) {
            rowEl.disabled = false;
            rowEl.textContent = `${originalLabel} — failed: ${e.message}`;
        }
    }
}

/* Only the web/Xbox leg needs this - <video><track> requires WebVTT, while Android's
   Media3 leg (see applySubtitleResult) hands ExoPlayer the raw .srt URL directly, since
   SubripDecoder parses .srt natively and converting it there would be wasted work.
   Revokes the previous track's blob URL rather than leaking one per search. */
function attachSubtitleTrack(controller, srtText, langCode, label) {
    if (!controller._videoEl) return;
    if (controller._subtitleTrackUrl) URL.revokeObjectURL(controller._subtitleTrackUrl);
    const vtt = srtToVtt(srtText);
    const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    controller._subtitleTrackUrl = url;
    controller._videoEl.querySelectorAll("track").forEach((t) => t.remove());
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.srclang = langCode || "en";
    track.label = label || langCode || "Subtitles";
    track.src = url;
    track.default = true;
    controller._videoEl.appendChild(track);
    if (controller._videoEl.textTracks[0]) controller._videoEl.textTracks[0].mode = "showing";
}

function srtToVtt(srtText) {
    return "WEBVTT\n\n" + srtText.replace(/\r+/g, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
}

/* Shared by both playback paths so the marker-range check isn't duplicated even though
   web/native render totally different skip-button UI. Assumes Plex's Marker objects use
   startTimeOffset/endTimeOffset in ms, consistent with duration/viewOffset elsewhere in
   this codebase - unverified against a real response, see this phase's open risks. */
export function activeMarkerAt(controller, timeMs) {
    const markers = controller._session?.markers || [];
    return markers.find((m) => timeMs >= (m.startTimeOffset ?? 0) && timeMs <= (m.endTimeOffset ?? 0)) || null;
}

export function skipLabelFor(marker) {
    return marker?.type === "credits" ? "Skip Credits" : "Skip Intro";
}

/* Bottom-center, separate from the top-right fading control row (matching where
   Plex/Netflix conventionally put this) - force-shown for as long as a marker is active
   rather than joining the idle-fade timer, since it's a contextual action ("this is
   available right now"), not ambient chrome. */
export function updateSkipButton(controller, marker) {
    controller._activeSkipMarker = marker;
    if (!marker) {
        if (controller._skipBtnEl) controller._skipBtnEl.style.display = "none";
        return;
    }
    if (!controller._skipBtnEl) {
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
            if (controller._videoEl && controller._activeSkipMarker) {
                controller._videoEl.currentTime = (controller._activeSkipMarker.endTimeOffset ?? 0) / 1000;
            }
        });
        document.body.appendChild(btn);
        controller._skipBtnEl = btn;
    }
    controller._skipBtnEl.textContent = skipLabelFor(marker);
    controller._skipBtnEl.style.display = "block";
}
