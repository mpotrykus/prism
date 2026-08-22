import { wireLinearNav, registerNavHandler, focusAfterPaint, isControllerActive } from "../../focus-nav.js";
import { lockScroll, unlockScroll } from "../../scroll-lock.js";
import { paintWatchlistButton } from "./watchlist.js";
import { WATCHED_ICON_SVG, wireArrowVisibility } from "./rows.js";
import { PROFILE_ICON_SVG } from "./profile.js";
import { pickNextEpisode } from "./logic/catalog.js";
import { createRowScroll } from "./row-scroll.js";

/* Plex's Media[].Part[].Stream[] carries every stream on a version (video/audio/
   subtitle, distinguished by streamType - 2 is audio). Only surfaced for the player's
   Audio Track menu, which stays hidden entirely when there's nothing to switch between
   (see plex-player.js's _openHamburgerMenu), so an item with only one audio stream (or
   no Stream data at all) just yields an empty list here rather than an error. */
export function extractAudioStreams(media, mediaIndex) {
  const streams = media?.[mediaIndex]?.Part?.[0]?.Stream || [];
  return streams
    .filter((s) => s.streamType === 2)
    .map((s) => ({
      id: s.id,
      label: s.extendedDisplayTitle || s.displayTitle || s.languageCode || "Unknown",
      selected: !!s.selected,
    }));
}

/* Whether this version's video stream is HDR, read from Plex's own stream metadata. streamType 1 is
   video.

   Needed BEFORE playback starts, which is why it comes from Plex rather than from the decoder: the
   Xbox leg has to switch the console's HDMI output into an HDR mode before the first frame arrives
   (see HdrDisplayController), and waiting for the player to report its own format would be too late.
   The native side re-reports what the output actually ended up doing afterwards.

   Checks colorTrc first because that is the property that actually distinguishes HDR transfer
   functions; `smpte2084` is HDR10/PQ and `arib-std-b67` is HLG. bt2020 primaries alone are treated as
   HDR too, since a bt2020 video stream in practice is HDR - but Dolby Vision profiles are NOT detected
   here, matching Android's own isHdrContent(), so a DV-only source falls through as SDR rather than
   being wrongly promised HDR. */
export function isHdrVideo(media, mediaIndex) {
  const streams = media?.[mediaIndex]?.Part?.[0]?.Stream || [];
  const video = streams.find((s) => s.streamType === 1);
  if (!video) return false;
  const trc = String(video.colorTrc || "").toLowerCase();
  if (trc === "smpte2084" || trc === "arib-std-b67") return true;
  return String(video.colorSpace || "").toLowerCase().startsWith("bt2020");
}

/* streamType 3 is subtitle. Filtered to entries carrying a `key` - an embedded
   (in-container) subtitle stream has no `key` at all and can only be played back via a
   burn-in transcode Prism doesn't support yet, so listing it here would offer a menu
   item that silently can't be selected. A `key` means an external sidecar file Plex can
   serve directly (one Prism itself downloaded via plex-subtitles.js's search, one
   manually uploaded via Plex Web, or one a tool like Bazarr wrote to disk and Plex
   picked up on its own library scan) - same fetch-and-attach path either way. */
export function extractSubtitleTracks(media, mediaIndex) {
  const streams = media?.[mediaIndex]?.Part?.[0]?.Stream || [];
  return streams
    .filter((s) => s.streamType === 3 && s.key)
    .map((s) => ({
      key: s.key,
      codec: s.codec || "srt",
      languageCode: s.languageCode || s.language || "en",
      label: s.title || s.extendedDisplayTitle || s.displayTitle || s.languageCode || "Unknown",
      selected: !!s.selected,
    }));
}

/* Plex's Media[] describes every version this item has (e.g. a 4K remux alongside a
   1080p encode) - reduced here to {mediaIndex, label} for the player's in-session
   Video Quality menu (see chrome.js's openVersionMenu), the same "resolve Plex's
   protocol once, hand the player a plain list" split extractAudioStreams above
   follows. Resolution/codec/bitrate field names are unverified against a real
   multi-version item - see this feature's own open risks. */
export function extractMediaVersions(media) {
  return (media || []).map((m, i) => {
    const parts = [];
    if (m.videoResolution) parts.push(String(m.videoResolution));
    if (m.videoCodec) parts.push(m.videoCodec.toUpperCase());
    if (m.bitrate) parts.push(`${(m.bitrate / 1000).toFixed(1)} Mbps`);
    return { mediaIndex: i, label: parts.join(" · ") || `Version ${i + 1}` };
  });
}

/* Plex's Media[].Part[].Indexes carries the BIF trickplay index path (used for the
   player's scrub-preview thumbnail, see src/player/core/bif.js) when one's been
   generated for this part - same per-version/per-part shape as extractAudioStreams
   above, since a multi-version item could have generated one for some versions and not
   others. */
export function bifIndexPath(media, mediaIndex) {
  const part = media?.[mediaIndex]?.Part?.[0];
  /* Plex's JSON conversion lowercases XML attributes but keeps child-element names
     capitalized as authored (Chapter/Marker/Stream/Media) - "indexes" is an attribute
     on Part, hence the lowercase i here despite every neighboring field being
     capitalized. Confirmed against a real response, not assumed - a PowerShell check
     of this same field is case-insensitive and would silently pass either way. */
  return part?.indexes ? `/library/parts/${part.id}/indexes/sd` : null;
}

/* The Part's own id and key. `partId` is needed to PUT
   /library/parts/<id>?audioStreamID=...&allParts=1 when the player's Audio Track menu
   switches streams (see web-fallback.js's reloadWebSource and
   PlayerActivity.switchAudioStream) - Plex's transcode start URL doesn't reliably honor
   a bare audioStreamID query param on its own, but does honor whichever stream is
   currently marked "selected" on the Part.

   `partKey` is Plex's own direct-file path (e.g. "/library/parts/12345/167xxxx/file.mkv")
   - the URL a real direct play (no transcode session at all) is built from, see
   core/stream-url.js's resolvePlaybackUrl. Its exact shape comes from the same
   already-fetched metadata response `partId` does, no extra request - but unlike
   `partId` (long-verified against a real server), `partKey`'s value has not yet been
   confirmed against one; log it once on first real direct-play attempt before trusting
   it blindly, matching this project's own established discipline for every other Plex
   response shape. */
export function extractPartInfo(media, mediaIndex) {
  const part = media?.[mediaIndex]?.Part?.[0];
  return { partId: part?.id ?? null, partKey: part?.key ?? null };
}

