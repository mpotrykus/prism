import { wireLinearNav, focusAfterPaint } from "./focus-nav.js";
import { App } from "@capacitor/app";
import { player } from "./plex-player.js";
import { tapUrl } from "./src/card/logic/deep-link.js";
import { normalizeTitle, isInWatchlist } from "./src/card/logic/watchlist-match.js";
import {
  shuffle,
  mapItem,
  mergeGenreRows,
  buildRecommendedRaw,
  buildPopularRaw,
  buildCollectionRows,
  buildAiRows,
} from "./src/card/logic/catalog.js";
import { paintWatchlistButton, addToWatchlist, removeFromWatchlist } from "./src/card/watchlist.js";
import {
  WATCHED_ICON_SVG,
  emptyStateHtml,
  renderMessage,
  renderLoading,
  showLoadingMore,
  hideLoadingMore,
  renderRows,
  buildRowSection,
  buildPoster,
} from "./src/card/rows.js";
import { PinEntry } from "./src/card/pin.js";
import { renderMoreSheet } from "./src/card/more-sheet.js";
import { fetchHomeProfiles, renderProfileNav, renderProfileList, switchToUser } from "./src/card/profile.js";
import { TitleInfoController } from "./src/card/title-info.js";
import { HeroController } from "./src/card/hero.js";
import { plexFetch, loadAll, sectionForView, sectionsForView, fetchWatchlistRaw, fetchOnDeckRaw } from "./src/card/data.js";
import { onSearchInput, exitSearch, renderSearchPage } from "./src/card/search-page.js";
import { wireNavItem, renderNavSections, wireHomeNav } from "./src/card/nav.js";

import hostResetCss from "./src/card/styles/host-reset.css?inline";
import sidenavCss from "./src/card/styles/sidenav.css?inline";
import heroCss from "./src/card/styles/hero.css?inline";
import headerSearchCss from "./src/card/styles/header-search.css?inline";
import rowsPosterCss from "./src/card/styles/rows-poster.css?inline";
import pinModalCss from "./src/card/styles/pin-modal.css?inline";
import profileCss from "./src/card/styles/profile.css?inline";
import moreSheetCss from "./src/card/styles/more-sheet.css?inline";
import titleInfoCss from "./src/card/styles/title-info.css?inline";
import sharedFocusCss from "./src/card/styles/shared-focus.css?inline";
import responsiveCss from "./src/card/styles/responsive.css?inline";

const STYLE = [
  hostResetCss,
  sidenavCss,
  heroCss,
  headerSearchCss,
  rowsPosterCss,
  pinModalCss,
  profileCss,
  moreSheetCss,
  titleInfoCss,
  sharedFocusCss,
  responsiveCss,
].join("\n");

/* type here matches settings.js's SECTION_TYPE_MAP (1 = movie, 2 = show) - the
   numeric convention persisted in config.sections. */
const SECTION_TYPE_FILTERS = {
  1: { onDeck: "movie", other: "movie" },
  2: { onDeck: "episode", other: "show" },
};


const SEARCH_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="16.2" y1="16.2" x2="21" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CLEAR_ICON_SVG =
  '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MORE_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';

class PlexNetflixCard extends HTMLElement {
  /* No required fields here, unlike the original HA-card version - this can be called
     with an empty/partial config (e.g. first run, nothing in Settings yet) and just
     renders a "go configure me" message from _loadAll() below instead of throwing. */
  setConfig(config) {
    this._config = {
      max_genre_rows: 12,
      collection_row_count: 2,
      row_size: 20,
      sections: [],
      title: "Streaming",
      landscape_every_nth: 4,
      ai_rows_cadence_ms: 7 * 24 * 60 * 60 * 1000,
      ...config,
    };
    if (!this._built) {
      this._build();
      this._built = true;
    } else {
      this._renderNavSections();
    }
  }

  /* Public entry point for Settings modal saves (see app.js) - re-merges config and
     re-runs the full load, since _loadAll() otherwise only ever fires once per
     connectedCallback (see _loaded guard there). */
  refreshConfig(config) {
    this.setConfig(config);
    this._loaded = true;
    this._loadAll();
  }

  /* See src/card/pin.js's PinEntry for the shared numeric-keypad modal itself - the
     Plex profile switcher's PIN prompt (_switchToUser) goes through this one instance. */
  _promptForDigits(length, title) {
    return this._pin.prompt(length, title);
  }

  _shakePinEntry() {
    this._pin.shake();
  }

  getCardSize() {
    return 12;
  }

  connectedCallback() {
    if (!this._loaded) {
      this._loaded = true;
      this._loadAll();
    }
  }

