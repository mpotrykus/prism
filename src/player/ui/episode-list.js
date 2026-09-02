import { playQueuedTitle, formatTime } from "./chrome-transport.js";
import { wireLinearNav } from "../../core/focus-nav.js";
import { media } from "../core/media-facade.js";
import { plexAssetUrl } from "../core/plex-asset-url.js";
import { fetchQueueItemsMetadata } from "../core/title-fetch.js";
import { WATCHED_ICON_SVG } from "../../card/rows.js";
import { formatRuntime } from "../../card/title-info.js";
import { createRowScroll } from "../../card/row-scroll.js";
import { closeInlineMenu } from "./chrome-menu.js";
import { showControls, hideControls } from "./chrome-controls.js";
import { ensurePlayerStyles } from "./styles.js";

/* In-player episode/queue list overlay (HBO Max-style) - a bottom sheet over the still-
   playing video (see the "keep playing behind overlay" decision) listing every title in
   session.queueRatingKeys as a horizontally-scrolling row of cards, letting the viewer
   jump straight to a different episode/queued title without leaving the player. Reuses
   the same queue player.js already carries for the title-prev/title-next buttons
   (see chrome-transport.js's playQueuedTitle) rather than re-deriving season/show structure -
   queueRatingKeys is already the full flattened episode order (or playlist/collection
   order), so one flat list works for both cases with no season concept needed here. */

/* Scoped selectors for gamepad navigation - see openEpisodeListOverlay. */
const EPISODE_LIST_CLASS = "prism-player-episode-list";
const CHAPTER_LIST_CLASS = "prism-player-chapter-list";

/* The bottom-sheet panel both overlays in this file slide up: same box, same fade/translate
   transition, same heading row. */
function buildSheetPanel(headingText) {
    const panel = document.createElement("div");
    panel.className = "prism-player-list-panel";

    const header = document.createElement("div");
    header.className = "prism-player-list-header";
    const heading = document.createElement("div");
    heading.className = "prism-player-list-heading";
    heading.textContent = headingText;
    header.appendChild(heading);

    return { panel, header, heading };
}

/* The card frame shared by the episode and chapter rows: fixed-width button, 16:9 thumb well,
   lazy <img>. Only the current item's card gets the accent border. Everything a card puts
   under or over the thumb (watched badge, progress bar, titles) is appended by the caller. */
function buildCardShell(isCurrent) {
    const card = document.createElement("button");
    card.type = "button";
    card.classList.add("prism-player-focusable", "prism-player-card", "prism-player-list-card");

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "prism-player-list-thumb";
    thumbWrap.classList.toggle("is-current", !!isCurrent);

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = "";
    img.referrerPolicy = "no-referrer";

    return { card, thumbWrap, img };
}

/* Same "Scroll left"/"Scroll right" idea the browsing page's poster rows use (card/rows.js's
   buildScrollArrow) - not reused directly because that file's styling lives inside the card's
   shadow DOM, which never reaches this overlay (appended to document.body, outside that
   shadow root - confirmed as empty button chrome when first tried). */
function buildQueueScrollArrow(direction, scroller, rowScroll) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("prism-player-focusable", "prism-player-list-arrow", direction);
    btn.setAttribute("aria-label", direction === "left" ? "Scroll left" : "Scroll right");
    btn.innerHTML =
        direction === "left" ?
        '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>' :
        '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4L13.2 12z"/></svg>';
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
        leftArrow.classList.toggle("is-visible", showLeft);
        rightArrow.classList.toggle("is-visible", showRight);
    };
    rowScroll.onChange(update);
    /* Card images loading in can still nudge track.scrollWidth a moment after the initial
       layout pass, so this checks again shortly after. */
    requestAnimationFrame(() => rowScroll.refresh());
    setTimeout(() => rowScroll.refresh(), 300);
}

