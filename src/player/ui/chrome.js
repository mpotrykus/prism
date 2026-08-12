import { Capacitor } from "@capacitor/core";
import * as StreamingSubtitles from "../core/subtitle-provider.js";
import * as subtitleStore from "../core/subtitle-store.js";
import { SHADER_TYPES } from "../shader/shaders.js";
import { setShaderStrength, setColorBoostStrength, upscaleModeOf, setUpscaleMode, colorBoostModeOf, setColorBoostMode } from "../shader-pipeline.js";
import { setAmbientEnabled, setAmbientOpacity } from "../ambient-pipeline.js";
import { reloadWebSource } from "../web-fallback.js";
import { setAutoQualityEnabled } from "../core/abr.js";
import { setNativePlaybackRate, setNativeSubtitle, setNativeSubtitleOffset, notifyNativeSubtitleApplied } from "../native-bridge.js";
import {
    CONTROLS_HIDE_DELAY_MS,
    PLAYBACK_RATES,
    SLEEP_TIMER_PRESETS_MIN,
    ZOOM_LEVELS,
    QUALITY_CAP_PRESETS,
    VOLUME_STORAGE_KEY,
    storedVolume,
    volumeIconMarkup,
    seekIconMarkup,
    skipIconMarkup,
    fullscreenIconMarkup,
    audioSubtitlesIconMarkup,
    chaptersIconMarkup,
    versionIconMarkup,
    qualityCapIconMarkup,
    effectsIconMarkup,
    extrasIconMarkup,
    performanceIconMarkup,
    colorBoostIconMarkup,
    ambientIconMarkup,
    speedIconMarkup,
    zoomIconMarkup,
    sleepIconMarkup,
} from "./shared.js";
import { loadBifIndex, findNearestBifFrame, fetchBifFrameUrl } from "../core/bif.js";
import { plexAssetUrl } from "../core/plex-asset-url.js";
/* Circular with episode-list.js (which imports playQueuedTitle/formatTime from this
   file) - safe here because both sides only reference the other module's export from
   inside a function body (openChapterListOverlay is called from a click handler, long
   after both modules have finished loading), never at top-level module-evaluation
   time. */
import { openChapterListOverlay } from "./episode-list.js";
import { fetchQueuedTitle } from "../core/title-fetch.js";

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
        top: "24px",
        zIndex: "10001",
        width: "40px",
        height: "40px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "0",
        border: "none",
        background: "transparent",
        color: "#fff",
        fontSize: "22px",
        fontWeight: "600",
        lineHeight: "1",
        cursor: "pointer",
        opacity: "1",
        textShadow: "0 1px 4px rgba(0,0,0,0.85)",
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
        el.style[side] = `${24 + stacked * 44}px`;
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

/* Used instead of scheduleHideControls's delayed fade when the episode list overlay
   opens - that overlay is a full-width bottom sheet occupying the same screen real
   estate as the transport bar, so the corner buttons/transport bar need to disappear
   immediately rather than linger underneath it until the idle timer catches up. */
export function hideControls(controller) {
    clearTimeout(controller._controlsHideTimer);
    controller._controlButtons.forEach((b) => {
        b.style.opacity = "0";
        b.style.pointerEvents = "none";
    });
}

/* pointerEvents is toggled alongside opacity, not just opacity alone - a faded-out
   transport bar spanning the full screen width would otherwise still intercept clicks
   (opacity:0 doesn't remove a hit target), swallowing taps on the video underneath that
   are meant to toggle play/pause or reshow the controls. */
export function scheduleHideControls(controller) {
    clearTimeout(controller._controlsHideTimer);
    if (controller._controlsHovering || controller._inlineMenuEl || controller._episodeListEl || controller._chapterListEl || controller._audioSubtitlesEl) return;
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

/* Play/pause flanked by back-5s/forward-5s seek buttons (matching HBO's own transport
   row) with chapter nav further out on each side, only when the session actually has
   chapters - same "never an empty/dead affordance" rule the hamburger's Chapters entry
   follows - and title nav (prev/next episode, playlist/collection item, or just "play
   this movie from the start") further out still. Title nav is always shown, unlike
   chapter nav: prev is always a real action (restart, even with no queue at all) and
   next disables itself rather than disappearing when there's nothing queued after this
   title (see makeTitleNavButton) - a movie played on its own still gets both buttons,
   just with next greyed out. Appended into the bottom transport bar's own center cell
   (built first, see buildTransportBar) rather than floating mid-screen, matching a
   premium-streaming-app transport row instead of a YouTube-style center overlay. */
export function buildCenterControls(controller, video) {
    const row = controller._centerControlsSlot;
    if (!row) return null;

    row.appendChild(makeTitleNavButton(controller, "prev", video));

    const chapters = controller._session?.chapters || [];
    if (chapters.length) row.appendChild(makeChapterNavButton(controller, "prev", video));

    row.appendChild(makeSeekButton(controller, "back", video));

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.setAttribute("aria-label", "Play/Pause");
    Object.assign(playBtn.style, {
        width: "32px",
        height: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "0",
        border: "none",
        background: "transparent",
        color: "#fff",
        fontSize: "22px",
        cursor: "pointer",
        padding: "0",
    });
    const syncPlayIcon = () => {
        playBtn.textContent = video.paused ? "▶" : "❙❙";
    };
    syncPlayIcon();
    playBtn.addEventListener("click", () => {
        if (video.paused) video.play();
        else video.pause();
    });
    video.addEventListener("play", syncPlayIcon);
    video.addEventListener("pause", syncPlayIcon);
    row.appendChild(playBtn);

    row.appendChild(makeSeekButton(controller, "forward", video));

    if (chapters.length) row.appendChild(makeChapterNavButton(controller, "next", video));
    row.appendChild(makeTitleNavButton(controller, "next", video));

    return row;
}

function makeSeekButton(controller, direction, video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", direction === "back" ? "Back 5 seconds" : "Forward 5 seconds");
    btn.innerHTML = seekIconMarkup(direction);
    Object.assign(btn.style, {
        width: "34px",
        height: "34px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "0",
        border: "none",
        background: "transparent",
        color: "#fff",
        cursor: "pointer",
        padding: "0",
    });
    btn.addEventListener("click", () => {
        if (!video.duration) {
            video.currentTime = Math.max(0, (video.currentTime || 0) + (direction === "back" ? -5 : 5));
            return;
        }
        video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + (direction === "back" ? -5 : 5)));
    });
    return btn;
}