  _build() {
    this._currentView = "home";
    this._lastSearchQuery = null;
    this._lastSearchHubs = null;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <nav class="sidenav">
          <div class="nav-top">
            <div class="nav-item active" data-view="home" tabindex="0">
              <span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v9h12v-9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="10" y="14" width="4" height="5" fill="currentColor"/></svg></span>
              <span class="nav-label">Home</span>
            </div>
          </div>
          <div class="nav-bottom">
            <div class="nav-item nav-settings" title="Settings" tabindex="0">
              <span class="nav-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3.5v2.4M12 18.1v2.4M4.5 12H6.9M17.1 12h2.4M6.3 6.3l1.7 1.7M16 16l1.7 1.7M17.7 6.3 16 8M8 16l-1.7 1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
              <span class="nav-label">Settings</span>
            </div>
            <div class="nav-item nav-more" title="More" tabindex="0">
              <span class="nav-icon">${MORE_ICON_SVG}</span>
              <span class="nav-label">More</span>
            </div>
          </div>
        </nav>
        <div class="more-overlay" tabindex="-1">
          <div class="more-sheet">
            <div class="more-sheet-title">More</div>
            <div class="more-sheet-list"></div>
            <button type="button" class="more-sheet-cancel">Cancel</button>
          </div>
        </div>
        <div class="content">
          <div class="header">
            <img class="plex-logo" src="./assets/plex-logo.png" alt="Plex" />
            <div class="search-wrap">
              <button type="button" class="search-toggle"></button>
              <input class="search" type="text" placeholder="Search movies, shows, actors…" autocomplete="off" />
            </div>
            <div class="nav-item nav-profile" title="Switch Profile" hidden tabindex="0">
              <span class="nav-icon nav-profile-icon"></span>
              <span class="nav-label nav-profile-label">Profile</span>
            </div>
          </div>
          <div class="main">
            <div class="hero">
              <div class="hero-media hero-media-a"></div>
              <div class="hero-media hero-media-b"></div>
              <div class="hero-fade"></div>
              <div class="hero-info">
                <div class="hero-title"></div>
                <div class="hero-subtitle"></div>
                <div class="hero-summary"></div>
                <div class="hero-buttons">
                  <button type="button" class="hero-info-btn">More Info</button>
                  <button type="button" class="hero-watchlist-btn" aria-label="Add to My List">+</button>
                </div>
              </div>
              <button type="button" class="hero-play-btn" aria-label="Play/pause">⏸</button>
              <button type="button" class="hero-mute-btn" aria-label="Toggle sound">🔊</button>
            </div>
            <div class="rows"></div>
          </div>
        </div>
      </div>
      <div class="pin-overlay" tabindex="-1">
        <div class="pin-modal">
          <div class="pin-icon">
            <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 11V7a4 4 0 0 1 8 0v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </div>
          <div class="pin-title">Enter PIN</div>
          <div class="pin-dots"></div>
          <div class="pin-error">Incorrect PIN</div>
          <div class="pin-keypad">
            <button type="button" class="pin-key" data-digit="1">1</button>
            <button type="button" class="pin-key" data-digit="2">2</button>
            <button type="button" class="pin-key" data-digit="3">3</button>
            <button type="button" class="pin-key" data-digit="4">4</button>
            <button type="button" class="pin-key" data-digit="5">5</button>
            <button type="button" class="pin-key" data-digit="6">6</button>
            <button type="button" class="pin-key" data-digit="7">7</button>
            <button type="button" class="pin-key" data-digit="8">8</button>
            <button type="button" class="pin-key" data-digit="9">9</button>
            <button type="button" class="pin-key pin-key-empty" tabindex="-1"></button>
            <button type="button" class="pin-key" data-digit="0">0</button>
            <button type="button" class="pin-key pin-backspace" aria-label="Backspace">⌫</button>
          </div>
          <button type="button" class="pin-cancel">Cancel</button>
        </div>
      </div>
      <div class="profile-overlay" tabindex="-1">
        <div class="profile-modal">
          <div class="profile-title">Switch Profile</div>
          <div class="profile-list"></div>
          <button type="button" class="profile-cancel">Cancel</button>
        </div>
      </div>
      <div class="title-info-overlay" tabindex="-1">
        <div class="title-info-modal">
          <button type="button" class="title-info-close" aria-label="Close">✕</button>
          <div class="title-info-art">
            <div class="title-info-progress" hidden><div class="bar"></div></div>
          </div>
          <div class="title-info-body">
            <div class="title-info-header">
              <div class="title-info-title"></div>
              <div class="title-info-meta"></div>
            </div>
            <div class="title-info-actions">
              <button type="button" class="title-info-play">▶ Play</button>
              <button type="button" class="title-info-restart-btn" hidden>↺ Restart</button>
              <button type="button" class="title-info-watched-btn" aria-label="Mark as watched" hidden>${WATCHED_ICON_SVG}</button>
              <button type="button" class="title-info-watchlist-btn" aria-label="Add to My List">+</button>
            </div>
            <div class="title-info-actions-loading" hidden><span class="spinner"></span></div>
            <div class="title-info-summary"></div>
            <div class="title-info-episodes"></div>
            <div class="title-info-cast-wrap" hidden>
              <div class="title-info-section-title">Cast</div>
              <div class="title-info-cast"></div>
            </div>
            <div class="title-info-similar-wrap" hidden>
              <div class="title-info-section-title">More Like This</div>
              <div class="title-info-similar"></div>
            </div>
          </div>
        </div>
      </div>
    `;
    this._rowsEl = this.shadowRoot.querySelector(".rows");
    this._searchWrap = this.shadowRoot.querySelector(".search-wrap");
    this._searchToggle = this.shadowRoot.querySelector(".search-toggle");
    this._searchInput = this.shadowRoot.querySelector(".search");
    this._renderNavSections();
    this._settingsBtn = this.shadowRoot.querySelector(".nav-settings");
    this._profileNavItem = this.shadowRoot.querySelector(".nav-profile");
    this._profileNavIcon = this.shadowRoot.querySelector(".nav-profile-icon");
    this._profileNavLabel = this.shadowRoot.querySelector(".nav-profile-label");
    this._profileOverlay = this.shadowRoot.querySelector(".profile-overlay");
    this._profileListEl = this.shadowRoot.querySelector(".profile-list");
    this._profileCancelBtn = this.shadowRoot.querySelector(".profile-cancel");
    this._moreBtn = this.shadowRoot.querySelector(".nav-more");
    this._moreOverlay = this.shadowRoot.querySelector(".more-overlay");
    this._moreListEl = this.shadowRoot.querySelector(".more-sheet-list");
    this._moreCancelBtn = this.shadowRoot.querySelector(".more-sheet-cancel");
    this._pin = new PinEntry(this.shadowRoot);
    this._titleInfo = new TitleInfoController(this.shadowRoot, {
      escape: (s) => this._escape(s),
      plexFetch: (path, params) => this._plexFetch(path, params),
      plexImageUrl: (path) => this._plexImageUrl(path),
      plexThumbUrl: (path, width, height) => this._plexThumbUrl(path, width, height),
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      isInWatchlist: (item) => this._isInWatchlist(item),
      resolveLocalRatingKey: (item) => this._resolveLocalRatingKey(item),
      onAddToWatchlist: (item, btnEl) => this._addToWatchlist(item, btnEl),
      onRemoveFromWatchlist: (item, btnEl) => this._removeFromWatchlist(item, btnEl),
      onPlayItem: (item, opts) => this._playItem(item, opts),
      onPlayHistoryMutated: (ratingKey, watched) => this._onPlayHistoryMutated(ratingKey, watched),
    });
    this._hero = new HeroController(this.shadowRoot, {
      escape: (s) => this._escape(s),
      plexFetch: (path, params) => this._plexFetch(path, params),
      plexImageUrl: (path) => this._plexImageUrl(path),
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      isInWatchlist: (item) => this._isInWatchlist(item),
      onAddToWatchlist: (item, btnEl) => this._addToWatchlist(item, btnEl),
      onRemoveFromWatchlist: (item, btnEl) => this._removeFromWatchlist(item, btnEl),
      onOpenTitleInfo: (item, source) => this._openTitleInfo(item, source),
      getConfig: () => this._config,
      getCurrentView: () => this._currentView,
      getSectionsForView: (view) => this._sectionsForView(view),
      getGenreBySection: () => this._genreBySection,
    });

    /* Continue Watching membership can change from any playback session, not just one
       that started from the title-info modal (e.g. an episode row's direct-play click) -
       a single card-level listener covers every path, rather than each of them having to
       remember to call _onPlayHistoryMutated itself. */
    window.addEventListener("streaming-player-close", () => this._onPlayHistoryMutated());

    /* Dynamic (per-library) nav items are already wired inside _renderNavSections,
       called above - only Home is static and needs wiring here. */
    this._wireNavItem(this.shadowRoot.querySelector('.nav-item[data-view="home"]'));

    this._settingsBtn.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("open-settings", { bubbles: true, composed: true }));
    });

    this._profileNavItem.addEventListener("click", () => this._openProfileOverlay());
    this._profileCancelBtn.addEventListener("click", () => this._closeProfileOverlay());
    this._profileOverlay.addEventListener("click", (e) => {
      if (e.target === this._profileOverlay) this._closeProfileOverlay();
    });
    this._profileNav = wireLinearNav(this.shadowRoot, ".profile-switch-btn, .profile-cancel", {
      orientation: "vertical",
      onBack: () => this._closeProfileOverlay(),
    });

    this._moreBtn.addEventListener("click", () => this._openMoreSheet());
    this._moreCancelBtn.addEventListener("click", () => this._closeMoreSheet());
    this._moreOverlay.addEventListener("click", (e) => {
      if (e.target === this._moreOverlay) this._closeMoreSheet();
    });
    this._moreNav = wireLinearNav(this.shadowRoot, ".more-sheet-item, .more-sheet-cancel", {
      orientation: "vertical",
      onBack: () => this._closeMoreSheet(),
    });

    /* Registering a backButton listener at all switches off Capacitor's own default
       Android hardware-back handling (goBack()-if-possible, else exit the app) - without
       this, none of these overlays have a browser history entry to go back to, so every
       one of them just fell straight through to exiting the app. Ordered by overlay
       z-index (highest first) since more than one can theoretically be open at once. */
    App.addListener("backButton", () => {
      const settingsModal = document.querySelector("streaming-settings-modal");
      if (this._titleInfo.isOpen()) this._titleInfo.close();
      else if (this._pin.isOpen()) this._pin.cancel();
      else if (this._profileOverlay.classList.contains("open")) this._closeProfileOverlay();
      else if (this._moreOverlay.classList.contains("open")) this._closeMoreSheet();
      else if (settingsModal?.isOpen()) settingsModal.close();
      else App.exitApp();
    });

    this._wireHomeNav();

    this._updateSearchToggleIcon();
    this._searchToggle.addEventListener("click", () => {
      if (this._searchInput.value) {
        this._clearSearchInput();
        this._onSearchInput();
        this._searchWrap.classList.remove("expanded");
        this._searchInput.blur();
        return;
      }
      this._searchWrap.classList.add("expanded");
      this._searchInput.focus();
    });
    this._searchInput.addEventListener("focus", () => this._searchWrap.classList.add("expanded"));
    this._searchInput.addEventListener("blur", () => {
      if (this._currentView === "search") return;
      this._searchWrap.classList.remove("expanded");
    });
    this._searchInput.addEventListener("input", () => {
      this._updateSearchToggleIcon();
      this._onSearchInput();
    });
    this._searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this._clearSearchInput();
        this._exitSearch();
        this._searchWrap.classList.remove("expanded");
        this._searchInput.blur();
      }
    });
  }

  _wireNavItem(el) {
    wireNavItem(this, el);
  }

  _renderNavSections() {
    renderNavSections(this);
  }

  _clearSearchInput() {
    this._searchInput.value = "";
    this._updateSearchToggleIcon();
  }

  _updateSearchToggleIcon() {
    const hasValue = !!this._searchInput.value;
    this._searchToggle.innerHTML = hasValue ? CLEAR_ICON_SVG : SEARCH_ICON_SVG;
    this._searchToggle.setAttribute("aria-label", hasValue ? "Clear search" : "Search");
  }

  _plexFetch(path, params = {}) {
    return plexFetch(this, path, params);
  }

  _loadAll() {
    return loadAll(this);
  }

  _sectionForView(view) {
    return sectionForView(this, view);
  }

  _sectionsForView(view) {
    return sectionsForView(this, view);
  }

  _fetchWatchlistRaw() {
    return fetchWatchlistRaw(this);
  }

  _shuffle(array) {
    return shuffle(array);
  }

  _plexImageUrl(path) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${this._config.plex_url}${path}${sep}X-Plex-Token=${this._config.plex_token}`;
  }