export function formatRuntime(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/* Plex's videoResolution is a bare number-as-string ("1080", "720") for anything
   sub-4K, but "4k"/"8k" below that. Normalized the same way for both rather than
   just String()-ing it like extractMediaVersions above, since this one is user-facing
   in the info modal's meta line, not an internal version-menu label. */
export function formatResolution(res) {
  const r = String(res || "").toLowerCase();
  if (!r) return "";
  if (r === "sd") return "SD";
  if (r.endsWith("k")) return r.toUpperCase();
  return `${r}p`;
}

/* Raw-meta equivalents of logic/catalog.js's mapItem watched/hasHistory fields, for the
   detail fetches here that hand this a raw Plex response object rather than an
   already-mapped item - a show/season has no viewOffset/viewCount of its own the way a
   movie or episode does (see mapItem's comment), so its own "fully watched"/"has any
   history" both key off viewedLeafCount/leafCount instead. */
function isFullyWatched(meta) {
  if (meta.type === "show" || meta.type === "season") return meta.leafCount > 0 && meta.viewedLeafCount === meta.leafCount;
  return (meta.viewCount || 0) > 0;
}
function hasAnyHistory(meta) {
  if (meta.type === "show" || meta.type === "season") return (meta.viewedLeafCount || 0) > 0;
  return (meta.viewOffset || 0) > 0 || (meta.viewCount || 0) > 0;
}
/* "Has an actual mid-title resume position" - distinct from hasAnyHistory above, which
   also goes true once something is fully watched (viewCount > 0, viewOffset back at 0).
   Restart only makes sense when there's real progress to discard by starting over; a
   show/season container has no viewOffset of its own to resume from at all. */
function hasProgress(meta) {
  if (meta.type === "show" || meta.type === "season") return false;
  return (meta.viewOffset || 0) > 0;
}

/* Same shape as rows.js's own buildScrollArrow (also used by the player's
   openEpisodeListOverlay for its own card row), but a distinct class name rather than
   that one's hardcoded ".scroll-arrow" - rows-poster.css's own geometry for that class
   (44px arrow inset at a fixed 45px top/bottom, tuned for the main page's poster-glow
   bleed padding) doesn't match this row's differently-sized episode cards. Reuses
   wireArrowVisibility as-is though, since that helper only ever toggles a "hidden"
   class rather than assuming ".scroll-arrow" itself. */
function buildEpisodeRowArrow(dir, scroller, rowScroll) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `title-info-row-arrow ${dir} hidden`;
  btn.setAttribute("aria-label", dir === "left" ? "Scroll left" : "Scroll right");
  btn.innerHTML =
    dir === "left"
      ? '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4L13.2 12z"/></svg>';
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const amount = scroller.clientWidth * 0.9 * (dir === "left" ? -1 : 1);
    rowScroll.scrollBy(amount, { animate: true });
  });
  return btn;
}

/* One episode card - same visual shape as the in-player episode list's own
   buildEpisodeCard (src/player/ui/episode-list.js), just built as an HTML string here
   since this modal already renders its lists that way rather than via DOM-factory calls.
   "current" (the resumed/on-deck episode landed on via openForEpisode) is applied by the
   caller afterward via a data-rating-key lookup, same as before this became a row.
   title+summary are grouped under .title-info-episode-text (rather than sitting directly
   in .title-info-episode, as they did before this became a card row) so mobile's own CSS
   (see responsive.css) can revert this card to the old thumb-beside-text row layout by
   just flipping .title-info-episode back to flex-row with that wrapper as its second
   item - the same markup then serves both layouts, no separate mobile template needed. */
function episodeCardHtml(ctx, ep) {
  const progress = ep.duration ? Math.max(0, Math.min(1, (ep.viewOffset || 0) / ep.duration)) : 0;
  const watched = !!ep.viewCount && progress <= 0;
  return `
    <div class="title-info-episode" data-rating-key="${ep.ratingKey}" tabindex="0">
      <div class="title-info-episode-thumb">
        <img loading="lazy" src="${ctx.escape(ctx.plexThumbUrl(ep.thumb, 320, 180))}" alt="" />
        ${watched ? `<div class="title-info-episode-watched">${WATCHED_ICON_SVG}</div>` : ""}
        ${
          progress > 0
            ? `<div class="title-info-episode-progress"><div class="bar" style="width:${Math.round(progress * 100)}%"></div></div>`
            : ""
        }
        <div class="title-info-episode-play"><div class="title-info-episode-play-icon">▶</div></div>
      </div>
      <div class="title-info-episode-text">
        <div class="title-info-episode-title">${ep.index}. ${ctx.escape(ep.title)}</div>
        <div class="title-info-episode-summary">${ctx.escape(ep.summary || "")}</div>
      </div>
    </div>`;
}

/* Collection/playlist row equivalent of episodeCardHtml above - kept as a separate
   function (rather than branching inside one) since its source shape (an already-mapped
   card/logic/catalog.js item, no per-episode index prefix, no hover play icon - see
   _renderFlatItems's own comment on why these aren't directly playable the way episodes
   are) differs enough from a raw Plex episode child to make one shared function more
   confusing than two small ones. */
function flatItemCardHtml(ctx, mapped, rawSummary) {
  const watched = mapped.watched && !(mapped.progress > 0);
  return `
    <div class="title-info-episode" data-rating-key="${mapped.ratingKey}" tabindex="0">
      <div class="title-info-episode-thumb">
        <img loading="lazy" src="${ctx.escape(mapped.art || mapped.image)}" alt="" />
        ${watched ? `<div class="title-info-episode-watched">${WATCHED_ICON_SVG}</div>` : ""}
        ${
          mapped.progress > 0
            ? `<div class="title-info-episode-progress"><div class="bar" style="width:${Math.round(mapped.progress * 100)}%"></div></div>`
            : ""
        }
      </div>
      <div class="title-info-episode-text">
        <div class="title-info-episode-title">${ctx.escape(mapped.title)}</div>
        <div class="title-info-episode-summary">${ctx.escape(rawSummary || "")}</div>
      </div>
    </div>`;
}

/* The title-info detail overlay: cast/seasons-episodes/collection-playlist items/
   similar titles, plus the Play/Restart/watched-toggle/watchlist actions. Version and
   quality-cap selection used to live in a picker nested inside this modal - that's now
   an in-player "Video Quality" menu (see chrome.js's openVideoQualityMenu) fed by this
   item's Media[] list, since it changes what's actually decoded, not what gets
   requested before playback starts.
   ctx: { escape, plexFetch, plexImageUrl, mapItem, isInWatchlist, onAddToWatchlist,
   onRemoveFromWatchlist, onPlayItem } - the card's own collaborators, passed in
   explicitly rather than this reaching into card state. */
export class TitleInfoController {
  constructor(shadowRoot, ctx) {
    this._shadowRoot = shadowRoot;
    this._ctx = ctx;

    this._overlay = shadowRoot.querySelector(".title-info-overlay");
    this._modal = shadowRoot.querySelector(".title-info-modal");
    this._closeBtn = shadowRoot.querySelector(".title-info-close");
    this._artEl = shadowRoot.querySelector(".title-info-art");
    this._progressEl = shadowRoot.querySelector(".title-info-progress");
    this._progressBar = this._progressEl.querySelector(".bar");
    this._titleEl = shadowRoot.querySelector(".title-info-title");
    this._metaEl = shadowRoot.querySelector(".title-info-meta");
    this._playBtn = shadowRoot.querySelector(".title-info-play");
    this._restartBtn = shadowRoot.querySelector(".title-info-restart-btn");
    this._watchedBtn = shadowRoot.querySelector(".title-info-watched-btn");
    this._watchlistBtn = shadowRoot.querySelector(".title-info-watchlist-btn");
    this._actionsEl = shadowRoot.querySelector(".title-info-actions");
    this._actionsLoadingEl = shadowRoot.querySelector(".title-info-actions-loading");
    this._summaryEl = shadowRoot.querySelector(".title-info-summary");
    this._episodesEl = shadowRoot.querySelector(".title-info-episodes");
    this._castWrap = shadowRoot.querySelector(".title-info-cast-wrap");
    this._castEl = shadowRoot.querySelector(".title-info-cast");
    this._similarWrap = shadowRoot.querySelector(".title-info-similar-wrap");
    this._similarEl = shadowRoot.querySelector(".title-info-similar");

    this._item = null;
    this._source = null;
    this._duration = null;
    this._viewOffset = 0;
    this._viewCount = 0;
    this._watched = false;
    this._markers = [];
    this._chapters = [];
    this._media = [];
    this._flatItems = null;
    this._pendingEpisodeFocus = null;
    this._resumeEpisodeKey = null;
    this._flatQueueContext = null;
    this._episodeQueueCache = null;
    this._nextEpisodeCache = null;
    this._focusPlayOnceLoaded = false;

    this._wire();
  }

