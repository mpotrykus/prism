import { registerControlButton, showControls, scheduleHideControls } from "./chrome-controls.js";
import { openAudioSubtitlesOverlay } from "./chrome-subtitles.js";
import { VOLUME_STORAGE_KEY, volumeIconMarkup, seekIconMarkup, skipIconMarkup, fullscreenIconMarkup, audioSubtitlesIconMarkup } from "./shared.js";
import { loadBifIndex, findNearestBifFrame, fetchBifFrameUrl } from "../core/bif.js";
import { plexAssetUrl } from "../core/plex-asset-url.js";
import { fetchQueuedTitle } from "../core/title-fetch.js";
import { usesGamepadChrome } from "../core/platform.js";
/* Circular with episode-list.js (which imports playQueuedTitle/formatTime from this very
   file, via chrome.js's re-export) - safe for the same reason chrome-menu.js's own episode-
   list.js import is: this file's use of openEpisodeListOverlay is confined to a click
   handler below, never called until long after both modules have finished loading. */
import { openEpisodeListOverlay } from "./episode-list.js";

/* Bottom transport bar (title/subtitle + remaining time, scrub bar/chapter segments/BIF
   scrub-preview) and, on real Xbox only, the floating center play/pause button mirroring the
   Android native player's layout (see PlayerUiHelper.java) - a single large play/pause
   control floating over the video, nothing else, since there's no mouse/hover there to use
   a fuller transport row with. Web and PC keep the full mouse-driven row instead (play/pause
   flanked by 5s-seek and chapter/title nav, plus volume/Audio & Subtitles/fullscreen on the
   right - see buildCenterControls/buildTransportBar's !usesGamepadChrome() branches; PC
   still reports platformTag() === "uwp" for streaming/native-player purposes, so this file
   deliberately doesn't test that directly - see usesGamepadChrome()'s own comment).
   Android never renders any of this file at all - it has its own native chrome (see
   PlayerUiHelper.java). Takes the StreamingPlayerController instance as an explicit first
   argument (see native-bridge.js/shader-pipeline.js for why) rather than owning independent
   state - the idle-fade timer and session state are shared with the rest of the player
   chrome, not cleanly separable per element. */

/* Real Xbox's only on-screen playback control, centered over the video rather than living in
   a transport row it doesn't have - matches Android's buildFloatingPlaybackControls (a 60dp
   play/pause). Only mounted when usesGamepadChrome() (see player-chrome.js's
   mountPlayerChrome) - web/PC use buildCenterControls' in-row play/pause instead so there's
   never two play/pause buttons on screen at once. */
export function buildFloatingPlayButton(controller, video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("prism-player-focusable", "prism-player-float-play");
    btn.setAttribute("aria-label", "Play/Pause");
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
   (player.js's _handlePlayerNavCommand) - either way, also reachable via the More
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

/* Lazily builds the one flash overlay for a given direction (reused across repeated
   presses, same lazy-singleton convention as chrome-skip.js's ensureSkipButtonEl) -
   a dark gradient over the side of the screen the seek moved toward, fixed/full-height
   like this file's other document.body-level overlays, so it sits above the video
   regardless of which playback backend is rendering underneath it. */
function ensureSeekFlashEl(controller, direction) {
    const key = direction === "back" ? "_seekFlashBackEl" : "_seekFlashForwardEl";
    if (controller[key]) return controller[key];
    const isBack = direction === "back";
    const el = document.createElement("div");
    el.className = `prism-player-seek-flash prism-player-seek-flash--${isBack ? "back" : "forward"}`;
    el.textContent = isBack ? "-5s" : "+5s";
    document.body.appendChild(el);
    controller[key] = el;
    return el;
}

/* Restarts the animation from scratch on every press, including a repeat press before the
   previous fade finished - forcing a reflow between resetting to the hidden state and
   re-triggering the visible one is what makes the transition replay rather than no-op because
   the end style never changed. */
function flashSeekIndicator(controller, direction) {
    const el = ensureSeekFlashEl(controller, direction);
    const timerKey = direction === "back" ? "_seekFlashBackTimer" : "_seekFlashForwardTimer";
    clearTimeout(controller[timerKey]);
    el.classList.remove("is-visible", "is-fading");
    void el.offsetWidth;
    el.classList.add("is-visible");
    controller[timerKey] = setTimeout(() => el.classList.add("is-fading"), 450);
}

/* Removes both flash overlays and their pending timers - called from
   unmountPlayerChrome alongside this file's other document.body-level overlays
   (chrome-skip.js's skip button, the volume flyout), which the same teardown pass
   already knows aren't swept up by the control-row removal. */
export function teardownSeekFlash(controller) {
    clearTimeout(controller._seekFlashBackTimer);
    clearTimeout(controller._seekFlashForwardTimer);
    controller._seekFlashBackTimer = null;
    controller._seekFlashForwardTimer = null;
    controller._seekFlashBackEl?.remove();
    controller._seekFlashForwardEl?.remove();
    controller._seekFlashBackEl = null;
    controller._seekFlashForwardEl = null;
}

function makeSeekButton(controller, direction, video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("prism-player-focusable", "prism-player-icon-btn", "prism-player-icon-btn--seek");
    btn.setAttribute("aria-label", direction === "back" ? "Back 5 seconds" : "Forward 5 seconds");
    btn.innerHTML = seekIconMarkup(direction);
    btn.addEventListener("click", () => {
        if (!video.duration) {
            video.currentTime = Math.max(0, (video.currentTime || 0) + (direction === "back" ? -5 : 5));
        } else {
            video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + (direction === "back" ? -5 : 5)));
        }
        flashSeekIndicator(controller, direction);
    });
    return btn;
}