export async function openEpisodeListOverlay(controller) {
    closeEpisodeListOverlay(controller);
    closeInlineMenu(controller);

    const session = controller._session;
    const queueRatingKeys = session?.queueRatingKeys || [];
    if (queueRatingKeys.length < 2) return;

    ensurePlayerStyles();
    const scrim = document.createElement("div");
    scrim.className = "prism-player-list-scrim";
    scrim.addEventListener("click", () => closeEpisodeListOverlay(controller));

    /* Same seasonNumber-present check chrome-menu.js's Episodes/Up Next row uses to decide
       whether a session is a TV episode vs a movie/collection item - label wording only. */
    const { panel, header } = buildSheetPanel(session.seasonNumber != null ? "Episodes" : "Up Next");
    /* No visible close button here (Xbox has no pointer to click one with anyway) - the
       scrim click and the "back" nav command (wireLinearNav's onBack below) are the only
       ways to dismiss this overlay. */
    panel.appendChild(header);

    const scroll = document.createElement("div");
    scroll.className = "prism-player-scroll prism-player-list-scroll";
    const track = document.createElement("div");
    track.className = "prism-player-list-track";
    scroll.appendChild(track);
    const loading = document.createElement("div");
    loading.className = "prism-player-list-loading";
    const spinner = document.createElement("div");
    spinner.className = "prism-player-list-spinner";
    loading.appendChild(spinner);
    track.appendChild(loading);

    const scrollWrap = document.createElement("div");
    scrollWrap.className = "prism-player-list-scrollwrap";
    scrollWrap.appendChild(scroll);
    panel.appendChild(scrollWrap);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    controller._episodeListEl = { scrim, panel };
    panel.classList.add(EPISODE_LIST_CLASS);
    const rowScroll = createRowScroll(scroll, track);
    /* Same fade-edge scroll arrows as openChapterListOverlay below - built now (rowScroll
       already exists) but only made visible once the real cards load and wireQueueArrowVisibility
       runs below; harmless to sit at opacity:0 over the loading spinner in the meantime. */
    const leftArrow = buildQueueScrollArrow("left", scroll, rowScroll);
    const rightArrow = buildQueueScrollArrow("right", scroll, rowScroll);
    scrollWrap.insertBefore(leftArrow, scroll);
    scrollWrap.appendChild(rightArrow);
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
    hideControls(controller);
    requestAnimationFrame(() => {
        panel.classList.add("is-open");
    });

    const items = await getQueueItems(controller, session, queueRatingKeys);
    /* The overlay may have been closed (or reopened fresh) while this fetch was in
       flight - bail rather than paint into a panel that's no longer the active one. */
    if (controller._episodeListEl?.panel !== panel) return;

    track.innerHTML = "";
    if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "prism-player-list-empty";
        empty.textContent = "Couldn't load the queue.";
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
    wireQueueArrowVisibility(rowScroll, leftArrow, rightArrow);
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
    showControls(controller);
}

/* Same overlay shape as openEpisodeListOverlay above (horizontally-scrolling card row,
   fade-edge scroll arrows, keep-playing-behind-it scrim) reused for the More menu's
   Chapters row instead of an inline accordion picker - chrome-menu.js's "Chapters" section
   navigates here (see renderMainList) rather than expanding in place. Simpler than the
   episode overlay in one way: chapters are already fully present on session.chapters
   (no getQueueItems-style async Plex fetch needed), so there's no loading-placeholder
   state to build. */
