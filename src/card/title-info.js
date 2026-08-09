import { wireLinearNav, registerNavHandler } from "../../focus-nav.js";
import { lockScroll, unlockScroll } from "../../scroll-lock.js";
import { paintWatchlistButton } from "./watchlist.js";
import { WATCHED_ICON_SVG } from "./rows.js";
import { PROFILE_ICON_SVG } from "./profile.js";

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

export function formatRuntime(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
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

/* The title-info detail overlay: cast/seasons-episodes/collection-playlist items/
   similar titles, plus the Play/Restart/mark-unwatched/watchlist actions. Version and
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
    this._unwatchBtn = shadowRoot.querySelector(".title-info-unwatch-btn");
    this._watchlistBtn = shadowRoot.querySelector(".title-info-watchlist-btn");
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
    this._markers = [];
    this._chapters = [];
    this._media = [];
    this._flatItems = null;
    this._pendingEpisodeFocus = null;
    this._resumeEpisodeKey = null;
    this._flatQueueContext = null;
    this._episodeQueueCache = null;

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

  /* Play/Resume + the Restart/mark-unwatched pair share one on/off switch - "has this
     been started or finished before" - rather than three separately-derived booleans
     that could drift out of sync with each other. resumeEpisode ({season, episode}) is
     only known when this modal stands in for a specific episode (see openForEpisode) -
     a show opened directly has no single episode to name, so it keeps the plain label. */
  _updatePlayHistoryUI(hasHistory, resumeEpisode = null) {
    const resumeLabel = resumeEpisode ? `▶ Resume S${resumeEpisode.season} E${resumeEpisode.episode}` : "▶ Resume";
    this._playBtn.textContent = hasHistory ? resumeLabel : "▶ Play";
    this._restartBtn.hidden = !hasHistory;
    this._unwatchBtn.hidden = !hasHistory;
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
      this._updatePlayHistoryUI(!!(item.progress > 0 || item.hasHistory), resumeEpisode);
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
    this._updatePlayHistoryUI(!!(item.progress > 0 || item.hasHistory));
    const art = item.art || item.image || "";
    this._artEl.style.backgroundImage = art ? `url('${art}')` : "none";
    this._modal.style.setProperty("--title-info-bg", art ? `url('${art}')` : "none");
    this._titleEl.textContent = item.title || "";
    this._metaEl.innerHTML = item.subtitle ? `<span>${this._ctx.escape(item.subtitle)}</span>` : "";
    this._summaryEl.textContent = "";
    this._episodesEl.innerHTML = "";
    this._castWrap.hidden = true;
    this._castEl.innerHTML = "";
    this._similarWrap.hidden = true;
    this._similarEl.innerHTML = "";
    const canWatchlist = item.type === "movie" || item.type === "show";
    this._watchlistBtn.hidden = !canWatchlist;
    if (canWatchlist) {
      paintWatchlistButton(this._watchlistBtn, this._ctx.isInWatchlist(item));
    }
    /* Re-opening for a different item (e.g. clicking a "More Like This" card) while
       already open must not lock scroll a second time - only the matching close() call
       unlocks it once, so a second lock here would leave the counter permanently off by
       one. */
    if (!this.isOpen()) lockScroll();
    this._overlay.classList.add("open");
    /* Focusing the overlay shell itself (tabindex="-1", just so a click outside it can
       still blur out of whatever was focused before) would leave document.activeElement
       pointing at an element wireLinearNav's own selector never matches - every D-pad
       command then falls straight through as unhandled, since registerNavHandler's
       handler here only acts when the active element is one of its own watched items.
       focusFirst() lands on the actual first nav target (.title-info-close) instead. */
    this._nav.focusFirst();

    let ratingKey = item.ratingKey;
    if (source === "watchlist") {
      ratingKey = await this._ctx.resolveLocalRatingKey(item);
      if (this._item !== item) return;
      /* Swap the item's Discover-scoped ratingKey for the resolved local one so
         downstream staleness checks (_loadSimilar/_loadSeasons compare against
         this._item.ratingKey) and Play's native playback request both key off the ID
         that actually exists on this server. */
      item.ratingKey = ratingKey;
    }
    if (!ratingKey) return;
    /* Playlists aren't part of library metadata (see the card's _fetchPlaylistsRaw) -
       their detail lives under /playlists/{ratingKey}, not /library/metadata/{ratingKey}
       like every other item type here. */
    const metaPath = item.type === "playlist" ? `/playlists/${ratingKey}` : `/library/metadata/${ratingKey}`;
    try {
      const data = await this._ctx.plexFetch(metaPath, { includeChapters: 1 });
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (meta && this._item === item) this._renderDetail(meta);
    } catch (e) {
      // detail is best-effort - the poster/title painted above stays usable on failure
    }
  }

  _renderDetail(meta) {
    this._duration = meta.duration || null;
    this._viewOffset = meta.viewOffset || 0;
    this._viewCount = meta.viewCount || 0;
    this._markers = meta.Marker || [];
    this._chapters = meta.Chapter || [];
    this._media = meta.Media || [];
    this._updatePlayHistoryUI(hasAnyHistory(meta));
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
          ? `<img src="${this._ctx.escape(this._ctx.plexImageUrl(r.thumb))}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
             <div class="title-info-cast-avatar-fallback" style="display:none">${PROFILE_ICON_SVG}</div>`
          : fallback;
        const role = r.role ? `<div class="title-info-cast-role">${this._ctx.escape(r.role)}</div>` : "";
        return `<div class="title-info-cast-chip"><div class="title-info-cast-avatar">${avatar}</div><div class="title-info-cast-name">${this._ctx.escape(r.tag)}</div>${role}</div>`;
      })
      .join("");

    if (meta.type === "show") this._loadSeasons(meta.ratingKey);
    else if (meta.type === "collection") this._loadCollectionItems(meta.ratingKey);
    else if (meta.type === "playlist") this._loadPlaylistItems(meta.ratingKey);
    this._loadSimilar(meta.ratingKey);
  }

  async _loadSeasons(showRatingKey) {
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${showRatingKey}/children`);
      const seasons = (data?.MediaContainer?.Metadata || []).filter((s) => s.index != null);
      if (!seasons.length || this._item?.ratingKey !== showRatingKey) return;

      this._episodesEl.innerHTML = "";
      const select = document.createElement("select");
      select.className = "title-info-season-select";
      select.innerHTML = seasons
        .map((s) => `<option value="${s.ratingKey}">${this._ctx.escape(s.title || `Season ${s.index}`)}</option>`)
        .join("");
      const list = document.createElement("div");
      this._episodesEl.appendChild(select);
      this._episodesEl.appendChild(list);

      const showSeason = async (seasonRatingKey, focusEpisodeRatingKey) => {
        list.innerHTML = '<div class="title-info-loading">Loading episodes…</div>';
        const epData = await this._ctx.plexFetch(`/library/metadata/${seasonRatingKey}/children`, { includeChapters: 1 });
        if (this._item?.ratingKey !== showRatingKey) return;
        const episodes = epData?.MediaContainer?.Metadata || [];
        list.innerHTML = episodes
          .map((ep) => {
            const progress = ep.duration ? Math.max(0, Math.min(1, (ep.viewOffset || 0) / ep.duration)) : 0;
            const watched = !!ep.viewCount && progress <= 0;
            return `
          <div class="title-info-episode" data-rating-key="${ep.ratingKey}">
            <div class="title-info-episode-thumb">
              <img loading="lazy" src="${this._ctx.escape(this._ctx.plexImageUrl(ep.thumb))}" alt="" />
              ${watched ? `<div class="title-info-episode-watched">${WATCHED_ICON_SVG}</div>` : ""}
              ${
                progress > 0
                  ? `<div class="title-info-episode-progress"><div class="bar" style="width:${Math.round(progress * 100)}%"></div></div>`
                  : ""
              }
              <div class="title-info-episode-play"><div class="title-info-episode-play-icon">▶</div></div>
            </div>
            <div>
              <div class="title-info-episode-title">${ep.index}. ${this._ctx.escape(ep.title)}</div>
              <div class="title-info-episode-summary">${this._ctx.escape(ep.summary || "")}</div>
            </div>
          </div>`;
          })
          .join("");
        list.querySelectorAll(".title-info-episode").forEach((row) => {
          row.addEventListener("click", async () => {
            const ep = episodes.find((e) => String(e.ratingKey) === row.dataset.ratingKey);
            if (!ep) return;
            const queueRatingKeys = await this._getShowEpisodeQueue(showRatingKey);
            const queueIndex = queueRatingKeys.findIndex((k) => String(k) === String(ep.ratingKey));
            this._ctx.onPlayItem(this._ctx.mapItem(ep, true), {
              durationMs: ep.duration || null,
              startOffsetMs: ep.viewOffset || 0,
              source: "local",
              markers: ep.Marker || [],
              chapters: ep.Chapter || [],
              audioStreams: extractAudioStreams(ep.Media, 0),
              bifIndexPath: bifIndexPath(ep.Media, 0),
              ...(queueIndex >= 0 ? { queueRatingKeys, queueIndex } : {}),
            });
          });
        });
        if (focusEpisodeRatingKey) {
          const row = list.querySelector(`[data-rating-key="${focusEpisodeRatingKey}"]`);
          if (row) {
            row.classList.add("current");
          }
        }
      };
      select.addEventListener("change", () => showSeason(select.value));
      /* Opening a show from an episode (e.g. Continue Watching) requests landing on that
         episode's own season/row instead of always season 1 - see openForEpisode. */
      const focus = this._pendingEpisodeFocus;
      this._pendingEpisodeFocus = null;
      const focusSeason = focus && seasons.find((s) => String(s.ratingKey) === String(focus.seasonRatingKey));
      const initialSeasonKey = focusSeason ? focusSeason.ratingKey : seasons[0].ratingKey;
      select.value = initialSeasonKey;
      showSeason(initialSeasonKey, focusSeason ? focus.episodeRatingKey : null);
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
    this._episodesEl.innerHTML = rawItems
      .map((m) => {
        const mapped = this._ctx.mapItem(m, true);
        const watched = mapped.watched && !(mapped.progress > 0);
        return `
      <div class="title-info-episode" data-rating-key="${mapped.ratingKey}">
        <div class="title-info-episode-thumb">
          <img loading="lazy" src="${this._ctx.escape(mapped.art || mapped.image)}" alt="" />
          ${watched ? `<div class="title-info-episode-watched">${WATCHED_ICON_SVG}</div>` : ""}
          ${
            mapped.progress > 0
              ? `<div class="title-info-episode-progress"><div class="bar" style="width:${Math.round(mapped.progress * 100)}%"></div></div>`
              : ""
          }
        </div>
        <div>
          <div class="title-info-episode-title">${this._ctx.escape(mapped.title)}</div>
          <div class="title-info-episode-summary">${this._ctx.escape(m.summary || "")}</div>
        </div>
      </div>`;
      })
      .join("");
    this._episodesEl.querySelectorAll(".title-info-episode").forEach((row, i) => {
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
      const items = (data?.MediaContainer?.Hub || []).flatMap((h) => h.Metadata || []).slice(0, 12);
      if (!items.length || this._item?.ratingKey !== ratingKey) return;
      this._similarWrap.hidden = false;
      this._similarEl.innerHTML = items
        .map((m) => {
          const mapped = this._ctx.mapItem(m, false);
          return `
          <div class="title-info-similar-item" data-rating-key="${mapped.ratingKey}">
            <img loading="lazy" src="${this._ctx.escape(mapped.image)}" alt="" />
            <div class="t">${this._ctx.escape(mapped.title)}</div>
          </div>`;
        })
        .join("");
      this._similarEl.querySelectorAll(".title-info-similar-item").forEach((el, i) => {
        el.addEventListener("click", () => this.open(this._ctx.mapItem(items[i], false), "local"));
      });
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
      bifIndexPath: bifIndexPath(this._media, mediaIndex),
      ...queue,
    });
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
        this._ctx.plexFetch(`/library/metadata/${ratingKey}`, { includeChapters: 1 }),
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
        bifIndexPath: bifIndexPath(meta.Media, 0),
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
      const data = await this._ctx.plexFetch(`/library/metadata/${rawItems[index].ratingKey}`, { includeChapters: 1 });
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
        bifIndexPath: bifIndexPath(meta.Media, 0),
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
    if (!ratingKey || this._unwatchBtn.dataset.busy) return;
    this._unwatchBtn.dataset.busy = "1";
    this._unwatchBtn.classList.add("busy");
    try {
      await this._ctx.plexFetch("/:/unscrobble", { key: ratingKey, identifier: "com.plexapp.plugins.library" });
      this._viewOffset = 0;
      this._viewCount = 0;
      this._progressEl.hidden = true;
      this._progressBar.style.width = "0%";
      this._updatePlayHistoryUI(false);
      /* Clearing history here can drop this item out of Continue Watching, and - when
         this modal stands in for a resumed episode - can flip its show's own poster
         badge from "Watched" back off (unwatching any one episode makes "every episode
         watched" false, so no extra fetch is needed to know the show's new state is
         false). Both rows/posters live on the card, not this controller, so they're
         refreshed via the same collaborator the card passes in rather than this
         reaching into card state. */
      this._ctx.onPlayHistoryMutated?.(item?.ratingKey, false);
    } catch (e) {
      this._unwatchBtn.classList.add("error");
      setTimeout(() => this._unwatchBtn.classList.remove("error"), 1500);
    } finally {
      this._unwatchBtn.classList.remove("busy");
      delete this._unwatchBtn.dataset.busy;
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
      this._updatePlayHistoryUI(hasAnyHistory(meta), resumeEpisode);
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

  _wire() {
    window.addEventListener("streaming-player-close", () => this._refreshAfterPlayback());
    this._closeBtn.addEventListener("click", () => this.close());
    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this.close();
    });
    this._nav = wireLinearNav(
      this._shadowRoot,
      ".title-info-close, .title-info-play, .title-info-restart-btn, .title-info-unwatch-btn, .title-info-watchlist-btn, .title-info-season-select, .title-info-episode, .title-info-similar-item",
      { orientation: "vertical", onBack: () => this.close() }
    );
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
    this._unwatchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._markUnwatched();
    });
  }
}