function makeChapterNavButton(controller, direction, video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", direction === "prev" ? "Previous chapter" : "Next chapter");
    btn.innerHTML = skipIconMarkup(direction, { double: true });
    Object.assign(btn.style, {
        width: "26px",
        height: "26px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "0",
        border: "none",
        background: "transparent",
        color: "#fff",
        cursor: "pointer",
        padding: "0",
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

const TITLE_PREV_RESTART_MS = 10000;

/* Always rendered, unlike chapter nav - "restart this title from the beginning" is a
   valid action whether or not there's a queue at all (a standalone movie included), so
   prev is never disabled. Next is the only one that ever greys out: skipping forward has
   no equivalent "restart" fallback, so it's a real dead end whenever there's no next
   queued title (see plex-player.js's queueRatingKeys/queueIndex) - shown disabled rather
   than hidden so a movie's transport row still reads as symmetric with an episode's. */
function makeTitleNavButton(controller, direction, video) {
    const session = controller._session;
    const queue = session?.queueRatingKeys || [];
    const index = session?.queueIndex ?? -1;
    const enabled = direction === "prev" || (index >= 0 && index < queue.length - 1);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", direction === "prev" ? "Previous title" : "Next title");
    btn.innerHTML = skipIconMarkup(direction, { double: false });
    Object.assign(btn.style, {
        width: "26px",
        height: "26px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "0",
        border: "none",
        background: "transparent",
        color: enabled ? "#fff" : "#666",
        cursor: enabled ? "pointer" : "default",
        padding: "0",
    });
    btn.disabled = !enabled;
    if (enabled) btn.addEventListener("click", () => seekToAdjacentTitle(controller, direction, video));
    return btn;
}

/* "Previous" restarts the current title once more than a few seconds into it, jumping to
   the actual previous queued title only when one exists and playback is still near the
   start - same convention as seekToAdjacentChapter above, except prev is always enabled
   here (see makeTitleNavButton), so a title with no previous queued entry (or no queue at
   all - any standalone movie) still restarts from 0 rather than doing nothing. "Next"
   always jumps forward - there's no equivalent restart concept for it, so it's simply
   disabled when there's nowhere to jump to. Both directions that do jump fetch the
   adjacent title's fresh metadata (the queue only ever carries ratingKeys) and hand off
   to the controller's own mid-session _switchTitle rather than a cold-start play(), so
   the pushed history entry and hero-trailer open/close events stay scoped to the whole
   player, not each title. */
async function seekToAdjacentTitle(controller, direction, video) {
    const session = controller._session;
    const queue = session?.queueRatingKeys || [];
    const index = session?.queueIndex ?? -1;
    if (direction === "next") {
        if (index < 0 || index >= queue.length - 1) return;
        await playQueuedTitle(controller, queue, index + 1);
        return;
    }
    const position = (video.currentTime || 0) * 1000;
    if (index > 0 && position <= TITLE_PREV_RESTART_MS) {
        await playQueuedTitle(controller, queue, index - 1);
        return;
    }
    video.currentTime = 0;
}

export async function playQueuedTitle(controller, queue, newIndex) {
    const session = controller._session;
    if (!session) return;
    try {
        const meta = await fetchQueuedTitle(session.plexUrl, session.plexToken, queue[newIndex]);
        if (!meta) return;
        await controller._switchTitle({
            ...meta,
            plexUrl: session.plexUrl,
            plexToken: session.plexToken,
            startOffsetMs: 0,
            qualityCapKbps: session.qualityCapKbps,
            queueRatingKeys: queue,
            queueIndex: newIndex,
        });
    } catch (e) {
        // best-effort - the title-nav button simply won't respond if this fails
    }
}

export function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const SEEK_FILLED_COLOR = "#e5a00d";
const SEEK_BUFFERED_COLOR = "rgba(255,255,255,0.5)";
const SEEK_UNFILLED_COLOR = "rgba(255,255,255,0.3)";

/* Finds how far ahead of the current position is actually buffered - video.buffered
   is a list of disjoint ranges (seeking around leaves gaps), so this deliberately
   returns the end of whichever range currently contains the playhead rather than the
   furthest point buffered anywhere, matching what "buffered ahead" visually means to a
   viewer. Falls back to currentTime (i.e. nothing buffered ahead) if the playhead
   isn't inside any known range yet. */
function bufferedEndSeconds(video) {
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) {
            return ranges.end(i);
        }
    }
    return video.currentTime;
}

/* One reusable "paint a range with up to 3 colors" gradient, shared by the plain
   (no-chapter) track's --seek-buffered-pct CSS var and each per-chapter segment div
   below - both are really the same problem (a [startPct, endPct] span with a played
   breakpoint and a buffered breakpoint somewhere inside it), just at different scales.
   Breakpoints outside [startPct, endPct] clamp to 0%/100%, which collapses that color's
   stop-pair to zero width rather than needing a special case - CSS renders a zero-width
   hard edge as simply invisible. */
function threeColorGradient(startPct, endPct, playedAt, bufferedAt, before, middle, after) {
    const span = endPct - startPct || 1;
    const localPlayed = Math.min(100, Math.max(0, ((playedAt - startPct) / span) * 100));
    const localBuffered = Math.min(100, Math.max(localPlayed, ((bufferedAt - startPct) / span) * 100));
    return `linear-gradient(to right, ${before} ${localPlayed}%, ${middle} ${localPlayed}%, ${middle} ${localBuffered}%, ${after} ${localBuffered}%)`;
}

/* Segmented scrub track (Plezy-style): each chapter gets its own independently
   rounded-pill DOM element instead of one continuous bar with straight-edged gaps cut
   into it - a single CSS background can only ever paint one border-radius'd shape, so
   getting 4 rounded corners per segment needs a real element per segment, layered
   behind the (now track-transparent, see --segmented CSS above) range input. The gap
   between two adjacent segments is split as a 2px inset on each side (4px total),
   fixed-pixel rather than percentage so it looks consistent regardless of the bar's
   actual rendered width - the same approach Plezy's BufferRangePainter uses on canvas.
   Built once duration is known (see buildTransportBar's loadedmetadata/durationchange
   handling); only the fill color of each segment is touched afterward, every tick. */
function buildChapterSegments(layer, chapters, durationMs) {
    layer.innerHTML = "";
    if (!durationMs || !(chapters || []).length) return [];
    const splits = chapters
        .map((c) => ((c.startTimeOffset ?? 0) / durationMs) * 100)
        .filter((f) => Number.isFinite(f) && f > 0.4 && f < 99.6)
        .sort((a, b) => a - b);
    const edges = [0, ...splits, 100];
    const segments = [];
    for (let i = 0; i < edges.length - 1; i++) {
        const startPct = edges[i];
        const endPct = edges[i + 1];
        const leftGapPx = i > 0 ? 2 : 0;
        const rightGapPx = i < edges.length - 2 ? 2 : 0;
        const el = document.createElement("div");
        Object.assign(el.style, {
            position: "absolute",
            top: "0",
            bottom: "0",
            left: `calc(${startPct}% + ${leftGapPx}px)`,
            width: `calc(${endPct - startPct}% - ${leftGapPx + rightGapPx}px)`,
            borderRadius: "999px",
            background: SEEK_UNFILLED_COLOR,
        });
        layer.appendChild(el);
        segments.push({ startPct, endPct, el });
    }
    return segments;
}

function paintChapterSegments(segments, pct, bufferedPct) {
    for (const { startPct, endPct, el } of segments) {
        el.style.background = threeColorGradient(startPct, endPct, pct, bufferedPct, SEEK_FILLED_COLOR, SEEK_BUFFERED_COLOR, SEEK_UNFILLED_COLOR);
    }
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
        flexDirection: "column",
        gap: "10px",
        padding: "70px 40px 22px",
        background: "linear-gradient(to top, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.55) 45%, transparent 100%)",
        opacity: "1",
        transition: "opacity 0.25s ease",
        boxSizing: "border-box",
    });

    /* Title/season-episode (or year, for a movie) left, remaining time right - both
       already carried on the session (see plex-netflix-card.js's _playItem), just not
       previously surfaced anywhere in this chrome. */
    const infoRow = document.createElement("div");
    Object.assign(infoRow.style, { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "16px" });

    const session = controller._session;
    const titleBlock = document.createElement("div");
    const titleLine = document.createElement("div");
    titleLine.textContent = session?.title || "";
    Object.assign(titleLine.style, { color: "#fff", fontSize: "19px", fontWeight: "700", fontFamily: '"Roboto", sans-serif', lineHeight: "1.3" });
    titleBlock.appendChild(titleLine);

    const subtitleParts = [];
    if (session?.seasonNumber != null && session?.episodeNumber != null) {
        if (session?.episodeTitle) subtitleParts.push(session.episodeTitle);
        subtitleParts.push(`S${session.seasonNumber} E${session.episodeNumber}`);
    } else if (session?.year) {
        subtitleParts.push(String(session.year));
    }
    if (subtitleParts.length) {
        const subLine = document.createElement("div");
        subLine.textContent = subtitleParts.join("  •  ");
        Object.assign(subLine.style, { color: "rgba(255,255,255,0.65)", fontSize: "13px", fontWeight: "600", fontFamily: '"Roboto", sans-serif', marginTop: "2px" });
        titleBlock.appendChild(subLine);
    }
    infoRow.appendChild(titleBlock);

    const remainingEl = document.createElement("span");
    remainingEl.textContent = "-0:00";
    Object.assign(remainingEl.style, { flex: "0 0 auto", color: "rgba(255,255,255,0.75)", fontSize: "13px", fontFamily: '"Roboto", sans-serif', fontVariantNumeric: "tabular-nums" });
    infoRow.appendChild(remainingEl);
    bar.appendChild(infoRow);

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
            /* The scrub bar's embossed rim isn't a focus ring - it's Chromium/Firefox's
               native appearance:auto track theme (a light groove with a darker edge),
               which outline/box-shadow resets above can't touch. appearance:none drops
               that native theme entirely, so the track/thumb/fill all have to be drawn by
               hand below instead of relying on accent-color. --seek-pct is written from
               JS (see buildTransportBar) wherever seek.value changes, since a plain CSS
               gradient can't otherwise express "amber up to the thumb, dim after it". */
            /* The input's own box is the actual click/touch/drag hit target - a plain
               3px-tall element (matching the visible track) was nearly impossible to
               grab precisely. Bumped to 24px here while the track pseudo-elements below
               stay explicitly 3px, which browsers vertically center within the taller
               box by default - the same "invisible padding around a thin visual track"
               trick most custom range sliders use. The thumb's -4.5px margin-top below
               is calculated against the track's own 3px height, not this one, so it
               still centers correctly. */
            .streaming-player-seek.streaming-player-seek--scrub {
                -webkit-appearance: none;
                appearance: none;
                background: transparent;
                height: 24px;
            }
            .streaming-player-seek.streaming-player-seek--scrub::-webkit-slider-runnable-track {
                height: 3px;
                border-radius: 2px;
                border: none;
                background: linear-gradient(to right, #e5a00d var(--seek-pct, 0%), rgba(255,255,255,0.5) var(--seek-pct, 0%), rgba(255,255,255,0.5) var(--seek-buffered-pct, var(--seek-pct, 0%)), rgba(255,255,255,0.3) var(--seek-buffered-pct, var(--seek-pct, 0%)));
            }
            .streaming-player-seek.streaming-player-seek--scrub::-moz-range-track {
                height: 3px;
                border-radius: 2px;
                border: none;
                background: linear-gradient(to right, #e5a00d var(--seek-pct, 0%), rgba(255,255,255,0.5) var(--seek-pct, 0%), rgba(255,255,255,0.5) var(--seek-buffered-pct, var(--seek-pct, 0%)), rgba(255,255,255,0.3) var(--seek-buffered-pct, var(--seek-pct, 0%)));
            }
            /* When rendering real per-chapter segments (see buildSegmentLayout below),
               those DOM divs sit behind the input and ARE the visible track - the
               input's own native track paint has to get out of the way entirely rather
               than showing through/behind them. */
            .streaming-player-seek.streaming-player-seek--scrub.streaming-player-seek--segmented::-webkit-slider-runnable-track {
                background: transparent;
            }
            .streaming-player-seek.streaming-player-seek--scrub.streaming-player-seek--segmented::-moz-range-track {
                background: transparent;
            }
            .streaming-player-seek.streaming-player-seek--scrub::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #e5a00d;
                margin-top: -4.5px;
            }
            .streaming-player-seek.streaming-player-seek--scrub::-moz-range-thumb {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                border: none;
                background: #e5a00d;
            }
        `;
        document.head.appendChild(style);
    }

    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "streaming-player-seek streaming-player-seek--scrub";
    seek.min = "0";
    seek.max = "1000";
    seek.value = "0";
    /* position:relative is needed so the thumb paints above segmentLayer - a static
       (non-positioned) element always paints below any positioned sibling regardless
       of DOM order, so without this the absolutely-positioned segment divs covered
       the range input's thumb even though seek is appended after them below. */
    Object.assign(seek.style, { cursor: "pointer", width: "100%", display: "block", position: "relative", zIndex: "1" });

    const chapters = controller._session?.chapters || [];
    const seekWrap = document.createElement("div");
    Object.assign(seekWrap.style, { position: "relative", flex: "1 1 auto", display: "flex", alignItems: "center" });
    const segmentLayer = document.createElement("div");
    Object.assign(segmentLayer.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "50%",
        height: "3px",
        transform: "translateY(-50%)",
        pointerEvents: "none",
    });
    if (chapters.length) seek.classList.add("streaming-player-seek--segmented");
    seekWrap.appendChild(segmentLayer);
    seekWrap.appendChild(seek);

    /* Segment geometry only depends on duration, which is stable once known - built
       once (guarded by segmentsDurationMs) rather than on every tick, unlike the color
       repaint below which does need to run every tick as the playhead moves. */
    let segments = [];
    let segmentsDurationMs = 0;
    const ensureSegments = () => {
        const durationMs = (video.duration || 0) * 1000;
        if (!durationMs || durationMs === segmentsDurationMs) return;
        segmentsDurationMs = durationMs;
        segments = buildChapterSegments(segmentLayer, chapters, durationMs);
    };

    const syncSeekFill = () => {
        const pct = Number(seek.value) / 10;
        seek.style.setProperty("--seek-pct", `${pct}%`);
        const bufferedPct = video.duration ? (bufferedEndSeconds(video) / video.duration) * 100 : pct;
        seek.style.setProperty("--seek-buffered-pct", `${bufferedPct}%`);
        if (chapters.length) {
            ensureSegments();
            paintChapterSegments(segments, pct, bufferedPct);
        }
    };
    syncSeekFill();
    /* video.buffered updates independently of currentTime - e.g. the player keeps
       loading ahead while paused, or a slow connection means the buffered edge lags
       noticeably behind the playhead. timeupdate alone (below) wouldn't repaint for
       either case. */
    video.addEventListener("progress", syncSeekFill);

    /* Scrub-preview tooltip (BIF trickplay thumbnails) - shown on hover AND while
       dragging. Loads the index lazily/fire-and-forget rather than blocking the
       transport bar on it; until it resolves (or if this session has no BIF data at
       all - most don't have one generated) the tooltip still shows a time label with
       no image, same "never worse than today" fallback the segmented track uses. */
    const bifUrl = plexAssetUrl(controller._session, controller._session?.bifIndexPath);
    let bifIndex = null;
    let lastHoverClientX = null;
    if (bifUrl) {
        loadBifIndex(bifUrl).then((index) => {
            bifIndex = index;
            controller._bifIndex = index;
            /* The index takes a couple of Range round-trips to load - if the user was
               already hovering/dragging and had stopped moving the pointer before it
               resolved, nothing would otherwise ever retry the frame lookup for that
               position (only pointerenter/pointermove call showPreview, and a
               stationary pointer fires neither). */
            if (index && lastHoverClientX != null) showPreview(lastHoverClientX);
        });
    }

    const previewTooltip = document.createElement("div");
    Object.assign(previewTooltip.style, {
        position: "absolute",
        bottom: "calc(100% + 10px)",
        display: "none",
        flexDirection: "column",
        alignItems: "center",
        pointerEvents: "none",
        transform: "translateX(-50%)",
    });
    const previewImg = document.createElement("img");
    previewImg.alt = "";
    Object.assign(previewImg.style, {
        width: "160px",
        height: "90px",
        objectFit: "cover",
        borderRadius: "6px",
        display: "none",
        background: "#000",
        boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
    });
    const previewTime = document.createElement("div");
    Object.assign(previewTime.style, {
        marginTop: "6px",
        padding: "3px 8px",
        borderRadius: "4px",
        background: "rgba(0,0,0,0.75)",
        color: "#fff",
        fontSize: "12px",
        fontFamily: '"Roboto", sans-serif',
        fontVariantNumeric: "tabular-nums",
    });
    previewTooltip.appendChild(previewImg);
    previewTooltip.appendChild(previewTime);
    seekWrap.appendChild(previewTooltip);

    let previewLastTimeMs = null;
    let previewRequestId = 0;
    const showPreview = (clientX) => {
        if (!video.duration) return;
        const rect = seekWrap.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const timeMs = fraction * video.duration * 1000;

        previewTooltip.style.display = "flex";
        const tooltipHalfWidth = 80;
        previewTooltip.style.left = `${Math.min(rect.width - tooltipHalfWidth, Math.max(tooltipHalfWidth, fraction * rect.width))}px`;
        previewTime.textContent = formatTime(timeMs / 1000);

        /* Debounced to roughly one lookup per real second of video scrubbed past,
           rather than one per pointermove event - a fast drag across a long movie can
           fire dozens of move events a second, and each would otherwise trigger its
           own Range fetch for a frame the user never actually paused on. */
        if (!bifIndex || (previewLastTimeMs != null && Math.abs(timeMs - previewLastTimeMs) < 1000)) return;
        previewLastTimeMs = timeMs;
        const frame = findNearestBifFrame(bifIndex, timeMs);
        if (!frame) return;
        const requestId = ++previewRequestId;
        fetchBifFrameUrl(bifIndex, frame).then((url) => {
            if (requestId !== previewRequestId) return; // a newer hover position won the race
            previewImg.src = url;
            previewImg.style.display = "block";
        });
    };
    const hidePreview = () => {
        previewTooltip.style.display = "none";
        previewImg.style.display = "none";
        previewLastTimeMs = null;
        lastHoverClientX = null;
    };
    seek.addEventListener("pointerenter", (e) => {
        lastHoverClientX = e.clientX;
        showPreview(e.clientX);
    });
    seek.addEventListener("pointermove", (e) => {
        lastHoverClientX = e.clientX;
        showPreview(e.clientX);
    });
    seek.addEventListener("pointerleave", () => {
        if (!scrubbing) hidePreview();
    });

    /* Scrubbing is tracked so the timeupdate-driven sync below doesn't fight the user's
       own drag - without it, every timeupdate tick would snap the thumb back to the
       actual playback position mid-drag. */
    let scrubbing = false;
    seek.addEventListener("pointerdown", () => {
        scrubbing = true;
    });
    const endScrub = () => {
        scrubbing = false;
        hidePreview();
    };
    seek.addEventListener("pointerup", endScrub);
    seek.addEventListener("pointercancel", endScrub);
    const syncRemaining = (time) => {
        if (!video.duration) return;
        remainingEl.textContent = `-${formatTime(video.duration - time)}`;
    };
    seek.addEventListener("input", () => {
        syncSeekFill();
        if (!video.duration) return;
        const time = (Number(seek.value) / 1000) * video.duration;
        video.currentTime = time;
        syncRemaining(time);
    });

    video.addEventListener("timeupdate", () => {
        if (scrubbing || !video.duration) return;
        seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
        syncSeekFill();
        syncRemaining(video.currentTime);
    });
    video.addEventListener("durationchange", () => {
        syncRemaining(video.currentTime);
        syncSeekFill();
    });
    video.addEventListener("loadedmetadata", () => {
        syncRemaining(video.currentTime);
        syncSeekFill();
    });

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

    /* Not rendered at all when the host has no Fullscreen API (Xbox WebView2 already
       runs the whole shell fullscreen, with no chrome to hide) - same "never an empty/
       dead affordance" rule the hamburger's Chapters entry follows. */
    const fullscreenSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    let fullscreenBtn = null;
    if (fullscreenSupported) {
        fullscreenBtn = document.createElement("button");
        fullscreenBtn.type = "button";
        Object.assign(fullscreenBtn.style, {
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
        const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
        const syncFullscreenUi = () => {
            const active = isFullscreen();
            fullscreenBtn.innerHTML = fullscreenIconMarkup(active);
            fullscreenBtn.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
        };
        syncFullscreenUi();
        fullscreenBtn.addEventListener("click", () => {
            if (isFullscreen()) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            } else {
                const el = document.documentElement;
                (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
            }
        });
        /* Listener lives on `document`, outside this bar's own DOM subtree, so it can't
           be cleaned up just by removing the bar (see teardownWeb's _controlButtons
           sweep) - stashed on the controller so teardownWeb can remove it explicitly,
           same reasoning as every other cross-cutting resource cleaned up there. */
        controller._fullscreenChangeHandler = syncFullscreenUi;
        document.addEventListener("fullscreenchange", syncFullscreenUi);
        document.addEventListener("webkitfullscreenchange", syncFullscreenUi);
    }

    bar.appendChild(seekWrap);

    /* Three-cell row: play/pause (+ chapter nav, when the session has chapters) always
       centered, mute pinned to the far right - filled in by buildCenterControls, called
       right after this (see web-fallback.js), via _centerControlsSlot rather than this
       function reaching into chapter/play-pause concerns itself. */
    const controlsRow = document.createElement("div");
    Object.assign(controlsRow.style, { display: "flex", alignItems: "center" });
    const leftCell = document.createElement("div");
    Object.assign(leftCell.style, { flex: "1 1 0", display: "flex", alignItems: "center" });
    /* Text label standing in for the old standalone Episodes icon button (top-right
       corner) - same "Episodes" vs "Up Next" wording episode-list.js's own overlay
       heading already uses (seasonNumber present means a TV episode with siblings to
       browse; its absence means a movie/collection queue, where "next" is the more
       accurate word than "episode"), so the button and the screen it opens never
       disagree about what to call the same queue. Only shown when there's an actual
       queue to browse - same "never an empty/dead affordance" rule the hamburger's
       Chapters/Audio Track rows already follow. */
    if (session?.queueRatingKeys?.length > 1) {
        const episodesBtn = document.createElement("button");
        episodesBtn.type = "button";
        episodesBtn.textContent = session.seasonNumber != null ? "Episodes" : "Up Next";
        Object.assign(episodesBtn.style, {
            background: "transparent",
            border: "none",
            color: "#fff",
            fontSize: "13px",
            fontWeight: "700",
            fontFamily: '"Roboto", sans-serif',
            cursor: "pointer",
            padding: "0",
        });
        episodesBtn.addEventListener("click", () => {
            if (controller._episodeListEl) {
                controller._closeEpisodeListOverlay();
            } else {
                controller._openEpisodeListOverlay();
            }
        });
        leftCell.appendChild(episodesBtn);
    }
    const centerCell = document.createElement("div");
    Object.assign(centerCell.style, { flex: "0 0 auto", display: "flex", alignItems: "center", gap: "22px" });
    const rightCell = document.createElement("div");
    Object.assign(rightCell.style, { flex: "1 1 0", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "14px" });
    controlsRow.appendChild(leftCell);
    controlsRow.appendChild(centerCell);
    controlsRow.appendChild(rightCell);
    bar.appendChild(controlsRow);
    controller._centerControlsSlot = centerCell;

    /* Moved out of the More menu entirely (used to be a row there, "Audio & Subtitles")
       into its own transport-bar icon between mute and fullscreen - both are "what am I
       hearing/reading" controls a viewer reaches for far more often than anything else
       in that menu, so they earned equal billing with volume/fullscreen rather than
       being buried a tap deeper. */
    const audioSubtitlesBtn = document.createElement("button");
    audioSubtitlesBtn.type = "button";
    audioSubtitlesBtn.innerHTML = audioSubtitlesIconMarkup();
    audioSubtitlesBtn.setAttribute("aria-label", "Audio & Subtitles");
    Object.assign(audioSubtitlesBtn.style, {
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
    audioSubtitlesBtn.addEventListener("click", () => openAudioSubtitlesOverlay(controller));

    rightCell.appendChild(muteBtn);
    rightCell.appendChild(audioSubtitlesBtn);
    if (fullscreenBtn) rightCell.appendChild(fullscreenBtn);
    document.body.appendChild(bar);
    registerControlButton(controller, bar, { anchor: false });
    return bar;
}

/* Full-height right-side drawer (frameless, gradient fading into the video rather than
   a bordered/blurred glass panel - same white-text look as episode-list.js's queue
   overlay, just fading in from the right edge instead of up from the bottom) instead of
   a small flyout anchored to the hamburger button. Every category expands in place as
   an accordion section instead of replacing the whole panel with a new one to navigate
   back from. Picking a value only collapses that one section (see buildAccordionRow),
   so adjusting several settings in one sitting no longer means reopening the hamburger
   button between each one. */
const SHEET_GRADIENT = "linear-gradient(to left, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.88) 55%, rgba(0,0,0,0.5) 85%, transparent 100%)";

const MENU_SCROLL_CLASS = "streaming-player-menu-scroll";

/* A slim, on-theme scrollbar for any flyout content that overflows (subtitle search
   results, a long chapter/audio-track list) instead of the browser's default wide
   scrollbar clashing with the glass-panel look above. Injected once, lazily, rather than
   at module load - nothing needs it until a panel actually overflows. */
function ensureMenuScrollStyle() {
    if (document.getElementById("streaming-player-menu-scroll-style")) return;
    const style = document.createElement("style");
    style.id = "streaming-player-menu-scroll-style";
    style.textContent = `
        .${MENU_SCROLL_CLASS} {
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.25) transparent;
        }
        .${MENU_SCROLL_CLASS}::-webkit-scrollbar { width: 6px; }
        .${MENU_SCROLL_CLASS}::-webkit-scrollbar-track { background: transparent; }
        .${MENU_SCROLL_CLASS}::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 3px; }
        .${MENU_SCROLL_CLASS}::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }
    `;
    document.head.appendChild(style);
}

/* Shared row look for every tap-to-pick item inside an expanded accordion section
   (speed/sleep/zoom/audio/chapters/quality-cap/version presets) - one visual
   definition instead of each render function styling its own. */
function renderPickerList(content, items, { rowGap = 0 } = {}) {
    items.forEach((item, index) => {
        const row = document.createElement("button");
        row.type = "button";
        Object.assign(row.style, {
            display: "flex",
            alignItems: "center",
            gap: "12px",
            width: "100%",
            textAlign: "left",
            padding: "9px 16px",
            background: "transparent",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: "500",
            fontFamily: '"Roboto", sans-serif',
            marginBottom: index < items.length - 1 ? `${rowGap}px` : "0",
        });
        /* Only the Chapters section sets item.thumb - every other picker (speed, sleep
           timer, audio track...) leaves it undefined, so this is a no-op there. Hidden
           on error rather than left to show a broken-image icon - Plex's chapterImages
           endpoint isn't guaranteed pre-generated for every chapter. */
        if (item.thumb) {
            const thumb = document.createElement("img");
            thumb.src = item.thumb;
            thumb.loading = "lazy";
            thumb.alt = "";
            Object.assign(thumb.style, {
                width: "64px",
                height: "36px",
                borderRadius: "4px",
                objectFit: "cover",
                flex: "0 0 auto",
                background: "rgba(255,255,255,0.08)",
            });
            thumb.addEventListener("error", () => thumb.remove());
            row.appendChild(thumb);
        }
        const label = document.createElement("span");
        label.textContent = item.label;
        label.style.flex = "1 1 auto";
        row.appendChild(label);
        row.addEventListener("mouseenter", () => {
            row.style.background = "rgba(255,255,255,0.08)";
        });
        row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
        });
        row.addEventListener("click", () => item.onSelect && item.onSelect());
        content.appendChild(row);
    });
}

/* One row of the More sheet. Sections with `render` expand in place (accordion, one
   section open at a time per `state` - opening a new one collapses whatever else was
   open, via `state.expandedCollapse`); sections with `nav` instead replace the whole
   list with a different screen (see renderEffectsList) rather than expanding in
   place - used only for "Effects", whose three sub-controls (Shader Upscaling/Color
   Boost/Ambient Lighting) read better as their own dedicated list than squeezed inline
   under a fourth row. Sections with only `toggle` (Auto-Play, Performance Overlay) are
   plain on/off rows with nothing to expand or navigate to. `toggle` and `render` are
   independent - Ambient Lighting has both, flipping on/off without affecting whether
   its opacity section is open. */
function buildAccordionRow(list, state, section) {
    const wrap = document.createElement("div");
    wrap.style.borderBottom = "1px solid rgba(255,255,255,0.07)";

    const header = document.createElement("button");
    header.type = "button";
    Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        width: "100%",
        textAlign: "left",
        padding: "14px 16px",
        background: "transparent",
        border: "none",
        cursor: section.render || section.nav ? "pointer" : "default",
        fontFamily: '"Roboto", sans-serif',
    });

    const labelStack = document.createElement("span");
    Object.assign(labelStack.style, { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" });
    const labelEl = document.createElement("span");
    labelEl.textContent = section.label;
    Object.assign(labelEl.style, { color: "#fff", fontSize: "15px", fontWeight: "600" });
    labelStack.appendChild(labelEl);
    let valueEl = null;
    const setValue = (text) => {
        if (text) {
            if (!valueEl) {
                valueEl = document.createElement("span");
                Object.assign(valueEl.style, { fontSize: "12px", fontWeight: "400", color: "rgba(255,255,255,0.45)" });
                labelStack.appendChild(valueEl);
            }
            valueEl.textContent = text;
        } else if (valueEl) {
            valueEl.remove();
            valueEl = null;
        }
    };
    setValue(section.getValue ? section.getValue() : null);

    /* Icon + labelStack share one flex container (leftSide) rather than being direct
       children of `header` - header's own justify-content:space-between only reads as
       "label left, controls right" with exactly two children; a bare 3rd child (the
       icon) would get pushed to the middle instead of hugging the label. */
    const leftSide = document.createElement("span");
    Object.assign(leftSide.style, { display: "flex", alignItems: "center", gap: "12px", minWidth: "0", flex: "1 1 auto" });
    if (section.icon) {
        const iconEl = document.createElement("span");
        iconEl.innerHTML = section.icon;
        Object.assign(iconEl.style, { display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto", width: "20px", height: "20px", color: "rgba(255,255,255,0.75)" });
        leftSide.appendChild(iconEl);
    }
    leftSide.appendChild(labelStack);
    header.appendChild(leftSide);

    const rightSide = document.createElement("span");
    Object.assign(rightSide.style, { display: "flex", alignItems: "center", gap: "12px", flex: "0 0 auto" });
    if (section.toggle) {
        rightSide.appendChild(makeToggleSwitch(section.toggle.checked, (checked) => setValue(section.toggle.onChange(checked))));
    }

    let chevronEl = null;
    if (section.render || section.nav) {
        chevronEl = document.createElement("span");
        chevronEl.textContent = "›";
        Object.assign(chevronEl.style, { color: "rgba(255,255,255,0.35)", fontSize: "17px", display: "inline-block", transition: "transform 0.15s ease" });
        rightSide.appendChild(chevronEl);
    }
    if (rightSide.children.length) header.appendChild(rightSide);
    wrap.appendChild(header);

    if (section.render) {
        const content = document.createElement("div");
        content.style.display = "none";
        content.style.padding = "0 0 12px";
        wrap.appendChild(content);

        header.setAttribute("aria-expanded", "false");
        let built = false;
        const collapse = () => {
            content.style.display = "none";
            chevronEl.style.transform = "rotate(0deg)";
            header.setAttribute("aria-expanded", "false");
            if (state.expandedCollapse === collapse) state.expandedCollapse = null;
        };
        header.addEventListener("click", () => {
            if (content.style.display !== "none") {
                collapse();
                return;
            }
            if (state.expandedCollapse) state.expandedCollapse();
            if (!built) {
                built = true;
                section.render(content, { setValue, collapse });
            }
            content.style.display = "block";
            chevronEl.style.transform = "rotate(90deg)";
            header.setAttribute("aria-expanded", "true");
            state.expandedCollapse = collapse;
        });
    } else if (section.nav) {
        header.addEventListener("click", () => section.nav());
    }

    list.appendChild(wrap);
}

/* Every navigated-to sub-list (currently just Effects') gets the same dimmed,
   divider-topped "back up a level" row instead of each screen styling its own -
   distinguishes "leave this screen" from a selectable option in a way a plain row
   sharing the same style as everything else couldn't. */
function makeBackRow(onClick) {
    const row = document.createElement("button");
    row.type = "button";
    row.textContent = "‹  Back";
    Object.assign(row.style, {
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
        color: "rgba(255,255,255,0.55)",
        fontSize: "12px",
        fontWeight: "700",
        letterSpacing: "0.02em",
        cursor: "pointer",
        padding: "14px 16px",
        fontFamily: '"Roboto", sans-serif',
    });
    row.addEventListener("mouseenter", () => {
        row.style.color = "#fff";
    });
    row.addEventListener("mouseleave", () => {
        row.style.color = "rgba(255,255,255,0.55)";
    });
    row.addEventListener("click", onClick);
    return row;
}

export function openHamburgerMenu(controller, anchor) {
    closeInlineMenu(controller);
    ensureMenuScrollStyle();
    const session = controller._session;

    const scrim = document.createElement("div");
    Object.assign(scrim.style, { position: "fixed", inset: "0", zIndex: "10002", background: "transparent" });
    scrim.addEventListener("click", () => closeInlineMenu(controller));

    /* Full-height, right-hugging gradient backdrop (unchanged from the drawer this
       replaced) - the header+list card inside it (see `card` below) is what's actually
       vertically centered, via justifyContent, rather than the gradient itself
       shrinking to the card's height. A full-height backdrop that shrank to a short
       row list's own height left a stretch of plain, undarkened video below a
       vertically-centered card - the backdrop needs to keep covering the full screen
       height regardless of how tall the card inside it happens to be. */
    const sheet = document.createElement("div");
    Object.assign(sheet.style, {
        position: "fixed",
        top: "0",
        right: "0",
        bottom: "0",
        width: "min(400px, 100vw)",
        zIndex: "10003",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: SHEET_GRADIENT,
        fontFamily: '"Roboto", sans-serif',
        boxSizing: "border-box",
        opacity: "0",
        transform: "translateX(20px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    /* The actual visible "menu" - header plus scrollable row list, capped at 82vh and
       otherwise sized to its own content (a short row list, e.g. the Effects/Extras
       sub-screens, centers as a short card rather than stretching to fill the full
       backdrop). */
    const card = document.createElement("div");
    Object.assign(card.style, { display: "flex", flexDirection: "column", maxHeight: "82vh", minHeight: "0" });
    sheet.appendChild(card);

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", flex: "0 0 auto", padding: "24px 16px 12px" });
    const heading = document.createElement("div");
    heading.textContent = "More";
    Object.assign(heading.style, { color: "#fff", fontSize: "18px", fontWeight: "700" });
    header.appendChild(heading);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close menu");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
        width: "32px",
        height: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "transparent",
        color: "#fff",
        fontSize: "16px",
        cursor: "pointer",
        padding: "0",
    });
    closeBtn.addEventListener("click", () => closeInlineMenu(controller));
    header.appendChild(closeBtn);
    card.appendChild(header);

    const list = document.createElement("div");
    list.className = MENU_SCROLL_CLASS;
    Object.assign(list.style, { flex: "1 1 auto", minHeight: "0", overflowY: "auto", padding: "0 0 20px" });
    card.appendChild(list);

    function renderMainList() {
    list.innerHTML = "";
    const state = { expandedCollapse: null };
    /* Ordered by how often a row is actually touched, not the order features shipped
       in: what-you're-watching controls (Chapters/Audio & Subtitles) first, since
       those get touched per-video; source/quality (Version/Quality Cap) and the
       Auto-Play toggle next; Effects/Extras/Performance Overlay last, in that order -
       the three rows here most people set once and never revisit. */
    const sections = [];
    if (session?.chapters?.length) {
        sections.push({
            /* Opens the same horizontally-scrolling card overlay episode-list.js uses
               for browsing episodes/queue items, rather than an inline text-row picker
               - chapters read better as thumbnail cards than plain rows, same as
               episodes do. Closes the More sheet on the way there (see
               openChapterListOverlay), matching how opening the Episodes overlay
               already closes this sheet too. */
            key: "chapters",
            label: "Chapters",
            icon: chaptersIconMarkup(),
            nav: () => openChapterListOverlay(controller),
        });
    }
    /* Version and Quality Cap used to live one level deeper, behind a "Video Quality"
       row - flattened to their own top-level rows (Version only shown when this item
       actually has more than one Media[] entry, same "never an empty/dead affordance"
       rule Audio Track/Chapters follow) so changing either is one fewer tap. Quality
       Cap is always shown since it always has at least "Original" to show. */
    if (session?.mediaVersions?.length > 1) {
        sections.push({
            key: "version",
            label: "Version",
            icon: versionIconMarkup(),
            getValue: () => session.mediaVersions.find((v) => v.mediaIndex === session.mediaIndex)?.label || null,
            render: (content, helpers) => renderVersionSection(controller, content, helpers),
        });
    }
    sections.push({
        /* Own dedicated screen (see renderQualityCapList), not an inline expand - same
           reasoning as Subtitles above. */
        key: "qualitycap",
        label: "Quality Cap",
        icon: qualityCapIconMarkup(),
        getValue: () => qualityCapMenuLabel(controller),
        nav: () => renderQualityCapList(controller, list, renderMainList),
    });
    sections.push({
        key: "autoplay",
        label: "Auto-Play",
        /* No expand - same plain on/off toggle as Performance Overlay below, nothing
           to drill into (advancing to whatever's next in the queue is the whole
           feature, no strength/opacity to tune). Icon reuses skipIconMarkup's "next"
           glyph - advancing to the next queued item is exactly what this toggle does. */
        icon: skipIconMarkup("next"),
        getValue: () => (controller._autoPlayEnabled ? "On" : null),
        toggle: {
            checked: controller._autoPlayEnabled,
            onChange: (checked) => {
                controller._setAutoPlayEnabled(checked);
                return checked ? "On" : null;
            },
        },
    });
    sections.push({
        /* Navigates to a dedicated Shader Upscaling/Color Boost/Ambient Lighting list
           (see renderEffectsList) rather than expanding in place - three sub-controls
           read better as their own screen than squeezed inline under a fourth row. */
        key: "effects",
        label: "Effects",
        icon: effectsIconMarkup(),
        nav: () => renderEffectsList(controller, list, renderMainList),
    });
    sections.push({
        /* Same "own dedicated screen" reasoning as Effects above, for Playback Speed/
           Zoom/Sleep Timer - grouped as "Extras" since none of the three relate to
           each other the way Effects' three GPU-pipeline controls do, but each is
           simple/single-picker enough that squeezing all three top-level rows down to
           one still reads as a sensible cluster (playback tweaks that aren't part of
           the everyday audio/subtitle/quality set above). */
        key: "extras",
        label: "Extras",
        icon: extrasIconMarkup(),
        nav: () => renderExtrasList(controller, list, renderMainList),
    });
    sections.push({
        key: "stats",
        label: "Performance Overlay",
        /* No expand - nothing to drill into (no strength/opacity slider, unlike Shader
           Upscaling/Color Boost/Ambient Lighting above), just a plain on/off toggle. */
        icon: performanceIconMarkup(),
        getValue: () => (controller._statsOverlayEnabled ? "On" : null),
        toggle: {
            checked: controller._statsOverlayEnabled,
            onChange: (checked) => {
                controller._setStatsOverlayEnabled(checked);
                return checked ? "On" : null;
            },
        },
    });

    sections.forEach((section) => buildAccordionRow(list, state, section));
    }

    renderMainList();

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    controller._inlineMenuEl = sheet;
    controller._inlineMenuScrim = scrim;
    controller._inlineMenuAnchor = anchor;
    hideControls(controller);
    requestAnimationFrame(() => {
        sheet.style.opacity = "1";
        sheet.style.transform = "translateX(0)";
    });
}

/* "Auto (720p (10 Mbps))" while Auto Quality is actively adjusting the cap, else the
   plain preset label. Shared by the top-level "Quality Cap" row's own value and its
   expanded picker list so the two never show a different answer for the same state. */
function qualityCapMenuLabel(controller) {
    const label = QUALITY_CAP_PRESETS.find((p) => (p.kbps ?? null) === (controller._session?.qualityCapKbps ?? null))?.label || null;
    return controller._autoQualityEnabled ? `Auto (${label})` : label;
}

function renderVersionSection(controller, content, { setValue, collapse }) {
    const session = controller._session;
    const versions = session?.mediaVersions || [];
    renderPickerList(content, versions.map((v) => ({
        label: `${v.label}${v.mediaIndex === session.mediaIndex ? "  ✓" : ""}`,
        onSelect: () => {
            reloadWebSource(controller, { mediaIndex: v.mediaIndex });
            setValue(v.label);
            collapse();
        },
    })));
}

function renderQualityCapSection(controller, content, { setValue, collapse }) {
    const session = controller._session;
    const current = session?.qualityCapKbps ?? null;
    const autoOn = controller._autoQualityEnabled;
    /* No bandwidth signal exists on the native-HLS <video> branch (controller._hls is
       null there, see web-fallback.js's attachSource) - Auto Quality has nothing to
       evaluate against, so the row is omitted entirely rather than shown disabled.
       The persisted flag itself is untouched either way, so it still takes effect on
       a future session/device that does use hls.js. */
    const autoAvailable = !!controller._hls;
    const items = [];
    if (autoAvailable) {
        items.push({
            label: `Auto${autoOn ? "  ✓" : ""}`,
            onSelect: () => {
                setAutoQualityEnabled(controller, true);
                setValue(qualityCapMenuLabel(controller));
                collapse();
            },
        });
    }
    renderPickerList(
        content,
        [
            ...items,
            ...QUALITY_CAP_PRESETS.map((preset) => ({
                label: `${preset.label}${!autoOn && (preset.kbps ?? null) === current ? "  ✓" : ""}`,
                onSelect: () => {
                    setAutoQualityEnabled(controller, false);
                    reloadWebSource(controller, { qualityCapKbps: preset.kbps });
                    setValue(qualityCapMenuLabel(controller));
                    collapse();
                },
            })),
        ],
        { rowGap: 8 }
    );
}

/* "Quality Cap" navigates to its own screen (see buildAccordionRow's `nav` case)
   rather than expanding in place - same reasoning as Effects/Extras, just for one
   control instead of a cluster of several. Reuses renderQualityCapSection's picker-
   list body unchanged: `list` stands in for the accordion `content` div it normally
   renders into, and `onBack` (navigate to the main list, which re-derives every row's
   value fresh) stands in for `collapse`, so picking a preset here needs no separate
   "update this row's value" step of its own. */
function renderQualityCapList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    renderQualityCapSection(controller, list, { setValue: () => {}, collapse: onBack });
}

function renderAudioSection(controller, content, { setValue, collapse }) {
    const streams = controller._session?.audioStreams || [];
    const current = controller._session?.audioStreamId;
    renderPickerList(content, streams.map((stream) => ({
        label: `${stream.label}${stream.id === current ? "  ✓" : ""}`,
        onSelect: () => {
            reloadWebSource(controller, { audioStreamID: stream.id });
            setValue(stream.label);
            collapse();
        },
    })));
}

/* Audio Track and Subtitles' merged control, redone as its own right-anchored dialog
   (HBO Max's own audio/subtitle picker is the reference - a compact two-column grid,
   not a full screen) rather than a screen inside the More sheet's own single-list-of-
   rows shape - closes that sheet on the way there, same "own separate overlay" pattern
   openChapterListOverlay uses. The gradient panel itself spans the full screen height
   (top:0/bottom:0, same as the main hamburger sheet) so the fade reaches top to bottom
   even though its actual content is vertically centered and far shorter than that. */
export function openAudioSubtitlesOverlay(controller) {
    closeAudioSubtitlesOverlay(controller);
    closeInlineMenu(controller);

    const scrim = document.createElement("div");
    Object.assign(scrim.style, { position: "fixed", inset: "0", zIndex: "10002", background: "transparent" });
    scrim.addEventListener("click", () => closeAudioSubtitlesOverlay(controller));

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        position: "fixed",
        top: "0",
        right: "0",
        bottom: "0",
        zIndex: "10003",
        width: "min(820px, 92vw)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: SHEET_GRADIENT,
        fontFamily: '"Roboto", sans-serif',
        boxSizing: "border-box",
        padding: "20px 32px 24px",
        opacity: "0",
        transform: "translateX(20px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
        position: "absolute",
        top: "16px",
        right: "16px",
        width: "28px",
        height: "28px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "transparent",
        color: "#fff",
        fontSize: "16px",
        cursor: "pointer",
        padding: "0",
    });
    closeBtn.addEventListener("click", () => closeAudioSubtitlesOverlay(controller));
    panel.appendChild(closeBtn);

    /* Audio first (left), Subtitles second (right). Each column caps its own list at a
       fixed max-height and scrolls independently rather than the two needing to match
       heights exactly (unlike this control's previous top/bottom-split incarnation,
       nothing here requires the two columns to be the same height). */
    const grid = document.createElement("div");
    Object.assign(grid.style, { display: "flex", gap: "64px", marginTop: "12px", overflow: "hidden" });

    const audioColumn = buildAudioSubtitlesColumn("Audio");
    renderAudioSection(controller, audioColumn.body, { setValue: () => {}, collapse: () => {} });
    grid.appendChild(audioColumn.el);

    const subtitlesColumn = buildAudioSubtitlesColumn("Subtitles");
    renderSubtitleSection(controller, subtitlesColumn.body, { collapse: () => closeAudioSubtitlesOverlay(controller) });
    grid.appendChild(subtitlesColumn.el);

    panel.appendChild(grid);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    controller._audioSubtitlesEl = { scrim, panel };
    hideControls(controller);
    requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateX(0)";
    });
}

export function closeAudioSubtitlesOverlay(controller) {
    if (!controller._audioSubtitlesEl) return;
    controller._audioSubtitlesEl.scrim.remove();
    controller._audioSubtitlesEl.panel.remove();
    controller._audioSubtitlesEl = null;
    showControls(controller);
}

/* One column of the grid above - a bold heading with a divider underneath (matching
   the HBO reference's "Subtitles"/"Audio" column headers) plus a `body` container the
   caller renders its own picker list into. `body` caps its own height and scrolls
   independently of the other column, rather than the fixed 260px cap
   renderSubtitleSection's results list otherwise still carries - here that cap is
   exactly what "constrain to the height of the parent" already fixed once
   (renderSubtitleSection's own resultsEl is flex:1/minHeight:0, so it fills whatever
   height `body` actually has).

   maxHeight is calc(100vh - fixed chrome) rather than a flat vh percentage (a flat 40vh
   used to cap this well short of the panel's own full height, wasting most of a tall
   screen on a long subtitle-search-results list) - ~130px covers openAudioSubtitlesOverlay's
   panel padding (44px) + this column's own heading (~32px) + body's paddingTop (16px)
   + a margin of safety, so at the cap this genuinely uses close to the entire viewport
   instead of an arbitrary fraction of it. Short lists (Audio, most Subtitle searches)
   still size to their own content and sit centered (openAudioSubtitlesOverlay's own
   panel is justifyContent:"center") - this only changes what happens once content
   actually wants more room than that, which matters most on a short mobile viewport
   where 40vh of actual pixels was cramped rather than just "smaller than desktop". */
function buildAudioSubtitlesColumn(title) {
    const el = document.createElement("div");
    Object.assign(el.style, { flex: "1 1 0", minWidth: "0", display: "flex", flexDirection: "column" });

    const heading = document.createElement("div");
    heading.textContent = title;
    Object.assign(heading.style, {
        flex: "0 0 auto",
        color: "#fff",
        fontSize: "15px",
        fontWeight: "700",
        paddingBottom: "10px",
        borderBottom: "1px solid rgba(255,255,255,0.25)",
    });
    el.appendChild(heading);

    const body = document.createElement("div");
    body.className = MENU_SCROLL_CLASS;
    /* overflowX explicitly "hidden" here - per spec, leaving it at its default
       "visible" while overflowY is "auto" gets it implicitly upgraded to "auto" too,
       which was surfacing a horizontal scrollbar whenever a row's text nudged past the
       column's width. */
    Object.assign(body.style, {
        flex: "1 1 auto",
        minHeight: "0",
        maxHeight: "calc(100vh - 130px)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        overflowX: "hidden",
        paddingTop: "16px",
    });
    el.appendChild(body);

    return { el, body };
}

function renderSpeedSection(controller, content, { setValue, collapse }) {
    const current = controller._session?.playbackRate || 1;
    renderPickerList(content, PLAYBACK_RATES.map((rate) => ({
        label: `${rate}x${rate === current ? "  ✓" : ""}`,
        onSelect: () => {
            setPlaybackRate(controller, rate);
            setValue(`${rate}x`);
            collapse();
        },
    })));
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

function renderSleepSection(controller, content, { setValue, collapse }) {
    renderPickerList(content, [
        { label: `Off${!controller._sleepMinutes ? "  ✓" : ""}`, onSelect: () => { setSleepTimer(controller, 0); setValue(null); collapse(); } },
        ...SLEEP_TIMER_PRESETS_MIN.map((min) => ({
            label: `${min} min${controller._sleepMinutes === min ? "  ✓" : ""}`,
            onSelect: () => { setSleepTimer(controller, min * 60000); setValue(`${min}m`); collapse(); },
        })),
        { label: "End of episode", onSelect: () => { setSleepTimer(controller, 0); setValue(null); collapse(); } },
    ]);
}

/* ms=0 clears any pending timer - used by both "Off" (don't pause early) and "End of
   episode" (rely on the existing `ended` handling instead of a timer at all). */
function setSleepTimer(controller, ms) {
    clearTimeout(controller._sleepTimer);
    controller._sleepTimer = ms > 0 ? setTimeout(() => controller.pause(), ms) : null;
    controller._sleepMinutes = ms > 0 ? Math.round(ms / 60000) : 0;
}

function renderZoomSection(controller, content, { setValue, collapse }) {
    renderPickerList(content, ZOOM_LEVELS.map((level, idx) => ({
        label: `${level}x${idx === controller._zoomIndex ? "  ✓" : ""}`,
        onSelect: () => {
            controller._zoomIndex = idx;
            controller._zoomPanX = 0;
            controller._zoomPanY = 0;
            applyZoomTransform(controller);
            setValue(`${level}x`);
            collapse();
        },
    })));
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

const MODE_OPTIONS = [
    { key: "auto", label: "Auto" },
    { key: "on", label: "On" },
    { key: "off", label: "Off" },
];

/* Shared by renderShaderSection/renderColorBoostSection - a 3-way Auto/On/Off segmented control
   replacing the old separate enabled-toggle (hamburger row) + "Auto strength" checkbox
   (panel) pair, collapsed into shader-pipeline.js's upscaleModeOf/setUpscaleMode (and the
   Color Boost equivalents) - see those functions' own comments for why the underlying
   _shaderEnabled/_upscaleAuto flags stay as they were rather than being replaced outright.
   Disables the manual slider and snapshots the current auto-resolved value into it only
   in "auto" mode - "on" and "off" both leave it showing/editable at the manual value,
   same as the old enabled-toggle-off case always did (adjusting the remembered strength
   while the effect itself isn't currently applied). Snapshotting only happens at
   mode-switch time (not live-ticking while the panel stays open) since
   content-analysis.js only updates every ~750ms and the panel is normally only glanced
   at, not watched. */
function buildModeRow({ mode, onModeChange, getAutoValue, getManualValue, strengthInput, strengthLabel }) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", padding: "0 0 10px" });

    let currentMode = mode;
    const applyStrengthDisplay = (m) => {
        const auto = m === "auto";
        /* Only "on" leaves the slider interactive - "auto" because the value isn't
           user-driven, and "off" because there's no effect running for it to tune, same
           reasoning "off" already gets a dimmed/disabled mode button of its own. */
        const enabled = m === "on";
        strengthInput.disabled = !enabled;
        strengthInput.style.opacity = enabled ? "1" : "0.5";
        strengthInput.style.cursor = enabled ? "pointer" : "default";
        const value = auto ? (getAutoValue() ?? 0) : getManualValue();
        strengthInput.value = String(Math.round(value * 100));
        strengthLabel.textContent = `Strength: ${Math.round(value * 100)}%${auto ? " (auto)" : ""}`;
    };

    const buttons = MODE_OPTIONS.map((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = opt.label;
        Object.assign(btn.style, {
            width: "44px",
            textAlign: "center",
            boxSizing: "border-box",
            padding: "6px 0",
            fontSize: "12px",
            fontWeight: "600",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "6px",
            cursor: "pointer",
            background: "transparent",
            color: "rgba(255,255,255,0.7)",
        });
        btn.addEventListener("click", () => {
            currentMode = opt.key;
            onModeChange(opt.key);
            setActive(opt.key);
            applyStrengthDisplay(opt.key);
        });
        row.appendChild(btn);
        return { key: opt.key, btn };
    });

    const setActive = (activeMode) => {
        buttons.forEach(({ key, btn }) => {
            const selected = key === activeMode;
            btn.style.background = selected ? "#e5a00d" : "transparent";
            btn.style.color = selected ? "#1a1a1a" : "rgba(255,255,255,0.7)";
            btn.style.borderColor = selected ? "#e5a00d" : "rgba(255,255,255,0.15)";
        });
    };
    setActive(mode);
    applyStrengthDisplay(mode);

    /* Lets the caller re-run the auto-value refresh (see startLiveAutoRefresh below)
       without duplicating applyStrengthDisplay's formatting/disabled-state logic - a
       no-op whenever this row isn't currently in "auto" mode, so it's safe to call
       blindly on a timer. */
    const refreshIfAuto = () => {
        if (currentMode === "auto") applyStrengthDisplay("auto");
    };

    return { row, refreshIfAuto };
}

/* Ticks `refresh` while `el` stays in the DOM, then stops itself - used by the two
   Effects rows with an Auto mode (Shader Upscaling/Color Boost) to reflect
   content-analysis.js's background strength recalculation (every ~750ms, see
   CONTENT_SAMPLE_INTERVAL_MS there) instead of leaving a stale snapshot from whenever
   "Auto" was last tapped. Polls DOM connectedness rather than requiring an explicit
   teardown call, since this row can disappear via several different paths (back
   navigation, closing the whole sheet) that would otherwise each need their own
   cleanup wired in. */
function startLiveAutoRefresh(el, refresh) {
    const id = setInterval(() => {
        if (!el.isConnected) {
            clearInterval(id);
            return;
        }
        refresh();
    }, 750);
}

/* "Effects" navigates to a whole separate list (see buildAccordionRow's `nav` case)
   rather than expanding in place - Shader Upscaling/Color Boost/Ambient Lighting read
   better as their own dedicated screen than squeezed inline under a fourth row. Clears
   and rebuilds `list` in place (same element, new contents) rather than swapping in a
   second list element, so the sheet's own scroll position/height logic doesn't need to
   know which screen is currently showing. Unlike the main list's rows, these three are
   plain always-visible rows (see buildEffectRow) rather than accordion sections - with
   only three of them and every one landing on a slider, tap-to-expand just added a step
   between opening "Effects" and reaching the control someone came here for. */
function renderEffectsList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    buildShaderEffectRow(controller, list);
    buildColorBoostEffectRow(controller, list);
    buildAmbientEffectRow(controller, list);
}

/* Shared shell for the three Effects rows below - icon+label (and an optional caption
   under the label) on the left, whatever control(s) belong at a glance (mode buttons or
   a toggle) on the right, matching buildAccordionRow's header layout minus the chevron/
   click-to-expand behavior. Returns `rightSide` for the caller to drop its control into,
   and the row itself (`wrap`) for the caller to append full-width content (e.g. a
   slider) below the header line. */
function buildEffectRow(list, { icon, label, caption }) {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { borderBottom: "1px solid rgba(255,255,255,0.07)", padding: "14px 16px" });

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" });

    const leftSide = document.createElement("span");
    Object.assign(leftSide.style, { display: "flex", alignItems: "center", gap: "12px", minWidth: "0", flex: "1 1 auto" });
    const iconEl = document.createElement("span");
    iconEl.innerHTML = icon;
    Object.assign(iconEl.style, { display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto", width: "20px", height: "20px", color: "rgba(255,255,255,0.75)" });
    leftSide.appendChild(iconEl);

    const labelStack = document.createElement("span");
    Object.assign(labelStack.style, { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" });
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    Object.assign(labelEl.style, { color: "#fff", fontSize: "15px", fontWeight: "600" });
    labelStack.appendChild(labelEl);
    if (caption) {
        const captionEl = document.createElement("span");
        captionEl.textContent = caption;
        Object.assign(captionEl.style, { fontSize: "11px", fontWeight: "400", color: "rgba(255,255,255,0.45)" });
        labelStack.appendChild(captionEl);
    }
    leftSide.appendChild(labelStack);
    header.appendChild(leftSide);

    const rightSide = document.createElement("span");
    Object.assign(rightSide.style, { display: "flex", alignItems: "center", gap: "12px", flex: "0 0 auto" });
    header.appendChild(rightSide);

    wrap.appendChild(header);
    list.appendChild(wrap);
    return { wrap, rightSide };
}

/* Reuses fullscreenIconMarkup's expand-corners glyph - upscaling is, visually, the same
   "stretch the picture outward" idea. No manual Off/Anime4K/Live-Action picker -
   controller._shaderAutoType is decided once per video from its Plex genre tags (see
   detectShaderType) and shown here as read-only info via the caption. The mode row +
   slider are the only remaining controls, and dragging strength to 0% in "on" mode is
   what a plain "Off" used to be. */
function buildShaderEffectRow(controller, list) {
    const { wrap, rightSide } = buildEffectRow(list, {
        icon: fullscreenIconMarkup(false),
        label: "Shader Upscaling",
        caption: `Detected: ${SHADER_TYPES[controller._shaderAutoType].label}`,
    });

    const strengthLabel = document.createElement("div");
    Object.assign(strengthLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "10px 0 4px" });

    const strengthInput = document.createElement("input");
    strengthInput.type = "range";
    strengthInput.min = "0";
    strengthInput.max = "100";
    Object.assign(strengthInput.style, { display: "block", width: "100%", accentColor: "#e5a00d", cursor: "pointer", boxSizing: "border-box" });
    strengthInput.addEventListener("input", () => {
        strengthLabel.textContent = `Strength: ${strengthInput.value}%`;
        setShaderStrength(controller, Number(strengthInput.value) / 100);
    });

    const { row: modeRow, refreshIfAuto } = buildModeRow({
        mode: upscaleModeOf(controller),
        onModeChange: (mode) => setUpscaleMode(controller, mode),
        getAutoValue: () => controller._autoUpscaleStrength,
        getManualValue: () => controller._shaderStrength,
        strengthInput,
        strengthLabel,
    });
    rightSide.appendChild(modeRow);
    wrap.appendChild(strengthLabel);
    wrap.appendChild(strengthInput);
    startLiveAutoRefresh(strengthInput, refreshIfAuto);
}

/* Same pattern as buildShaderEffectRow above, simpler since there's no auto-detected
   type to show as read-only info here - just the one strength control. Unlike
   Android's equivalent panel, this applies live on every `input` event rather than
   gating to release: both compiled GL programs stay resident (see
   ensureShaderPipeline), so a strength change here is only a uniform update on the next
   frame, not a program rebuild. */
function buildColorBoostEffectRow(controller, list) {
    const { wrap, rightSide } = buildEffectRow(list, { icon: colorBoostIconMarkup(), label: "Color Boost" });

    const strengthLabel = document.createElement("div");
    Object.assign(strengthLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "10px 0 4px" });

    const strengthInput = document.createElement("input");
    strengthInput.type = "range";
    strengthInput.min = "0";
    strengthInput.max = "100";
    Object.assign(strengthInput.style, { display: "block", width: "100%", accentColor: "#e5a00d", cursor: "pointer", boxSizing: "border-box" });
    strengthInput.addEventListener("input", () => {
        strengthLabel.textContent = `Strength: ${strengthInput.value}%`;
        setColorBoostStrength(controller, Number(strengthInput.value) / 100);
    });

    const { row: modeRow, refreshIfAuto } = buildModeRow({
        mode: colorBoostModeOf(controller),
        onModeChange: (mode) => setColorBoostMode(controller, mode),
        getAutoValue: () => controller._autoColorBoostStrength,
        getManualValue: () => controller._colorBoostStrength,
        strengthInput,
        strengthLabel,
    });
    rightSide.appendChild(modeRow);
    wrap.appendChild(strengthLabel);
    wrap.appendChild(strengthInput);
    startLiveAutoRefresh(strengthInput, refreshIfAuto);
}

/* Same pattern as buildShaderEffectRow above (a continuous slider can't be expressed as
   tappable picker rows) - simpler, since there's no auto-detected type to show as read-
   only info here, just the one opacity control plus the on/off toggle. */
function buildAmbientEffectRow(controller, list) {
    const { wrap, rightSide } = buildEffectRow(list, { icon: ambientIconMarkup(), label: "Ambient Lighting" });

    const opacityLabel = document.createElement("div");
    opacityLabel.textContent = `Opacity: ${Math.round(controller._ambientOpacity * 100)}%`;
    Object.assign(opacityLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "10px 0 4px" });

    const opacityInput = document.createElement("input");
    opacityInput.type = "range";
    opacityInput.min = "0";
    opacityInput.max = "100";
    opacityInput.value = String(Math.round(controller._ambientOpacity * 100));
    Object.assign(opacityInput.style, { display: "block", width: "100%", accentColor: "#e5a00d", boxSizing: "border-box" });
    opacityInput.addEventListener("input", () => {
        opacityLabel.textContent = `Opacity: ${opacityInput.value}%`;
        setAmbientOpacity(controller, Number(opacityInput.value) / 100);
    });

    /* No effect running to tune while the toggle is off, same "disabled unless there's
       something to adjust" reasoning as Shader Upscaling/Color Boost's own strength
       slider (see buildModeRow's applyStrengthDisplay). */
    const applyOpacityEnabled = (enabled) => {
        opacityInput.disabled = !enabled;
        opacityInput.style.opacity = enabled ? "1" : "0.5";
        opacityInput.style.cursor = enabled ? "pointer" : "default";
    };
    applyOpacityEnabled(controller._ambientEnabled);

    rightSide.appendChild(makeToggleSwitch(controller._ambientEnabled, (checked) => {
        controller._setAmbientEnabled(checked);
        applyOpacityEnabled(checked);
    }));
    wrap.appendChild(opacityLabel);
    wrap.appendChild(opacityInput);
}

/* "Extras" - same dedicated-screen pattern as renderEffectsList above, for Playback
   Speed/Zoom/Sleep Timer instead of the shader/color/ambient trio. */
function renderExtrasList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    const state = { expandedCollapse: null };
    buildAccordionRow(list, state, {
        key: "speed",
        label: "Playback Speed",
        icon: speedIconMarkup(),
        getValue: () => `${controller._session?.playbackRate || 1}x`,
        render: (content, helpers) => renderSpeedSection(controller, content, helpers),
    });
    buildAccordionRow(list, state, {
        key: "zoom",
        label: "Zoom",
        icon: zoomIconMarkup(),
        getValue: () => `${ZOOM_LEVELS[controller._zoomIndex]}x`,
        render: (content, helpers) => renderZoomSection(controller, content, helpers),
    });
    buildAccordionRow(list, state, {
        key: "sleep",
        label: "Sleep Timer",
        icon: sleepIconMarkup(),
        getValue: () => (controller._sleepMinutes ? `${controller._sleepMinutes}m` : null),
        render: (content, helpers) => renderSleepSection(controller, content, helpers),
    });
}

/* A small on/off pill, e.g. Shader Upscaling's row in openHamburgerMenu - plain divs
   rather than a native <input type="checkbox">/<label> pair, since this nests inside a
   row that's itself a <button> and interactive controls can't nest inside one per the
   HTML content model. stopPropagation on click keeps a tap on the switch from also
   bubbling up into the row's own onSelect (which opens a submenu). */
function makeToggleSwitch(checked, onChange) {
    let isOn = checked;
    const el = document.createElement("div");
    el.setAttribute("role", "switch");
    el.setAttribute("aria-checked", String(isOn));
    Object.assign(el.style, {
        position: "relative",
        width: "34px",
        height: "20px",
        flex: "0 0 auto",
        borderRadius: "10px",
        background: isOn ? "#e5a00d" : "rgba(255,255,255,0.25)",
        transition: "background 0.15s ease",
        cursor: "pointer",
    });
    const thumb = document.createElement("div");
    Object.assign(thumb.style, {
        position: "absolute",
        top: "2px",
        left: isOn ? "16px" : "2px",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        transition: "left 0.15s ease",
    });
    el.appendChild(thumb);
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        isOn = !isOn;
        el.setAttribute("aria-checked", String(isOn));
        el.style.background = isOn ? "#e5a00d" : "rgba(255,255,255,0.25)";
        thumb.style.left = isOn ? "16px" : "2px";
        onChange(isOn);
    });
    return el;
}

export function closeInlineMenu(controller) {
    const wasOpen = !!controller._inlineMenuEl;
    if (controller._inlineMenuEl) {
        controller._inlineMenuEl.remove();
        controller._inlineMenuEl = null;
    }
    if (controller._inlineMenuScrim) {
        controller._inlineMenuScrim.remove();
        controller._inlineMenuScrim = null;
    }
    controller._inlineMenuAnchor = null;
    if (wasOpen) showControls(controller);
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
   search") more than a pre-playback picker step. */
function renderSubtitleSection(controller, content, { collapse }) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search subtitles…";
    input.value = controller._session?.title || "";
    Object.assign(input.style, {
        flex: "0 0 auto",
        display: "block",
        width: "calc(100% - 32px)",
        margin: "0 16px 8px",
        padding: "9px 12px",
        borderRadius: "8px",
        border: "1px solid rgba(255,255,255,0.15)",
        background: "rgba(255,255,255,0.06)",
        color: "#fff",
        fontSize: "13px",
        fontFamily: '"Roboto", sans-serif',
        boxSizing: "border-box",
    });

    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.textContent = "Search";
    Object.assign(searchBtn.style, {
        flex: "0 0 auto",
        display: "block",
        width: "calc(100% - 32px)",
        margin: "0 16px 10px",
        padding: "9px",
        borderRadius: "8px",
        border: "none",
        background: "#e5a00d",
        color: "#161619",
        fontSize: "13px",
        fontWeight: "700",
        cursor: "pointer",
        boxSizing: "border-box",
    });

    /* flex:1 1 auto/minHeight:0 fills exactly whatever height is left in the parent
       column after the heading/input/button above (see buildAudioSubtitlesColumn) -
       the one and only scroll region for this column, not a second fixed-height
       (previously 260px) scroller nested inside that column's own. */
    const resultsEl = document.createElement("div");
    resultsEl.className = MENU_SCROLL_CLASS;
    Object.assign(resultsEl.style, {
        flex: "1 1 auto",
        minHeight: "0",
        fontSize: "13px",
        color: "rgba(255,255,255,0.7)",
        overflowY: "auto",
        overflowX: "hidden",
        padding: "0 16px",
    });

    const runSearch = async () => {
        if (!input.value.trim()) {
            resultsEl.textContent = "Type something to search for.";
            return;
        }
        resultsEl.textContent = "Searching…";
        try {
            const results = await StreamingSubtitles.search(controller._session, { title: input.value });
            resultsEl.innerHTML = "";
            if (!results.length) {
                resultsEl.textContent = "No results.";
                return;
            }
            const appliedRatingKey = controller._session?.ratingKey;
            results.forEach((r) => {
                const row = document.createElement("button");
                row.type = "button";
                const isApplied = subtitleStore.isAppliedResult(appliedRatingKey, r);
                row.textContent = `${r.label} (${r.languageCode})${isApplied ? "  ✓" : ""}`;
                Object.assign(row.style, {
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 4px",
                    background: "transparent",
                    color: "#fff",
                    border: "none",
                    borderRadius: "8px",
                    cursor: "pointer",
                    fontSize: "13px",
                    marginBottom: "2px",
                    boxSizing: "border-box",
                });
                row.addEventListener("mouseenter", () => {
                    row.style.background = "rgba(255,255,255,0.1)";
                });
                row.addEventListener("mouseleave", () => {
                    row.style.background = "transparent";
                });
                row.addEventListener("click", () => applySubtitleResult(controller, r, row, collapse));
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

    content.appendChild(input);
    content.appendChild(searchBtn);
    /* Both only shown once a subtitle is actually attached - offsetting/removing a
       track that doesn't exist yet has nothing to act on. Rebuilt fresh on every render
       (same as the rest of this section) rather than kept in sync some other way, so
       reopening the menu after a fresh applySubtitleResult always picks both up. */
    if (controller._videoEl?.textTracks?.[0]) {
        content.appendChild(buildSubtitleOffsetRow(controller));
        content.appendChild(buildSubtitleOffButton(controller, collapse));
    }
    content.appendChild(resultsEl);

    if (input.value) runSearch();
}

/* Real-world .srt files are commonly a fixed amount early/late against the actual
   video - this nudges every cue's timing by SUBTITLE_OFFSET_STEP_MS per click without
   needing a new download. Kept as a flat +/- control (no numeric entry) to match the
   rest of this menu's picker-row style rather than adding a text input just for this. */
const SUBTITLE_OFFSET_STEP_MS = 250;

function buildSubtitleOffsetRow(controller) {
    const row = document.createElement("div");
    Object.assign(row.style, {
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        margin: "0 16px 10px",
        gap: "10px",
    });

    const label = document.createElement("span");
    Object.assign(label.style, {
        fontSize: "13px",
        color: "rgba(255,255,255,0.7)",
    });
    const renderLabel = () => {
        const ms = controller._subtitleOffsetMs || 0;
        label.textContent = `Sync: ${ms > 0 ? "+" : ""}${ms}ms`;
    };
    renderLabel();

    const makeStepBtn = (glyph, delta) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = glyph;
        btn.setAttribute("aria-label", delta < 0 ? "Subtitles earlier" : "Subtitles later");
        Object.assign(btn.style, {
            flex: "0 0 auto",
            width: "30px",
            height: "30px",
            borderRadius: "6px",
            border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(255,255,255,0.08)",
            color: "#fff",
            fontSize: "16px",
            fontWeight: "700",
            lineHeight: "1",
            cursor: "pointer",
        });
        btn.addEventListener("click", () => {
            adjustSubtitleOffset(controller, delta);
            renderLabel();
        });
        return btn;
    };

    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", gap: "6px", flex: "0 0 auto" });
    buttons.appendChild(makeStepBtn("–", -SUBTITLE_OFFSET_STEP_MS));
    buttons.appendChild(makeStepBtn("+", SUBTITLE_OFFSET_STEP_MS));

    row.appendChild(label);
    row.appendChild(buttons);
    return row;
}

/* Plain text-button row, matching the rest of this menu's picker style - removes the
   currently attached subtitle and forgets it (see removeSubtitleResult) rather than
   just hiding it for this session, so it doesn't come back next time this title plays. */
function buildSubtitleOffButton(controller, collapse) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Off";
    Object.assign(btn.style, {
        display: "block",
        width: "calc(100% - 32px)",
        margin: "0 16px 10px",
        padding: "9px",
        borderRadius: "8px",
        border: "1px solid rgba(255,255,255,0.2)",
        background: "rgba(255,255,255,0.08)",
        color: "#fff",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        boxSizing: "border-box",
    });
    btn.addEventListener("click", () => removeSubtitleResult(controller, collapse));
    return btn;
}

/* Shifts every cue relative to its ORIGINAL parsed time (cue._baseStart/_baseEnd),
   captured lazily on first adjustment here rather than up front when the track loads -
   by the time this menu is reachable a subtitle is already attached and its cues
   already parsed, so a separate <track> "load" listener would just be dead weight.
   Mutating startTime/endTime directly (rather than re-deriving cues from scratch) is
   what makes the browser's own cuechange timeline immediately reflect the new offset.
   Absolute rather than a delta so applyRememberedSubtitle below can restore a
   previously-saved offset in one call, the same function the +/- buttons use. */
function setSubtitleOffset(controller, offsetMs) {
    const textTrack = controller._videoEl?.textTracks?.[0];
    if (!textTrack) return;
    controller._subtitleOffsetMs = offsetMs;
    const offsetSec = offsetMs / 1000;
    Array.from(textTrack.cues || []).forEach((cue) => {
        if (cue._baseStart == null) {
            cue._baseStart = cue.startTime;
            cue._baseEnd = cue.endTime;
        }
        cue.startTime = cue._baseStart + offsetSec;
        cue.endTime = cue._baseEnd + offsetSec;
    });
}

/* Persisted on every click (subtitle-store.js's setAppliedOffsetMs), not just kept in
   controller._subtitleOffsetMs - so a sync adjustment survives closing and reopening
   this title, the same as the subtitle choice itself already does. Web/Xbox only, see
   subtitle-store.js's own header comment for why Android has no equivalent yet. */
function adjustSubtitleOffset(controller, deltaMs) {
    setSubtitleOffset(controller, (controller._subtitleOffsetMs || 0) + deltaMs);
    subtitleStore.setAppliedOffsetMs(controller._session?.ratingKey, controller._subtitleOffsetMs);
}

/* Shared by applySubtitleResult below and applyRememberedSubtitle (called from
   plex-player.js at the start of every session) so the native-vs-web branch only lives
   in one place. result is the raw search-result object (not the JSON-stringified form
   PlayerUiHelper's list rows carry as fileId) - re-stringified here so the native side
   learns which result this was, the same fileId shape PlayerActivity already gets from
   subtitleSearchRequested's own results. Needed so PlayerActivity.currentSubtitleFileId
   gets set on this path too, not just on a manual pick through
   native-bridge.js's subtitleSelectRequested listener. */
async function attachDownloadedSubtitle(controller, text, languageCode, result) {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
        await setNativeSubtitle(text, languageCode, "application/x-subrip");
        await notifyNativeSubtitleApplied(JSON.stringify(result), result.label);
    } else {
        await attachSubtitleTrack(controller, text, languageCode, result.label);
    }
}

/* rowEl gets an inline status update on failure instead of the previous
   console.error-only handling - a swallowed error here looked indistinguishable from
   "the click didn't register" since nothing on screen ever changed. Plex's own download
   is asynchronous (see plex-subtitles.js) so this can take up to ~20s, not the near-
   instant round-trip the direct-OpenSubtitles path (opensubtitles.js) makes. */
async function applySubtitleResult(controller, result, rowEl, collapse) {
    const originalLabel = rowEl?.textContent;
    if (rowEl) {
        rowEl.textContent = result.provider === "opensubtitles" ? "Downloading…" : "Downloading via Plex…";
        rowEl.disabled = true;
    }
    try {
        const { text, languageCode } = await StreamingSubtitles.download(controller._session, result);
        await attachDownloadedSubtitle(controller, text, languageCode, result);
        /* Remembered per-title (ratingKey), not per-session - see subtitle-store.js.
           plex-player.js's applyRememberedSubtitle re-reads this at the start of the
           next session for the same title, so this same result (served from the cache
           subtitle-provider.js's download() already populated above, not a fresh
           network call) auto-reapplies without the user searching/selecting again. */
        subtitleStore.setAppliedSubtitle(controller._session?.ratingKey, result);
        collapse();
    } catch (e) {
        console.error("StreamingPlayer: subtitle download failed -", e);
        if (rowEl) {
            rowEl.disabled = false;
            rowEl.textContent = `${originalLabel} — failed: ${e.message}`;
        }
    }
}

/* Re-attaches whatever subtitle was last applied to this title (if any), without the
   user searching/selecting again - called once per session from plex-player.js right
   after playback actually starts (native or web), since attaching needs a live
   <video>/native player to attach to. download() below is normally served from
   subtitle-provider.js's own cache (subtitle-store.js), not a fresh network call. */
export async function applyRememberedSubtitle(controller) {
    const ratingKey = controller._session?.ratingKey;
    const remembered = subtitleStore.getAppliedSubtitle(ratingKey);
    if (!remembered) return;
    try {
        const { text, languageCode } = await StreamingSubtitles.download(controller._session, remembered);
        await attachDownloadedSubtitle(controller, text, languageCode, remembered);
        /* A fresh apply resets the offset to 0 on both legs (attachSubtitleTrack's own
           reset on web; PlayerActivity.applySubtitle's on native) - this restores
           whatever the user last synced to, only bothering the native bridge when
           there's actually a non-zero offset to restore. */
        const offsetMs = subtitleStore.getAppliedOffsetMs(ratingKey);
        if (offsetMs) {
            if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
                await setNativeSubtitleOffset(offsetMs);
            } else {
                setSubtitleOffset(controller, offsetMs);
            }
        }
    } catch (e) {
        console.error("StreamingPlayer: failed to reapply remembered subtitle -", e);
    }
}

/* The web/Xbox leg's own "Off" row - Android has its own native equivalent
   (PlayerActivity.clearSubtitleTrack, reachable from PlayerUiHelper's menu; chrome.js's
   whole hamburger UI never renders on Android in the first place, see applySubtitleResult's
   history). Clears both the live <track> and the remembered per-title choice, so this
   title doesn't just come back with a subtitle the next time it plays. */
function removeSubtitleResult(controller, collapse) {
    detachSubtitleTrack(controller);
    subtitleStore.clearAppliedSubtitle(controller._session?.ratingKey);
    collapse();
}

/* Only the web/Xbox leg needs this - <video><track> requires WebVTT, while Android's
   Media3 leg (see applySubtitleResult) hands ExoPlayer the raw .srt URL directly, since
   SubripDecoder parses .srt natively and converting it there would be wasted work.
   Revokes the previous track's blob URL rather than leaking one per search. */
function attachSubtitleTrack(controller, srtText, langCode, label) {
    if (!controller._videoEl) return Promise.resolve();
    if (controller._subtitleTrackUrl) URL.revokeObjectURL(controller._subtitleTrackUrl);
    /* A new subtitle file has its own inherent timing - carrying over the previous
       file's offset would misalign this one from the very first cue. */
    controller._subtitleOffsetMs = 0;
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
    const textTrack = controller._videoEl.textTracks[0];
    if (!textTrack) return Promise.resolve();
    /* Rendered through a manual overlay instead of native "showing" mode - the shader
       upscaling/Color Boost canvas (shader-pipeline.js) opacity:0's the <video> element
       and paints from the raw decoded frame instead, which never includes the browser's
       own separately-composited caption layer. Native rendering would work whenever
       neither is active and silently vanish the instant either turns on, so this always
       draws cues itself rather than having two divergent code paths depending on
       whatever the shader state happens to be. */
    textTrack.mode = "hidden";
    const overlay = ensureSubtitleOverlay(controller);
    textTrack.addEventListener("cuechange", () => {
        const cues = Array.from(textTrack.activeCues || []);
        overlay.style.display = cues.length ? "block" : "none";
        overlay.innerHTML = cues.map((c) => renderSubtitleCueHtml(c.text)).join("<br>");
    });
    /* The <track> loads/parses its VTT asynchronously - textTrack.cues is still empty
       right after this function returns. A caller applying a remembered sync offset
       immediately afterward (applyRememberedSubtitle) needs the actual cues to exist
       before setSubtitleOffset's shift loop has anything to shift; without this wait,
       that offset silently no-ops (only _subtitleOffsetMs gets set) until some later
       unrelated +/- click re-runs the loop against by-then-loaded cues. */
    return new Promise((resolve) => {
        if (textTrack.cues && textTrack.cues.length) {
            resolve();
            return;
        }
        const done = () => {
            track.removeEventListener("load", done);
            track.removeEventListener("error", done);
            resolve();
        };
        track.addEventListener("load", done, { once: true });
        track.addEventListener("error", done, { once: true });
    });
}

/* Counterpart to attachSubtitleTrack above, used by removeSubtitleResult's "Off" row -
   removes the live <track> and hides the overlay rather than leaving the last cue's
   text stuck on screen with nothing left to clear it. */
function detachSubtitleTrack(controller) {
    if (!controller._videoEl) return;
    controller._videoEl.querySelectorAll("track").forEach((t) => t.remove());
    if (controller._subtitleTrackUrl) {
        URL.revokeObjectURL(controller._subtitleTrackUrl);
        controller._subtitleTrackUrl = null;
    }
    controller._subtitleOffsetMs = 0;
    if (controller._subtitleOverlayEl) {
        controller._subtitleOverlayEl.style.display = "none";
        controller._subtitleOverlayEl.innerHTML = "";
    }
}

/* Escapes everything first (this is untrusted third-party subtitle text), then
   re-enables only the handful of legacy SRT-style styling tags real-world .srt files
   actually carry (b/i/u, plus <font color="...">) - native VTT "showing" mode used to
   render these for free; a plain escape-and-dump would instead print the raw tags as
   literal text (confirmed against a real OpenSubtitles .srt with <font color> lines).
   Anything not matching one of these exact patterns stays escaped/literal rather than
   risking arbitrary HTML/CSS injection from a subtitle file. */
function renderSubtitleCueHtml(text) {
    let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    html = html.replace(/&lt;(\/?)(b|i|u)&gt;/gi, "<$1$2>");
    html = html.replace(/&lt;font color="(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)"&gt;/gi, '<span style="color:$1">');
    html = html.replace(/&lt;\/font&gt;/gi, "</span>");
    return html;
}

/* Lazily created (and reused across subtitle-result picks) rather than built alongside
   the video in web-fallback.js's playWeb - most sessions never touch subtitles at all.
   z-index 10001 matches every other always-on-top-of-the-shader-canvas overlay in this
   file (e.g. updateSkipButton) - the canvas itself sits at 10000 (shader-pipeline.js). */
function ensureSubtitleOverlay(controller) {
    if (controller._subtitleOverlayEl) return controller._subtitleOverlayEl;
    const overlay = document.createElement("div");
    overlay.className = "streaming-player-subtitle-overlay";
    Object.assign(overlay.style, {
        position: "fixed",
        left: "5%",
        right: "5%",
        bottom: "85px",
        zIndex: "10001",
        textAlign: "center",
        pointerEvents: "none",
        color: "rgba(235,235,235,0.95)",
        fontFamily: '"Roboto", sans-serif',
        fontWeight: "700",
        fontSize: "1.4em",
        lineHeight: "1.3",
        textShadow: "0 2px 6px rgba(0,0,0,0.85)",
        display: "none",
    });
    document.body.appendChild(overlay);
    controller._subtitleOverlayEl = overlay;
    return overlay;
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
            bottom: "170px",
            right: "40px",
            zIndex: "10001",
            padding: "10px 22px",
            borderRadius: "4px",
            border: "1px solid rgba(255,255,255,0.7)",
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            fontSize: "13px",
            fontWeight: "700",
            letterSpacing: "0.03em",
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