  get item() {
    return this._item;
  }

  isOpen() {
    return this._overlay.classList.contains("open");
  }

  close() {
    if (this.isOpen()) unlockScroll();
    this._overlay.classList.remove("open");
    this._item = null;
  }

  /* hasHistory (Play vs Resume label) and hasProgress (Restart's own visibility) are
     related but not the same thing - hasHistory also goes true once a title is fully
     watched with no resume offset left, where Restart wouldn't do anything meaningful
     (there's nothing to discard by "starting over"; Play already starts from zero).
     Defaults hasProgress to hasHistory only so a caller that hasn't been taught the
     distinction yet (there shouldn't be any) fails toward the old behavior rather than
     silently hiding Restart. resumeEpisode ({season, episode}) is only known when this
     modal stands in for a specific episode (see openForEpisode) - a show opened directly
     has no single episode to name, so it keeps the plain label. */
  _updatePlayHistoryUI(hasHistory, resumeEpisode = null, hasProgress = hasHistory) {
    const resumeLabel = resumeEpisode ? `▶ Resume S${resumeEpisode.season} E${resumeEpisode.episode}` : "▶ Resume";
    this._playBtn.textContent = hasHistory ? resumeLabel : "▶ Play";
    this._restartBtn.hidden = !hasProgress;
  }

  /* The watched toggle's label/state is driven only by Plex's own watched flag
     (isFullyWatched - viewCount/viewedLeafCount), never by progress/hasHistory - a
     title that's merely in-progress isn't "watched" and shouldn't render as if a click
     would unwatch it. */
  _updateWatchedUI(watched) {
    this._watched = watched;
    this._watchedBtn.classList.toggle("watched", watched);
    this._watchedBtn.setAttribute("aria-label", watched ? "Mark as unwatched" : "Mark as watched");
  }

  /* The optimistic paint in open() (Play/Restart/Watched labels and visibility) is only
     a guess from the row/hero item's already-truncated fields - the real detail fetch can
     flip Restart/Watched from hidden to shown or change Play's label between that paint
     and _renderDetail landing, which read as the buttons being clickable in a state that's
     about to change out from under the click. Swapping the whole actions row for a
     spinner for that window (rather than just disabling the buttons in place) removes the
     race entirely and avoids flashing buttons in a state that's about to change. */
  _setButtonsLoading(loading) {
    this._actionsEl.hidden = loading;
    this._actionsLoadingEl.hidden = !loading;
    /* Deferred from open() - Play/Resume was hidden (still loading) at the point a
       controller user's open() call wanted to land focus on it, so it's done here
       instead, once the button just became visible/focusable again. One-shot: only the
       open() call that requested it consumes the flag, so a later unrelated loading
       toggle (e.g. re-opening for a different item) doesn't yank focus back to Play. */
    if (!loading && this._focusPlayOnceLoaded) {
      this._focusPlayOnceLoaded = false;
      focusAfterPaint(this._playBtn);
    }
  }

  /* Redirects an episode click to the parent show's info modal, landing on the season/
     episode it came from (via _pendingEpisodeFocus, consumed in _loadSeasons) instead
     of opening a dedicated single-episode modal. item.image/art already resolve to the
     show's own thumb/art here (see mapItem's grandparentThumb/grandparentArt fallback
     for episodes), so the optimistic paint before the real fetch is accurate.
     _resumeEpisodeKey remembers which episode this show modal stands in for, so the
     Play button resumes that episode instead of trying to "play" the show container
     itself, which isn't a playable item (player.play fails on it and falls back to the
     web/details link - the "thrown to the Plex website" regression this comment is here
     to prevent reintroducing). */
  async openForEpisode(item, source) {
    this._pendingEpisodeFocus = { seasonRatingKey: item.seasonKey, episodeRatingKey: item.ratingKey };
    const showItem = {
      ratingKey: item.showKey,
      type: "show",
      title: item.title,
      subtitle: "",
      image: item.image,
      art: item.art,
    };
    await this.open(showItem, source);
    if (this._item === showItem) {
      this._resumeEpisodeKey = item.ratingKey;
      /* The show container's own meta has no viewOffset (see _playEpisodeByRatingKey's
         comment) - use the resumed episode's own progress/hasHistory, already known from
         the click that led here, instead. */
      const resumeEpisode = item.seasonNumber != null && item.episodeNumber != null ? { season: item.seasonNumber, episode: item.episodeNumber } : null;
      this._updatePlayHistoryUI(!!(item.progress > 0 || item.hasHistory), resumeEpisode, !!(item.progress > 0));
      /* _renderDetail (already run inside the open() call above) just painted the
         watched button from the show's own overall status - override with the specific
         resumed episode's own watched flag, since that's the ratingKey the button
         actually targets once _resumeEpisodeKey is set. */
      if (!this._watchedBtn.hidden) this._updateWatchedUI(!!item.watched);
    }
  }

  /* Opens instantly from whatever's already known about the item (title/image, via the
     existing mapItem shape) so there's no blank-modal flash, then fills in the rest
     from a full /library/metadata fetch. A watchlist item's own ratingKey is scoped to
     discover.provider.plex.tv, not this server, so it's resolved to a local ratingKey
     first via the card's resolveLocalRatingKey. A watchlist item that isn't in this
     server's library at all is a legitimate case, not an error - it just skips the
     detail fetch and leaves Play falling back to the Discover deep link. An episode
     (e.g. from Continue Watching) redirects to its show's info instead of a standalone
     episode modal - see openForEpisode. */
  async open(item, source, { flatQueueContext = null } = {}) {
    if (item.type === "episode" && item.showKey) {
      return this.openForEpisode(item, source);
    }
    this._resumeEpisodeKey = null;
    this._flatQueueContext = flatQueueContext;
    this._item = item;
    this._source = source;
    this._duration = null;
    this._viewOffset = 0;
    this._markers = [];
    this._chapters = [];
    this._media = [];
    this._flatItems = null;
    this._progressEl.hidden = !(item.progress > 0);
    this._progressBar.style.width = `${Math.round((item.progress || 0) * 100)}%`;
    this._updatePlayHistoryUI(!!(item.progress > 0 || item.hasHistory), null, !!(item.progress > 0));
    const art = item.art || item.image || "";
    this._artEl.style.backgroundImage = art ? `url('${art}')` : "none";
    this._modal.style.setProperty("--title-info-bg", art ? `url('${art}')` : "none");
    this._titleEl.textContent = item.title || "";
    this._metaEl.innerHTML = item.subtitle ? `<span>${this._ctx.escape(item.subtitle)}</span>` : "";
    this._summaryEl.textContent = "";
    this._episodesEl.innerHTML = "";
    this._episodesEl.classList.remove("title-info-row-wrap");
    this._castWrap.hidden = true;
    this._castEl.innerHTML = "";
    this._similarWrap.hidden = true;
    this._similarEl.innerHTML = "";
    const canWatchlist = item.type === "movie" || item.type === "show";
    this._watchlistBtn.hidden = !canWatchlist;
    if (canWatchlist) {
      paintWatchlistButton(this._watchlistBtn, this._ctx.isInWatchlist(item));
    }
    /* Collections/playlists are containers, not a single watchable item on this
       server - same reasoning as the watchlist gating above, just a different type set
       (a collection/playlist can still be added to My List, but has no watched state of
       its own to scrobble). */
    const canToggleWatched = item.type !== "collection" && item.type !== "playlist";
    this._watchedBtn.hidden = !canToggleWatched;
    if (canToggleWatched) this._updateWatchedUI(!!item.watched);
    /* Re-opening for a different item (e.g. clicking a "More Like This" card) while
       already open must not lock scroll a second time - only the matching close() call
       unlocks it once, so a second lock here would leave the counter permanently off by
       one. */
    if (!this.isOpen()) lockScroll();
    this._overlay.classList.add("open");
    this._setButtonsLoading(true);
    /* Focusing the overlay shell itself (tabindex="-1", just so a click outside it can
       still blur out of whatever was focused before) would leave document.activeElement
       pointing at an element wireLinearNav's own selector never matches - every D-pad
       command then falls straight through as unhandled, since registerNavHandler's
       handler here only acts when the active element is one of its own watched items.
       focusFirst() lands on the actual first nav target (.title-info-close) instead -
       always taken here, even for controller users, since Play/Resume itself is hidden
       behind _setButtonsLoading(true) right up above and .focus() on a hidden element is
       a silent no-op, not a deferred one: landing the deferred focusAfterPaint call on it
       directly here raced the detail fetch below and intermittently left focus behind the
       modal on whatever was focused before it opened. Controller users still get
       Play/Resume once it's actually visible - see the _setButtonsLoading(false) call
       sites below. */
    this._nav.focusFirst();
    this._focusPlayOnceLoaded = isControllerActive();

    let ratingKey = item.ratingKey;
    if (source === "watchlist") {
      ratingKey = await this._ctx.resolveLocalRatingKey(item);
      if (this._item !== item) return;
      /* Swap the item's Discover-scoped ratingKey (and key) for the resolved local ones
         so downstream staleness checks (_loadSimilar/_loadSeasons compare against
         this._item.ratingKey) and Play's native playback request both key off the ID
         that actually exists on this server. item.key must move with ratingKey -
         plex-player.js's _prepareSession prefers item.key over deriving the path from
         ratingKey, so leaving the old Discover-scoped key in place here silently sends
         playback requests at a path that doesn't exist on this server. */
      item.ratingKey = ratingKey;
      item.key = ratingKey ? `/library/metadata/${ratingKey}` : item.key;
    }
    if (!ratingKey) {
      this._setButtonsLoading(false);
      return;
    }
    /* Playlists aren't part of library metadata (see the card's _fetchPlaylistsRaw) -
       their detail lives under /playlists/{ratingKey}, not /library/metadata/{ratingKey}
       like every other item type here. */
    const metaPath = item.type === "playlist" ? `/playlists/${ratingKey}` : `/library/metadata/${ratingKey}`;
    try {
      const data = await this._ctx.plexFetch(metaPath, { includeChapters: 1, includeMarkers: 1 });
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (meta && this._item === item) this._renderDetail(meta);
    } catch (e) {
      // detail is best-effort - the poster/title painted above stays usable on failure
    } finally {
      if (this._item === item) this._setButtonsLoading(false);
    }
  }

