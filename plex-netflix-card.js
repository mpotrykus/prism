import { wireLinearNav, registerNavHandler, focusAfterPaint } from "./focus-nav.js";
import { App } from "@capacitor/app";
import { player } from "./plex-player.js";
import { passesKidsMode, isBlockedGenreName } from "./src/card/logic/kids-mode.js";
import { slugify, isAndroidUserAgent, tapUrl } from "./src/card/logic/deep-link.js";
import { normalizeTitle, isInWatchlist } from "./src/card/logic/watchlist-match.js";
import { parseYearQuery, buildGenreMatchHubs, buildReasonMatchHubs, SEARCH_REASON_LABELS } from "./src/card/logic/search.js";
import {
  shuffle,
  mapItem,
  mergeGenreRows,
  buildRecommendedRaw,
  buildPopularRaw,
  buildCollectionRows,
  buildAiRows,
  parseAiSectionIdeas,
} from "./src/card/logic/catalog.js";
import { paintWatchlistButton, addToWatchlist, removeFromWatchlist } from "./src/card/watchlist.js";
import {
  EMPTY_STATE_ICON_SVG,
  WATCHED_ICON_SVG,
  emptyStateHtml,
  renderMessage,
  renderLoading,
  renderRows,
  buildRowSection,
  buildScrollArrow,
  wireArrowVisibility,
  buildPoster,
} from "./src/card/rows.js";
import { PinEntry } from "./src/card/pin.js";
import { renderMoreSheet } from "./src/card/more-sheet.js";
import { fetchHomeProfiles, renderProfileNav, renderProfileList, switchToUser } from "./src/card/profile.js";
import { TitleInfoController } from "./src/card/title-info.js";
import { HeroController } from "./src/card/hero.js";

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

/* How many library tabs stay directly on the mobile bottom nav bar before the rest
   spill into the "More" overflow sheet alongside Profile/Kids Mode/Settings - desktop's
   hover sidenav has room for all of them regardless, see .nav-item-overflow. */
const MOBILE_VISIBLE_SECTION_CAP = 3;

const MOVIE_NAV_ICON_SVG =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="8" width="4" height="1.6" fill="currentColor"/><rect x="3" y="13" width="4" height="1.6" fill="currentColor"/><rect x="17" y="8" width="4" height="1.6" fill="currentColor"/><rect x="17" y="13" width="4" height="1.6" fill="currentColor"/></svg>';
const TV_NAV_ICON_SVG =
  '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="12" y1="18" x2="12" y2="21" stroke="currentColor" stroke-width="1.6"/></svg>';
const GENERIC_NAV_ICON_SVG =
  '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="3.2" rx="1.2" fill="currentColor"/><rect x="3" y="10.4" width="18" height="3.2" rx="1.2" fill="currentColor"/><rect x="3" y="15.8" width="18" height="3.2" rx="1.2" fill="currentColor"/></svg>';
/* Best-effort icon-by-name for a fetched library's own label (freely user-edited in
   Settings) - falls back to a generic library icon rather than guessing from the
   section's movie/show type, since a "Kids" or "Anime" library shouldn't just get
   whichever of the two hand-drawn icons happens to match its underlying Plex type. */
const NAV_ICON_NAME_RULES = [
  { test: /movie|film|cinema/i, icon: MOVIE_NAV_ICON_SVG },
  { test: /tv|show|series|anime/i, icon: TV_NAV_ICON_SVG },
];
function iconForLibraryLabel(label) {
  const rule = NAV_ICON_NAME_RULES.find((r) => r.test.test(label || ""));
  return rule ? rule.icon : GENERIC_NAV_ICON_SVG;
}

const SEARCH_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="16.2" y1="16.2" x2="21" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CLEAR_ICON_SVG =
  '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MORE_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';

/* Plex's /hubs/search `reason` field marks a match as coming from a specific
   person/entity rather than a plain title hit - only these two are confirmed
   to actually appear in practice, so only these get promoted to their own section. */
const SEARCH_HUB_LIMIT = 24;
/* "See All" section expansion - large enough that no single library section's
   search hub is likely to actually hit this ceiling. */
