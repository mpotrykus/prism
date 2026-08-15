import { registerControlButton } from "./chrome-controls.js";
import { PLAYER_FOCUSABLE_CLASS } from "./shared.js";
import { loadBifIndex, findNearestBifFrame, fetchBifFrameUrl } from "../core/bif.js";
import { plexAssetUrl } from "../core/plex-asset-url.js";
import { fetchQueuedTitle } from "../core/title-fetch.js";

/* Bottom transport bar (title/subtitle + remaining time, scrub bar/chapter segments/BIF
   scrub-preview) and the floating center play/pause button, mirroring the Android native
   player's layout (see PlayerUiHelper.java): a single large play/pause control floating
   over the video, a scrub bar pinned to the bottom, nothing else in either. Chapter nav,
   title nav, the 5s seek buttons, volume, Audio & Subtitles and fullscreen used to live
   here too - all removed rather than ported, since Android's own chrome doesn't have them
   either (volume/fullscreen have no Android equivalent to begin with; chapter/title/5s nav
   is still reachable - chapters via the More menu's Chapters row and Xbox's bumpers/
   triggers (see plex-player.js's _handlePlayerNavCommand), any queued title via the
   Episodes overlay - just not as dedicated transport-bar buttons; Audio & Subtitles moved
   into the More menu, see chrome-menu.js). Takes the StreamingPlayerController instance as
   an explicit first argument (see native-bridge.js/shader-pipeline.js for why) rather than
   owning independent state - the idle-fade timer and session state are shared with the
   rest of the player chrome, not cleanly separable per element. */

/* The one on-screen playback control this chrome has left, centered over the video rather
   than living in the transport bar - matches Android's buildFloatingPlaybackControls (a
   60dp play/pause, title-prev/next only on non-touch devices - dropped here per the same
   "no title nav buttons" decision as the transport bar's own header comment above). */
export function buildFloatingPlayButton(controller, video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add(PLAYER_FOCUSABLE_CLASS);
    btn.setAttribute("aria-label", "Play/Pause");
    Object.assign(btn.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: "10001",
        width: "76px",
        height: "76px",
        borderRadius: "50%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "rgba(20,20,20,0.4)",
        color: "#fff",
        fontSize: "32px",
        cursor: "pointer",
        padding: "0",
    });
    const syncPlayIcon = () => {
        btn.textContent = video.paused ? "▶" : "❙❙";
    };
    syncPlayIcon();
    btn.addEventListener("click", () => {
        if (video.paused) video.play();
        else video.pause();
    });
    video.addEventListener("play", syncPlayIcon);
    video.addEventListener("pause", syncPlayIcon);
    document.body.appendChild(btn);
    registerControlButton(controller, btn, { anchor: false });
    return btn;
}

/* "Previous" restarts the current chapter once more than a few seconds into it (rather
   than always jumping two chapters at once) - the same convention as prev-track buttons
   on physical media remotes. No on-screen button calls this anymore (see this file's own
   header comment) - it's reached via the Xbox bumpers (plex-player.js's
   _handlePlayerNavCommand) and, for non-gamepad input, the More menu's Chapters overlay. */
export function seekToAdjacentChapter(controller, direction, video) {
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
        // best-effort - the episode-list overlay's card simply won't respond if this fails
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
    let lastPreviewFraction = null;
    if (bifUrl) {
        loadBifIndex(bifUrl).then((index) => {
            bifIndex = index;
            controller._bifIndex = index;
            /* The index takes a couple of Range round-trips to load - if the user was
               already hovering/dragging (or gamepad-scrubbing) and had stopped moving
               before it resolved, nothing would otherwise ever retry the frame lookup
               for that position (only pointer movement / setPreview calls
               showPreviewAtFraction, and staying still fires neither). */
            if (index && lastPreviewFraction != null) showPreviewAtFraction(lastPreviewFraction);
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
    /* Core preview repaint, keyed off a bare fraction-of-duration rather than a pointer
       position - shared by pointer hover/drag (showPreview below, which derives the
       fraction from clientX) and gamepad scrubbing (controller._transportScrub.setPreview,
       which has no pointer at all and already knows its target time). */
    const showPreviewAtFraction = (fraction) => {
        if (!video.duration) return;
        lastPreviewFraction = fraction;
        const timeMs = fraction * video.duration * 1000;

        const rectWidth = seekWrap.getBoundingClientRect().width;
        previewTooltip.style.display = "flex";
        const tooltipHalfWidth = 80;
        previewTooltip.style.left = `${Math.min(rectWidth - tooltipHalfWidth, Math.max(tooltipHalfWidth, fraction * rectWidth))}px`;
        previewTime.textContent = formatTime(timeMs / 1000);

        /* Debounced to roughly one lookup per real second of video scrubbed past,
           rather than one per pointermove/gamepad tick - a fast drag (or held stick)
           across a long movie can fire dozens of updates a second, and each would
           otherwise trigger its own Range fetch for a frame the user never actually
           paused on. */
        if (!bifIndex || (previewLastTimeMs != null && Math.abs(timeMs - previewLastTimeMs) < 1000)) return;
        previewLastTimeMs = timeMs;
        const frame = findNearestBifFrame(bifIndex, timeMs);
        if (!frame) return;
        const requestId = ++previewRequestId;
        fetchBifFrameUrl(bifIndex, frame).then((url) => {
            if (requestId !== previewRequestId) return; // a newer preview position won the race
            previewImg.src = url;
            previewImg.style.display = "block";
        });
    };
    const showPreview = (clientX) => {
        const rect = seekWrap.getBoundingClientRect();
        showPreviewAtFraction(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
    };
    const hidePreview = () => {
        previewTooltip.style.display = "none";
        previewImg.style.display = "none";
        previewLastTimeMs = null;
        lastPreviewFraction = null;
    };
    seek.addEventListener("pointerenter", (e) => showPreview(e.clientX));
    seek.addEventListener("pointermove", (e) => showPreview(e.clientX));
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

    /* Gamepad scrub-preview (Xbox left stick, see plex-player.js's _adjustScrub/
       _commitScrub/_cancelScrub) - moves this same seek fill + BIF tooltip from a bare
       target time, with no pointer involved and no seek applied until the caller commits.
       Reuses the `scrubbing` flag pointer-drag already relies on so the timeupdate
       listener above doesn't fight it either way. */
    controller._transportScrub = {
        setPreview(timeMs) {
            if (!video.duration) return;
            scrubbing = true;
            const fraction = Math.min(1, Math.max(0, timeMs / (video.duration * 1000)));
            seek.value = String(Math.round(fraction * 1000));
            syncSeekFill();
            syncRemaining(fraction * video.duration);
            showPreviewAtFraction(fraction);
        },
        endPreview() {
            scrubbing = false;
            hidePreview();
            if (video.duration) {
                seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
                syncSeekFill();
                syncRemaining(video.currentTime);
            }
        },
    };

    bar.appendChild(seekWrap);
    document.body.appendChild(bar);
    registerControlButton(controller, bar, { anchor: false });
    return bar;
}
