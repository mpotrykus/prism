import { wireLinearNav, registerNavHandler, focusAfterPaint } from "../../focus-nav.js";
import { paintWatchlistButton } from "./watchlist.js";
import { WATCHED_ICON_SVG } from "./rows.js";
import { PROFILE_ICON_SVG } from "./profile.js";

/* kbps: null means "no cap" (Original) - matched against the selected quality cap by
   identity in _renderQualityPicker, so keep it null rather than 0 or a sentinel number. */
const QUALITY_CAP_PRESETS = [
  { label: "Original", kbps: null },
  { label: "1080p (20 Mbps)", kbps: 20000 },
  { label: "720p (10 Mbps)", kbps: 10000 },
  { label: "480p (4 Mbps)", kbps: 4000 },
  { label: "360p (2 Mbps)", kbps: 2000 },
];

/* Plex's Media[].Part[].Stream[] carries every stream on a version (video/audio/
   subtitle, distinguished by streamType - 2 is audio). Only surfaced for the player's
   Audio Track menu, which stays hidden entirely when there's nothing to switch between
   (see plex-player.js's _openHamburgerMenu), so an item with only one audio stream (or
   no Stream data at all) just yields an empty list here rather than an error. */
function extractAudioStreams(media, mediaIndex) {
  const streams = media?.[mediaIndex]?.Part?.[0]?.Stream || [];
  return streams
    .filter((s) => s.streamType === 2)
    .map((s) => ({
      id: s.id,
      label: s.extendedDisplayTitle || s.displayTitle || s.languageCode || "Unknown",
      selected: !!s.selected,
    }));
}

/* Plex's Media[].Part[].Indexes carries the BIF trickplay index path (used for the
   player's scrub-preview thumbnail, see src/player/core/bif.js) when one's been
   generated for this part - same per-version/per-part shape as extractAudioStreams
   above, since a multi-version item could have generated one for some versions and not
   others. */
function bifIndexPath(media, mediaIndex) {
  const part = media?.[mediaIndex]?.Part?.[0];
  /* Plex's JSON conversion lowercases XML attributes but keeps child-element names
     capitalized as authored (Chapter/Marker/Stream/Media) - "indexes" is an attribute
     on Part, hence the lowercase i here despite every neighboring field being
     capitalized. Confirmed against a real response, not assumed - a PowerShell check
     of this same field is case-insensitive and would silently pass either way. */
  return part?.indexes ? `/library/parts/${part.id}/indexes/sd` : null;
}

