import { playQueuedTitle } from "./chrome.js";
import { plexAssetUrl } from "../core/plex-asset-url.js";
import { fetchQueueItemsMetadata } from "../core/title-fetch.js";
import { WATCHED_ICON_SVG } from "../../card/rows.js";
import { formatRuntime } from "../../card/title-info.js";

/* In-player episode/queue list overlay (HBO Max-style) - a bottom sheet over the still-
   playing video (see the "keep playing behind overlay" decision) listing every title in
   session.queueRatingKeys as a horizontally-scrolling row of cards, letting the viewer
   jump straight to a different episode/queued title without leaving the player. Reuses
   the same queue plex-player.js already carries for the title-prev/title-next buttons
   (see chrome.js's playQueuedTitle) rather than re-deriving season/show structure -
   queueRatingKeys is already the full flattened episode order (or playlist/collection
   order), so one flat list works for both cases with no season concept needed here. */

const ACCENT_COLOR = "#e5a00d";
const SCROLL_CLASS = "streaming-player-episode-scroll";
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
function buildQueueScrollArrow(direction, scroller) {
    const btn = document.createElement("button");
    btn.type = "button";
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
        transition: "opacity 0.15s ease",
        background: direction === "left" ?
            "linear-gradient(90deg, rgba(10,10,12,0.9), rgba(10,10,12,0))" :
            "linear-gradient(270deg, rgba(10,10,12,0.9), rgba(10,10,12,0))",
    });
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const amount = scroller.clientWidth * 0.9 * (direction === "left" ? -1 : 1);
        scroller.scrollBy({ left: amount, behavior: "smooth" });
    });
    return btn;
}

function wireQueueArrowVisibility(scroller, leftArrow, rightArrow) {
    const update = () => {
        const maxScroll = scroller.scrollWidth - scroller.clientWidth - 1;
        const showLeft = scroller.scrollLeft > 0;
        const showRight = maxScroll > 0 && scroller.scrollLeft < maxScroll;
        leftArrow.style.opacity = showLeft ? "1" : "0";
        leftArrow.style.pointerEvents = showLeft ? "auto" : "none";
        rightArrow.style.opacity = showRight ? "1" : "0";
        rightArrow.style.pointerEvents = showRight ? "auto" : "none";
    };
    scroller.addEventListener("scroll", update, { passive: true });
    requestAnimationFrame(update);
    /* Card images loading in can still be nudging scrollWidth a moment after the initial
       layout pass - same "check again shortly after" reasoning rows.js's own
       wireArrowVisibility follows. */
    setTimeout(update, 300);
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
           insets below so the scroll arrows can still sit flush against the true window
           edges (see buildQueueScrollArrow's left:0/right:0) instead of stopping 40px
           short of them. */
        padding: "24px 0 28px",
        background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.88) 55%, rgba(0,0,0,0.5) 85%, transparent 100%)",
        boxSizing: "border-box",
        fontFamily: '"Roboto", sans-serif',
        opacity: "0",
        transform: "translateY(12px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", flex: "0 0 auto", padding: "0 24px" });

    const heading = document.createElement("div");
    /* Same seasonNumber-present check buildTransportBar already uses to decide whether
       a session is a TV episode vs a movie/collection item - reused here purely for
       label wording, nothing structural depends on it. */
    heading.textContent = session.seasonNumber != null ? "Episodes" : "Up Next";
    Object.assign(heading.style, { color: "#fff", fontSize: "18px", fontWeight: "700" });
    header.appendChild(heading);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close episode list");
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
    closeBtn.addEventListener("click", () => closeEpisodeListOverlay(controller));
    header.appendChild(closeBtn);
    panel.appendChild(header);

    ensureScrollStyle();
    const scroll = document.createElement("div");
    scroll.className = SCROLL_CLASS;
    /* Horizontal padding leaves room for the 44px-wide scroll arrows (buildQueueScrollArrow),
       which are absolutely positioned flush against scrollWrap's own true edges - without
       this, the first/last card would render underneath them. */
    Object.assign(scroll.style, { display: "flex", gap: "14px", overflowX: "auto", overflowY: "hidden", padding: "4px 54px" });
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
    scroll.appendChild(loading);

    const scrollWrap = document.createElement("div");
    /* flexShrink:0 keeps the card row at its natural height even once the panel itself
       is scrolling (see the panel's own overflowY:auto above) - otherwise flexbox would
       squash it to fit the capped box instead of just scrolling to reach the rest. */
    Object.assign(scrollWrap.style, { position: "relative", flexShrink: "0" });
    const leftArrow = buildQueueScrollArrow("left", scroll);
    const rightArrow = buildQueueScrollArrow("right", scroll);
    scrollWrap.appendChild(leftArrow);
    scrollWrap.appendChild(scroll);
    scrollWrap.appendChild(rightArrow);
    panel.appendChild(scrollWrap);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    controller._episodeListEl = { scrim, panel };
    controller._showControls();
    requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
    });

    const items = await getQueueItems(controller, session, queueRatingKeys);
    /* The overlay may have been closed (or reopened fresh) while this fetch was in
       flight - bail rather than paint into a panel that's no longer the active one. */
    if (controller._episodeListEl?.panel !== panel) return;

    scroll.innerHTML = "";
    if (!items.length) {
        const empty = document.createElement("div");
        empty.textContent = "Couldn't load the queue.";
        Object.assign(empty.style, { color: "rgba(255,255,255,0.6)", fontSize: "13px" });
        scroll.appendChild(empty);
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
        scroll.appendChild(card);
        if (formatted.current) currentCard = card;
    });

    if (currentCard) currentCard.scrollIntoView({ inline: "center", block: "nearest" });
    /* Wired after the real cards land (not right after scrollWrap is built) - scrollWidth
       is meaningless against the empty "Loading…" placeholder that was there before. */
    wireQueueArrowVisibility(scroll, leftArrow, rightArrow);
}

export function closeEpisodeListOverlay(controller) {
    if (!controller._episodeListEl) return;
    controller._episodeListEl.scrim.remove();
    controller._episodeListEl.panel.remove();
    controller._episodeListEl = null;
    controller._scheduleHideControls();
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