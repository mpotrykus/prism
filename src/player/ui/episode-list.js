import { playQueuedTitle, formatTime } from "./chrome.js";
import { wireLinearNav } from "../../../focus-nav.js";
import { media } from "../core/media-facade.js";
import { plexAssetUrl } from "../core/plex-asset-url.js";
import { fetchQueueItemsMetadata } from "../core/title-fetch.js";
import { WATCHED_ICON_SVG } from "../../card/rows.js";
import { formatRuntime } from "../../card/title-info.js";
import { createRowScroll } from "../../card/row-scroll.js";
import { PLAYER_FOCUSABLE_CLASS } from "./shared.js";

/* In-player episode/queue list overlay (HBO Max-style) - a bottom sheet over the still-
   playing video (see the "keep playing behind overlay" decision) listing every title in
   session.queueRatingKeys as a horizontally-scrolling row of cards, letting the viewer
   jump straight to a different episode/queued title without leaving the player. Reuses
   the same queue plex-player.js already carries for the title-prev/title-next buttons
   (see chrome.js's playQueuedTitle) rather than re-deriving season/show structure -
   queueRatingKeys is already the full flattened episode order (or playlist/collection
   order), so one flat list works for both cases with no season concept needed here. */

const ACCENT_COLOR = "#e5a00d";
/* Scoped selectors for gamepad navigation - see openEpisodeListOverlay. */
const EPISODE_LIST_CLASS = "streaming-player-episode-list";
const CHAPTER_LIST_CLASS = "streaming-player-chapter-list";
const SCROLL_CLASS = "streaming-player-episode-scroll";
/* The chapter list's left/right scroll-arrow buttons (buildQueueScrollArrow) - a D-pad/
   gamepad user already has Left/Right for this, and a click target is a dead end for
   them the same way the various "X" close buttons are (see shared.js's own
   OVERLAY_CLOSE_BTN_CLASS rule). Hidden rather than removed outright: mouse/touch users
   (and anyone testing on desktop web with a real pointer) still get them. */
const QUEUE_ARROW_CLASS = "streaming-player-queue-arrow";
const SPINNER_STYLE_ID = "streaming-player-episode-spinner-style";
/* Approximates one real row of buildEpisodeCard's cards (135px thumb + title + subtitle +
   summary + the 8px flex gaps between them) so the loading spinner's placeholder doesn't
   visibly resize once the real cards replace it - same idea as PlayerUiHelper.java's
   EPISODE_LOADING_HEIGHT_DP on the native leg. */
const EPISODE_CARD_HEIGHT_PX = 230;

/* Same @keyframes-injection idiom chrome.js's buildLoadingSpinner uses for the main
   buffering indicator - a separate keyframe/id rather than reusing that one directly, so
   this file doesn't depend on chrome.js having already run first to guarantee it exists. */