function formatRuntime(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/* The title-info detail overlay (cast/seasons-episodes/collection-playlist items/
   similar titles) and the quality picker nested inside it - kept as one controller
   since the quality picker reads/writes the currently-open title's own media list and
   selected version/quality-cap state directly, not through any separate interface.
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
    this._watchlistBtn = shadowRoot.querySelector(".title-info-watchlist-btn");
    this._qualityBtn = shadowRoot.querySelector(".title-info-quality-btn");
    this._summaryEl = shadowRoot.querySelector(".title-info-summary");
    this._episodesEl = shadowRoot.querySelector(".title-info-episodes");
    this._castWrap = shadowRoot.querySelector(".title-info-cast-wrap");
    this._castEl = shadowRoot.querySelector(".title-info-cast");
    this._similarWrap = shadowRoot.querySelector(".title-info-similar-wrap");
    this._similarEl = shadowRoot.querySelector(".title-info-similar");

    this._qualityOverlay = shadowRoot.querySelector(".quality-picker-overlay");
    this._qualityVersionsEl = shadowRoot.querySelector(".quality-picker-versions");
    this._qualityCapsEl = shadowRoot.querySelector(".quality-picker-caps");
    this._qualityDoneBtn = shadowRoot.querySelector(".quality-picker-done");

    this._item = null;
    this._source = null;
    this._duration = null;
    this._viewOffset = 0;
    this._markers = [];
    this._chapters = [];
    this._media = [];
    this._selectedMediaIndex = 0;
    this._qualityCapKbps = null;
    this._pendingEpisodeFocus = null;
    this._resumeEpisodeKey = null;

    this._wire();
  }

  get item() {
    return this._item;
  }

  isOpen() {
    return this._overlay.classList.contains("open");
  }

  isQualityPickerOpen() {
    return this._qualityOverlay.classList.contains("open");
  }

  close() {
    this._overlay.classList.remove("open");
    this._item = null;
  }

  closeQualityPicker() {
    this._qualityOverlay.classList.remove("open");
  }

  openQualityPicker() {
    this._renderQualityPicker();
    this._qualityOverlay.classList.add("open");
    focusAfterPaint(this._qualityDoneBtn);
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
    if (this._item === showItem) this._resumeEpisodeKey = item.ratingKey;
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
  async open(item, source) {
    if (item.type === "episode" && item.showKey) {
      return this.openForEpisode(item, source);
    }
    this._resumeEpisodeKey = null;
    this._item = item;
    this._source = source;
    this._duration = null;
    this._viewOffset = 0;
    this._markers = [];
    this._chapters = [];
    this._media = [];
    this._selectedMediaIndex = 0;
    this._qualityCapKbps = null;
    this._qualityBtn.hidden = true;
    this._progressEl.hidden = !(item.progress > 0);
    this._progressBar.style.width = `${Math.round((item.progress || 0) * 100)}%`;
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

  /* Version rows describe whatever Plex's Media[] actually reports (resolution/codec/
     bitrate field names unverified against a real multi-version item - see this
     phase's open risks); Quality Cap rows are the fixed QUALITY_CAP_PRESETS list.
     Re-rendered on every selection so the "selected" highlight stays in sync without a
     separate diffing step. */
  _renderQualityPicker() {
    const media = this._media || [];
    this._qualityVersionsEl.innerHTML = media.length
      ? media
          .map((m, i) => {
            const parts = [];
            if (m.videoResolution) parts.push(String(m.videoResolution));
            if (m.videoCodec) parts.push(m.videoCodec.toUpperCase());
            if (m.bitrate) parts.push(`${(m.bitrate / 1000).toFixed(1)} Mbps`);
            const label = parts.join(" · ") || `Version ${i + 1}`;
            const selected = (this._selectedMediaIndex || 0) === i;
            return `<button type="button" class="quality-picker-option${selected ? " selected" : ""}" data-media-index="${i}">${this._ctx.escape(label)}</button>`;
          })
          .join("")
      : `<div class="title-info-loading">Only one version available</div>`;
    this._qualityVersionsEl.querySelectorAll(".quality-picker-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._selectedMediaIndex = Number(btn.dataset.mediaIndex);
        this._renderQualityPicker();
      });
    });

    this._qualityCapsEl.innerHTML = QUALITY_CAP_PRESETS.map((preset) => {
      const selected = (this._qualityCapKbps ?? null) === preset.kbps;
      return `<button type="button" class="quality-picker-option${selected ? " selected" : ""}" data-kbps="${preset.kbps ?? ""}">${this._ctx.escape(preset.label)}</button>`;
    }).join("");
    this._qualityCapsEl.querySelectorAll(".quality-picker-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._qualityCapKbps = btn.dataset.kbps ? Number(btn.dataset.kbps) : null;
        this._renderQualityPicker();
      });
    });
  }

  _renderDetail(meta) {
    this._duration = meta.duration || null;
    this._viewOffset = meta.viewOffset || 0;
    this._markers = meta.Marker || [];
    this._chapters = meta.Chapter || [];
    this._media = meta.Media || [];
    this._qualityBtn.hidden = !this._media.length;
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
          row.addEventListener("click", () => {
            const ep = episodes.find((e) => String(e.ratingKey) === row.dataset.ratingKey);
            if (!ep) return;
            this._ctx.onPlayItem(this._ctx.mapItem(ep, true), {
              durationMs: ep.duration || null,
              startOffsetMs: ep.viewOffset || 0,
              source: "local",
              markers: ep.Marker || [],
              chapters: ep.Chapter || [],
              audioStreams: extractAudioStreams(ep.Media, 0),
              bifIndexPath: bifIndexPath(ep.Media, 0),
            });
          });
        });
        if (focusEpisodeRatingKey) {
          const row = list.querySelector(`[data-rating-key="${focusEpisodeRatingKey}"]`);
          if (row) {
            row.classList.add("current");
            row.scrollIntoView({ block: "center" });
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
    this._episodesEl.innerHTML = rawItems
      .map((m) => {
        const mapped = this._ctx.mapItem(m, true);
        const watched = !!mapped.viewCount && !(mapped.progress > 0);
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
      row.addEventListener("click", () => this.open(this._ctx.mapItem(rawItems[i], false), "local"));
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

  async _playCurrentItem() {
    if (this._resumeEpisodeKey) {
      return this._playEpisodeByRatingKey(this._resumeEpisodeKey);
    }
    const item = this._item;
    if (!item) return;
    const mediaIndex = this._selectedMediaIndex || 0;
    await this._ctx.onPlayItem(item, {
      durationMs: this._duration,
      startOffsetMs: this._viewOffset,
      source: this._source,
      markers: this._markers,
      chapters: this._chapters,
      mediaIndex,
      qualityCapKbps: this._qualityCapKbps,
      audioStreams: extractAudioStreams(this._media, mediaIndex),
      bifIndexPath: bifIndexPath(this._media, mediaIndex),
    });
  }

  /* Fetches the episode's own fresh duration/viewOffset (the show-level modal's
     _duration/_viewOffset are always null/0 - shows don't carry those fields) so
     resuming from the show modal's Play button seeks to the right spot. */
  async _playEpisodeByRatingKey(ratingKey) {
    try {
      const data = await this._ctx.plexFetch(`/library/metadata/${ratingKey}`, { includeChapters: 1 });
      const meta = data?.MediaContainer?.Metadata?.[0];
      if (!meta) return;
      await this._ctx.onPlayItem(this._ctx.mapItem(meta, true), {
        durationMs: meta.duration || null,
        startOffsetMs: meta.viewOffset || 0,
        source: "local",
        markers: meta.Marker || [],
        chapters: meta.Chapter || [],
        audioStreams: extractAudioStreams(meta.Media, 0),
        bifIndexPath: bifIndexPath(meta.Media, 0),
      });
    } catch (e) {
      // best-effort - Play simply won't respond if this fails
    }
  }

  _wire() {
    this._closeBtn.addEventListener("click", () => this.close());
    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this.close();
    });
    this._nav = wireLinearNav(
      this._shadowRoot,
      ".title-info-close, .title-info-play, .title-info-watchlist-btn, .title-info-quality-btn, .title-info-season-select, .title-info-episode, .title-info-similar-item",
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
    this._qualityBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openQualityPicker();
    });
    this._qualityOverlay.addEventListener("click", (e) => {
      if (e.target === this._qualityOverlay) this.closeQualityPicker();
    });
    this._qualityDoneBtn.addEventListener("click", () => this.closeQualityPicker());
    wireLinearNav(this._shadowRoot, ".quality-picker-option, .quality-picker-done", {
      orientation: "vertical",
      onBack: () => this.closeQualityPicker(),
    });
  }
}