export function openChapterListOverlay(controller) {
    closeChapterListOverlay(controller);
    closeInlineMenu(controller);

    const session = controller._session;
    const chapters = session?.chapters || [];
    if (!chapters.length) return;

    ensurePlayerStyles();
    const scrim = document.createElement("div");
    scrim.className = "prism-player-list-scrim";
    scrim.addEventListener("click", () => closeChapterListOverlay(controller));

    const { panel, header } = buildSheetPanel("Chapters");
    /* No visible close button here (Xbox has no pointer to click one with anyway) - the
       scrim click and the "back" nav command (wireLinearNav's onBack below) are the only
       ways to dismiss this overlay. */
    panel.appendChild(header);

    const scroll = document.createElement("div");
    scroll.className = "prism-player-scroll prism-player-list-scroll";
    const track = document.createElement("div");
    track.className = "prism-player-list-track";
    scroll.appendChild(track);

    const scrollWrap = document.createElement("div");
    scrollWrap.className = "prism-player-list-scrollwrap";
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
    hideControls(controller);
    requestAnimationFrame(() => {
        panel.classList.add("is-open");
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
    showControls(controller);
}

/* One card of the chapter row above - deliberately much plainer than buildEpisodeCard
   below (no watched badge, no progress bar, no summary line): a chapter is a timestamp
   within the title already being watched, not a separate Plex item with its own
   watched/progress state of its own. */
function buildChapterCard(session, chapter, isCurrent, onSelect) {
    const { card, thumbWrap, img } = buildCardShell(isCurrent);
    const thumbUrl = plexAssetUrl(session, chapter.thumb);
    if (thumbUrl) img.src = thumbUrl;
    thumbWrap.appendChild(img);
    card.appendChild(thumbWrap);

    const timeLabel = formatTime((chapter.startTimeOffset ?? 0) / 1000);
    const title = document.createElement("div");
    title.textContent = chapter.title || chapter.tag || timeLabel;
    title.className = "prism-player-list-title";
    card.appendChild(title);

    if (chapter.title || chapter.tag) {
        const subtitle = document.createElement("div");
        subtitle.textContent = timeLabel;
        subtitle.className = "prism-player-list-subtitle";
        card.appendChild(subtitle);
    }

    card.addEventListener("click", onSelect);
    return card;
}

/* Cached per queue (reference-equality on queueRatingKeys, which threads unchanged
   through playQueuedTitle/_prepareSession across a title switch within the same show/
   collection - see player.js) so reopening the list after navigating a few
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
        /* Same "  •  " join buildTransportBar's own subtitleParts uses. */
        subtitle: subtitleParts.join("  •  "),
        summary: item.summary || "",
        thumbUrl: plexAssetUrl(session, item.thumb),
        progress: item.progress,
        watched: item.watched,
        current: String(item.ratingKey) === String(session.ratingKey),
    };
}

function buildEpisodeCard(item, onSelect) {
    const { card, thumbWrap, img } = buildCardShell(item.current);
    if (item.thumbUrl) img.src = item.thumbUrl;
    thumbWrap.appendChild(img);

    if (item.watched) {
        /* Same dark-circle/amber-checkmark badge as the browsing modal's own episode
           rows (title-info.css's .title-info-episode-watched) and the main page's
           poster grid (rows-poster.css's .watched-badge) - top-left, not top-right. */
        const badge = document.createElement("div");
        badge.className = "prism-player-list-watched";
        badge.innerHTML = WATCHED_ICON_SVG;
        thumbWrap.appendChild(badge);
    } else {
        if (item.progress > 0) {
            const track = document.createElement("div");
            track.className = "prism-player-list-progress";
            const bar = document.createElement("div");
            bar.className = "prism-player-list-progress-bar";
            bar.style.width = `${Math.round(item.progress * 100)}%`;
            track.appendChild(bar);
            thumbWrap.appendChild(track);
        }
        /* Always visible, not hover-revealed - this app has no reliable hover input on
           touch/remote targets yet (see this repo's CLAUDE.md "Platform work not yet
           started"), so a hover-only play icon would simply never appear there. */
        const playIcon = document.createElement("div");
        playIcon.className = "prism-player-list-play";
        playIcon.textContent = "▶";
        thumbWrap.appendChild(playIcon);
    }

    card.appendChild(thumbWrap);

    const title = document.createElement("div");
    title.textContent = item.title;
    title.className = "prism-player-list-title";
    card.appendChild(title);

    if (item.subtitle) {
        const subtitle = document.createElement("div");
        subtitle.textContent = item.subtitle;
        subtitle.className = "prism-player-list-subtitle";
        card.appendChild(subtitle);
    }

    if (item.summary) {
        const summary = document.createElement("div");
        summary.textContent = item.summary;
        summary.className = "prism-player-list-summary";
        card.appendChild(summary);
    }

    card.addEventListener("click", onSelect);
    return card;
}