function ensureSpinnerStyle() {
    if (document.getElementById(SPINNER_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SPINNER_STYLE_ID;
    style.textContent = "@keyframes streaming-episode-spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
}

/* Same scrollbar-hiding approach as chrome.js's MENU_SCROLL_CLASS - scrollbar-width for
   Firefox, ::-webkit-scrollbar for everything Chromium-based, neither reachable via an
   inline style. */
function ensureScrollStyle() {
    if (document.getElementById(`${SCROLL_CLASS}-style`)) return;
    const style = document.createElement("style");
    style.id = `${SCROLL_CLASS}-style`;
    style.textContent = `
        .${SCROLL_CLASS} { scrollbar-width: none; -ms-overflow-style: none; }
        .${SCROLL_CLASS}::-webkit-scrollbar { display: none; width: 0; height: 0; }
        /* See QUEUE_ARROW_CLASS's own comment above and shared.js's OVERLAY_CLOSE_BTN_CLASS
           rule for why two gates: [data-platform="xbox"] (core/platform.js) is the UWP
           shell's own script-injected marker, reliable on real Xbox hardware regardless of
           the page's own input-mode heuristics; [data-input-mode="keyboard"] covers Fire TV
           and any keyboard/gamepad-driven desktop-web session, which has no such marker.
           !important because buildQueueScrollArrow sets display:"flex" as an inline style
           directly on the button - an inline style always wins over any stylesheet
           selector here regardless of specificity. */
        html[data-platform="xbox"] .${QUEUE_ARROW_CLASS},
        html[data-input-mode="keyboard"] .${QUEUE_ARROW_CLASS} {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
}

/* Same "Scroll left"/"Scroll right" idea the main page's poster rows use
   (card/rows.js's buildScrollArrow) - not reused directly because that file's styling
   lives in a CSS file scoped inside plex-netflix-card's shadow DOM, which never reaches
   this overlay (appended to document.body, outside that shadow root - confirmed empty
   button chrome when first tried). Built the same inline-style way every other piece of
   this player's chrome already is (see chrome.js/shared.js). Visible only while there's
   somewhere left to scroll (not hover-revealed like the main page's rows) - this app has
   no reliable hover input on touch/remote targets yet (see this repo's CLAUDE.md
   "Platform work not yet started"). */
function buildQueueScrollArrow(direction, scroller, rowScroll) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add(PLAYER_FOCUSABLE_CLASS, QUEUE_ARROW_CLASS);
    btn.setAttribute("aria-label", direction === "left" ? "Scroll left" : "Scroll right");
    btn.innerHTML =
        direction === "left" ?
        '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>' :
        '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4L13.2 12z"/></svg>';
    Object.assign(btn.style, {
        position: "absolute",
        top: "0",
        bottom: "0",
        [direction]: "0",
        width: "44px",
        border: "none",
        padding: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        cursor: "pointer",
        zIndex: "1",
        opacity: "0",
        pointerEvents: "none",
        transition: "opacity 0.15s ease, outline-color 0.125s ease",
        background: direction === "left" ?
            "linear-gradient(90deg, rgba(10,10,12,0.9), rgba(10,10,12,0))" :
            "linear-gradient(270deg, rgba(10,10,12,0.9), rgba(10,10,12,0))",
    });
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const amount = scroller.clientWidth * 0.9 * (direction === "left" ? -1 : 1);
        rowScroll.scrollBy(amount, { animate: true });
    });
    return btn;
}

/* Deferred to the next frame for the same WebView2 focus-timing reason as focus-nav.js's
   own focusAfterPaint. Centering itself now happens via the panel's own focusin listener
   (see openEpisodeListOverlay/openChapterListOverlay below), not a scrollIntoView call
   here - preventScroll:true still guards against the browser's default auto-scroll-into-
   view-on-focus, in case some ancestor is ever scrollable again. */
function focusCardCentered(el) {
    if (!el) return;
    requestAnimationFrame(() => el.focus({ preventScroll: true }));
}

/* Mirrors rows.js's wireArrowVisibility (card/row-scroll.js's rowScroll.onChange), not the
   native scroll-event polling this used before the queue row switched to a transform-driven
   track - see createRowScroll's own header comment for why a native-scrolling container had
   to go in the first place. */
function wireQueueArrowVisibility(rowScroll, leftArrow, rightArrow) {
    const update = (offset, max) => {
        const showLeft = offset > 0;
        const showRight = max > 0 && offset < max;
        leftArrow.style.opacity = showLeft ? "1" : "0";
        leftArrow.style.pointerEvents = showLeft ? "auto" : "none";
        rightArrow.style.opacity = showRight ? "1" : "0";
        rightArrow.style.pointerEvents = showRight ? "auto" : "none";
    };
    rowScroll.onChange(update);
    /* No window resize listener here (unlike rows.js's own wireArrowVisibility) - this
       overlay's panel/scroll/track get torn down and rebuilt fresh on every open, so a
       listener added here would otherwise accumulate one per open with nothing in
       closeChapterListOverlay to remove it again. Card images loading in can still be
       nudging track.scrollWidth a moment after the initial layout pass though, so this
       still checks again shortly after, same reasoning rows.js's own wireArrowVisibility
       follows for that part. */
    requestAnimationFrame(() => rowScroll.refresh());
    setTimeout(() => rowScroll.refresh(), 300);
}

export async function openEpisodeListOverlay(controller) {
    closeEpisodeListOverlay(controller);
    controller._closeInlineMenu();

    const session = controller._session;
    const queueRatingKeys = session?.queueRatingKeys || [];
    if (queueRatingKeys.length < 2) return;

    const scrim = document.createElement("div");
    Object.assign(scrim.style, { position: "fixed", inset: "0", zIndex: "10003", background: "transparent" });
    scrim.addEventListener("click", () => closeEpisodeListOverlay(controller));

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        position: "fixed",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "10004",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        /* Only vertical padding here - the header/scroll row apply their own horizontal
           insets below instead. */
        padding: "24px 0 28px",
        background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.88) 55%, rgba(0,0,0,0.5) 85%, transparent 100%)",
        boxSizing: "border-box",
        fontFamily: '"Roboto", sans-serif',
        opacity: "0",
        transform: "translateY(12px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", flex: "0 0 auto", padding: "0 24px" });

    const heading = document.createElement("div");
    /* Same seasonNumber-present check chrome-menu.js's Episodes/Up Next row uses to decide
       whether a session is a TV episode vs a movie/collection item - reused here purely for
       label wording, nothing structural depends on it. */
    heading.textContent = session.seasonNumber != null ? "Episodes" : "Up Next";
    Object.assign(heading.style, { color: "#fff", fontSize: "18px", fontWeight: "700" });
    header.appendChild(heading);
    /* No visible close button here (Xbox has no pointer to click one with anyway) - the
       scrim click and the "back" nav command (wireLinearNav's onBack below) are the only
       ways to dismiss this overlay. */
    panel.appendChild(header);

    ensureScrollStyle();
    const scroll = document.createElement("div");
    scroll.className = SCROLL_CLASS;
    /* No scroll-arrow reservation here (unlike openChapterListOverlay's own 54px) - the
       episode overlay has no arrows to leave room for. This is now the clipping viewport
       (like rows-poster.css's .row-scroller), not itself a native scroll container - see
       row-scroll.js's own header comment for why: Xbox WebView2's built-in gamepad-to-
       scroll handling hijacks any native overflow:auto container the thumbstick happens
       to be over, fighting this overlay's own D-pad centering. */
    Object.assign(scroll.style, { overflow: "hidden", padding: "4px 24px" });
    const track = document.createElement("div");
    Object.assign(track.style, { display: "flex", gap: "14px" });
    scroll.appendChild(track);
    ensureSpinnerStyle();
    const loading = document.createElement("div");
    Object.assign(loading.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "1 1 auto",
        width: "100%",
        height: `${EPISODE_CARD_HEIGHT_PX}px`,
    });
    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
        width: "36px",
        height: "36px",
        borderRadius: "50%",
        border: "3px solid rgba(255,255,255,0.25)",
        borderTopColor: ACCENT_COLOR,
        animation: "streaming-episode-spin 0.8s linear infinite",
    });
    loading.appendChild(spinner);
    track.appendChild(loading);

    const scrollWrap = document.createElement("div");
    /* flexShrink:0 keeps the card row at its natural height even once the panel itself
       is scrolling (see the panel's own overflowY:auto above) - otherwise flexbox would
       squash it to fit the capped box instead of just scrolling to reach the rest. */
    Object.assign(scrollWrap.style, { position: "relative", flexShrink: "0" });
    scrollWrap.appendChild(scroll);
    panel.appendChild(scrollWrap);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    controller._episodeListEl = { scrim, panel };
    panel.classList.add(EPISODE_LIST_CLASS);
    const rowScroll = createRowScroll(scroll, track);
    /* Centers whatever gains real DOM focus, including wireLinearNav's own focus() calls
       during ordinary Left/Right nav below - that shared helper's own plain scrollIntoView
       has nothing to act on any more now that `scroll` is a transform-driven track instead
       of a native scroll container (see the comment above). Scoped to `track` so focus
       landing on something else inside `panel` (nothing else is focusable here today, but
       openChapterListOverlay below shares this same pattern and does have scroll arrows)
       doesn't get run through row-scroll's card-centering math. */
    panel.addEventListener("focusin", (e) => {
        if (track.contains(e.target)) rowScroll.scrollIntoView(e.target, { inline: "center", animate: true });
    });
    /* Horizontal: these are scrolling card rows, so left/right is the axis that matches what is on
       screen. See the audio overlay for why the root is `document`. */
    const epNav = wireLinearNav(document, `.${EPISODE_LIST_CLASS} button`, {
        orientation: "horizontal",
        onBack: () => closeEpisodeListOverlay(controller),
    });
    /* No-ops for now - the only thing on screen is the loading spinner (not a button), so
       items()[0] is undefined. Called again below once the real cards actually exist, this
       time landing on the current item specifically (see currentCard below) rather than
       always index 0; without this call here though, D-pad/keyboard input (including Back)
       would never work on this overlay at all - not just after a selection, from the moment
       it opens - since wireLinearNav's handler only acts when focus is already inside its
       own list. */
    epNav.focusFirst();
    controller._episodeListNav = epNav;
    controller._hideControls();
    requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
    });

    const items = await getQueueItems(controller, session, queueRatingKeys);
    /* The overlay may have been closed (or reopened fresh) while this fetch was in
       flight - bail rather than paint into a panel that's no longer the active one. */
    if (controller._episodeListEl?.panel !== panel) return;

    track.innerHTML = "";
    if (!items.length) {
        const empty = document.createElement("div");
        empty.textContent = "Couldn't load the queue.";
        Object.assign(empty.style, { color: "rgba(255,255,255,0.6)", fontSize: "13px" });
        track.appendChild(empty);
        return;
    }

    let currentCard = null;
    items.forEach((item) => {
        const formatted = formatEpisodeListItem(session, item);
        const card = buildEpisodeCard(formatted, () => {
            if (formatted.current) {
                closeEpisodeListOverlay(controller);
                return;
            }
            const index = queueRatingKeys.findIndex((k) => String(k) === formatted.ratingKey);
            if (index < 0) return;
            closeEpisodeListOverlay(controller);
            playQueuedTitle(controller, queueRatingKeys, index);
        });
        track.appendChild(card);
        if (formatted.current) currentCard = card;
    });

    /* The cards this overlay actually browses didn't exist yet when focusFirst() was first
       called above (loading spinner only) - see that call's own comment. Land on the
       currently-playing card specifically (falling back to the first card if for some
       reason there isn't one) rather than epNav.focusFirst()'s always-index-0 behavior, so
       opening the list drops the viewer right where they already are in the queue. */
    focusCardCentered(currentCard || track.querySelector("button"));
}

export function closeEpisodeListOverlay(controller) {
    if (controller._episodeListNav) {
        controller._episodeListNav.destroy();
        controller._episodeListNav = null;
    }
    if (!controller._episodeListEl) return;
    controller._episodeListEl.scrim.remove();
    controller._episodeListEl.panel.remove();
    controller._episodeListEl = null;
    controller._showControls();
}

/* Same overlay shape as openEpisodeListOverlay above (horizontally-scrolling card row,
   fade-edge scroll arrows, keep-playing-behind-it scrim) reused for the More menu's
   Chapters row instead of an inline accordion picker - chrome.js's "Chapters" section
   navigates here (see renderMainList) rather than expanding in place. Simpler than the
   episode overlay in one way: chapters are already fully present on session.chapters
   (no getQueueItems-style async Plex fetch needed), so there's no loading-placeholder
   state to build. */
export function openChapterListOverlay(controller) {
    closeChapterListOverlay(controller);
    controller._closeInlineMenu();

    const session = controller._session;
    const chapters = session?.chapters || [];
    if (!chapters.length) return;

    const scrim = document.createElement("div");
    Object.assign(scrim.style, { position: "fixed", inset: "0", zIndex: "10003", background: "transparent" });
    scrim.addEventListener("click", () => closeChapterListOverlay(controller));

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        position: "fixed",
        left: "0",
        right: "0",
        bottom: "0",
        zIndex: "10004",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        padding: "24px 0 28px",
        background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.88) 55%, rgba(0,0,0,0.5) 85%, transparent 100%)",
        boxSizing: "border-box",
        fontFamily: '"Roboto", sans-serif',
        opacity: "0",
        transform: "translateY(12px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", flex: "0 0 auto", padding: "0 24px" });
    const heading = document.createElement("div");
    heading.textContent = "Chapters";
    Object.assign(heading.style, { color: "#fff", fontSize: "18px", fontWeight: "700" });
    header.appendChild(heading);
    /* No visible close button here (Xbox has no pointer to click one with anyway) - the
       scrim click and the "back" nav command (wireLinearNav's onBack below) are the only
       ways to dismiss this overlay. */
    panel.appendChild(header);

    ensureScrollStyle();
    const scroll = document.createElement("div");
    scroll.className = SCROLL_CLASS;
    /* Clipping viewport, not itself a native scroll container - see openEpisodeListOverlay's
       own comment on the same change for why (Xbox WebView2's gamepad-to-scroll hijack). */
    Object.assign(scroll.style, { overflow: "hidden", padding: "4px 54px" });
    const track = document.createElement("div");
    Object.assign(track.style, { display: "flex", gap: "14px" });
    scroll.appendChild(track);

    const scrollWrap = document.createElement("div");
    Object.assign(scrollWrap.style, { position: "relative", flexShrink: "0" });
    const rowScroll = createRowScroll(scroll, track);
    const leftArrow = buildQueueScrollArrow("left", scroll, rowScroll);
    const rightArrow = buildQueueScrollArrow("right", scroll, rowScroll);
    scrollWrap.appendChild(leftArrow);
    scrollWrap.appendChild(scroll);
    scrollWrap.appendChild(rightArrow);
    panel.appendChild(scrollWrap);

    /* "Current" is computed once, at open time, from wherever background playback
       happens to be right now - unlike episode-list.js's own `current` (pinned to
       session.ratingKey, which can't change while this overlay is open), a chapter
       boundary could in principle be crossed while the user is browsing, but re-
       deriving it live isn't worth the complexity for a highlight that's just meant to
       orient "you are roughly here" at a glance. */
    const positionMs = (media(controller)?.currentTime || 0) * 1000;
    let currentCard = null;
    chapters.forEach((chapter, index) => {
        const next = chapters[index + 1];
        const isCurrent = (chapter.startTimeOffset ?? 0) <= positionMs && (!next || (next.startTimeOffset ?? 0) > positionMs);
        const card = buildChapterCard(session, chapter, isCurrent, () => {
            closeChapterListOverlay(controller);
            const el = media(controller);
            if (el) el.currentTime = (chapter.startTimeOffset ?? 0) / 1000;
        });
        track.appendChild(card);
        if (isCurrent) currentCard = card;
    });

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    controller._chapterListEl = { scrim, panel };
    panel.classList.add(CHAPTER_LIST_CLASS);
    /* See openEpisodeListOverlay's own identical listener for why - scoped to `track` so
       focus landing on the leftArrow/rightArrow buttons (also real <button>s inside `panel`,
       and also reachable by this list's Left/Right nav) doesn't get run through row-scroll's
       card-centering math; they aren't part of the scrolling content themselves. */
    panel.addEventListener("focusin", (e) => {
        if (track.contains(e.target)) rowScroll.scrollIntoView(e.target, { inline: "center", animate: true });
    });
    const chNav = wireLinearNav(document, `.${CHAPTER_LIST_CLASS} button`, {
        orientation: "horizontal",
        onBack: () => closeChapterListOverlay(controller),
    });
    controller._chapterListNav = chNav;
    controller._hideControls();
    requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
    });

    /* Land on the current chapter specifically (falling back to the first one) rather
       than chNav.focusFirst()'s always-index-0 behavior - all the cards already exist
       synchronously by this point (unlike the episode overlay's async fetch), so there's
       no need for that helper's own two-call dance. */
    focusCardCentered(currentCard || track.querySelector("button"));
    wireQueueArrowVisibility(rowScroll, leftArrow, rightArrow);
}

export function closeChapterListOverlay(controller) {
    if (controller._chapterListNav) {
        controller._chapterListNav.destroy();
        controller._chapterListNav = null;
    }
    if (!controller._chapterListEl) return;
    controller._chapterListEl.scrim.remove();
    controller._chapterListEl.panel.remove();
    controller._chapterListEl = null;
    controller._showControls();
}

/* One card of the chapter row above - deliberately much plainer than buildEpisodeCard
   below (no watched badge, no progress bar, no summary line): a chapter is a timestamp
   within the title already being watched, not a separate Plex item with its own
   watched/progress state of its own. */
function buildChapterCard(session, chapter, isCurrent, onSelect) {
    const card = document.createElement("button");
    card.type = "button";
    card.classList.add(PLAYER_FOCUSABLE_CLASS);
    Object.assign(card.style, {
        flex: "0 0 auto",
        width: "240px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "0",
        cursor: "pointer",
        fontFamily: '"Roboto", sans-serif',
    });

    const thumbWrap = document.createElement("div");
    Object.assign(thumbWrap.style, {
        position: "relative",
        width: "100%",
        height: "135px",
        borderRadius: "8px",
        overflow: "hidden",
        background: "rgba(255,255,255,0.08)",
        boxSizing: "border-box",
        border: isCurrent ? `2px solid ${ACCENT_COLOR}` : "2px solid transparent",
    });
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    Object.assign(img.style, { width: "100%", height: "100%", objectFit: "cover", display: "block" });
    const thumbUrl = plexAssetUrl(session, chapter.thumb);
    if (thumbUrl) img.src = thumbUrl;
    thumbWrap.appendChild(img);
    card.appendChild(thumbWrap);

    const timeLabel = formatTime((chapter.startTimeOffset ?? 0) / 1000);
    const title = document.createElement("div");
    title.textContent = chapter.title || chapter.tag || timeLabel;
    Object.assign(title.style, { color: "#fff", fontSize: "13px", fontWeight: "700", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    card.appendChild(title);

    if (chapter.title || chapter.tag) {
        const subtitle = document.createElement("div");
        subtitle.textContent = timeLabel;
        Object.assign(subtitle.style, { color: "rgba(255,255,255,0.45)", fontSize: "11px", fontWeight: "600" });
        card.appendChild(subtitle);
    }

    card.addEventListener("click", onSelect);
    return card;
}

/* Cached per queue (reference-equality on queueRatingKeys, which threads unchanged
   through playQueuedTitle/_prepareSession across a title switch within the same show/
   collection - see plex-player.js) so reopening the list after navigating a few
   episodes normally doesn't refetch the whole queue's metadata each time. Exported so
   native-bridge.js's "episodeListRequested" listener can share the same fetch+cache
   instead of re-fetching independently for Android's native episode list. */
export function getQueueItems(controller, session, queueRatingKeys) {
    if (controller._episodeListCache?.queueRatingKeys === queueRatingKeys) {
        return controller._episodeListCache.promise;
    }
    const promise = fetchQueueItemsMetadata(session.plexUrl, session.plexToken, queueRatingKeys);
    controller._episodeListCache = { queueRatingKeys, promise };
    return promise;
}

/* Plex's originallyAvailableAt is a plain "YYYY-MM-DD" string - Date parses that as UTC
   midnight, but toLocaleDateString still renders the calendar date correctly regardless
   of the viewer's own timezone offset since only the date fields (not time-of-day) are
   ever shown. */
function formatReleaseDate(dateStr) {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* Shapes one raw fetchQueueItemsMetadata result into exactly what a row/card needs to
   display - the "S1 E1 - Title" / "TV-14 • 44m • Nov 15, 2004" formatting used to live
   inline in buildEpisodeCard below; pulled out and exported so Android's native episode
   list (native-bridge.js's "episodeListRequested" listener) renders identical text
   instead of re-deriving its own formatting in Java from raw fields. thumbUrl is
   resolved here (not left as a bare Plex path) for the same reason chapters/audioStreams
   already cross the native bridge pre-resolved - Java has no equivalent of this module's
   session-scoped plexAssetUrl to finish building it itself. */
export function formatEpisodeListItem(session, item) {
    const subtitleParts = [];
    if (item.contentRating) subtitleParts.push(item.contentRating);
    if (item.durationMs) subtitleParts.push(formatRuntime(item.durationMs));
    const releaseDate = formatReleaseDate(item.releaseDate);
    if (releaseDate) subtitleParts.push(releaseDate);

    return {
        index: item.index,
        ratingKey: String(item.ratingKey),
        title: item.seasonNumber != null && item.index != null ? `S${item.seasonNumber} E${item.index} - ${item.title}` : item.title,
        /* Same "  •  " join buildTransportBar's own subtitleParts uses (chrome.js). */
        subtitle: subtitleParts.join("  •  "),
        summary: item.summary || "",
        thumbUrl: plexAssetUrl(session, item.thumb),
        progress: item.progress,
        watched: item.watched,
        current: String(item.ratingKey) === String(session.ratingKey),
    };
}

function buildEpisodeCard(item, onSelect) {
    const card = document.createElement("button");
    card.type = "button";
    card.classList.add(PLAYER_FOCUSABLE_CLASS);
    Object.assign(card.style, {
        flex: "0 0 auto",
        width: "240px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "0",
        cursor: "pointer",
        fontFamily: '"Roboto", sans-serif',
    });

    const thumbWrap = document.createElement("div");
    Object.assign(thumbWrap.style, {
        position: "relative",
        width: "100%",
        height: "135px",
        borderRadius: "8px",
        overflow: "hidden",
        background: "rgba(255,255,255,0.08)",
        boxSizing: "border-box",
        border: item.current ? `2px solid ${ACCENT_COLOR}` : "2px solid transparent",
    });

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    Object.assign(img.style, { width: "100%", height: "100%", objectFit: "cover", display: "block" });
    if (item.thumbUrl) img.src = item.thumbUrl;
    thumbWrap.appendChild(img);

    if (item.watched) {
        /* Same dark-circle/amber-checkmark badge as the browsing modal's own episode
           rows (title-info.css's .title-info-episode-watched) and the main page's
           poster grid (rows-poster.css's .watched-badge) - top-left, not top-right. */
        const badge = document.createElement("div");
        badge.innerHTML = WATCHED_ICON_SVG;
        Object.assign(badge.style, {
            position: "absolute",
            top: "4px",
            left: "4px",
            width: "18px",
            height: "18px",
            borderRadius: "50%",
            background: "rgba(20,20,24,0.7)",
            color: ACCENT_COLOR,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
        });
        badge.querySelector("svg").style.width = "11px";
        badge.querySelector("svg").style.height = "11px";
        thumbWrap.appendChild(badge);
    } else {
        if (item.progress > 0) {
            const track = document.createElement("div");
            Object.assign(track.style, { position: "absolute", left: "0", right: "0", bottom: "0", height: "3px", background: "rgba(255,255,255,0.3)" });
            const bar = document.createElement("div");
            Object.assign(bar.style, { height: "100%", width: `${Math.round(item.progress * 100)}%`, background: ACCENT_COLOR });
            track.appendChild(bar);
            thumbWrap.appendChild(track);
        }
        /* Always visible, not hover-revealed - this app has no reliable hover input on
           touch/remote targets yet (see this repo's CLAUDE.md "Platform work not yet
           started"), so a hover-only play icon would simply never appear there. */
        const playIcon = document.createElement("div");
        playIcon.textContent = "▶";
        Object.assign(playIcon.style, {
            position: "absolute",
            left: "8px",
            bottom: "6px",
            color: "rgba(255,255,255,0.85)",
            fontSize: "13px",
            textShadow: "0 1px 3px rgba(0,0,0,0.9)",
        });
        thumbWrap.appendChild(playIcon);
    }

    card.appendChild(thumbWrap);

    const title = document.createElement("div");
    title.textContent = item.title;
    Object.assign(title.style, { color: "#fff", fontSize: "13px", fontWeight: "700", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    card.appendChild(title);

    if (item.subtitle) {
        const subtitle = document.createElement("div");
        subtitle.textContent = item.subtitle;
        Object.assign(subtitle.style, { color: "rgba(255,255,255,0.45)", fontSize: "11px", fontWeight: "600" });
        card.appendChild(subtitle);
    }

    if (item.summary) {
        const summary = document.createElement("div");
        summary.textContent = item.summary;
        Object.assign(summary.style, {
            color: "rgba(255,255,255,0.6)",
            fontSize: "12px",
            lineHeight: "1.4",
            display: "-webkit-box",
            WebkitLineClamp: "3",
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
        });
        card.appendChild(summary);
    }

    card.addEventListener("click", onSelect);
    return card;
}