  _renderDetail(meta) {
    this._duration = meta.duration || null;
    this._viewOffset = meta.viewOffset || 0;
    this._viewCount = meta.viewCount || 0;
    this._markers = meta.Marker || [];
    this._chapters = meta.Chapter || [];
    this._media = meta.Media || [];
    this._updatePlayHistoryUI(hasAnyHistory(meta), null, hasProgress(meta));
    if (!this._watchedBtn.hidden) this._updateWatchedUI(isFullyWatched(meta));
    /* Refines the possibly-truncated Genre list mapItem saw at row-click time (Plex list
       endpoints cap it to ~2 tags) with this fetch's full, untruncated list, so shader
       auto-detection (plex-player.js's detectShaderType) sees every genre tag, not just
       the first couple. */
    if (this._item) {
      this._item.genres = (meta.Genre || []).map((g) => (g.tag || "").trim()).filter(Boolean);
    }
    const progress = meta.duration ? Math.max(0, Math.min(1, this._viewOffset / meta.duration)) : 0;
    this._progressEl.hidden = progress <= 0;
    this._progressBar.style.width = `${Math.round(progress * 100)}%`;
    this._summaryEl.textContent = meta.summary || "";

    const metaParts = [];
    if (meta.contentRating) metaParts.push(meta.contentRating);
    if (meta.year) metaParts.push(String(meta.year));
    if (meta.duration) metaParts.push(formatRuntime(meta.duration));
    const resolution = meta.Media?.[0]?.videoResolution;
    if (resolution) metaParts.push(formatResolution(resolution));
    const rating = meta.audienceRating || meta.rating;
    if (rating) metaParts.push(`★ ${Number(rating).toFixed(1)}`);
    if (meta.Genre?.length) metaParts.push(meta.Genre.slice(0, 3).map((g) => g.tag).join(", "));
    this._metaEl.innerHTML = metaParts.map((p) => `<span>${this._ctx.escape(p)}</span>`).join("");

    const cast = (meta.Role || []).slice(0, 12);
    this._castWrap.hidden = !cast.length;
    this._castEl.innerHTML = cast
      .map((r) => {
        const fallback = `<div class="title-info-cast-avatar-fallback">${PROFILE_ICON_SVG}</div>`;
        const avatar = r.thumb
          ? `<img src="${this._ctx.escape(this._ctx.plexThumbUrl(r.thumb, 160, 160))}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
             <div class="title-info-cast-avatar-fallback" style="display:none">${PROFILE_ICON_SVG}</div>`
          : fallback;
        const role = r.role ? `<div class="title-info-cast-role">${this._ctx.escape(r.role)}</div>` : "";
        return `<div class="title-info-cast-chip"><div class="title-info-cast-avatar">${avatar}</div><div class="title-info-cast-name">${this._ctx.escape(r.tag)}</div>${role}</div>`;
      })
      .join("");

    if (meta.type === "show") {
      this._loadSeasons(meta.ratingKey);
      this._loadShowResumeLabel(meta);
    } else if (meta.type === "collection") this._loadCollectionItems(meta.ratingKey);
    else if (meta.type === "playlist") this._loadPlaylistItems(meta.ratingKey);
    this._loadSimilar(meta.ratingKey);
  }

