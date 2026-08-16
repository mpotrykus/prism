import { registerControlButton, showControls, scheduleHideControls } from "./chrome-controls.js";
import { openAudioSubtitlesOverlay } from "./chrome-subtitles.js";
import { PLAYER_FOCUSABLE_CLASS, VOLUME_STORAGE_KEY, volumeIconMarkup, seekIconMarkup, skipIconMarkup, fullscreenIconMarkup, audioSubtitlesIconMarkup } from "./shared.js";
import { loadBifIndex, findNearestBifFrame, fetchBifFrameUrl } from "../core/bif.js";
import { plexAssetUrl } from "../core/plex-asset-url.js";
import { fetchQueuedTitle } from "../core/title-fetch.js";
import { platformTag } from "../core/platform.js";

/* Bottom transport bar (title/subtitle + remaining time, scrub bar/chapter segments/BIF
   scrub-preview) and, on Xbox only, the floating center play/pause button mirroring the
   Android native player's layout (see PlayerUiHelper.java) - a single large play/pause
   control floating over the video, nothing else, since there's no mouse/hover there to use
   a fuller transport row with. Web keeps its full mouse-driven row instead (play/pause
   flanked by 5s-seek and chapter/title nav, plus volume/Audio & Subtitles/fullscreen on the
   right - see buildCenterControls/buildTransportBar's platformTag() !== "xbox" branches).
   Android never renders any of this file at all - it has its own native chrome (see
   PlayerUiHelper.java) - so "web" here really means "not Xbox". Takes the
   StreamingPlayerController instance as an explicit first argument (see native-bridge.js/
   shader-pipeline.js for why) rather than owning independent state - the idle-fade timer
   and session state are shared with the rest of the player chrome, not cleanly separable
   per element. */

/* Xbox's only on-screen playback control, centered over the video rather than living in a
   transport row it doesn't have - matches Android's buildFloatingPlaybackControls (a 60dp
   play/pause). Only mounted for platformTag() === "xbox" (see player-chrome.js's
   mountPlayerChrome) - web uses buildCenterControls' in-row play/pause instead so there's
   never two play/pause buttons on screen at once. */
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
   on physical media remotes. Called both by web's own on-screen chapter-nav button
   (makeChapterNavButton below) and, with no on-screen equivalent there, the Xbox bumpers
   (plex-player.js's _handlePlayerNavCommand) - either way, also reachable via the More
   menu's Chapters overlay. */
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
        // best-effort - the episode-list overlay's card / title-nav button simply won't respond if this fails
    }
}