  /* Poster-grid/avatar/episode-thumb images are always displayed small but Plex hands
     back full source-resolution art regardless (a lighthouse audit found 62MB/337
     images on one cold load) - route those through Plex's own /photo/:/transcode so PMS
     resizes once, caches the result, and every later request for that (item, size) is
     cheap. Deliberately NOT applied to hero/backdrop art (see _plexImageUrl callers in
     hero.js/catalog.js's `art` field) - those fill the screen at full res on purpose,
     and this endpoint's own cost is what an earlier investigation decided was too risky
     to run for the high-volume case (see image-transcode-wont-do memory) - this narrows
     that back down to just the small fixed-size grid case, not a blanket resize.
     Doesn't handle `path` values that are already absolute URLs (e.g. Gracenote-hosted
     agent artwork on metadata-static.plex.tv) - those aren't served by this PMS so can't
     be transcoded through it; falls back to the untouched original for those. */
  _plexThumbUrl(path, width = 320, height = 480) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    const sourceUrl = `${path}${path.includes("?") ? "&" : "?"}X-Plex-Token=${this._config.plex_token}`;
    const url = new URL(`${this._config.plex_url}/photo/:/transcode`);
    url.searchParams.set("width", String(width));
    url.searchParams.set("height", String(height));
    url.searchParams.set("minSize", "1");
    url.searchParams.set("upscale", "0");
    url.searchParams.set("X-Plex-Token", this._config.plex_token);
    url.searchParams.set("url", sourceUrl);
    return url.toString();
  }

  _advanceHero() {
    return this._hero.advance();
  }

  _showHero(preserveMute = false, crossfade = false) {
    this._hero.show(preserveMute, crossfade);
  }

  _renderCurrentView({ showHero = true } = {}) {
    const view = this._currentView || "home";
    if (showHero) this._showHero();
    const sectionsForGenres = this._sectionsForView(view);

    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    const onDeckFilter = sectionFilters ? (m) => m.type === sectionFilters.onDeck : () => true;
    const otherFilter = sectionFilters ? (m) => m.type === sectionFilters.other : () => true;
    const watchlistFilter = otherFilter;
    const recentlyAddedFilter = otherFilter;
    const recommendedFilter = otherFilter;
    const popularFilter = otherFilter;

    const onDeck = (this._onDeckRaw || [])
      .filter(onDeckFilter)
      .map((m) => this._mapItem(m, true));
    const watchlist = (this._watchlistRaw || [])
      .filter(watchlistFilter)
      .map((m) => this._mapItem(m, false));
    const recentlyAdded = (this._recentlyAddedRaw || [])
      .filter(recentlyAddedFilter)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, this._config.row_size)
      .map((m) => this._mapItem(m, false));
    const recommended = this._getRecommendedForView(view, recommendedFilter)
      .map((m) => this._mapItem(m, false));
    const popular = (this._popularRaw || [])
      .filter(popularFilter)
      .slice(0, Math.min(8, this._config.row_size))
      .map((m) => this._mapItem(m, false));
    const genreRows = this._getGenreRowsForView(view, sectionsForGenres);
    const collectionsRow = this._getCollectionsRowForView(sectionsForGenres);
    const playlistsRow = this._getPlaylistsRowForView(view);

    const rows = [];
    if (onDeck.length) rows.push({ title: "Continue Watching", items: onDeck, source: "local", landscape: true });
    if (recentlyAdded.length) rows.push({ title: "Recently Added", items: recentlyAdded, source: "local" });
    if (watchlist.length) rows.push({ title: "My List", items: watchlist, source: "watchlist" });
    if (recommended.length)
      rows.push({ title: "Recommended for You", items: recommended, source: "local", landscape: true });
    if (popular.length) rows.push({ title: "What's Popular", items: popular, source: "local", rankNumbers: true });
    rows.push(...genreRows);
    if (collectionsRow) rows.push(collectionsRow);
    if (playlistsRow) rows.push(playlistsRow);
    /* showHero:false always means "background data streaming in after first paint" (see
       data.js's loadBackgroundData) - merge the newly-available rows in without
       disturbing what's already rendered, for the same reason showHero itself is
       skipped: this isn't a real view change, so nothing already on screen should move
       or restart. */
    this._renderRows(rows, { merge: !showHero });
  }

  /* Rebuilds just the "My List" row after an add/remove, instead of the full
     _renderCurrentView() - that also unconditionally calls _showHero(), which resets mute
     state and restarts the active hero video/trailer, an unwanted side effect of clicking
     an unrelated poster's watchlist button elsewhere on the page. */
  _refreshWatchlistRow() {
    const view = this._currentView || "home";
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    const watchlistFilter = sectionFilters ? (m) => m.type === sectionFilters.other : () => true;
    const watchlist = (this._watchlistRaw || [])
      .filter(watchlistFilter)
      .map((m) => this._mapItem(m, false));

    const existing = this._rowsEl.querySelector('[data-row-key="watchlist"]');
    if (!watchlist.length) {
      if (existing) existing.remove();
      return;
    }

    const sections = Array.from(this._rowsEl.children);
    const rowIndex = existing ? sections.indexOf(existing) : sections.length;
    const nth = this._config.landscape_every_nth;
    const landscape = !!nth && (rowIndex + 1) % nth === 0;
    const newSection = this._buildRowSection({ title: "My List", items: watchlist, source: "watchlist" }, landscape, rowIndex);

    if (existing) {
      existing.replaceWith(newSection);
      return;
    }
    const anchor = sections.find(
      (s) => !["Continue Watching", "Recently Added"].includes(s.querySelector(".row-title")?.textContent)
    );
    if (anchor) this._rowsEl.insertBefore(newSection, anchor);
    else this._rowsEl.appendChild(newSection);
  }

  /* Rebuilds just the "Continue Watching" row - same _renderCurrentView-avoidance
     reasoning as _refreshWatchlistRow. Always the first row when present (see
     _renderCurrentView), so there's no nth-cycling landscape calc or anchor search
     needed for the insert case, unlike the watchlist row. */
  _refreshOnDeckRow() {
    const view = this._currentView || "home";
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    const onDeckFilter = sectionFilters ? (m) => m.type === sectionFilters.onDeck : () => true;
    const onDeck = (this._onDeckRaw || [])
      .filter(onDeckFilter)
      .map((m) => this._mapItem(m, true));

    const existing = this._rowsEl.querySelector('[data-row-key="on-deck"]');
    if (!onDeck.length) {
      if (existing) existing.remove();
      return;
    }

    const rowIndex = existing ? Array.from(this._rowsEl.children).indexOf(existing) : 0;
    const newSection = this._buildRowSection({ title: "Continue Watching", items: onDeck, source: "local", landscape: true }, true, rowIndex);

    if (existing) existing.replaceWith(newSection);
    else this._rowsEl.insertBefore(newSection, this._rowsEl.firstChild);
  }

  /* Refetches on-deck data from Plex after anything that changes a title's watch
     history from within an already-rendered view (restart/mark-unwatched via the
     title-info modal, or any playback session ending - see the streaming-player-close
     listener in _build) - Plex is the only source of truth for which titles currently
     qualify for Continue Watching. ratingKey/watched are optional - only title-info.js's
     own calls know which title's own "Watched" badge to live-patch; the plain
     streaming-player-close listener below doesn't know which title played and just
     refreshes on-deck. */
  async _onPlayHistoryMutated(ratingKey, watched) {
    if (ratingKey != null && watched != null) this._patchWatchedBadge(ratingKey, watched);
    this._onDeckRaw = await fetchOnDeckRaw(this);
    this._refreshOnDeckRow();
  }

  /* Live-updates every rendered copy of this title's poster (the same title can appear
     in more than one row at once - see rows.js) instead of a full _renderCurrentView(),
     which would also reset the hero trailer (see _refreshWatchlistRow's comment) - the
     underlying raw row caches stay stale until the next full reload, a known gap rather
     than something worth a wholesale re-architecture for right now. */
  _patchWatchedBadge(ratingKey, watched) {
    this._rowsEl.querySelectorAll(`.poster[data-rating-key="${ratingKey}"] .card`).forEach((cardEl) => {
      const hasProgress = !!cardEl.querySelector(".progress");
      const shouldShow = watched && !hasProgress;
      let badge = cardEl.querySelector(".watched-badge");
      if (shouldShow && !badge) {
        badge = document.createElement("div");
        badge.className = "watched-badge";
        badge.title = "Watched";
        badge.innerHTML = WATCHED_ICON_SVG;
        cardEl.appendChild(badge);
      } else if (!shouldShow && badge) {
        badge.remove();
      }
    });
  }

  _getCollectionsRowForView(sections) {
    const keys = new Set(sections.map((s) => s.key));
    const collections = (this._collectionsRaw || []).filter((c) => keys.has(c.section.key));
    if (!collections.length) return null;
    const items = collections.map((c) => ({
      ratingKey: c.ratingKey,
      type: "collection",
      title: c.title,
      subtitle: c.childCount ? `${c.childCount} titles` : "",
      image: this._plexThumbUrl(c.thumb),
      art: this._plexImageUrl(c.thumb),
    }));
    return { title: "Collections", items, source: "local" };
  }

  _getPlaylistsRowForView(view) {
    /* Playlists aren't scoped to a single library section like collections are (a
       playlist can mix movies/shows), so there's no clean per-view filter - only show
       this row on the unfiltered Home view rather than guess which playlists "belong"
       to Movies vs. TV. */
    if (view !== "home") return null;
    const playlists = this._playlistsRaw || [];
    if (!playlists.length) return null;
    const items = playlists.map((p) => ({
      ratingKey: p.ratingKey,
      type: "playlist",
      title: p.title,
      subtitle: p.leafCount ? `${p.leafCount} items` : "",
      image: this._plexThumbUrl(p.composite),
      art: this._plexImageUrl(p.composite),
    }));
    return { title: "Playlists", items, source: "local" };
  }

  /* Plex Home profiles - only worth surfacing the switcher UI at all when there's more
     than one (a solo account has nothing to switch to). Failures (no account token yet,
     no Plex Home set up, network error) all collapse to "no switcher", same as an empty
     list - none of them should ever block the rest of the dashboard from loading. */
  _fetchHomeProfiles() {
    return fetchHomeProfiles(this._config.plex_account_token);
  }

  _renderProfileNav() {
    renderProfileNav(this._profileNavItem, this._profileNavLabel, this._profileNavIcon, this._homeUsers || [], this._activeUserId, (s) => this._escape(s));
  }

  _openProfileOverlay() {
    this._renderProfileList();
    this._profileOverlay.classList.add("open");
    this._profileNav.focusFirst();
  }

  _closeProfileOverlay() {
    this._profileOverlay.classList.remove("open");
  }

  /* Mobile-only overflow menu (see .nav-more/.nav-item-overflow) - every row here just
     delegates to the real nav item's own click handler instead of reimplementing Profile/
     Settings/library-switch behavior a second time. */
  _renderMoreSheet() {
    const rows = [];
    const addRow = (label, iconHTML, active, target) => {
      rows.push({ label, iconHTML, active, onSelect: () => { this._closeMoreSheet(); target.click(); } });
    };
    this.shadowRoot.querySelectorAll(".nav-item-overflow").forEach((el) => {
      addRow(el.querySelector(".nav-label").textContent, el.querySelector(".nav-icon").innerHTML, el.classList.contains("active"), el);
    });
    if (!this._profileNavItem.hidden) {
      addRow(this._profileNavLabel.textContent, this._profileNavIcon.innerHTML, false, this._profileNavItem);
    }
    addRow("Settings", this._settingsBtn.querySelector(".nav-icon").innerHTML, false, this._settingsBtn);
    renderMoreSheet(this._moreListEl, rows, (s) => this._escape(s));
  }

  _openMoreSheet() {
    this._renderMoreSheet();
    this._moreOverlay.classList.add("open");
    this._moreNav.focusFirst();
  }

  _closeMoreSheet() {
    this._moreOverlay.classList.remove("open");
  }

  _renderProfileList() {
    renderProfileList(this._profileListEl, this._homeUsers || [], this._activeUserId, (s) => this._escape(s), (user, rowEl) => this._switchToUser(user, rowEl));
  }

  /* Redirects an episode click to the parent show's info modal, landing on the season/
     episode it came from (via _pendingEpisodeFocus, consumed in _loadTitleInfoSeasons)
     instead of opening a dedicated single-episode modal. item.image/art already resolve
     to the show's own thumb/art here (see _mapItem's grandparentThumb/grandparentArt
     fallback for episodes), so the optimistic paint before the real fetch is accurate.
     _titleInfoResumeEpisodeKey remembers which episode this show modal stands in for, so
     the Play button resumes that episode instead of trying to "play" the show container
     itself, which isn't a playable item (StreamingPlayer.play fails on it and falls back
     to _tapUrl's web/details link - the "thrown to the Plex website" regression this
     comment is here to prevent reintroducing). */
  _openTitleInfo(item, source) {
    return this._titleInfo.open(item, source);
  }

  _wireHomeNav() {
    wireHomeNav(this);
  }

  /* Prefers the shared player (native on Android, <video>+hls.js everywhere else - see
     plex-player.js) and only falls back to handing off via _tapUrl (native Plex app /
     Plex web player) when playback fails to start - e.g. a watchlist item with no local
     ratingKey, which player.play rejects by design. Shared by the title-info modal's
     Play button and the episode list's direct-play rows. */
  async _playItem(item, { durationMs = null, startOffsetMs = 0, source, markers = [], chapters = [], mediaIndex = 0, mediaVersions = [], audioStreams = [], bifIndexPath = null, partId = null, queueRatingKeys = null, queueIndex = null } = {}) {
    try {
      await player.play({
        ratingKey: item.ratingKey,
        key: item.key,
        type: item.type,
        plexUrl: this._config.plex_url,
        plexToken: this._config.plex_token,
        durationMs,
        startOffsetMs,
        markers,
        chapters,
        mediaIndex,
        mediaVersions,
        audioStreams,
        bifIndexPath,
        partId,
        /* Already produced by _mapItem for every call site - title is the show's own
           title (not the episode's) for episode items, which is what a subtitle search
           query needs to key off, not the individual episode title. */
        title: item.title,
        episodeTitle: item.seasonNumber != null ? item.subtitle : null,
        year: item.year,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        /* Drives plex-player.js's shader auto-detection (anime vs. live-action) - see
           _mapItem/_renderTitleInfoDetail for where this gets resolved. */
        genres: item.genres || [],
        /* The ordered list of sibling ratingKeys (a show's full episode order, or a
           playlist/collection's own order) this item came from, if any - see
           title-info.js's _getShowEpisodeQueue/_flatQueueContext. Powers the player's
           title-prev/title-next buttons (src/player/ui/chrome.js). */
        queueRatingKeys,
        queueIndex,
      });
      return;
    } catch (e) {
      // fall through to the deep-link fallback below
    }
    window.open(this._tapUrl(item, source), "_blank");
  }

  /* Protected profiles get prompted through the shared numeric-keypad modal (see
     _promptForDigits above) instead of a plain text input - one PIN-entry UI in the
     app, not two. A wrong entry here isn't retried automatically: only Plex can say
     whether it was right, so a rejected PIN just reports the error and leaves the
     user to press "Switch" again. */
  _switchToUser(user, rowEl) {
    return switchToUser(user, rowEl, {
      promptForDigits: (length, title) => this._promptForDigits(length, title),
      accountToken: this._config.plex_account_token,
      machineId: this._config.machine_id,
      onSuccess: async ({ plexToken, accountToken, userId }) => {
        this._config.plex_token = plexToken;
        this._config.plex_account_token = accountToken;
        this._activeUserId = userId;
        this._closeProfileOverlay();
        await this._loadAll();
      },
    });
  }

  _getRecommendedForView(view, filterFn) {
    if (!this._recommendedRowCache) this._recommendedRowCache = {};
    if (!this._recommendedRowCache[view]) {
      const rowSize = this._config.row_size;
      /* Wider pool (2x row_size) keeps the row anchored to genuinely high-affinity
         matches - unlike genre rows, which shuffle across the whole eligible set. */
      const pool = (this._recommendedRaw || []).filter(filterFn).slice(0, rowSize * 2);
      this._recommendedRowCache[view] = this._shuffle(pool).slice(0, rowSize);
    }
    return this._recommendedRowCache[view];
  }

  _getGenreRowsForView(view, sections) {
    if (!this._genreRowsCache) this._genreRowsCache = {};
    if (!this._genreRowsCache[view]) {
      const genreRows = this._mergeGenreRows(sections);
      const aiRows = this._buildAiRows(view);
      const collectionRows = this._buildCollectionRows(view);
      /* Collection rows are guaranteed to appear (reserved out of the max_genre_rows cap
         below) rather than competing for a slot like genre/AI rows - but still shuffled
         into a random position together with everything else, not pinned to a fixed spot. */
      const pool = this._shuffle([...genreRows, ...aiRows]).slice(
        0,
        Math.max(0, this._config.max_genre_rows - collectionRows.length)
      );
      this._genreRowsCache[view] = this._shuffle([...pool, ...collectionRows]);
    }
    return this._genreRowsCache[view];
  }

  /* Collection rows: title = a real Plex Collection's name, items = its actual movies -
     picked randomly per real page load in _loadAll (see _collectionRowPicks), unlike
     genre/AI rows which are recomputed from the full pool every time. No totalSize>=5
     floor here (unlike _mergeGenreRows) - collections are hand-curated and small ones
     (e.g. a 2-film franchise) are still worth showing as-is. */
  _typeFilterForView(view) {
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionForView(view)?.type];
    return sectionFilters ? (m) => m.type === sectionFilters.other : () => true;
  }

  /* Cheap candidate pool for the hero's very first pick (see data.js's loadAll and
     HeroController.loadInitialItem) - reuses the same "other" (movie/show, not
     episode) type filter _buildCollectionRows/_buildAiRows already apply for this view,
     so an in-progress TV episode from onDeck doesn't end up as the hero item without its
     show-level context. */
  _buildHeroInitialPool(view) {
    const filter = this._typeFilterForView(view);
    return [
      ...(this._onDeckRaw || []).filter(filter),
      ...(this._watchlistRaw || []).filter(filter),
      ...(this._recentlyAddedRaw || []).filter(filter),
    ];
  }

  _buildCollectionRows(view) {
    return buildCollectionRows(this._collectionRowsRaw, this._typeFilterForView(view), {
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      rowSize: this._config.row_size,
    });
  }

  _buildAiRows(view) {
    return buildAiRows(this._aiRowsRaw, this._typeFilterForView(view), {
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      rowSize: this._config.row_size,
    });
  }

  _mergeGenreRows(sections) {
    return mergeGenreRows(sections, {
      genreBySection: this._genreBySection,
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      shuffle: (arr) => this._shuffle(arr),
      rowSize: this._config.row_size,
    });
  }

  /* Genre-affinity recommender: scores every unwatched library item by how much its
     genres overlap with genres pulled from watch history, weighted so more-recently-
     watched items count for more. Pure local-PMS data (history + genre listings already
     fetched elsewhere) - no Plex cloud/Discover dependency, unlike the watchlist fetch. */
  _buildRecommendedRaw(historyRaw) {
    return buildRecommendedRaw(historyRaw, {
      genreBySection: this._genreBySection,
      isBlockedGenreName: (name) => this._isBlockedGenreName(name),
      onDeckRaw: this._onDeckRaw,
    });
  }

  /* "What's Popular" row: blended recency + audience-rating score computed entirely
     from local Plex metadata (year + audienceRating, sourced from Rotten Tomatoes per
     the PMS agent) - no external API calls. Replaces an earlier TMDb-trending-based
     version that too often had zero overlap with an older library (trending skews hard
     toward brand-new theatrical releases). Year is normalized against the library's own
     min/max release year, so "recent" is relative to what's actually in the library,
     not calendar time; weighted 50/50 with rating, adjust freely. */
  _buildPopularRaw() {
    return buildPopularRaw({ genreBySection: this._genreBySection, isBlockedGenreName: (name) => this._isBlockedGenreName(name) });
  }

  /* episodeFallbackGenres: an episode's own Plex metadata carries no Genre (that lives
     on the show) - fall back to whatever show-level genres the open title-info modal
     already resolved (see _renderTitleInfoDetail) rather than going undetected by
     plex-player.js's shader auto-detection. */
  _mapItem(m, withProgress) {
    return mapItem(m, withProgress, {
      plexImageUrl: (path) => this._plexImageUrl(path),
      plexThumbUrl: (path) => this._plexThumbUrl(path),
      episodeFallbackGenres: this._titleInfo?.item?.genres || [],
    });
  }

  _tapUrl(item, source) {
    return tapUrl(item, source, {
      machineId: this._config.machine_id,
      plexUrl: this._config.plex_url,
      userAgent: navigator.userAgent,
    });
  }

  get _rowCtx() {
    return {
      escape: (s) => this._escape(s),
      isInWatchlist: (item) => this._isInWatchlist(item),
      paintWatchlistButton,
      onAddToWatchlist: (item, btnEl) => this._addToWatchlist(item, btnEl),
      onRemoveFromWatchlist: (item, btnEl) => this._removeFromWatchlist(item, btnEl),
      onOpenTitleInfo: (item, source) => this._openTitleInfo(item, source),
    };
  }

  _emptyStateHtml(msg) {
    return emptyStateHtml(msg, (s) => this._escape(s));
  }

  _renderMessage(msg) {
    renderMessage(this._rowsEl, msg, (s) => this._escape(s));
  }

  _renderLoading() {
    renderLoading(this._rowsEl);
  }

  _showLoadingMore() {
    showLoadingMore(this._rowsEl);
  }

  _hideLoadingMore() {
    hideLoadingMore(this._rowsEl);
  }

  _renderRows(rows, { merge = false } = {}) {
    renderRows(this._rowsEl, rows, this._config.landscape_every_nth, this._rowCtx, { merge });
  }

  _buildRowSection(row, landscape = false, rowIndex = 0) {
    return buildRowSection(row, landscape, rowIndex, this._rowCtx);
  }

  _buildPoster(item, source, opts = {}) {
    return buildPoster(item, source, opts, this._rowCtx);
  }

  /* Local library titles and Plex's cloud Discover titles can differ in punctuation only
     (e.g. local "Dragon Ball Z Bio-Broly" vs Discover "Dragon Ball Z: Bio-Broly") - an exact
     string match silently fails on these, so comparisons strip everything but alphanumerics. */
  _normalizeTitle(t) {
    return normalizeTitle(t);
  }

  _isInWatchlist(item) {
    return isInWatchlist(item, this._watchlistRaw);
  }

  /* A "My List" item's ratingKey is scoped to discover.provider.plex.tv, a different ID
     space than this server's /library/metadata - using it directly there 404s. Resolve
     the local ratingKey (if the title is actually in this server's library) via
     /hubs/search before fetching detail. */
  async _resolveLocalRatingKey(item) {
    try {
      const data = await this._plexFetch("/hubs/search", { query: item.title, limit: 10 });
      const results = (data?.MediaContainer?.Hub || [])
        .filter((h) => h.type === item.type)
        .flatMap((h) => h.Metadata || []);
      const norm = this._normalizeTitle(item.title);
      const exact = results.find(
        (m) => this._normalizeTitle(m.title) === norm && (!item.year || m.year === item.year)
      );
      return (exact || results[0])?.ratingKey || null;
    } catch (e) {
      return null;
    }
  }

  async _onWatchlistMutated() {
    this._watchlistRaw = await this._fetchWatchlistRaw();
    this._refreshWatchlistRow();
  }

  _addToWatchlist(item, btnEl) {
    return addToWatchlist(item, btnEl, {
      plexAccountToken: this._config.plex_account_token,
      onSuccess: () => this._onWatchlistMutated(),
    });
  }

  _removeFromWatchlist(item, btnEl) {
    return removeFromWatchlist(item, btnEl, {
      plexAccountToken: this._config.plex_account_token,
      onSuccess: () => this._onWatchlistMutated(),
    });
  }

  _onSearchInput() {
    onSearchInput(this);
  }

  _exitSearch() {
    exitSearch(this);
  }

  _renderSearchPage(hubs, opts = {}) {
    renderSearchPage(this, hubs, opts);
  }

  _escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
}

if (!customElements.get("plex-netflix-card")) {
  customElements.define("plex-netflix-card", PlexNetflixCard);
  console.info(
    "%c PLEX-NETFLIX-CARD %c v1.0.0-standalone ",
    "color:white;background:#e5a00d;font-weight:bold;",
    "color:#e5a00d;background:#222;font-weight:bold;"
  );
}