  async _loadSeasons(showRatingKey) {
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${showRatingKey}/children`);
      const seasons = (data?.MediaContainer?.Metadata || []).filter((s) => s.index != null);
      if (!seasons.length || this._item?.ratingKey !== showRatingKey) return;

      this._episodesEl.innerHTML = "";
      /* A native <select>'s dropdown-open is a browser-gated action - it only responds to a
         genuinely trusted user gesture (a real mousedown, or a trusted keydown's own default
         action), never to a script-driven `.click()`/`.showPicker()` call. That's exactly what
         "activate" resolves to for a gamepad/D-pad press whose only path into the page is this
         file's own synthetic-KeyboardEvent bridge (see focus-nav.js's dispatchSyntheticKey) -
         same root cause as adjustRange's own comment in focus-nav.js, just hitting a browser
         control this app can't work around by manually firing an "input"/"change" event. A
         hand-built trigger+list instead opens/closes via a plain "open" class toggle in response
         to whatever click the trigger's own listener sees - script-driven or real, it's all the
         same to a plain click listener. */
      const picker = document.createElement("div");
      picker.className = "title-info-season-picker";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "title-info-season-select";
      const options = document.createElement("div");
      options.className = "title-info-season-options";
      options.innerHTML = seasons
        .map((s) => `<div class="title-info-season-option" data-rating-key="${s.ratingKey}" tabindex="0">${this._ctx.escape(s.title || `Season ${s.index}`)}</div>`)
        .join("");
      picker.appendChild(trigger);
      picker.appendChild(options);
      const list = document.createElement("div");
      this._episodesEl.appendChild(picker);
      this._episodesEl.appendChild(list);

      const showSeason = async (seasonRatingKey, focusEpisodeRatingKey) => {
        list.innerHTML = '<div class="title-info-loading">Loading episodes…</div>';
        const epData = await this._ctx.plexFetch(`/library/metadata/${seasonRatingKey}/children`, { includeChapters: 1 });
        if (this._item?.ratingKey !== showRatingKey) return;
        const episodes = epData?.MediaContainer?.Metadata || [];
        const track = this._buildCardRow(
          list,
          episodes.map((ep) => episodeCardHtml(this._ctx, ep)).join("")
        );
        track.querySelectorAll(".title-info-episode").forEach((row) => {
          /* Delegates to _playEpisodeByRatingKey (same as the show-level Play button
             resuming into an episode) instead of building the play payload straight off
             `ep` - `ep` is this row's entry from the season's /children listing, and
             Plex list endpoints truncate/omit nested Media[].Part[].Stream[] data the
             same way they truncate Genre (see this repo's CLAUDE.md) - audioStreams/
             mediaVersions extracted from it here used to come back empty or partial for
             many episodes. _playEpisodeByRatingKey does a full single-item fetch first,
             which always carries complete Stream data. */
          row.addEventListener("click", async () => {
            const ep = episodes.find((e) => String(e.ratingKey) === row.dataset.ratingKey);
            if (!ep) return;
            await this._playEpisodeByRatingKey(ep.ratingKey);
          });
        });
        if (focusEpisodeRatingKey) {
          const row = track.querySelector(`[data-rating-key="${focusEpisodeRatingKey}"]`);
          if (row) {
            row.classList.add("current");
          }
        }
      };
      const selectSeason = (seasonRatingKey, focusEpisodeRatingKey) => {
        const season = seasons.find((s) => String(s.ratingKey) === String(seasonRatingKey));
        trigger.textContent = `${season ? season.title || `Season ${season.index}` : "Season"} ▾`;
        options.querySelectorAll(".title-info-season-option").forEach((opt) => {
          opt.classList.toggle("selected", opt.dataset.ratingKey === String(seasonRatingKey));
        });
        options.classList.remove("open");
        showSeason(seasonRatingKey, focusEpisodeRatingKey);
      };
      trigger.addEventListener("click", () => options.classList.toggle("open"));
      options.querySelectorAll(".title-info-season-option").forEach((opt) => {
        opt.addEventListener("click", () => {
          selectSeason(opt.dataset.ratingKey);
          focusAfterPaint(trigger);
        });
      });
      /* Opening a show from an episode (e.g. Continue Watching) requests landing on that
         episode's own season/row instead of always season 1 - see openForEpisode. */
      const focus = this._pendingEpisodeFocus;
      this._pendingEpisodeFocus = null;
      const focusSeason = focus && seasons.find((s) => String(s.ratingKey) === String(focus.seasonRatingKey));
      const initialSeasonKey = focusSeason ? focusSeason.ratingKey : seasons[0].ratingKey;
      selectSeason(initialSeasonKey, focusSeason ? focus.episodeRatingKey : null);
    } catch (e) {
      // episode list is supplementary; leave the rest of the modal usable on failure
    }
  }

  /* Collections/playlists are just a flat ordered list of full items (movies/shows,
     occasionally episodes for a playlist) rather than a show's season/episode tree, so
     there's no season <select> - clicking a row opens that item's own info (episodes
     redirect to their show via openForEpisode) instead of playing directly, since these
     rows aren't playable segments the way a show's episodes are. */
  _renderFlatItems(rawItems, ratingKey) {
    if (!rawItems.length || this._item?.ratingKey !== ratingKey) return;
    this._flatItems = rawItems;
    const track = this._buildCardRow(
      this._episodesEl,
      rawItems.map((m) => flatItemCardHtml(this._ctx, this._ctx.mapItem(m, true), m.summary)).join("")
    );
    track.querySelectorAll(".title-info-episode").forEach((row, i) => {
      row.addEventListener("click", () => {
        const mapped = this._ctx.mapItem(rawItems[i], false);
        /* Only movies/episodes are ever directly playable from this flat list (a show or
           collection row just opens its own info instead, per the comment above) - the
           queue context only matters, and is only kept, for the types the player could
           actually use it for. */
        const flatQueueContext =
          mapped.type === "movie" || mapped.type === "episode"
            ? { ratingKeys: rawItems.map((m) => m.ratingKey), index: i }
            : null;
        this.open(mapped, "local", { flatQueueContext });
      });
    });
  }

  async _loadCollectionItems(ratingKey) {
    try {
      const data = await this._ctx.plexFetch(`/library/collections/${ratingKey}/children`);
      this._renderFlatItems(data?.MediaContainer?.Metadata || [], ratingKey);
    } catch (e) {
      // item list is supplementary; leave the rest of the modal usable on failure
    }
  }

  async _loadPlaylistItems(ratingKey) {
    try {
      const data = await this._ctx.plexFetch(`/playlists/${ratingKey}/items`);
      this._renderFlatItems(data?.MediaContainer?.Metadata || [], ratingKey);
    } catch (e) {
      // item list is supplementary; leave the rest of the modal usable on failure
    }
  }

  async _loadSimilar(ratingKey) {
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${ratingKey}/related`);
      const seen = new Set();
      const items = (data?.MediaContainer?.Hub || [])
        .flatMap((h) => h.Metadata || [])
        .filter((m) => (seen.has(m.ratingKey) ? false : (seen.add(m.ratingKey), true)))
        .slice(0, 12);
      if (!items.length || this._item?.ratingKey !== ratingKey) return;
      this._similarWrap.hidden = false;
      this._similarEl.innerHTML = items
        .map((m) => {
          const mapped = this._ctx.mapItem(m, false);
          return `
          <div class="title-info-similar-item" data-rating-key="${mapped.ratingKey}" tabindex="0">
            <img loading="lazy" src="${this._ctx.escape(mapped.image)}" alt="" />
            <div class="t">${this._ctx.escape(mapped.title)}</div>
          </div>`;
        })
        .join("");
      this._similarEl.querySelectorAll(".title-info-similar-item").forEach((el, i) => {
        el.addEventListener("click", () => this.open(this._ctx.mapItem(items[i], false), "local"));
      });
      this._assignSimilarRowGroups();
    } catch (e) {
      // similar titles are supplementary; leave the rest of the modal usable on failure
    }
  }

  async _playCurrentItem({ restart = false } = {}) {
    if (this._resumeEpisodeKey) {
      return this._playEpisodeByRatingKey(this._resumeEpisodeKey, { restart });
    }
    const item = this._item;
    if (!item) return;
    /* Collections/playlists have no Media[] of their own - "Play" on one starts its
       first directly-playable child instead (movies/episodes; shows still require
       picking an episode), with the rest of the flat list attached as a queue so
       title-next/prev walks through it exactly like clicking each row by hand would. */
    if (item.type === "collection" || item.type === "playlist") {
      return this._playFirstFlatItem();
    }
    /* A show has no Media[] of its own either - this only runs when _resumeEpisodeKey
       wasn't already set above, i.e. the modal was opened directly off the show's own
       poster/row (browsing "TV Shows", search, etc.) rather than redirected here from an
       on-deck/continue-watching episode (see openForEpisode). Previously this fell
       straight through to onPlayItem(item, ...) with the show container itself as the
       "item" - not a playable thing on this server, so playback silently failed for any
       show whose modal wasn't opened via an episode. Plex has no per-show on-deck lookup
       (confirmed empirically - /library/metadata/<ratingKey>/onDeck 404s), so this pulls
       every episode via allLeaves and picks one with pickNextEpisode instead. */
    if (item.type === "show") {
      return this._playShow(item.ratingKey, { restart });
    }
    /* Always starts on the first Media[] entry with no cap - Version/Quality Cap are
       now an in-player "Video Quality" menu (see chrome.js's openVideoQualityMenu) fed
       by mediaVersions below, not a pre-play choice made here. */
    const mediaIndex = 0;
    /* Only attaches the flat playlist/collection queue captured on the row click that
       led here (see _renderFlatItems) when it still actually matches what's playing -
       reopening this same modal via some other route (e.g. a "More Like This" card) in
       between would otherwise leave a stale queue pointing at the wrong item. */
    const flat = this._flatQueueContext;
    const queue =
      flat && String(flat.ratingKeys[flat.index]) === String(item.ratingKey)
        ? { queueRatingKeys: flat.ratingKeys, queueIndex: flat.index }
        : {};
    await this._ctx.onPlayItem(item, {
      durationMs: this._duration,
      startOffsetMs: restart ? 0 : this._viewOffset,
      source: this._source,
      markers: this._markers,
      chapters: this._chapters,
      mediaIndex,
      mediaVersions: extractMediaVersions(this._media),
      audioStreams: extractAudioStreams(this._media, mediaIndex),
      isHdr: isHdrVideo(this._media, mediaIndex),
      subtitleTracks: extractSubtitleTracks(this._media, mediaIndex),
      bifIndexPath: bifIndexPath(this._media, mediaIndex),
      ...extractPartInfo(this._media, mediaIndex),
      ...queue,
    });
  }

  /* Resolves which episode a show's own top-level Play button should start on (see the
     _playCurrentItem branch above), then hands off to _playEpisodeByRatingKey exactly
     like clicking that episode's row in the season list would. Shares _getNextEpisode's
     cache with _loadShowResumeLabel below so the button's "Resume S# E#" label and what
     actually plays can never disagree about which episode is next. */
  async _playShow(showRatingKey, { restart = false } = {}) {
    const episode = await this._getNextEpisode(showRatingKey);
    if (!episode || this._item?.ratingKey !== showRatingKey) return;
    await this._playEpisodeByRatingKey(episode.ratingKey, { restart });
  }

  /* Cached per show for as long as this modal stays open on it (same pattern as
     _getShowEpisodeQueue) - _playShow and _loadShowResumeLabel both need "which episode
     is next", and a show's allLeaves listing doesn't change mid-session. */
  _getNextEpisode(showRatingKey) {
    if (this._nextEpisodeCache?.showRatingKey === showRatingKey) return this._nextEpisodeCache.promise;
    const promise = this._fetchNextEpisode(showRatingKey);
    this._nextEpisodeCache = { showRatingKey, promise };
    return promise;
  }

  async _fetchNextEpisode(showRatingKey) {
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${showRatingKey}/allLeaves`);
      const episodes = data?.MediaContainer?.Metadata || [];
      const ratingKey = pickNextEpisode(episodes);
      return episodes.find((ep) => String(ep.ratingKey) === String(ratingKey)) || null;
    } catch (e) {
      return null;
    }
  }

  /* A show's Play/Resume button only showed "Resume S# E#" (instead of a bare "Resume")
     when this modal was opened via an on-deck episode redirect (openForEpisode already
     knows the episode from the click that led here) - not when opened directly off the
     show's own poster/row, even though _playCurrentItem's show branch resolves and
     plays that exact same next episode either way. Resolves it here too, async (so it
     doesn't block the modal's initial paint) and only when there's some history to
     resume - a never-started show already correctly shows a bare "▶ Play" (see
     _updatePlayHistoryUI), which doesn't need a season/episode number. */
  async _loadShowResumeLabel(meta) {
    if (!hasAnyHistory(meta)) return;
    const showRatingKey = meta.ratingKey;
    const episode = await this._getNextEpisode(showRatingKey);
    if (!episode || this._item?.ratingKey !== showRatingKey) return;
    const resumeEpisode = episode.parentIndex != null && episode.index != null ? { season: episode.parentIndex, episode: episode.index } : null;
    this._updatePlayHistoryUI(true, resumeEpisode, false);
  }

  /* Full show-wide episode order (every season flattened, ratingKeys only) so the
     player's title-prev/title-next buttons can cross season boundaries, not just
     whichever single season _loadSeasons currently has fetched. Cached per show for as
     long as this modal stays open on that show, so clicking through several episodes in
     a row doesn't re-fetch every season's children on each Play press. */
  _getShowEpisodeQueue(showRatingKey) {
    if (this._episodeQueueCache?.showRatingKey === showRatingKey) return this._episodeQueueCache.promise;
    const promise = this._fetchShowEpisodeQueue(showRatingKey);
    this._episodeQueueCache = { showRatingKey, promise };
    return promise;
  }

  async _fetchShowEpisodeQueue(showRatingKey) {
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${showRatingKey}/children`);
      const seasons = (data?.MediaContainer?.Metadata || []).filter((s) => s.index != null);
      const perSeason = await Promise.all(seasons.map((s) => this._ctx.plexFetch(`/library/metadata/${s.ratingKey}/children`)));
      return perSeason.flatMap((d) => d?.MediaContainer?.Metadata || []).map((ep) => ep.ratingKey);
    } catch (e) {
      return [];
    }
  }

  /* Fetches the episode's own fresh duration/viewOffset (the show-level modal's
     _duration/_viewOffset are always null/0 - shows don't carry those fields) so
     resuming from the show modal's Play button seeks to the right spot. */
  async _playEpisodeByRatingKey(ratingKey, { restart = false } = {}) {
    const showRatingKey = this._item?.ratingKey;
    try {
      const [data, queueRatingKeys] = await Promise.all([
        this._ctx.plexFetch(`/library/metadata/${ratingKey}`, { includeChapters: 1, includeMarkers: 1 }),
        showRatingKey ? this._getShowEpisodeQueue(showRatingKey) : Promise.resolve([]),
      ]);
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (!meta) return;
      const queueIndex = queueRatingKeys.findIndex((k) => String(k) === String(meta.ratingKey));
      await this._ctx.onPlayItem(this._ctx.mapItem(meta, true), {
        durationMs: meta.duration || null,
        startOffsetMs: restart ? 0 : meta.viewOffset || 0,
        source: "local",
        markers: meta.Marker || [],
        chapters: meta.Chapter || [],
        mediaVersions: extractMediaVersions(meta.Media),
        audioStreams: extractAudioStreams(meta.Media, 0),
        isHdr: isHdrVideo(meta.Media, 0),
        subtitleTracks: extractSubtitleTracks(meta.Media, 0),
        bifIndexPath: bifIndexPath(meta.Media, 0),
        ...extractPartInfo(meta.Media, 0),
        ...(queueIndex >= 0 ? { queueRatingKeys, queueIndex } : {}),
      });
    } catch (e) {
      // best-effort - Play simply won't respond if this fails
    }
  }

  /* Mirrors _playEpisodeByRatingKey's approach for a collection/playlist's own Play
     button: the flat children list rendered by _renderFlatItems is already ordered and
     cached in _flatItems, so this picks the first entry that's actually a directly-
     playable type (a collection of shows, e.g., has none - that's a no-op, same as a
     collection with no children) and fetches its full metadata for duration/markers/
     chapters/audio before handing off, same as any other direct play. */
  async _playFirstFlatItem() {
    const ratingKey = this._item?.ratingKey;
    const rawItems = this._flatItems || [];
    const index = rawItems.findIndex((m) => {
      const mapped = this._ctx.mapItem(m, false);
      return mapped.type === "movie" || mapped.type === "episode";
    });
    if (index < 0) return;
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${rawItems[index].ratingKey}`, { includeChapters: 1, includeMarkers: 1 });
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (!meta || this._item?.ratingKey !== ratingKey) return;
      await this._ctx.onPlayItem(this._ctx.mapItem(meta, true), {
        durationMs: meta.duration || null,
        startOffsetMs: meta.viewOffset || 0,
        source: this._source,
        markers: meta.Marker || [],
        chapters: meta.Chapter || [],
        mediaVersions: extractMediaVersions(meta.Media),
        audioStreams: extractAudioStreams(meta.Media, 0),
        isHdr: isHdrVideo(meta.Media, 0),
        subtitleTracks: extractSubtitleTracks(meta.Media, 0),
        bifIndexPath: bifIndexPath(meta.Media, 0),
        ...extractPartInfo(meta.Media, 0),
        queueRatingKeys: rawItems.map((m) => m.ratingKey),
        queueIndex: index,
      });
    } catch (e) {
      // best-effort - Play simply won't respond if this fails
    }
  }

  /* Plex's own "mark unwatched" action (/:/unscrobble) - the same GET-with-query-token
     shape plexFetch already uses for reads, since Plex's scrobble endpoints take no body.
     Targets the resumed episode's own ratingKey when this modal stands in for one (see
     openForEpisode) rather than the show container's, since that's the item that
     actually carries the watch history being cleared. */
  async _markUnwatched() {
    const item = this._item;
    const ratingKey = this._resumeEpisodeKey || item?.ratingKey;
    if (!ratingKey || this._watchedBtn.dataset.busy) return;
    this._watchedBtn.dataset.busy = "1";
    this._watchedBtn.classList.add("busy");
    try {
      await this._ctx.plexFetch("/:/unscrobble", { key: ratingKey, identifier: "com.plexapp.plugins.library" });
      this._viewOffset = 0;
      this._viewCount = 0;
      this._progressEl.hidden = true;
      this._progressBar.style.width = "0%";
      this._updatePlayHistoryUI(false);
      this._updateWatchedUI(false);
      /* Clearing history here can drop this item out of Continue Watching, and - when
         this modal stands in for a resumed episode - can flip its show's own poster
         badge from "Watched" back off (unwatching any one episode makes "every episode
         watched" false, so no extra fetch is needed to know the show's new state is
         false). Both rows/posters live on the card, not this controller, so they're
         refreshed via the same collaborator the card passes in rather than this
         reaching into card state. */
      this._ctx.onPlayHistoryMutated?.(item?.ratingKey, false);
    } catch (e) {
      this._watchedBtn.classList.add("error");
      setTimeout(() => this._watchedBtn.classList.remove("error"), 1500);
    } finally {
      this._watchedBtn.classList.remove("busy");
      delete this._watchedBtn.dataset.busy;
    }
  }

  /* Plex's own "mark watched" action (/:/scrobble) - the mirror image of
     _markUnwatched above, same endpoint shape and same resumed-episode ratingKey
     targeting. Unlike unwatching (which always makes "the whole show watched" false),
     watching one more episode might or might not newly complete the whole show - so the
     show's own poster badge needs a real refetch of the show's viewedLeafCount/leafCount
     rather than assuming true, same as _refreshAfterPlayback does. */
  async _markWatched() {
    const item = this._item;
    const showRatingKey = this._resumeEpisodeKey ? item?.ratingKey : null;
    const ratingKey = this._resumeEpisodeKey || item?.ratingKey;
    if (!ratingKey || this._watchedBtn.dataset.busy) return;
    this._watchedBtn.dataset.busy = "1";
    this._watchedBtn.classList.add("busy");
    try {
      await this._ctx.plexFetch("/:/scrobble", { key: ratingKey, identifier: "com.plexapp.plugins.library" });
      this._viewOffset = 0;
      this._progressEl.hidden = true;
      this._progressBar.style.width = "0%";
      /* Scrobbling clears the resume offset (this._viewOffset above) - Restart has
         nothing left to discard, so hasProgress is explicitly false here even though
         hasHistory is true (see hasProgress's own comment for why those differ). */
      this._updatePlayHistoryUI(true, null, false);
      this._updateWatchedUI(true);
      if (showRatingKey) {
        const showData = await this._ctx.plexFetch(`/library/metadata/${showRatingKey}`);
        const showMeta = showData?.MediaContainer?.Metadata?.[0];
        this._ctx.onPlayHistoryMutated?.(showRatingKey, showMeta ? isFullyWatched(showMeta) : true);
      } else {
        this._ctx.onPlayHistoryMutated?.(item?.ratingKey, true);
      }
    } catch (e) {
      this._watchedBtn.classList.add("error");
      setTimeout(() => this._watchedBtn.classList.remove("error"), 1500);
    } finally {
      this._watchedBtn.classList.remove("busy");
      delete this._watchedBtn.dataset.busy;
    }
  }

  /* This modal stays open (behind the full-screen player) for as long as playback runs -
     nothing closes it when Play/Resume/Restart hands off to plex-player.js. Without this,
     its own timeline/Play-Resume-Restart state stays frozen at whatever it was when
     playback started, stale until the modal is closed and reopened. Re-fetches whichever
     ratingKey this modal actually stands in for (the resumed episode, if any - see
     openForEpisode) rather than assuming it's still the top-level item. */
  async _refreshAfterPlayback() {
    if (!this.isOpen()) return;
    const showRatingKey = this._resumeEpisodeKey ? this._item?.ratingKey : null;
    const ratingKey = this._resumeEpisodeKey || this._item?.ratingKey;
    if (!ratingKey) return;
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${ratingKey}`);
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (!meta || (this._resumeEpisodeKey || this._item?.ratingKey) !== ratingKey) return;
      this._viewOffset = meta.viewOffset || 0;
      this._viewCount = meta.viewCount || 0;
      const progress = meta.duration ? Math.max(0, Math.min(1, this._viewOffset / meta.duration)) : 0;
      this._progressEl.hidden = progress <= 0;
      this._progressBar.style.width = `${Math.round(progress * 100)}%`;
      const resumeEpisode = this._resumeEpisodeKey && meta.parentIndex != null && meta.index != null ? { season: meta.parentIndex, episode: meta.index } : null;
      this._updatePlayHistoryUI(hasAnyHistory(meta), resumeEpisode, hasProgress(meta));
      /* The watched button targets this same ratingKey (see _markWatched/_markUnwatched),
         so this same meta fetch is exactly the right source for its state too. */
      if (!this._watchedBtn.hidden) this._updateWatchedUI(isFullyWatched(meta));
      /* A poster's "Watched" badge belongs to the container shown in rows (a show's own
         poster), not to the leaf episode ratingKey just fetched above - watching more of
         one episode can newly complete the whole show, which needs the show's own
         viewedLeafCount/leafCount, not this episode's. */
      if (showRatingKey) {
        const showData = await this._ctx.plexFetch(`/library/metadata/${showRatingKey}`);
        const showMeta = showData?.MediaContainer?.Metadata?.[0];
        if (showMeta) this._ctx.onPlayHistoryMutated?.(showRatingKey, isFullyWatched(showMeta));
      } else {
        this._ctx.onPlayHistoryMutated?.(ratingKey, isFullyWatched(meta));
      }
    } catch (e) {
      // best-effort - the modal just keeps showing its pre-playback state on failure
    }
  }

  /* .title-info-similar lays out via CSS grid (auto-fill columns, see title-info.css) rather
     than a fixed column count, so which items share a visual row can only be known from
     actual layout, not computed up front. Grouping same-row items under a shared
     data-nav-group value is what lets wireLinearNav's own Left/Right-within-group and
     positional Up/Down-across-group logic (see focus-nav.js's moveWithinGroup/
     moveAcrossGroup) treat this grid as an actual 2D grid instead of one long vertical
     list - without this, every item just sits in the flat list unGrouped, and Up/Down
     visits them one at a time in DOM order regardless of which column they're actually in. */
  _assignSimilarRowGroups() {
    const items = Array.from(this._similarEl.querySelectorAll(".title-info-similar-item"));
    if (!items.length) return;
    let rowTop = null;
    let rowIndex = -1;
    items.forEach((el) => {
      if (rowTop === null || Math.abs(el.offsetTop - rowTop) > 2) {
        rowIndex++;
        rowTop = el.offsetTop;
      }
      el.dataset.navGroup = `similar-row-${rowIndex}`;
    });
  }

  /* Shared by both _loadSeasons' showSeason (one season's episodes) and _renderFlatItems
     (a collection/playlist's flat item list) - both want the same horizontally-scrolling
     card row the in-player episode list uses (src/player/ui/episode-list.js), just built
     as an innerHTML string here rather than that file's DOM-factory calls, matching how
     every other list in this modal already renders. `wrapEl` becomes the row's own
     position:relative anchor for the fade-edge scroll arrows - the season case passes
     `list` (a dedicated child of .title-info-episodes, sitting below the season picker);
     the collection/playlist case, with no picker to sit below, passes .title-info-episodes
     itself. One shared data-nav-group ("title-info-episodes") is safe for both since only
     one of these two callers is ever active for a given item - a show has seasons, a
     collection/playlist has a flat list, never both at once. */
  _buildCardRow(wrapEl, itemsHtml) {
    wrapEl.classList.add("title-info-row-wrap");
    wrapEl.innerHTML = `<div class="title-info-row-scroller"><div class="title-info-row-track">${itemsHtml}</div></div>`;
    const scroller = wrapEl.querySelector(".title-info-row-scroller");
    const track = wrapEl.querySelector(".title-info-row-track");
    const rowScroll = createRowScroll(scroller, track);
    const leftArrow = buildEpisodeRowArrow("left", scroller, rowScroll);
    const rightArrow = buildEpisodeRowArrow("right", scroller, rowScroll);
    wrapEl.insertBefore(leftArrow, scroller);
    wrapEl.appendChild(rightArrow);
    wireArrowVisibility(rowScroll, leftArrow, rightArrow);
    /* Desktop-only grouping (mobile reflows these same cards into a stacked vertical list
       instead, where Up/Down should step through them one at a time) - see
       syncEpisodesNavGroup's own comment in _wire for why this is a shared, persistent
       function rather than a one-off assignment here. */
    this._syncEpisodesNavGroup();
    /* wireLinearNav's own focusItem centers the newly-focused card along the page's real
       (vertical) scroll axis via a native scrollIntoView - it can't also bring the card
       into view along this row's own horizontal axis, since `scroller` clips via
       overflow:hidden rather than a real overflow:auto (see row-scroll.js's own header
       comment for why: Xbox WebView2's gamepad-to-scroll handling would otherwise hijack a
       real scroll container out from under this row's D-pad centering). Same pattern the
       player's own openEpisodeListOverlay uses for its identical card row. */
    track.addEventListener("focusin", (e) => {
      const card = e.target.closest(".title-info-episode");
      if (card) rowScroll.scrollIntoView(card, { inline: "center", animate: true });
    });
    return track;
  }

  _wire() {
    /* Recomputes which items land in which visual row whenever the grid's own width
       changes (window resize, or the responsive layout swapping breakpoints) - the
       auto-fill column count is purely width-driven, so a stale grouping from before a
       resize would misreport which items are actually side-by-side. */
    new ResizeObserver(() => this._assignSimilarRowGroups()).observe(this._similarEl);

    /* The player is a full-screen overlay on top of this modal, not a replacement for it -
       closing it leaves document.activeElement pointing at whatever the player itself last
       focused (now torn down), so D-pad/gamepad nav silently stops responding to anything
       until a click forces focus somewhere new. Landing back on Play/Resume mirrors what
       open() already does for a freshly-opened modal (_nav.focusFirst() above). */
    window.addEventListener("streaming-player-close", () => {
      this._refreshAfterPlayback();
      if (this.isOpen() && isControllerActive()) focusAfterPaint(this._playBtn);
    });
    this._closeBtn.addEventListener("click", () => this.close());
    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this.close();
    });
    this._nav = wireLinearNav(
      this._shadowRoot,
      ".title-info-close, .title-info-play, .title-info-restart-btn, .title-info-watched-btn, .title-info-watchlist-btn, .title-info-season-select, .title-info-season-option, .title-info-episode, .title-info-cast-wrap, .title-info-similar-item",
      { orientation: "vertical", onBack: () => this.close() }
    );
    /* Play/Restart/Watched/Watchlist visually sit in one horizontal row (.title-info-actions,
       see title-info.css) except on mobile (responsive.css wraps them to one full-width button
       per line instead) - grouping them via data-nav-group (see wireLinearNav) only on the
       desktop layout makes Left/Right cycle across the row there, while Up/Down still steps
       through them one at a time on mobile where they're actually stacked. Same 700px cutoff
       responsive.css itself uses. */
    const desktopActionsQuery = window.matchMedia("(min-width: 701px)");
    const syncActionsNavGroup = () => {
      [this._playBtn, this._restartBtn, this._watchedBtn, this._watchlistBtn].forEach((el) => {
        if (desktopActionsQuery.matches) el.dataset.navGroup = "title-info-actions";
        else delete el.dataset.navGroup;
      });
    };
    syncActionsNavGroup();
    desktopActionsQuery.addEventListener("change", syncActionsNavGroup);
    /* Same reasoning as syncActionsNavGroup just above, for the episode/collection card row
       instead of the actions row - desktop's cards sit in one actual horizontal row
       (title-info.css), so grouping them makes Left/Right cycle across it and Up/Down treat
       it as a single stop; mobile's own CSS (responsive.css) reflows the exact same cards
       into a stacked vertical list instead, where a shared group would wrongly make Up/Down
       skip over all of them at once rather than stepping through one at a time - the bug this
       fixes. Reuses desktopActionsQuery rather than a second matchMedia for the same 701px
       cutoff. Queried fresh from the shadow root (not a fixed element list, unlike
       syncActionsNavGroup's four static buttons) since _buildCardRow replaces these cards
       outright on every season switch/reopen - stored on `this` so _buildCardRow can re-run
       it right after building a fresh batch without this file needing a second matchMedia
       listener alongside this one. */
    const syncEpisodesNavGroup = () => {
      this._shadowRoot.querySelectorAll(".title-info-episode").forEach((el) => {
        if (desktopActionsQuery.matches) el.dataset.navGroup = "title-info-episodes";
        else delete el.dataset.navGroup;
      });
    };
    this._syncEpisodesNavGroup = syncEpisodesNavGroup;
    desktopActionsQuery.addEventListener("change", syncEpisodesNavGroup);
    this._watchlistBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = this._item;
      if (!item) return;
      if (this._watchlistBtn.classList.contains("added")) {
        this._ctx.onRemoveFromWatchlist(item, this._watchlistBtn);
      } else {
        this._ctx.onAddToWatchlist(item, this._watchlistBtn);
      }
    });
    this._watchlistBtn.addEventListener("mouseenter", () => {
      if (this._watchlistBtn.classList.contains("added")) this._watchlistBtn.textContent = "−";
    });
    this._watchlistBtn.addEventListener("mouseleave", () => {
      if (this._watchlistBtn.classList.contains("added")) this._watchlistBtn.textContent = "✓";
    });
    this._playBtn.addEventListener("click", () => this._playCurrentItem());
    this._restartBtn.addEventListener("click", () => this._playCurrentItem({ restart: true }));
    this._watchedBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._watched) this._markUnwatched();
      else this._markWatched();
    });
  }
}