function makeSeekButton(controller, direction, video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add(PLAYER_FOCUSABLE_CLASS);
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
    btn.classList.add(PLAYER_FOCUSABLE_CLASS);
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
    if (enabled) btn.classList.add(PLAYER_FOCUSABLE_CLASS);
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
   disabled when there's nowhere to jump to. */
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

/* Web-only (platformTag() !== "xbox") play/pause flanked by back-5s/forward-5s seek
   buttons, with chapter nav further out when the session has chapters, and title nav
   (prev/next episode, playlist/collection item, or restart) further out still - matches a
   premium-streaming-app transport row instead of Xbox/Android's single floating button.
   Appended into buildTransportBar's own centerCell slot (see controller._centerControlsSlot),
   called from there directly right after that cell exists. */
function buildCenterControls(controller, video) {
    const row = controller._centerControlsSlot;
    if (!row) return null;

    row.appendChild(makeTitleNavButton(controller, "prev", video));

    const chapters = controller._session?.chapters || [];
    if (chapters.length) row.appendChild(makeChapterNavButton(controller, "prev", video));

    row.appendChild(makeSeekButton(controller, "back", video));

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.classList.add(PLAYER_FOCUSABLE_CLASS);
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

/* Repaints the transport bar's title/subtitle from whatever controller._session currently is -
   called once at buildTransportBar's own initial mount, and again by _switchTitleNative
   (plex-player.js) after an in-place title switch, since that path never rebuilds this chrome. */
export function updateTransportBarInfo(controller) {
    const titleLine = controller._transportTitleEl;
    const subLine = controller._transportSubtitleEl;
    if (!titleLine || !subLine) return;
    const session = controller._session;
    titleLine.textContent = session?.title || "";

    const subtitleParts = [];
    if (session?.seasonNumber != null && session?.episodeNumber != null) {
        if (session?.episodeTitle) subtitleParts.push(session.episodeTitle);
        subtitleParts.push(`S${session.seasonNumber} E${session.episodeNumber}`);
    } else if (session?.year) {
        subtitleParts.push(String(session.year));
    }
    subLine.textContent = subtitleParts.join("  •  ");
    subLine.style.display = subtitleParts.length ? "" : "none";
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

    const titleBlock = document.createElement("div");
    const titleLine = document.createElement("div");
    Object.assign(titleLine.style, { color: "#fff", fontSize: "19px", fontWeight: "700", fontFamily: '"Roboto", sans-serif', lineHeight: "1.3" });
    titleBlock.appendChild(titleLine);

    const subLine = document.createElement("div");
    Object.assign(subLine.style, { color: "rgba(255,255,255,0.65)", fontSize: "13px", fontWeight: "600", fontFamily: '"Roboto", sans-serif', marginTop: "2px", display: "none" });
    titleBlock.appendChild(subLine);
    infoRow.appendChild(titleBlock);

    /* Kept on the controller (rather than only closed over here) so an in-place title switch that
       doesn't remount this chrome - _switchTitleNative, which reuses the same DOM chrome across the
       switch rather than tearing it down and rebuilding it the way the <video>+hls.js fallback's
       _beginSession does (see plex-player.js's _switchTitle) - can still repaint this text for the new
       session. Without this, the bar kept showing whichever title was on screen when it was first
       mounted. */
    controller._transportTitleEl = titleLine;
    controller._transportSubtitleEl = subLine;
    updateTransportBarInfo(controller);

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

    /* The fuller mouse-driven control row (play/pause + chapter/title nav, mute/volume,
       Audio & Subtitles, fullscreen) only makes sense where there's a mouse/hover to use it
       with - Xbox instead gets just the floating play button (buildFloatingPlayButton,
       mounted separately, see player-chrome.js's platformTag() gate) and reaches
       chapter/title nav via its bumpers/triggers and the More menu. Android never renders
       this file at all, so this is really just "is this Xbox". */
    if (platformTag() !== "xbox") {
        const controlsRow = document.createElement("div");
        Object.assign(controlsRow.style, { display: "flex", alignItems: "center" });
        const leftCell = document.createElement("div");
        Object.assign(leftCell.style, { flex: "1 1 0" });
        const centerCell = document.createElement("div");
        Object.assign(centerCell.style, { flex: "0 0 auto", display: "flex", alignItems: "center", gap: "22px" });
        const rightCell = document.createElement("div");
        Object.assign(rightCell.style, { flex: "1 1 0", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "14px" });
        controlsRow.appendChild(leftCell);
        controlsRow.appendChild(centerCell);
        controlsRow.appendChild(rightCell);
        bar.appendChild(controlsRow);
        controller._centerControlsSlot = centerCell;
        buildCenterControls(controller, video);

        const muteBtn = document.createElement("button");
        muteBtn.type = "button";
        muteBtn.classList.add(PLAYER_FOCUSABLE_CLASS);
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
               web/Xbox target this app ships to is Chromium-based and supports it (Xbox
               never renders this element at all, but Android's own WebView also would).
               direction: rtl puts the minimum at the bottom and the maximum at the top,
               matching a physical volume slider. */
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

        const audioSubtitlesBtn = document.createElement("button");
        audioSubtitlesBtn.type = "button";
        audioSubtitlesBtn.classList.add(PLAYER_FOCUSABLE_CLASS);
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

        /* Not rendered at all when the host has no Fullscreen API - same "never an empty/
           dead affordance" rule the hamburger's Chapters entry follows. */
        const fullscreenSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;
        if (fullscreenSupported) {
            const fullscreenBtn = document.createElement("button");
            fullscreenBtn.type = "button";
            fullscreenBtn.classList.add(PLAYER_FOCUSABLE_CLASS);
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
               be cleaned up just by removing the bar (see player-chrome.js's
               unmountPlayerChrome, which removes _controlButtons) - stashed on the controller
               so that function can remove it explicitly, same reasoning as _volumePopoutEl
               below and every other cross-cutting resource cleaned up there. */
            controller._fullscreenChangeHandler = syncFullscreenUi;
            document.addEventListener("fullscreenchange", syncFullscreenUi);
            document.addEventListener("webkitfullscreenchange", syncFullscreenUi);
            rightCell.appendChild(fullscreenBtn);
        }
    }

    document.body.appendChild(bar);
    registerControlButton(controller, bar, { anchor: false });
    return bar;
}