function makeChapterNavButton(controller, direction, video) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("prism-player-focusable", "prism-player-icon-btn", "prism-player-icon-btn--nav");
    btn.setAttribute("aria-label", direction === "prev" ? "Previous chapter" : "Next chapter");
    btn.innerHTML = skipIconMarkup(direction, { double: true });
    btn.addEventListener("click", () => seekToAdjacentChapter(controller, direction, video));
    return btn;
}

const TITLE_PREV_RESTART_MS = 10000;

/* Always rendered, unlike chapter nav - "restart this title from the beginning" is a
   valid action whether or not there's a queue at all (a standalone movie included), so
   prev is never disabled. Next is the only one that ever greys out: skipping forward has
   no equivalent "restart" fallback, so it's a real dead end whenever there's no next
   queued title (see player.js's queueRatingKeys/queueIndex) - shown disabled rather
   than hidden so a movie's transport row still reads as symmetric with an episode's. */
function makeTitleNavButton(controller, direction, video) {
    const session = controller._session;
    const queue = session?.queueRatingKeys || [];
    const index = session?.queueIndex ?? -1;
    const enabled = direction === "prev" || (index >= 0 && index < queue.length - 1);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("prism-player-icon-btn", "prism-player-icon-btn--nav");
    if (enabled) btn.classList.add("prism-player-focusable");
    btn.setAttribute("aria-label", direction === "prev" ? "Previous title" : "Next title");
    btn.innerHTML = skipIconMarkup(direction, { double: false });
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

/* Mouse/hover chrome only (!usesGamepadChrome()) play/pause flanked by back-5s/forward-5s seek
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
    playBtn.classList.add("prism-player-focusable", "prism-player-icon-btn", "prism-player-icon-btn--play");
    playBtn.setAttribute("aria-label", "Play/Pause");
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
   (player.js) after an in-place title switch, since that path never rebuilds this chrome. */
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
        el.className = "prism-player-segment";
        el.style.left = `calc(${startPct}% + ${leftGapPx}px)`;
        el.style.width = `calc(${endPct - startPct}% - ${leftGapPx + rightGapPx}px)`;
        el.style.background = SEEK_UNFILLED_COLOR;
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
    bar.className = "prism-player-bar";

    /* Title/season-episode (or year, for a movie) left, remaining time right - both
       already carried on the session (see card.js's _playItem), just not
       previously surfaced anywhere in this chrome. */
    const infoRow = document.createElement("div");
    infoRow.className = "prism-player-info-row";

    const titleBlock = document.createElement("div");
    const titleLine = document.createElement("div");
    titleLine.className = "prism-player-title";
    titleBlock.appendChild(titleLine);

    const subLine = document.createElement("div");
    subLine.className = "prism-player-subtitle";
    titleBlock.appendChild(subLine);
    infoRow.appendChild(titleBlock);

    /* Kept on the controller (rather than only closed over here) so an in-place title switch that
       doesn't remount this chrome - _switchTitleNative, which reuses the same DOM chrome across the
       switch rather than tearing it down and rebuilding it the way the <video>+hls.js fallback's
       _beginSession does (see player.js's _switchTitle) - can still repaint this text for the new
       session. Without this, the bar kept showing whichever title was on screen when it was first
       mounted. */
    controller._transportTitleEl = titleLine;
    controller._transportSubtitleEl = subLine;
    updateTransportBarInfo(controller);

    const remainingEl = document.createElement("span");
    remainingEl.className = "prism-player-remaining";
    remainingEl.textContent = "-0:00";
    infoRow.appendChild(remainingEl);
    bar.appendChild(infoRow);


    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "prism-player-range prism-player-seek";
    seek.min = "0";
    seek.max = "1000";
    seek.value = "0";

    const chapters = controller._session?.chapters || [];
    const seekWrap = document.createElement("div");
    seekWrap.className = "prism-player-seek-wrap";
    const segmentLayer = document.createElement("div");
    segmentLayer.className = "prism-player-segments";
    if (chapters.length) seek.classList.add("prism-player-seek--segmented");
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
    previewTooltip.className = "prism-player-preview";
    const previewImg = document.createElement("img");
    previewImg.alt = "";
    previewImg.className = "prism-player-preview-img";
    const previewTime = document.createElement("div");
    previewTime.className = "prism-player-preview-time";
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
        previewTooltip.classList.add("is-visible");
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
            previewImg.classList.add("is-visible");
        });
    };
    const showPreview = (clientX) => {
        const rect = seekWrap.getBoundingClientRect();
        showPreviewAtFraction(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
    };
    const hidePreview = () => {
        previewTooltip.classList.remove("is-visible");
        previewImg.classList.remove("is-visible");
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

    /* Gamepad scrub-preview (Xbox left stick, see player.js's _adjustScrub/
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
       with - real Xbox instead gets just the floating play button (buildFloatingPlayButton,
       mounted separately, see player-chrome.js's usesGamepadChrome() gate) and reaches
       chapter/title nav via its bumpers/triggers and the More menu. Android never renders
       this file at all. PC deliberately gets this row too, despite reporting
       platformTag() === "uwp" - see usesGamepadChrome()'s own comment. */
    if (!usesGamepadChrome()) {
        const controlsRow = document.createElement("div");
        controlsRow.className = "prism-player-controls-row";
        const leftCell = document.createElement("div");
        leftCell.className = "prism-player-cell-left";
        const centerCell = document.createElement("div");
        centerCell.className = "prism-player-cell-center";
        const rightCell = document.createElement("div");
        rightCell.className = "prism-player-cell-right";
        controlsRow.appendChild(leftCell);
        controlsRow.appendChild(centerCell);
        controlsRow.appendChild(rightCell);
        bar.appendChild(controlsRow);
        controller._centerControlsSlot = centerCell;
        buildCenterControls(controller, video);

        /* Text label, not an icon - a glyph here read too close to the opposite corner's "☰"
           More button to tell apart at a glance. Same seasonNumber-based wording as the More
           sheet's own (now-removed) Episodes row and this overlay's own heading - see
           formatEpisodeListItem's neighbouring reasoning. Queue-presence gate matches
           chrome-menu.js's identical check for the same reason: no dead affordance when
           there's nowhere to jump to. */
        const session = controller._session;
        if (session?.queueRatingKeys?.length > 1) {
            const episodesBtn = document.createElement("button");
            episodesBtn.type = "button";
            episodesBtn.classList.add("prism-player-focusable", "prism-player-icon-btn", "prism-player-icon-btn--text");
            episodesBtn.textContent = session.seasonNumber != null ? "Episodes" : "Up Next";
            episodesBtn.addEventListener("click", () => openEpisodeListOverlay(controller));
            leftCell.appendChild(episodesBtn);
        }

        const muteBtn = document.createElement("button");
        muteBtn.type = "button";
        muteBtn.classList.add("prism-player-focusable", "prism-player-icon-btn");

        /* A floating panel above the mute icon - matches the volume-flyout convention most
           desktop/TV players use (drag up for louder) rather than a slider that permanently
           eats transport-bar space. Appended to document.body (not `bar`) so its `position:
           fixed` coordinates, computed off muteBtn's own rect in positionVolumePopout,
           aren't affected by the bar's own opacity/transform transitions. */
        const volumePopout = document.createElement("div");
        volumePopout.className = "prism-player-volume-popout";

        const volumeSlider = document.createElement("input");
        volumeSlider.type = "range";
        volumeSlider.className = "prism-player-range prism-player-volume-slider";
        volumeSlider.min = "0";
        volumeSlider.max = "100";
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
            volumePopout.classList.add("is-open");
        };
        /* sliderActive covers the duration of a drag - hideVolumePopout would otherwise fire
           mid-drag whenever the pointer momentarily leaves the (narrow) slider or popout
           bounds, yanking the control out from under the user's own gesture. */
        let sliderActive = false;
        let volumeHideTimer = null;
        const hideVolumePopout = () => {
            if (sliderActive) return;
            volumePopout.classList.remove("is-open");
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
        audioSubtitlesBtn.classList.add("prism-player-focusable", "prism-player-icon-btn");
        audioSubtitlesBtn.innerHTML = audioSubtitlesIconMarkup();
        audioSubtitlesBtn.setAttribute("aria-label", "Audio & Subtitles");
        audioSubtitlesBtn.addEventListener("click", () => openAudioSubtitlesOverlay(controller));

        rightCell.appendChild(muteBtn);
        rightCell.appendChild(audioSubtitlesBtn);

        /* Not rendered at all when the host has no Fullscreen API - same "never an empty/
           dead affordance" rule the hamburger's Chapters entry follows. */
        const fullscreenSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled;
        if (fullscreenSupported) {
            const fullscreenBtn = document.createElement("button");
            fullscreenBtn.type = "button";
            fullscreenBtn.classList.add("prism-player-focusable", "prism-player-icon-btn");
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