const SEARCH_EXPAND_LIMIT = 500;

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
      /* Required to turn Kids Mode back OFF (turning it on is never gated). */
      kids_mode_pin: "1233",
      /* Ratings at/under a PG-equivalent - anything else (or unrated/missing) is hidden
         in Kids Mode. TV-PG is the closest TV-scale equivalent to a movie PG rating. */
      kids_mode_allowed_ratings: ["G", "PG", "TV-Y", "TV-Y7", "TV-Y7-FV", "TV-G", "TV-PG"],
      /* Hidden in Kids Mode regardless of content rating - horror was the explicit ask;
         war/thriller are included as a reasonable default extension, adjust freely. */
      kids_mode_blocked_genres: ["Horror", "War", "Thriller"],
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

  /* True unless Kids Mode is on and this raw Plex metadata item (has .contentRating /
     .Genre, same shape everywhere in this file before _mapItem strips it down) fails
     the rating or genre check. Used as the single filter predicate everywhere raw items
     become candidates for display: genre rows, AI rows, hero picks, search, etc. */
  _passesKidsMode(m) {
    return passesKidsMode(m, {
      kidsMode: this._kidsMode,
      blockedGenres: this._config.kids_mode_blocked_genres || [],
      allowedRatings: this._config.kids_mode_allowed_ratings || [],
    });
  }

  /* Whole-row genre blocking, separate from _passesKidsMode's per-item Genre check.
     Plex's list endpoints (genre listing, /all?genre=) truncate each item's own Genre
     array to ~2 tags, so plenty of titles filed under e.g. Horror don't actually show
     "Horror" in their own truncated tag list (confirmed empirically: "The Conjuring:
     The Devil Made Me Do It" returns Genre [Thriller, Mystery], no Horror). A row built
     directly from a genre fetch is unambiguously that genre regardless of what its
     items' own tags say - checking the row's own genre name here is what actually keeps
     a "Horror" row from appearing at all in Kids Mode. */
  _isBlockedGenreName(name) {
    return isBlockedGenreName(name, { kidsMode: this._kidsMode, blockedGenres: this._config.kids_mode_blocked_genres || [] });
  }

  _onKidsModeChanged() {
    this._kidsToggleBtn?.classList.toggle("active", this._kidsMode);
    if (!this._loaded) return;
    /* Cached per-view genre/AI row shuffle needs to re-filter, not just re-shuffle. */
    this._genreRowsCache = {};
    if (this._currentView === "search") {
      if (this._lastSearchHubs) this._renderSearchPage(this._lastSearchHubs);
    } else {
      this._renderCurrentView();
      this._advanceHero();
    }
  }

  /* See src/card/pin.js's PinEntry for the shared numeric-keypad modal itself - Kids
     Mode's exit gate and the Plex profile switcher's PIN prompt (_verifyKidsPin/
     _switchToUser) both go through this one instance. */
  _promptForDigits(length, title) {
    return this._pin.prompt(length, title);
  }

  _shakePinEntry() {
    this._pin.shake();
  }

  /* Loops the shared PIN prompt until the Kids Mode PIN matches or the user cancels -
     this is where the "compare against kids_mode_pin" logic that used to live inside
     the keypad modal itself now lives, since the modal is generic. */
  async _verifyKidsPin() {
    const expected = String(this._config.kids_mode_pin || "");
    for (;;) {
      const entry = await this._promptForDigits(expected.length || 4, "Enter PIN to Exit Kids Mode");
      if (entry === null) return false;
      if (entry === expected) return true;
      this._shakePinEntry();
    }
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
    /* Purely local now (localStorage) - no HA entity backing this, so it's
       per-browser/per-device rather than shared across every screen. */
    this._kidsMode = localStorage.getItem("prism.kidsMode") === "1";
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
            <div class="nav-item nav-profile" title="Switch Profile" hidden tabindex="0">
              <span class="nav-icon nav-profile-icon"></span>
              <span class="nav-label nav-profile-label">Profile</span>
            </div>
            <div class="nav-item nav-kids-toggle" title="Kids Mode" tabindex="0">
              <span class="nav-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.7" cy="10" r="1.15" fill="currentColor"/><circle cx="15.3" cy="10" r="1.15" fill="currentColor"/><path d="M8 14.5c1 1.3 2.5 2 4 2s3-0.7 4-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
              <span class="nav-label">Kids Mode</span>
            </div>
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
            <div class="title-info-title"></div>
            <div class="title-info-meta"></div>
            <div class="title-info-actions">
              <button type="button" class="title-info-play">▶ Play</button>
              <button type="button" class="title-info-watchlist-btn" aria-label="Add to My List">+</button>
              <button type="button" class="title-info-quality-btn" aria-label="Quality" hidden>⚙</button>
            </div>
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
      <div class="quality-picker-overlay" tabindex="-1">
        <div class="quality-picker-modal">
          <div class="quality-picker-title">Quality</div>
          <div class="quality-picker-section-title">Version</div>
          <div class="quality-picker-versions"></div>
          <div class="quality-picker-section-title">Quality Cap</div>
          <div class="quality-picker-caps"></div>
          <button type="button" class="quality-picker-done">Done</button>
        </div>
      </div>
    `;
    this._rowsEl = this.shadowRoot.querySelector(".rows");
    this._searchWrap = this.shadowRoot.querySelector(".search-wrap");
    this._searchToggle = this.shadowRoot.querySelector(".search-toggle");
    this._searchInput = this.shadowRoot.querySelector(".search");
    this._renderNavSections();
    this._kidsToggleBtn = this.shadowRoot.querySelector(".nav-kids-toggle");
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
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      isInWatchlist: (item) => this._isInWatchlist(item),
      resolveLocalRatingKey: (item) => this._resolveLocalRatingKey(item),
      onAddToWatchlist: (item, btnEl) => this._addToWatchlist(item, btnEl),
      onRemoveFromWatchlist: (item, btnEl) => this._removeFromWatchlist(item, btnEl),
      onPlayItem: (item, opts) => this._playItem(item, opts),
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
      isBlockedGenreName: (name) => this._isBlockedGenreName(name),
      passesKidsMode: (m) => this._passesKidsMode(m),
    });

    /* Dynamic (per-library) nav items are already wired inside _renderNavSections,
       called above - only Home is static and needs wiring here. */
    this._wireNavItem(this.shadowRoot.querySelector('.nav-item[data-view="home"]'));

    this._kidsToggleBtn.addEventListener("click", async () => {
      /* Only exiting Kids Mode is PIN-gated - turning it on is always allowed. */
      if (this._kidsMode && this._config.kids_mode_pin) {
        const ok = await this._verifyKidsPin();
        if (!ok) return;
      }
      this._kidsMode = !this._kidsMode;
      localStorage.setItem("prism.kidsMode", this._kidsMode ? "1" : "0");
      this._onKidsModeChanged();
    });

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
       z-index (highest first) since more than one can theoretically be open at once
       (e.g. quality-picker over title-info). */
    App.addListener("backButton", () => {
      const settingsModal = document.querySelector("streaming-settings-modal");
      if (this._titleInfo.isQualityPickerOpen()) this._titleInfo.closeQualityPicker();
      else if (this._titleInfo.isOpen()) this._titleInfo.close();
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
    el.addEventListener("click", () => {
      const view = el.dataset.view;
      this._clearSearchInput();
      this._searchWrap.classList.remove("expanded");
      if (view === this._currentView) return;
      this._currentView = view;
      this._navItems.forEach((n) => n.classList.toggle("active", n === el));
      window.scrollTo({ top: 0, behavior: "instant" });
      this._renderCurrentView();
      this._advanceHero();
    });
  }

  /* Renders one nav tab per fetched library (config.sections) instead of fixed
     Movies/TV entries - lets Settings' "Fetch Libraries" list drive the tabs
     directly, so it naturally covers however many/whatever-named libraries the
     server actually has. Re-run on every setConfig() after the initial build (see
     setConfig) so re-fetching/renaming/toggling libraries in Settings updates the
     nav without a full rebuild. Home stays a separate static item since it's the
     fixed "everything combined" view, not tied to any one section. */
  _renderNavSections() {
    const homeItem = this.shadowRoot.querySelector('.nav-item[data-view="home"]');
    this.shadowRoot.querySelectorAll(".nav-item-dynamic").forEach((el) => el.remove());
    const sections = this._config.sections || [];
    const html = sections
      .map(
        (s, i) => `
            <div class="nav-item nav-item-dynamic${i >= MOBILE_VISIBLE_SECTION_CAP ? " nav-item-overflow" : ""}" data-view="section-${s.key}" tabindex="0">
              <span class="nav-icon">${iconForLibraryLabel(s.label)}</span>
              <span class="nav-label">${this._escape(s.label)}</span>
            </div>`
      )
      .join("");
    if (html) homeItem.insertAdjacentHTML("afterend", html);
    this._navItems = [...this.shadowRoot.querySelectorAll(".nav-item[data-view]")];
    this.shadowRoot.querySelectorAll(".nav-item-dynamic").forEach((el) => this._wireNavItem(el));
    if (this._currentView !== "home" && this._currentView !== "search" && !sections.some((s) => `section-${s.key}` === this._currentView)) {
      this._currentView = "home";
    }
    this._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === this._currentView));
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

  async _plexFetch(path, params = {}) {
    const url = new URL(this._config.plex_url + path);
    Object.entries(params).forEach(([k, v]) => {
      /* Plex ANDs repeated same-key filter params (e.g. two `genre=` keys) rather
         than ORing them - array values let AI-generated multi-genre rows use that. */
      if (Array.isArray(v)) v.forEach((vv) => url.searchParams.append(k, vv));
      else url.searchParams.set(k, v);
    });
    url.searchParams.set("X-Plex-Token", this._config.plex_token);
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Plex ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async _loadAll() {
    if (!this._config.plex_url || !this._config.plex_token) {
      this._renderMessage("Open Settings to add your Plex server URL and token.");
      return;
    }
    if (!this._config.sections || !this._config.sections.length) {
      this._renderMessage('Open Settings and click "Fetch Libraries" to choose what to show.');
      return;
    }
    this._renderLoading();
    try {
      const [
        onDeckRaw,
        watchlistRaw,
        recentlyAddedRaw,
        genreBySection,
        searchFacets,
        historyRaw,
        collectionsRaw,
        playlistsRaw,
        homeProfiles,
      ] = await Promise.all([
        this._fetchOnDeckRaw(),
        this._fetchWatchlistRaw(),
        this._fetchRecentlyAddedRaw(),
        this._loadGenreDataBySection(),
        this._loadSearchFacets(),
        this._fetchWatchHistoryRaw(),
        this._fetchCollectionsRaw(),
        this._fetchPlaylistsRaw(),
        this._fetchHomeProfiles(),
      ]);
      this._onDeckRaw = onDeckRaw;
      this._watchlistRaw = watchlistRaw;
      this._recentlyAddedRaw = recentlyAddedRaw;
      this._genreBySection = genreBySection;
      this._genreRowsCache = {};
      this._recommendedRowCache = {};
      this._studioFacets = searchFacets.studios;
      this._collectionFacets = searchFacets.collections;
      this._collectionsRaw = collectionsRaw;
      this._playlistsRaw = playlistsRaw;
      this._homeUsers = homeProfiles.users;
      this._activeUserId = homeProfiles.activeId;
      this._renderProfileNav();
      const rowCount = this._config.collection_row_count ?? 0;
      this._collectionRowPicks = this._shuffle(this._collectionsRaw).slice(0, rowCount);
      this._collectionRowsRaw = await this._fetchCollectionRowItems(this._collectionRowPicks);
      this._recommendedRaw = this._buildRecommendedRaw(historyRaw);
      this._popularRaw = this._buildPopularRaw();
      const aiIdeas = await this._loadAiIdeas();
      this._aiRowsRaw = aiIdeas.length ? await this._fetchAiRowsRaw(aiIdeas) : [];
      await this._hero.loadInitialItem(this._sectionsForView(this._currentView));
      this._renderCurrentView();
    } catch (err) {
      this._renderMessage(`Couldn't load Plex: ${err.message}`);
    }
  }

  /* "home"/"search" (or any unrecognized view) fall through to null, meaning "no
     single section" - callers treat that as "all sections". */
  _sectionForView(view) {
    if (typeof view !== "string" || !view.startsWith("section-")) return null;
    const key = Number(view.slice("section-".length));
    return (this._config.sections || []).find((s) => s.key === key) || null;
  }

  _sectionsForView(view) {
    const section = this._sectionForView(view);
    return section ? [section] : this._config.sections;
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

  _advanceHero() {
    return this._hero.advance();
  }

  _showHero(preserveMute = false, crossfade = false) {
    this._hero.show(preserveMute, crossfade);
  }

  _renderCurrentView() {
    const view = this._currentView || "home";
    this._showHero();
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
      .filter((m) => this._passesKidsMode(m))
      .map((m) => this._mapItem(m, true));
    const watchlist = (this._watchlistRaw || [])
      .filter(watchlistFilter)
      .filter((m) => this._passesKidsMode(m))
      .map((m) => this._mapItem(m, false));
    const recentlyAdded = (this._recentlyAddedRaw || [])
      .filter(recentlyAddedFilter)
      .filter((m) => this._passesKidsMode(m))
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
      .slice(0, this._config.row_size)
      .map((m) => this._mapItem(m, false));
    const recommended = this._getRecommendedForView(view, recommendedFilter)
      .filter((m) => this._passesKidsMode(m))
      .map((m) => this._mapItem(m, false));
    const popular = (this._popularRaw || [])
      .filter(popularFilter)
      .filter((m) => this._passesKidsMode(m))
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
    this._renderRows(rows);
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
      .filter((m) => this._passesKidsMode(m))
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

  _getCollectionsRowForView(sections) {
    if (this._kidsMode) return null;
    const keys = new Set(sections.map((s) => s.key));
    const collections = (this._collectionsRaw || []).filter((c) => keys.has(c.section.key));
    if (!collections.length) return null;
    const items = collections.map((c) => ({
      ratingKey: c.ratingKey,
      type: "collection",
      title: c.title,
      subtitle: c.childCount ? `${c.childCount} titles` : "",
      image: this._plexImageUrl(c.thumb),
      art: this._plexImageUrl(c.thumb),
    }));
    return { title: "Collections", items, source: "local" };
  }

  _getPlaylistsRowForView(view) {
    if (this._kidsMode) return null;
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
      image: this._plexImageUrl(p.composite),
      art: this._plexImageUrl(p.composite),
    }));
    return { title: "Playlists", items, source: "local" };
  }

  async _fetchOnDeckRaw() {
    try {
      const data = await this._plexFetch("/library/onDeck");
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
  }

  async _fetchWatchlistRaw() {
    try {
      const url = new URL("https://discover.provider.plex.tv/library/sections/watchlist/all");
      /* discover.provider.plex.tv is plex.tv's account-level Discover service, not the
         local server - it needs the account token (plex_account_token), not the
         server-specific plex_token, so this scopes correctly per switched Home profile
         instead of always reflecting whichever profile originally signed in. */
      url.searchParams.set("X-Plex-Token", this._config.plex_account_token);
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) return [];
      const data = await res.json();
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
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
     Kids Mode/Settings/library-switch behavior a second time. */
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
    addRow("Kids Mode", this._kidsToggleBtn.querySelector(".nav-icon").innerHTML, this._kidsMode, this._kidsToggleBtn);
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

  /* The home screen (sidenav + hero + a 2D grid of poster rows) isn't a single list -
     wireLinearNav's 1D model doesn't cover "Left/Right moves within whichever row
     currently has focus, Up/Down moves between rows while roughly preserving column
     position." Scoped by checking active-element membership first, so it never fires
     while a modal overlay (which registers its own handler elsewhere) currently owns
     focus - only one handler ever actually acts on a given keypress since focus is a
     singleton. */
  _wireHomeNav() {
    const sidenavItems = () =>
      Array.from(this.shadowRoot.querySelectorAll(".nav-item")).filter((el) => el.offsetParent !== null);
    const heroItems = () =>
      Array.from(this.shadowRoot.querySelectorAll(".hero-info-btn, .hero-watchlist-btn, .hero-play-btn, .hero-mute-btn")).filter(
        (el) => el.offsetParent !== null
      );
    const rowSections = () =>
      Array.from(this.shadowRoot.querySelectorAll(".row-section")).filter((s) => s.offsetParent !== null);
    const postersIn = (section) =>
      section ? Array.from(section.querySelectorAll(".poster")).filter((el) => el.offsetParent !== null) : [];

    registerNavHandler((command, e, active) => {
      const inSidenav = sidenavItems().includes(active);
      const inHero = !inSidenav && heroItems().includes(active);
      const posterSection = !inSidenav && !inHero && active?.classList?.contains("poster") ? active.closest(".row-section") : null;

      if (!inSidenav && !inHero && !posterSection) {
        /* Every registered handler sees every keydown regardless of which one owns
           focus - a handler returning false here must NOT assume that means "nothing is
           focused," only "not focused in my scope" (a modal overlay's own handler may
           legitimately own this keypress instead). Only the true fresh-load case (no
           active element anywhere, or it's just document.body/the card host with
           nothing focused inside) gets the lazy first-D-pad-press starting point;
           anything else falls through untouched, letting the real owner act instead of
           this handler stealing focus mid-interaction with some other overlay. */
        const nothingFocusedYet = !active || active === document.body || active === this;
        if (nothingFocusedYet && ["up", "down", "left", "right"].includes(command)) {
          sidenavItems()[0]?.focus();
          return true;
        }
        return false;
      }

      if (command === "activate") {
        active.click();
        return true;
      }

      if (inSidenav) {
        const list = sidenavItems();
        const idx = list.indexOf(active);
        if (command === "down") {
          list[Math.min(idx + 1, list.length - 1)].focus();
          return true;
        }
        if (command === "up") {
          list[Math.max(idx - 1, 0)].focus();
          return true;
        }
        if (command === "right") {
          const target = heroItems()[0] || postersIn(rowSections()[0])[0];
          target?.focus();
          return true;
        }
        return false;
      }

      if (inHero) {
        const list = heroItems();
        const idx = list.indexOf(active);
        if (command === "right") {
          list[Math.min(idx + 1, list.length - 1)].focus();
          return true;
        }
        if (command === "left") {
          if (idx <= 0) sidenavItems()[0]?.focus();
          else list[idx - 1].focus();
          return true;
        }
        if (command === "down") {
          postersIn(rowSections()[0])[0]?.focus();
          return true;
        }
        if (command === "up") return true; // nothing above the hero - swallow, don't fall through
        return false;
      }

      // posterSection
      const posters = postersIn(posterSection);
      const idx = posters.indexOf(active);
      if (command === "right") {
        posters[Math.min(idx + 1, posters.length - 1)].focus();
        return true;
      }
      if (command === "left") {
        if (idx <= 0) sidenavItems()[0]?.focus();
        else posters[idx - 1].focus();
        return true;
      }
      if (command === "down" || command === "up") {
        const sections = rowSections();
        const sectionIdx = sections.indexOf(posterSection);
        if (command === "up" && sectionIdx === 0) {
          heroItems()[0]?.focus();
          return true;
        }
        const targetSection = sections[sectionIdx + (command === "down" ? 1 : -1)];
        if (!targetSection) return true; // no more rows that way - swallow
        const targetPosters = postersIn(targetSection);
        const target = targetPosters[Math.min(idx, targetPosters.length - 1)];
        target?.focus();
        target?.scrollIntoView({ block: "nearest", inline: "center" });
        return true;
      }
      return false;
    });
  }

  /* Prefers the shared player (native on Android, <video>+hls.js everywhere else - see
     plex-player.js) and only falls back to handing off via _tapUrl (native Plex app /
     Plex web player) when playback fails to start - e.g. a watchlist item with no local
     ratingKey, which player.play rejects by design. Shared by the title-info modal's
     Play button and the episode list's direct-play rows. */
  async _playItem(item, { durationMs = null, startOffsetMs = 0, source, markers = [], chapters = [], mediaIndex = 0, qualityCapKbps = null, audioStreams = [] } = {}) {
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
        qualityCapKbps,
        audioStreams,
        /* Already produced by _mapItem for every call site - title is the show's own
           title (not the episode's) for episode items, which is what a subtitle search
           query needs to key off, not the individual episode title. */
        title: item.title,
        year: item.year,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        /* Drives plex-player.js's shader auto-detection (anime vs. live-action) - see
           _mapItem/_renderTitleInfoDetail for where this gets resolved. */
        genres: item.genres || [],
      });
      return;
    } catch (e) {
      // fall through to the deep-link fallback below
    }
    window.open(this._tapUrl(item, source), "_blank");
  }

  /* Protected profiles get prompted through the same numeric-keypad modal Kids Mode
     uses to exit (see _promptForDigits/_verifyKidsPin above) instead of a plain text
     input - one PIN-entry UI in the app, not two. Unlike Kids Mode, a wrong entry here
     isn't retried automatically: only Plex can say whether it was right, so a rejected
     PIN just reports the error and leaves the user to press "Switch" again. */
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

  async _fetchWatchHistoryRaw() {
    try {
      const data = await this._plexFetch("/status/sessions/history/all", {
        sort: "viewedAt:desc",
        "X-Plex-Container-Size": 500,
      });
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
  }

  async _fetchRecentlyAddedRaw() {
    const rowSize = this._config.row_size;
    const perSection = await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/all`, {
            type: s.type,
            sort: "addedAt:desc",
            "X-Plex-Container-Size": rowSize,
          });
          return data?.MediaContainer?.Metadata || [];
        } catch (e) {
          return [];
        }
      })
    );
    return perSection.flat();
  }

  async _fetchCollectionsRaw() {
    /* Deliberately NOT the /library/sections/{key}/collection (singular) endpoint used by
       _loadSearchFacets below - that one is Plex's filter-facet listing and only returns
       {key, title}, no ratingKey/thumb/childCount. The real collection objects (with
       posters) live at the plural /collections endpoint, under MediaContainer.Metadata.
       No `type` param here, deliberately - passing the section's type (e.g. 1 for movie)
       makes Plex return every movie in the section instead of the collection objects
       themselves (confirmed empirically), unlike every other endpoint in this file. */
    const perSection = await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/collections`);
          return (data?.MediaContainer?.Metadata || []).map((d) => ({ ...d, section: s }));
        } catch (e) {
          return [];
        }
      })
    );
    return perSection.flat();
  }

  /* Fetches actual movie items for a handful of randomly-picked real Plex Collections
     (picked fresh in _loadAll each real page load) so they can be mixed in as their own
     titled rows - title = collection name, items = its movies - alongside genre/AI rows.
     Uses the dedicated /library/collections/{ratingKey}/children endpoint, NOT a
     `collection=` filter param against /all - confirmed empirically that the latter does
     NOT filter by the collection at all (it silently matched a single unrelated movie
     instead of the collection's real members). The children endpoint also doesn't respect
     sort/X-Plex-Container-Size query params (tested), but returns items in a sensible
     built-in order (chronological/release order) already, and row-size slicing happens
     client-side in _buildCollectionRows anyway, so no params are needed here. */
  async _fetchCollectionRowItems(picks) {
    const results = await Promise.all(
      picks.map(async (c) => {
        try {
          const data = await this._plexFetch(`/library/collections/${c.ratingKey}/children`);
          return { title: c.title, items: data?.MediaContainer?.Metadata || [] };
        } catch (e) {
          return { title: c.title, items: [] };
        }
      })
    );
    return results.filter((r) => r.items.length);
  }

  async _fetchPlaylistsRaw() {
    /* Server-wide endpoint, not per-section like collections - a playlist can span
       multiple libraries. Posters live under `composite`, not `thumb` (confirmed via
       raw JSON, unlike every other item type in this file). Filtered to playlistType
       "video" since this dashboard has no audio/music sections configured. */
    try {
      const data = await this._plexFetch("/playlists");
      return (data?.MediaContainer?.Metadata || []).filter((p) => p.playlistType === "video");
    } catch (e) {
      return [];
    }
  }

  async _loadSearchFacets() {
    const studios = [];
    const collections = [];
    await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/studio`, { type: s.type });
          for (const d of data?.MediaContainer?.Directory || []) {
            studios.push({ title: d.title, key: d.key, section: s });
          }
        } catch (e) {}
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/collection`, { type: s.type });
          for (const d of data?.MediaContainer?.Directory || []) {
            collections.push({ title: d.title, key: d.key, section: s });
          }
        } catch (e) {}
      })
    );
    return { studios, collections };
  }

  async _loadGenreDataBySection() {
    const sections = this._config.sections;
    const rowSize = this._config.row_size;
    const result = new Map();

    await Promise.all(
      sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/genre`, { type: s.type });
          const genres = data?.MediaContainer?.Directory || [];
          const perGenre = await Promise.all(
            genres.map(async (g) => {
              try {
                const gdata = await this._plexFetch(`/library/sections/${s.key}/all`, {
                  type: s.type,
                  genre: g.key,
                  sort: "addedAt:desc",
                  "X-Plex-Container-Size": rowSize,
                });
                const mc = gdata?.MediaContainer || {};
                return { title: g.title, key: g.key, items: mc.Metadata || [], totalSize: mc.totalSize ?? mc.size ?? 0 };
              } catch (e) {
                return { title: g.title, key: g.key, items: [], totalSize: 0 };
              }
            })
          );
          result.set(s.key, perGenre);
        } catch (e) {
          result.set(s.key, []);
        }
      })
    );

    return result;
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

  _buildCollectionRows(view) {
    return buildCollectionRows(this._collectionRowsRaw, this._typeFilterForView(view), {
      passesKidsMode: (m) => this._passesKidsMode(m),
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      rowSize: this._config.row_size,
    });
  }

  _buildAiRows(view) {
    return buildAiRows(this._aiRowsRaw, this._typeFilterForView(view), {
      isBlockedGenreName: (name) => this._isBlockedGenreName(name),
      passesKidsMode: (m) => this._passesKidsMode(m),
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      rowSize: this._config.row_size,
    });
  }

  /* The model is asked for strict JSON but may still wrap it in a code fence or
     return junk, so this validates everything regardless of source. */
  _parseAiSectionIdeas(raw) {
    return parseAiSectionIdeas(raw);
  }

  /* AI row ideas, fetched directly from OpenRouter with the user's own key (Settings)
     and cached in localStorage - no server/HA dependency. Falls back to the last good
     cache entry on any fetch/parse error rather than dropping the feature for the
     session, and skips the network entirely with no key configured. */
  async _loadAiIdeas() {
    const key = this._config.openrouter_api_key;
    if (!key) return [];
    const cacheKey = "prism.aiIdeasCache";
    const cadenceMs = this._config.ai_rows_cadence_ms;
    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    } catch (e) {
      cached = null;
    }
    if (cached && Array.isArray(cached.ideas) && Date.now() - cached.fetchedAt < cadenceMs) {
      return cached.ideas;
    }
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/llama-3.1-8b-instruct",
          messages: [
            {
              role: "user",
              content:
                "Generate a JSON array of exactly 10 objects. Each object must have a label field (a short catchy row title, 2 to 5 words) and a genres field (an array of 1 or 2 genre words drawn only from this list: Action, Adventure, Animation, Anime, Biography, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Musical, Mystery, Romance, Sci-Fi, Sport, Suspense, Thriller, War, Western). About half the ideas should combine two different genres for interesting mixes, for example Sci-Fi Comedy would have genres Sci-Fi and Comedy. Respond with ONLY the raw JSON array. No markdown code fences. No explanation. No extra text before or after the array.",
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
      const data = await res.json();
      const ideas = this._parseAiSectionIdeas(data?.choices?.[0]?.message?.content);
      if (ideas.length) localStorage.setItem(cacheKey, JSON.stringify({ ideas, fetchedAt: Date.now() }));
      return ideas;
    } catch (e) {
      return (cached && cached.ideas) || [];
    }
  }

  async _fetchAiRowsRaw(ideas) {
    const rowSize = this._config.row_size;
    const results = await Promise.all(
      ideas.map(async (idea) => {
        const perSection = await Promise.all(
          this._config.sections.map(async (s) => {
            const genreEntries = (this._genreBySection && this._genreBySection.get(s.key)) || [];
            const keys = idea.genres.map((g) => {
              const norm = g.trim().toLowerCase();
              const match = genreEntries.find((e) => e.title.trim().toLowerCase() === norm);
              return match ? match.key : null;
            });
            if (keys.some((k) => !k)) return [];
            try {
              const data = await this._plexFetch(`/library/sections/${s.key}/all`, {
                type: s.type,
                genre: keys,
                sort: "addedAt:desc",
                "X-Plex-Container-Size": rowSize,
              });
              return data?.MediaContainer?.Metadata || [];
            } catch (e) {
              return [];
            }
          })
        );
        return { label: idea.label, genres: idea.genres, items: perSection.flat() };
      })
    );
    return results.filter((r) => r.items.length);
  }

  _mergeGenreRows(sections) {
    return mergeGenreRows(sections, {
      genreBySection: this._genreBySection,
      isBlockedGenreName: (name) => this._isBlockedGenreName(name),
      passesKidsMode: (m) => this._passesKidsMode(m),
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
      episodeFallbackGenres: this._titleInfo?.item?.genres || [],
    });
  }

  _slugify(text) {
    return slugify(text);
  }

  _isAndroid() {
    return isAndroidUserAgent(navigator.userAgent);
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

  _renderRows(rows) {
    renderRows(this._rowsEl, rows, this._config.landscape_every_nth, this._rowCtx);
  }

  _buildRowSection(row, landscape = false, rowIndex = 0) {
    return buildRowSection(row, landscape, rowIndex, this._rowCtx);
  }

  _buildScrollArrow(dir, scroller) {
    return buildScrollArrow(dir, scroller);
  }

  _wireArrowVisibility(scroller, leftArrow, rightArrow) {
    return wireArrowVisibility(scroller, leftArrow, rightArrow);
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
    clearTimeout(this._searchTimer);
    const q = this._searchInput.value.trim();
    if (!q) {
      this._exitSearch();
      return;
    }
    if (this._currentView !== "search") this._enterSearch();
    this._searchTimer = setTimeout(() => this._runSearch(q), 300);
  }

  _enterSearch() {
    this._preSearchView = this._currentView;
    this._currentView = "search";
    this._navItems.forEach((n) => n.classList.remove("active"));
    this._showHero();
    this._renderLoading();
  }

  _exitSearch() {
    if (this._currentView !== "search") return;
    this._currentView = this._preSearchView || "home";
    this._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === this._currentView));
    this._renderCurrentView();
    this._advanceHero();
  }

  async _runSearch(q) {
    try {
      const hubs = await this._buildSearchHubs(q, SEARCH_HUB_LIMIT, this._config.row_size);
      if (this._currentView !== "search") return;
      this._lastSearchQuery = q;
      this._lastSearchHubs = hubs;
      this._renderSearchPage(hubs);
    } catch (e) {
      if (this._currentView !== "search") return;
      this._rowsEl.innerHTML = `<div class="empty">${this._emptyStateHtml("Search failed")}</div>`;
    }
  }

  /* Shared by both the normal (capped) search page and "See All" section expansion -
     the two differ only in the limits passed to Plex's hub search and to the
     locally-built genre/year/facet hubs. */
  async _buildSearchHubs(q, hubLimit, rowLimit) {
    /* /hubs/search ignores X-Plex-Container-Size for its per-hub result count (silently
       caps at 3 regardless of that value) - the real per-hub limit param is `limit`,
       confirmed empirically. */
    const data = await this._plexFetch("/hubs/search", { query: q, limit: hubLimit });
    const hubs = (data?.MediaContainer?.Hub || []).filter((h) => (h.Metadata || []).length);
    const reasonHubs = this._buildReasonMatchHubs(hubs, hubLimit);
    const otherHubs = hubs
      .map((h) => {
        const rawLen = (h.Metadata || []).length;
        return {
          ...h,
          Metadata: (h.Metadata || []).filter((m) => !SEARCH_REASON_LABELS[m.reason]),
          /* /hubs/search DOES honor `limit` (unlike X-Plex-Container-Size elsewhere), so
             hitting it exactly is a reliable "there may be more" signal - there's no
             per-hub totalSize in this response to check precisely. */
          hasMore: rawLen >= hubLimit,
        };
      })
      .filter((h) => h.Metadata.length);
    const genreHubs = this._buildGenreMatchHubs(q, rowLimit);
    const yearHubs = await this._buildYearMatchHubs(q, rowLimit);
    const facetHubs = await this._buildFacetMatchHubs(q, rowLimit);
    return [...otherHubs, ...reasonHubs, ...genreHubs, ...yearHubs, ...facetHubs];
  }

  async _expandSearchSection(title) {
    const q = this._lastSearchQuery;
    if (!q) return;
    this._renderLoading();
    try {
      const hubs = await this._buildSearchHubs(q, SEARCH_EXPAND_LIMIT, SEARCH_EXPAND_LIMIT);
      if (this._currentView !== "search") return;
      const hub = hubs.find((h) => h.title === title);
      this._renderSearchPage(hub ? [hub] : [], { expanded: true });
    } catch (e) {
      if (this._currentView !== "search") return;
      this._rowsEl.innerHTML = `<div class="empty">${this._emptyStateHtml("Search failed")}</div>`;
    }
  }

  _buildGenreMatchHubs(query, limit) {
    return buildGenreMatchHubs(query, limit, {
      genreBySection: this._genreBySection,
      isBlockedGenreName: (name) => this._isBlockedGenreName(name),
    });
  }

  _parseYearQuery(query) {
    return parseYearQuery(query);
  }

  async _buildYearMatchHubs(query, limit) {
    const range = this._parseYearQuery(query);
    if (!range) return [];
    const [start, end] = range;
    /* Plex's advanced filter operators (>>/<< on the field name) are strict
       inequalities, so an inclusive range needs the bounds nudged by one -
       confirmed empirically against this server (year>>1989&year<<1996 returns
       exactly 1990-1995). */
    const yearParams = start === end ? { year: start } : { "year>>": start - 1, "year<<": end + 1 };
    const perSection = await Promise.all(
      this._config.sections.map(async (s) => {
        try {
          const data = await this._plexFetch(`/library/sections/${s.key}/all`, {
            type: s.type,
            "X-Plex-Container-Size": limit,
            ...yearParams,
          });
          return data?.MediaContainer?.Metadata || [];
        } catch (e) {
          return [];
        }
      })
    );
    const items = perSection.flat();
    if (!items.length) return [];
    const title = start === end ? `Year ${start}` : `Year ${start}–${end}`;
    /* X-Plex-Container-Size is silently ignored on /library/sections/{key}/all (confirmed
       empirically, same as the /hubs/search quirk noted above) - Plex already returned
       the full matching set here, so `items.length` is the true total, not just what
       got requested, and the slice below is the only thing actually capping this row. */
    return [{ title, Metadata: items.slice(0, limit), hasMore: items.length > limit }];
  }

  async _buildFacetMatchHubs(query, limit) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const matchFacets = (facets) => (facets || []).filter((f) => f.title.toLowerCase().includes(q));
    const jobs = [
      ...matchFacets(this._studioFacets).map((facet) => ({ facet, filterName: "studio", label: "Studio" })),
      ...matchFacets(this._collectionFacets).map((facet) => ({ facet, filterName: "collection", label: "Collection" })),
    ];
    const hubs = await Promise.all(
      jobs.map(async ({ facet, filterName, label }) => {
        const items = await this._fetchByFacet(facet, filterName, limit);
        /* _fetchByFacet already returns everything Plex has for this facet (see its
           comment - X-Plex-Container-Size is ignored server-side and nothing slices
           the result afterward), so there's never anything left to reveal via "See All". */
        if (!items.length) return null;
        const hub = { title: `${label} "${facet.title}"`, Metadata: items, hasMore: false };
        if (filterName === "collection") {
          /* facet comes from the singular /collection facet-listing endpoint, which has
             no thumb - look the real poster up by title from the plural /collections
             fetch (_fetchCollectionsRaw) instead, matched within the same section. */
          const match = (this._collectionsRaw || []).find(
            (c) => c.section.key === facet.section.key && c.title === facet.title
          );
          if (match?.thumb) hub.image = this._plexImageUrl(match.thumb);
        }
        return hub;
      })
    );
    return hubs.filter(Boolean);
  }

  async _fetchByFacet(facet, filterName, limit) {
    try {
      /* facet.key comes back from Plex's own /studio and /collection directory listings
         already percent-escaped for direct reuse as a filter value (double-escaped for
         studio names with spaces, e.g. "Marvel%2520Studios") - it must be appended to the
         URL as-is, not passed through URLSearchParams/searchParams.set, which would
         re-encode the literal "%" characters and break the match. */
      const base = new URL(`${this._config.plex_url}/library/sections/${facet.section.key}/all`);
      base.searchParams.set("type", facet.section.type);
      base.searchParams.set("X-Plex-Container-Size", limit);
      base.searchParams.set("X-Plex-Token", this._config.plex_token);
      const res = await fetch(`${base.toString()}&${filterName}=${facet.key}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data?.MediaContainer?.Metadata || [];
    } catch (e) {
      return [];
    }
  }

  _buildReasonMatchHubs(hubs, hubLimit) {
    return buildReasonMatchHubs(hubs, hubLimit);
  }

  _renderSearchPage(hubs, { expanded = false } = {}) {
    /* Filtered here rather than at each hub-building function (reason/genre/year/facet
       hubs all funnel through this one render call) so Kids Mode covers search with a
       single change, and re-rendering from the cached _lastSearchHubs (Back button,
       or a Kids Mode toggle mid-search) always re-applies the current filter live. */
    const visibleHubs = hubs
      .map((hub) => ({ ...hub, Metadata: (hub.Metadata || []).filter((m) => this._passesKidsMode(m)) }))
      .filter((hub) => hub.Metadata.length);
    if (!visibleHubs.length) {
      this._rowsEl.innerHTML = `<div class="empty">${this._emptyStateHtml("No results")}</div>`;
      return;
    }
    const page = document.createElement("div");
    page.className = "search-page";
    if (expanded) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "search-page-back";
      back.textContent = "← Back to all results";
      back.addEventListener("click", () => {
        if (this._lastSearchHubs) this._renderSearchPage(this._lastSearchHubs);
      });
      page.appendChild(back);
    }
    for (const hub of visibleHubs) {
      const group = document.createElement("div");
      group.className = "search-page-group";
      const header = document.createElement("div");
      header.className = "search-page-group-header";
      const h = document.createElement("div");
      h.className = "search-page-group-title";
      h.textContent = hub.title;
      if (hub.image) {
        const titleWrap = document.createElement("div");
        titleWrap.className = "search-page-group-title-wrap";
        const img = document.createElement("img");
        img.className = "search-page-group-image";
        img.src = hub.image;
        img.alt = "";
        titleWrap.appendChild(img);
        titleWrap.appendChild(h);
        header.appendChild(titleWrap);
      } else {
        header.appendChild(h);
      }
      if (!expanded && hub.hasMore) {
        const seeAll = document.createElement("button");
        seeAll.type = "button";
        seeAll.className = "search-page-see-all";
        seeAll.textContent = "See All";
        seeAll.addEventListener("click", () => this._expandSearchSection(hub.title));
        header.appendChild(seeAll);
      }
      group.appendChild(header);
      const grid = document.createElement("div");
      grid.className = "search-page-grid";
      for (const m of hub.Metadata || []) {
        const item = this._mapItem(m, false);
        grid.appendChild(this._buildPoster(item, "local"));
      }
      group.appendChild(grid);
      page.appendChild(group);
    }
    this._rowsEl.innerHTML = "";
    this._rowsEl.appendChild(page);
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
