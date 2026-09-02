import { wireLinearNav, focusAfterPaint, reflectControllerActive } from "../core/focus-nav.js";
import { APP_EVENT, VIEW, SECTION_TYPE } from "../constants.js";
import { App } from "@capacitor/app";
import { player } from "../player/player.js";
import { tapUrl } from "./logic/deep-link.js";
import { isInWatchlist, findLocalMatch } from "./logic/watchlist-match.js";
import { dedupeSourcesByServer } from "./logic/cross-server.js";
import {
  shuffle,
  mapItem,
  mergeGenreRows,
  buildRecommendedRaw,
  buildPopularRaw,
  buildCollectionRows,
  buildAiRows,
} from "./logic/catalog.js";
import { paintWatchlistButton, addToWatchlist, removeFromWatchlist } from "./watchlist.js";
import { WATCHED_ICON_SVG, DOWNLOAD_ICON_SVG, renderRows, buildRowSection, wireArrowVisibility } from "./rows.js";
import { createRowScroll } from "./row-scroll.js";
import { PinEntry } from "./pin.js";
import { renderMoreSheet } from "./more-sheet.js";
import { renderProfileNav, renderProfileList, switchToUser, PROFILE_ICON_SVG } from "./profile.js";
import { TitleInfoController } from "./title-info.js";
import { HeroController, PAUSE_ICON_SVG } from "./hero.js";
import {
  findOnServer,
  plexFetch,
  loadAll,
  sectionForView,
  sectionsForView,
  fetchWatchlistRaw,
  fetchOnDeckRaw,
  primaryServer,
  serverForSection,
  activeServers,
} from "./data.js";
import { onSearchInput, exitSearch, openRowSeeMore } from "./search-page.js";
import {
  wireNavItem,
  renderNavSections,
  wireHeaderNav,
  wireHomeNav,
  wireSearchNav,
  wireTabSwitch,
  wireSearchToggle,
  wireVirtualKeyboardDismiss,
  wireStartButton,
  wireProfileButton,
  wireProfileMenu,
  restoreFocusAfterSearch,
  dismissSearchKeyboard,
} from "./nav.js";

import hostResetCss from "./styles/host-reset.css?inline";
import sidenavCss from "./styles/sidenav.css?inline";
import heroCss from "./styles/hero.css?inline";
import headerSearchCss from "./styles/header-search.css?inline";
import headerNavCss from "./styles/header-nav.css?inline";
import rowsPosterCss from "./styles/rows-poster.css?inline";
import pinModalCss from "./styles/pin-modal.css?inline";
import profileCss from "./styles/profile.css?inline";
import moreSheetCss from "./styles/more-sheet.css?inline";
import titleInfoCss from "./styles/title-info.css?inline";
import sharedFocusCss from "./styles/shared-focus.css?inline";
import responsiveCss from "./styles/responsive.css?inline";

const STYLE = [
  hostResetCss,
  sidenavCss,
  heroCss,
  headerSearchCss,
  headerNavCss,
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

/* Row "See More" re-fetch limit (genre/AI rows - see _loadGenreRowFull/
   _loadAiRowFull) - same value and "large enough that no row's
   true total realistically hits it" reasoning as search-page.js's own
   SEARCH_EXPAND_LIMIT for its "See All" section expansion. */
const ROW_SEE_MORE_LIMIT = 500;


const SEARCH_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="16.2" y1="16.2" x2="21" y2="21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const CLEAR_ICON_SVG =
  '<svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MORE_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/></svg>';
const LIBRARIES_ICON_SVG =
  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="13" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

class PlexNetflixCard extends HTMLElement {
  /* No required fields: this can be called with an empty/partial config (first run, nothing
     in Settings yet) and renders a "go configure me" message rather than throwing. */
  setConfig(config) {
    this._config = {
      max_genre_rows: 12,
      collection_row_count: 2,
      row_size: 20,
      sections: [],
      title: "Streaming",
      landscape_every_nth: 4,
      ai_rows_cadence_ms: 7 * 24 * 60 * 60 * 1000,
      trailers_enabled: true,
      title_trailers_enabled: true,
      ai_rows_enabled: true,
      ...config,
    };
    if (!this._built) {
      this._build();
      this._built = true;
    } else {
      renderNavSections(this);
    }
  }

  /* Public entry point for Settings modal saves (see app.js) - re-merges config and
     re-runs the full load, since _loadAll() otherwise only ever fires once per
     connectedCallback (see _loaded guard there). */
  refreshConfig(config) {
    this.setConfig(config);
    this._loaded = true;
    loadAll(this);
  }



  getCardSize() {
    return 12;
  }

  connectedCallback() {
    if (!this._loaded) {
      this._loaded = true;
      loadAll(this);
    }
  }

  _build() {
    this._currentView = this._config.default_view || "home";
    this._lastSearchQuery = null;
    this._lastSearchHubs = null;
    this._searchSeq = 0;
    reflectControllerActive(this);
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <div class="wrap">
        <nav class="sidenav">
          <div class="nav-top">
            <div class="nav-item active" data-view="${VIEW.HOME}" tabindex="0">
              <span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v9h12v-9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="10" y="14" width="4" height="5" fill="currentColor"/></svg></span>
              <span class="nav-label">Home</span>
            </div>
            <div class="nav-item nav-libraries" title="Libraries" tabindex="0">
              <span class="nav-icon">${LIBRARIES_ICON_SVG}</span>
              <span class="nav-label">Libraries</span>
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
        <div class="libraries-overlay" tabindex="-1">
          <div class="more-sheet">
            <div class="more-sheet-title">Libraries</div>
            <div class="libraries-sheet-list more-sheet-list"></div>
            <button type="button" class="libraries-sheet-cancel more-sheet-cancel">Cancel</button>
          </div>
        </div>
        <div class="content">
          <div class="header">
            <div class="header-side header-side-left">
              <img class="prism-logo" src="./assets/prism-logo.svg" alt="Prism" />
            </div>
            <div class="header-nav">
              <button type="button" class="header-nav-arrow left hidden" aria-label="Scroll left">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>
              </button>
              <div class="header-nav-scroller">
                <div class="header-nav-track">
                  <div class="nav-item header-nav-item active" data-view="${VIEW.HOME}" tabindex="0">
                    <span class="nav-icon"><svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10v9h12v-9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><rect x="10" y="14" width="4" height="5" fill="currentColor"/></svg></span>
                    <span class="nav-label">Home</span>
                  </div>
                </div>
              </div>
              <button type="button" class="header-nav-arrow right hidden" aria-label="Scroll right">
                <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4L13.2 12z"/></svg>
              </button>
            </div>
            <div class="header-side header-side-right">
              <div class="search-wrap">
                <button type="button" class="search-toggle"></button>
                <input class="search" type="text" placeholder="Search movies, shows, actors…" autocomplete="off" />
              </div>
              <div class="profile-menu-wrap">
                <div class="nav-item nav-profile" title="Account" tabindex="0">
                  <span class="nav-icon nav-profile-icon">${PROFILE_ICON_SVG}</span>
                  <span class="nav-label nav-profile-label">Profile</span>
                </div>
              </div>
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
              <button type="button" class="hero-play-btn" aria-label="Play/pause">${PAUSE_ICON_SVG}</button>
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
        <button type="button" class="profile-close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>
        </button>
        <div class="profile-panel">
          <div class="profile-title">Switch Profile</div>
          <div class="profile-badges-wrap">
            <button type="button" class="profile-arrow profile-arrow-left" aria-label="Scroll left">
              <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>
            </button>
            <div class="profile-badges-scroll">
              <div class="profile-list"></div>
            </div>
            <button type="button" class="profile-arrow profile-arrow-right" aria-label="Scroll right">
              <svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4L13.2 12z"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="profile-dropdown" hidden>
        <button type="button" class="profile-dropdown-item profile-dropdown-profile">
          <span class="profile-dropdown-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20c1.2-4 4-6 7-6s5.8 2 7 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
          Profile
        </button>
        <button type="button" class="profile-dropdown-item profile-dropdown-settings">
          <span class="profile-dropdown-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3.5v2.4M12 18.1v2.4M4.5 12H6.9M17.1 12h2.4M6.3 6.3l1.7 1.7M16 16l1.7 1.7M17.7 6.3 16 8M8 16l-1.7 1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
          Settings
        </button>
      </div>
      <div class="title-info-overlay" tabindex="-1">
        <div class="title-info-modal">
          <button type="button" class="title-info-close" aria-label="Close">‹</button>
          <div class="title-info-art">
            <div class="title-info-art-img"></div>
          </div>
          <button type="button" class="title-info-trailer-play-btn" aria-label="Play/pause trailer" hidden>⏸</button>
          <button type="button" class="title-info-trailer-mute-btn" aria-label="Toggle trailer sound" hidden>🔊</button>
          <div class="title-info-progress" hidden><div class="bar"></div></div>
          <div class="title-info-body">
            <div class="title-info-header">
              <div class="title-info-title"></div>
              <div class="title-info-meta"></div>
              <div class="title-info-badges" hidden></div>
              <div class="title-info-sources" hidden></div>
            </div>
            <div class="title-info-actions">
              <button type="button" class="title-info-play">▶ Play</button>
              <button type="button" class="title-info-restart-btn" hidden>↺ Restart</button>
              <button type="button" class="title-info-watched-btn" aria-label="Mark as watched" hidden>
                <span class="title-info-action-icon">${WATCHED_ICON_SVG}</span>
                <span class="title-info-action-label">Watched</span>
              </button>
              <button type="button" class="title-info-watchlist-btn" aria-label="Add to My List">
                <span class="title-info-action-icon">+</span>
                <span class="title-info-action-label">My List</span>
              </button>
              <button type="button" class="title-info-download-btn" aria-label="Download" hidden>
                <span class="title-info-action-icon">${DOWNLOAD_ICON_SVG}</span>
                <span class="title-info-action-label">Download</span>
              </button>
            </div>
            <div class="title-info-actions-loading" hidden><span class="spinner"></span></div>
            <div class="title-info-summary"></div>
            <div class="title-info-episodes"></div>
            <div class="title-info-cast-wrap" tabindex="0" hidden>
              <div class="title-info-section-title">Cast</div>
              <div class="title-info-cast"></div>
            </div>
            <div class="title-info-similar-wrap" hidden>
              <div class="title-info-section-title">More Like This</div>
              <div class="title-info-similar"></div>
            </div>
          </div>
          <div class="title-info-loading-overlay"><span class="spinner"></span></div>
        </div>
      </div>
      <div class="title-info-season-overlay" tabindex="-1">
        <div class="title-info-season-modal">
          <div class="title-info-season-modal-title">Select Season</div>
          <div class="title-info-season-modal-list"></div>
        </div>
      </div>
    `;
    this._rowsEl = this.shadowRoot.querySelector(".rows");
    this._searchWrap = this.shadowRoot.querySelector(".search-wrap");
    this._searchToggle = this.shadowRoot.querySelector(".search-toggle");
    this._searchInput = this.shadowRoot.querySelector(".search");
    this._contentEl = this.shadowRoot.querySelector(".content");
    this._headerEl = this.shadowRoot.querySelector(".header");
    /* header-search.css fades the header's own blurred backdrop out while this reads
       true - at the very top of the page there's nothing scrolled "under" the sticky
       header yet, so the backdrop can blend straight into the hero instead of showing a
       blur/gradient over nothing. Checked on scroll rather than derived from
       _currentView: every view (home, a library section, search) shares the same
       scrollable .content and can independently be scrolled away from its own top. */
    const updateHeaderAtTop = () => this._headerEl.classList.toggle("header-at-top", this._contentEl.scrollTop <= 0);
    /* Netflix-style "get out of the way while browsing" behavior for the desktop header-nav
       library strip (header-nav.css) - fades out while the user is actively scrolling down
       through a row-heavy view, and comes right back the moment they scroll back up, rather
       than staying pinned in place the whole time. Direction is compared against the
       previous scroll position, not just distance from the top, so it reacts to which way
       the user is scrolling right now.

       Controller nav gets a stricter rule than mouse/touch: wireHomeNav's only path onto the
       nav strip is hero "up" (sidenav/header-nav "down" only ever lands on the hero or a
       poster row, never straight onto the strip), and focusHero always scrolls .content back
       to the top first - so a D-pad/gamepad user can only ever actually reach these items
       once they're already scrolled to the top. Fading them out on direction like the mouse
       case would leave them tabbable-but-invisible (scroll up a little, stop - strip stays
       hidden under the direction rule but is still the "up" target from the hero) instead of
       matching what's really reachable. */
    let lastScrollTop = this._contentEl.scrollTop;
    const updateHeaderNavScroll = () => {
      const top = this._contentEl.scrollTop;
      if (this.hasAttribute("controller-active")) {
        this._headerEl.classList.toggle("header-nav-hidden", top > 0);
      } else if (top > lastScrollTop && top > 40) {
        this._headerEl.classList.add("header-nav-hidden");
      } else if (top < lastScrollTop) {
        this._headerEl.classList.remove("header-nav-hidden");
      }
      lastScrollTop = top;
    };
    this._contentEl.addEventListener("scroll", updateHeaderAtTop, { passive: true });
    this._contentEl.addEventListener("scroll", updateHeaderNavScroll, { passive: true });
    document.addEventListener(APP_EVENT.CONTROLLER_ACTIVE_CHANGE, updateHeaderNavScroll);
    updateHeaderAtTop();
    updateHeaderNavScroll();
    this._headerNavScroller = this.shadowRoot.querySelector(".header-nav-scroller");
    this._headerNavTrack = this.shadowRoot.querySelector(".header-nav-track");
    renderNavSections(this);
    this._settingsBtn = this.shadowRoot.querySelector(".nav-settings");
    this._profileMenuWrap = this.shadowRoot.querySelector(".profile-menu-wrap");
    this._profileNavItem = this.shadowRoot.querySelector(".nav-profile");
    this._profileNavIcon = this.shadowRoot.querySelector(".nav-profile-icon");
    this._profileNavLabel = this.shadowRoot.querySelector(".nav-profile-label");
    this._profileDropdown = this.shadowRoot.querySelector(".profile-dropdown");
    this._profileDropdownProfileBtn = this.shadowRoot.querySelector(".profile-dropdown-profile");
    this._profileDropdownSettingsBtn = this.shadowRoot.querySelector(".profile-dropdown-settings");
    this._profileOverlay = this.shadowRoot.querySelector(".profile-overlay");
    this._profileListEl = this.shadowRoot.querySelector(".profile-list");
    this._profileScroll = this.shadowRoot.querySelector(".profile-badges-scroll");
    this._profileCloseBtn = this.shadowRoot.querySelector(".profile-close");
    this._profileArrowLeft = this.shadowRoot.querySelector(".profile-arrow-left");
    this._profileArrowRight = this.shadowRoot.querySelector(".profile-arrow-right");
    this._moreBtn = this.shadowRoot.querySelector(".nav-more");
    this._moreOverlay = this.shadowRoot.querySelector(".more-overlay");
    this._moreListEl = this.shadowRoot.querySelector(".more-sheet-list");
    this._moreCancelBtn = this.shadowRoot.querySelector(".more-sheet-cancel");
    this._librariesBtn = this.shadowRoot.querySelector(".nav-libraries");
    this._librariesOverlay = this.shadowRoot.querySelector(".libraries-overlay");
    this._librariesListEl = this.shadowRoot.querySelector(".libraries-sheet-list");
    this._librariesCancelBtn = this.shadowRoot.querySelector(".libraries-sheet-cancel");
    this._pin = new PinEntry(this.shadowRoot);
    this._titleInfo = new TitleInfoController(this.shadowRoot, {
      /* Bound to whichever item the title-info overlay currently has open, not a
         global server - every metadata/scrobble/season/episode fetch this overlay makes
         is for the same show/movie (and therefore the same server) as this._item, so a
         single binding here covers every ctx.plexFetch/plexImageUrl call inside
         title-info.js without threading a server through each one individually. Safe
         because open() sets this._item synchronously before any of these fire. */
      plexFetch: (path, params, server) => plexFetch(this, path, params, server || this._titleInfo?.item?.server),
      plexImageUrl: (path, server) => this._plexImageUrl(path, server || this._titleInfo?.item?.server),
      plexThumbUrl: (path, width, height, server) =>
        this._plexThumbUrl(path, width, height, server || this._titleInfo?.item?.server),
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      isInWatchlist: (item) => isInWatchlist(item, this._watchlistRaw),
      resolveLocalRatingKey: (item) => this._resolveLocalRatingKey(item),
      resolveItemSources: (item) => this._resolveItemSources(item),
      onAddToWatchlist: (item, btnEl) => this._addToWatchlist(item, btnEl),
      onRemoveFromWatchlist: (item, btnEl) => this._removeFromWatchlist(item, btnEl),
      onPlayItem: (item, opts) => this._playItem(item, opts),
      onPlayHistoryMutated: (ratingKey, watched) => this._onPlayHistoryMutated(ratingKey, watched),
      getConfig: () => this._config,
    });
    this._hero = new HeroController(this.shadowRoot, {
      /* Same "bind to the current item's server" reasoning as title-info's ctx above -
         hero.js explicitly passes an item's own __server through to most of these calls
         already (see its _resolveVideo/_resolveLogo), this is just the fallback for the
         couple of spots that don't. */
      plexFetch: (path, params, server) => plexFetch(this, path, params, server || this._hero?.item?.__server),
      plexImageUrl: (path, server) => this._plexImageUrl(path, server || this._hero?.item?.__server),
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      isInWatchlist: (item) => isInWatchlist(item, this._watchlistRaw),
      onAddToWatchlist: (item, btnEl) => this._addToWatchlist(item, btnEl),
      onRemoveFromWatchlist: (item, btnEl) => this._removeFromWatchlist(item, btnEl),
      onOpenTitleInfo: (item, source) => this._titleInfo.open(item, source),
      getConfig: () => this._config,
      getCurrentView: () => this._currentView,
      getSectionsForView: (view) => sectionsForView(this, view),
      getGenreBySection: () => this._genreBySection,
    });

    /* Continue Watching membership can change from any playback session, not just one
       that started from the title-info modal (e.g. an episode row's direct-play click) -
       a single card-level listener covers every path, rather than each of them having to
       remember to call _onPlayHistoryMutated itself. */
    window.addEventListener(APP_EVENT.PLAYER_CLOSE, () => this._onPlayHistoryMutated());

    /* Dynamic (per-library) nav items are already wired inside renderNavSections,
       called above - only the two static Home items (sidenav + header-nav) need wiring
       here. */
    this.shadowRoot.querySelectorAll(`.nav-item[data-view="${VIEW.HOME}"]`).forEach((el) => wireNavItem(this, el));
    wireHeaderNav(this);

    this._settingsBtn.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent(APP_EVENT.OPEN_SETTINGS, { bubbles: true, composed: true }));
    });

    this._profileNavItem.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleProfileDropdown();
    });
    this._profileDropdownProfileBtn.addEventListener("click", () => {
      this._closeProfileDropdown();
      this._openProfileOverlay();
    });
    this._profileDropdownSettingsBtn.addEventListener("click", () => {
      this._closeProfileDropdown();
      this._settingsBtn.click();
    });
    this.shadowRoot.addEventListener("click", (e) => {
      if (!this._profileDropdown.hidden && !this._profileMenuWrap.contains(e.target) && !this._profileDropdown.contains(e.target)) {
        this._closeProfileDropdown();
      }
    });
    this._profileCloseBtn.addEventListener("click", () => this._closeProfileOverlay());
    this._profileOverlay.addEventListener("click", (e) => {
      if (e.target === this._profileOverlay) this._closeProfileOverlay();
    });
    /* Same transform-driven track as rows.js's poster rows (see row-scroll.js's own header
       comment) rather than native overflow scroll - keeps this badge row immune to Xbox
       WebView2's built-in gamepad-to-scroll hijack, same reasoning as episode-list.js's
       queue row. */
    this._profileRowScroll = createRowScroll(this._profileScroll, this._profileListEl);
    wireArrowVisibility(this._profileRowScroll, this._profileArrowLeft, this._profileArrowRight);
    this._profileArrowLeft.addEventListener("click", () => {
      this._profileRowScroll.scrollBy(-this._profileScroll.clientWidth * 0.9, { animate: true });
    });
    this._profileArrowRight.addEventListener("click", () => {
      this._profileRowScroll.scrollBy(this._profileScroll.clientWidth * 0.9, { animate: true });
    });
    /* Mirrors episode-list.js's own focusin listener: .profile-list is a transform-driven
       track, not a native scroll container, so wireLinearNav's plain scrollIntoView has
       nothing to act on. */
    this._profileOverlay.addEventListener("focusin", (e) => {
      if (this._profileListEl.contains(e.target)) this._profileRowScroll.scrollIntoView(e.target, { inline: "center", animate: true });
    });
    this._profileNav = wireLinearNav(this.shadowRoot, ".profile-badge, .profile-close", {
      orientation: "horizontal",
      onBack: () => this._closeProfileOverlay(),
    });

    this._moreBtn.addEventListener("click", () => this._openMoreSheet());
    this._moreCancelBtn.addEventListener("click", () => this._closeMoreSheet());
    this._moreOverlay.addEventListener("click", (e) => {
      if (e.target === this._moreOverlay) this._closeMoreSheet();
    });
    this._moreNav = wireLinearNav(this.shadowRoot, ".more-overlay .more-sheet-item, .more-overlay .more-sheet-cancel", {
      orientation: "vertical",
      onBack: () => this._closeMoreSheet(),
    });

    this._librariesBtn.addEventListener("click", () => this._openLibrariesSheet());
    this._librariesCancelBtn.addEventListener("click", () => this._closeLibrariesSheet());
    this._librariesOverlay.addEventListener("click", (e) => {
      if (e.target === this._librariesOverlay) this._closeLibrariesSheet();
    });
    this._librariesNav = wireLinearNav(
      this.shadowRoot,
      ".libraries-overlay .more-sheet-item, .libraries-overlay .more-sheet-cancel",
      { orientation: "vertical", onBack: () => this._closeLibrariesSheet() }
    );

    /* Registering a backButton listener at all switches off Capacitor's own default
       Android hardware-back handling (goBack()-if-possible, else exit the app) - without
       this, none of these overlays have a browser history entry to go back to, so every
       one of them just fell straight through to exiting the app. Ordered by overlay
       z-index (highest first) since more than one can theoretically be open at once. */
    App.addListener("backButton", () => {
      const settingsModal = document.querySelector("streaming-settings-modal");
      if (this._titleInfo.isSeasonOverlayOpen()) this._titleInfo.closeSeasonOverlay();
      else if (this._titleInfo.isOpen()) this._titleInfo.close();
      else if (this._pin.isOpen()) this._pin.cancel();
      else if (this._profileOverlay.classList.contains("open")) this._closeProfileOverlay();
      else if (this._moreOverlay.classList.contains("open")) this._closeMoreSheet();
      else if (this._librariesOverlay.classList.contains("open")) this._closeLibrariesSheet();
      else if (settingsModal?.isOpen()) settingsModal.close();
      else if (this._currentView === VIEW.SEARCH) {
        this._clearSearchInput();
        exitSearch(this);
        this._searchWrap.classList.remove("expanded");
        this._searchInput.blur();
        restoreFocusAfterSearch(this);
      } else App.exitApp();
    });

    this._wireHomeNav();

    /* Continuously remembers whatever last held real DOM focus *outside* the search box
       (poster, sidenav item, hero button, ...) so search-exit paths below can restore it.
       Deliberately not captured at each search-entry call site instead (click toggle,
       Tab, gamepad Y, hero up-hand-off) - clicking the toggle button, for instance,
       transiently focuses that button itself before this._searchInput.focus() runs, and a
       relatedTarget/active-element snapshot taken at that point would wrongly capture the
       button (itself inside .search-wrap) rather than whatever was focused before the
       click. Tracking continuously and only updating for focus landing outside the wrap
       sidesteps that regardless of which entry path fires. */
    this.shadowRoot.addEventListener("focusin", (e) => {
      if (!this._searchWrap.contains(e.target)) this._searchReturnFocusEl = e.target;
      /* Same continuous-tracking idea, scoped to the nav (sidenav on mobile, the header's
         horizontal strip on desktop - see nav.js) instead of the search box - lets
         wireHomeNav's/wireSearchNav's "enter main content" handler return to whatever hero
         button/poster/result had focus before the user moved into the nav, instead of
         always restarting from the hero's first button. */
      if (!this._searchWrap.contains(e.target) && !e.target.closest(".sidenav") && !e.target.closest(".header-nav")) this._lastContentFocusEl = e.target;
    });

    this._updateSearchToggleIcon();
    this._searchToggle.addEventListener("click", () => {
      if (this._searchInput.value) {
        this._clearSearchInput();
        onSearchInput(this);
        this._searchWrap.classList.remove("expanded");
        this._searchInput.blur();
        restoreFocusAfterSearch(this);
        return;
      }
      this._searchWrap.classList.add("expanded");
      this._searchInput.focus();
    });
    this._searchInput.addEventListener("focus", () => this._searchWrap.classList.add("expanded"));
    this._searchInput.addEventListener("blur", () => {
      if (this._currentView === VIEW.SEARCH) return;
      this._searchWrap.classList.remove("expanded");
    });
    this._searchInput.addEventListener("input", () => {
      this._updateSearchToggleIcon();
      onSearchInput(this);
    });
    this._searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dismissSearchKeyboard(this);
    });
    wireSearchToggle(this);
    wireVirtualKeyboardDismiss(this);
    wireStartButton(this);
    wireProfileButton(this);
    wireProfileMenu(this);
  }

  _toggleProfileDropdown() {
    if (this._profileDropdown.hidden) this._openProfileDropdown();
    else this._closeProfileDropdown();
  }

  _openProfileDropdown() {
    this._profileDropdownProfileBtn.hidden = !this._hasMultipleProfiles;
    /* The dropdown lives outside .header/.content rather than anchored position:absolute
       inside .profile-menu-wrap: .header's mask-image (its scroll-fade) clips any descendant
       extending past its own box, which silently ate the dropdown's items - only its top
       border edge survived, rendering as a bare line with nothing inside. So it's
       position:fixed, computed fresh from the icon's real screen position on each open. */
    const rect = this._profileNavItem.getBoundingClientRect();
    this._profileDropdown.style.top = `${rect.bottom + 10}px`;
    this._profileDropdown.style.right = `${document.documentElement.clientWidth - rect.right}px`;
    this._profileDropdown.hidden = false;
  }

  _closeProfileDropdown() {
    this._profileDropdown.hidden = true;
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

  _plexFetch(path, params = {}, server = null) {
    return plexFetch(this, path, params, server);
  }



  /* The section `type` (1=movie, 2=show - see SECTION_TYPE_FILTERS above) to filter every
     raw pool by for a given view. A single-library tab borrows that library's own type;
     Movies/TV are cross-server aggregates with no single backing section, so they carry a
     fixed type instead; every other view (Home, a server's "All" tab, search) has no type
     restriction (undefined - see SECTION_TYPE_FILTERS' own lookup at each call site). */
  _sectionTypeForView(view) {
    if (view === VIEW.MOVIES) return SECTION_TYPE.MOVIE;
    if (view === VIEW.TV) return SECTION_TYPE.SHOW;
    return sectionForView(this, view)?.type;
  }

  /* sectionsForView (data.js) already scopes genre/collection rows to the tapped
     server's own sections, but onDeck/watchlist/recentlyAdded/recommended/popular are
     built from card-wide raw caches (see loadAll) spanning every active server, with no
     section to key off - this is the equivalent per-view filter for those, keyed off
     each raw item's own __server stamp (see data.js's plexFetch) instead. */
  _serverFilterForView(view) {
    if (typeof view !== "string") return () => true;
    if (view.startsWith("server-")) {
      const id = view.slice("server-".length);
      return (m) => m.__server?.id === id;
    }
    /* A library tab (view = "section-<server_id>:<key>") is scoped to one specific library,
       not merely one server: a server with two movie libraries tags both the same server_id,
       and SECTION_TYPE_FILTERS above only narrows movie-vs-show, so matching on server_id
       alone mixed both libraries into whichever movie tab you opened.

       data.js's stampSection tags recentlyAdded / genre-by-section (and therefore
       recommended/popular) / AI-row items with m.__section = {server_id, key} at the exact
       per-section fetch that produced them. That's authoritative and checked first.
       onDeck/watchlist have no per-section fetch to stamp from (onDeck is one server-wide
       endpoint; watchlist is account-level), so they fall back to Plex's own
       librarySectionID - which is NOT reliable enough to be the only signal: testing against
       a real multi-library server showed those rows still mixing sections when filtered on it
       alone, which is why the other sources carry the stamp. A missing librarySectionID on
       the fallback path fails open, same convention as data.js's isFromEnabledSection. */
    if (view.startsWith("section-")) {
      const section = sectionForView(this, view);
      if (!section) return () => true;
      return (m) => {
        if (m.__section) return m.__section.server_id === section.server_id && m.__section.key === section.key;
        return (
          m.__server?.id === section.server_id &&
          (m.librarySectionID == null || Number(m.librarySectionID) === section.key)
        );
      };
    }
    return () => true;
  }



  /* Watchlist items come from plex.tv's account-level Discover API (fetchWatchlistRaw),
     not any local server's plexFetch - unlike every other raw source in this file, they
     never get a __server/__section stamp, so _serverFilterForView can never match them
     directly against a server/library tab. This is the only other place these items'
     server/section identity is checked, so the fallback pool is built fresh from
     whatever local raw data is already in memory (recentlyAdded/onDeck/per-genre
     pools - all properly stamped) rather than requiring a dedicated fetch. */
  _watchlistLocalPool() {
    const pool = [...(this._recentlyAddedRaw || []), ...(this._onDeckRaw || [])];
    if (this._genreBySection) {
      for (const entries of this._genreBySection.values()) {
        for (const g of entries) pool.push(...g.items);
      }
    }
    return pool;
  }

  /* _serverFilterForView composed with a type filter, but for watchlist items: matches by
     normalized title(+year) against _watchlistLocalPool to borrow a local item's
     __server/__section stamp, since a watchlist item has none of its own. With no local match
     it checks the raw watchlist item instead, which correctly yields nothing on a specific
     library tab and is a no-op on home/search, where serverFilter is already `() => true`. */
  _watchlistFilterForView(view) {
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionTypeForView(view)];
    const serverFilter = this._serverFilterForView(view);
    const pool = this._watchlistLocalPool();
    return (m) => {
      if (sectionFilters && m.type !== sectionFilters.other) return false;
      const local = findLocalMatch(m, pool);
      return local ? serverFilter(local) : serverFilter(m);
    };
  }


  _plexImageUrl(path, server = null) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    const s = server || primaryServer(this);
    const sep = path.includes("?") ? "&" : "?";
    return `${s.url}${path}${sep}X-Plex-Token=${s.token}`;
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
  _plexThumbUrl(path, width = 320, height = 480, server = null) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    const s = server || primaryServer(this);
    const sourceUrl = `${path}${path.includes("?") ? "&" : "?"}X-Plex-Token=${s.token}`;
    const url = new URL(`${s.url}/photo/:/transcode`);
    url.searchParams.set("width", String(width));
    url.searchParams.set("height", String(height));
    url.searchParams.set("minSize", "1");
    url.searchParams.set("upscale", "0");
    url.searchParams.set("X-Plex-Token", s.token);
    url.searchParams.set("url", sourceUrl);
    return url.toString();
  }


  _showHero(preserveMute = false, crossfade = false) {
    this._hero.show(preserveMute, crossfade);
  }

  _renderCurrentView({ showHero = true } = {}) {
    const view = this._currentView || "home";
    if (showHero) this._showHero();
    const sectionsForGenres = sectionsForView(this, view);

    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionTypeForView(view)];
    const serverFilter = this._serverFilterForView(view);
    const onDeckFilter = (m) => (sectionFilters ? m.type === sectionFilters.onDeck : true) && serverFilter(m);
    const otherFilter = (m) => (sectionFilters ? m.type === sectionFilters.other : true) && serverFilter(m);
    const watchlistFilter = this._watchlistFilterForView(view);
    const recentlyAddedFilter = otherFilter;
    const recommendedFilter = otherFilter;
    const popularFilter = otherFilter;

    const onDeck = (this._onDeckRaw || [])
      .filter(onDeckFilter)
      .map((m) => this._mapItem(m, true));
    const watchlistFull = (this._watchlistRaw || []).filter(watchlistFilter);
    const watchlist = watchlistFull.slice(0, this._config.row_size).map((m) => this._mapItem(m, false));
    const recentlyAddedFull = (this._recentlyAddedRaw || [])
      .filter(recentlyAddedFilter)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const recentlyAdded = recentlyAddedFull.slice(0, this._config.row_size).map((m) => this._mapItem(m, false));
    const recommended = this._getRecommendedForView(view, recommendedFilter)
      .map((m) => this._mapItem(m, false));
    const popularFull = (this._popularRaw || []).filter(popularFilter);
    const popular = popularFull
      .slice(0, Math.min(8, this._config.row_size))
      .map((m) => this._mapItem(m, false));
    const genreRows = this._getGenreRowsForView(view, sectionsForGenres);
    const collectionsRow = this._getCollectionsRowForView(sectionsForGenres);
    const playlistsRow = this._getPlaylistsRowForView(view);

    const rows = [];
    if (onDeck.length && this._config.row_continue_watching_enabled !== false)
      rows.push({ title: "Continue Watching", items: onDeck, source: "local", landscape: true });
    if (recentlyAdded.length && this._config.row_recently_added_enabled !== false)
      rows.push({
        title: "Recently Added",
        items: recentlyAdded,
        source: "local",
      });
    if (watchlist.length && this._config.row_watchlist_enabled !== false)
      rows.push({
        title: "My List",
        items: watchlist,
        source: "watchlist",
        hasMore: watchlist.length < watchlistFull.length,
        loadMore: () => watchlistFull,
      });
    if (recommended.length && this._config.row_recommended_enabled !== false)
      rows.push({
        title: "Recommended for You",
        items: recommended,
        source: "local",
        landscape: true,
      });
    if (popular.length && this._config.row_popular_enabled !== false)
      rows.push({
        title: "What's Popular",
        items: popular,
        source: "local",
        rankNumbers: true,
      });
    rows.push(...genreRows);
    if (collectionsRow && this._config.row_collections_enabled !== false) rows.push(collectionsRow);
    if (playlistsRow && this._config.row_playlists_enabled !== false) rows.push(playlistsRow);
    /* showHero:false always means "background data streaming in after first paint" (see
       data.js's loadBackgroundData) - merge the newly-available rows in without
       disturbing what's already rendered, for the same reason showHero itself is
       skipped: this isn't a real view change, so nothing already on screen should move
       or restart. */
    renderRows(this._rowsEl, rows, this._config.landscape_every_nth, this._rowCtx, { merge: !showHero });
  }

  /* Rebuilds just the "My List" row after an add/remove, instead of the full
     _renderCurrentView() - that also unconditionally calls _showHero(), which resets mute
     state and restarts the active hero video/trailer, an unwanted side effect of clicking
     an unrelated poster's watchlist button elsewhere on the page. */
  _refreshWatchlistRow() {
    const view = this._currentView || "home";
    const watchlistFilter = this._watchlistFilterForView(view);
    const watchlistFull = (this._watchlistRaw || []).filter(watchlistFilter);
    const watchlist =
      this._config.row_watchlist_enabled === false
        ? []
        : watchlistFull.slice(0, this._config.row_size).map((m) => this._mapItem(m, false));

    const existing = this._rowsEl.querySelector('[data-row-key="watchlist"]');
    if (!watchlist.length) {
      if (existing) existing.remove();
      return;
    }

    const sections = Array.from(this._rowsEl.children);
    const rowIndex = existing ? sections.indexOf(existing) : sections.length;
    const nth = this._config.landscape_every_nth;
    const landscape = !!nth && (rowIndex + 1) % nth === 0;
    const newSection = buildRowSection(
      {
        title: "My List",
        items: watchlist,
        source: "watchlist",
        hasMore: watchlist.length < watchlistFull.length,
        loadMore: () => watchlistFull,
      },
      landscape,
      rowIndex
    );

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
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionTypeForView(view)];
    const serverFilter = this._serverFilterForView(view);
    const onDeckFilter = (m) => (sectionFilters ? m.type === sectionFilters.onDeck : true) && serverFilter(m);
    const onDeck =
      this._config.row_continue_watching_enabled === false
        ? []
        : (this._onDeckRaw || []).filter(onDeckFilter).map((m) => this._mapItem(m, true));

    const existing = this._rowsEl.querySelector('[data-row-key="on-deck"]');
    if (!onDeck.length) {
      if (existing) existing.remove();
      return;
    }

    const rowIndex = existing ? Array.from(this._rowsEl.children).indexOf(existing) : 0;
    const newSection = buildRowSection({ title: "Continue Watching", items: onDeck, source: "local", landscape: true }, true, rowIndex);

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
    /* Composite server_id+key, not key alone: Plex library keys are small per-server integers,
       not globally unique, so a bare key match lets a different server's same-numbered
       library's collections leak into this view's Collections row. */
    const keys = new Set(sections.map((s) => `${s.server_id}:${s.key}`));
    const collections = (this._collectionsRaw || []).filter((c) => keys.has(`${c.section.server_id}:${c.section.key}`));
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


  _renderProfileNav() {
    this._hasMultipleProfiles = renderProfileNav(this._profileNavItem, this._profileNavLabel, this._profileNavIcon, this._homeUsers || [], this._activeUserId);
  }

  _openProfileOverlay() {
    renderProfileList(this._profileListEl, this._homeUsers || [], this._activeUserId, (user, badgeEl) => this._switchToUser(user, badgeEl));
    this._profileOverlay.classList.add("open");
    /* Lands D-pad/keyboard nav (and the badge row's own centering, see the focusin listener
       above) on the current profile rather than always the leftmost one - the whole point of
       "keep the currently selected centered" on open, not just once the user first moves. */
    const activeBadge = this._profileListEl.querySelector(".profile-badge.active");
    if (activeBadge) focusAfterPaint(activeBadge);
    else this._profileNav.focusFirst();
  }

  /* Entry point for nav.js's wireProfileButton (gamepad Back/Select). Guarded the same
     way the sidenav item itself is (hidden when there's nothing to switch to) since this
     can be invoked with no prior check that a switcher is even applicable. */
  openProfileSwitcher() {
    if (!this._hasMultipleProfiles) return;
    this._openProfileOverlay();
  }

  _closeProfileOverlay() {
    this._profileOverlay.classList.remove("open");
  }

  /* Mobile-only overflow menu (see .nav-more) - every row here just delegates to the
     real nav item's own click handler instead of reimplementing Profile/Settings
     behavior a second time. Library switching has its own dedicated sheet now (see
     .nav-libraries/_renderLibrariesSheet below), so this one is just Profile + Settings. */
  _renderMoreSheet() {
    const rows = [];
    const addRow = (label, iconHTML, active, target, sublabel = "") => {
      rows.push({ label, sublabel, iconHTML, active, onSelect: () => { this._closeMoreSheet(); target.click(); } });
    };
    if (this._hasMultipleProfiles) {
      rows.push({
        label: this._profileNavLabel.textContent,
        sublabel: "",
        iconHTML: this._profileNavIcon.innerHTML,
        active: false,
        onSelect: () => { this._closeMoreSheet(); this._openProfileOverlay(); },
      });
    }
    addRow("Settings", this._settingsBtn.querySelector(".nav-icon").innerHTML, false, this._settingsBtn);
    renderMoreSheet(this._moreListEl, rows);
  }

  _openMoreSheet() {
    this._renderMoreSheet();
    this._moreOverlay.classList.add("open");
    this._moreNav.focusFirst();
  }

  _closeMoreSheet() {
    this._moreOverlay.classList.remove("open");
  }

  /* Mobile-only library-switcher sheet (see .nav-libraries) - the one place on mobile a
     library tab is ever reachable now (see responsive.css's .nav-item-dynamic rule), so
     unlike _renderMoreSheet above this always lists every tab, not just an overflow past
     some cap. Same real-.click()-delegation pattern as _renderMoreSheet. */
  _renderLibrariesSheet() {
    const rows = [...this.shadowRoot.querySelectorAll(".nav-item-dynamic")].map((el) => ({
      label: el.querySelector(".nav-label").textContent,
      /* See _renderMoreSheet's own comment on this - the bottom bar's real tabs are
         icon-only, so this sheet is the one place a library tab's server-name subtitle
         (nav.js's navItemHtml) actually gets to show up on mobile. */
      sublabel: el.querySelector(".nav-sublabel")?.textContent || "",
      iconHTML: el.querySelector(".nav-icon").innerHTML,
      active: el.classList.contains("active"),
      onSelect: () => { this._closeLibrariesSheet(); el.click(); },
    }));
    renderMoreSheet(this._librariesListEl, rows);
  }

  _openLibrariesSheet() {
    this._renderLibrariesSheet();
    this._librariesOverlay.classList.add("open");
    this._librariesNav.focusFirst();
  }

  _closeLibrariesSheet() {
    this._librariesOverlay.classList.remove("open");
  }

  _renderProfileList() {
    renderProfileList(this._profileListEl, this._homeUsers || [], this._activeUserId, (user, badgeEl) => this._switchToUser(user, badgeEl));
  }


  _wireHomeNav() {
    wireHomeNav(this);
    wireSearchNav(this);
    wireTabSwitch(this);
  }

  /* Prefers the shared player (native on Android, <video>+hls.js everywhere else - see
     player.js) and only falls back to handing off via _tapUrl (native Plex app /
     Plex web player) when playback fails to start - e.g. a watchlist item with no local
     ratingKey, which player.play rejects by design. Shared by the title-info modal's
     Play button and the episode list's direct-play rows. */
  async _playItem(item, { durationMs = null, startOffsetMs = 0, source, markers = [], chapters = [], mediaIndex = 0, mediaVersions = [], audioStreams = [], isHdr = false, bifIndexPath = null, partId = null, partKey = null, queueRatingKeys = null, queueIndex = null } = {}) {
    /* Hitting Play (from search -> title info -> play) reads as the user having found
       what they were looking for - leave them back on their normal view, not still
       sitting in search results, once playback closes. Mirrors the Escape-key exit path
       above minus the blur/focus-restore, since focus is about to move to the player. */
    if (this._currentView === VIEW.SEARCH) {
      this._clearSearchInput();
      exitSearch(this);
      this._searchWrap.classList.remove("expanded");
    }
    const server = item.server || primaryServer(this);
    try {
      await player.play({
        ratingKey: item.ratingKey,
        key: item.key,
        type: item.type,
        plexUrl: server.url,
        plexToken: server.token,
        durationMs,
        startOffsetMs,
        markers,
        chapters,
        mediaIndex,
        mediaVersions,
        audioStreams,
        isHdr,
        bifIndexPath,
        partId,
        partKey,
        /* Already produced by _mapItem for every call site - title is the show's own
           title (not the episode's) for episode items, which is what a subtitle search
           query needs to key off, not the individual episode title. */
        title: item.title,
        episodeTitle: item.seasonNumber != null ? item.subtitle : null,
        year: item.year,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        /* Drives player.js's shader auto-detection (anime vs. live-action) - see
           _mapItem/_renderTitleInfoDetail for where this gets resolved. studio is the
           secondary signal detectShaderType uses to catch CGI animation (Pixar/DreamWorks/
           Illumination-style) that would otherwise get misclassified as anime4k just for
           being Genre-tagged "Animation". */
        genres: item.genres || [],
        studio: item.studio || "",
        /* The ordered list of sibling ratingKeys (a show's full episode order, or a
           playlist/collection's own order) this item came from, if any - see
           title-info.js's _getShowEpisodeQueue/_flatQueueContext. Powers the player's
           title-prev/title-next buttons (src/player/ui/). */
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
  _switchToUser(user, badgeEl) {
    return switchToUser(user, badgeEl, {
      promptForDigits: (length, title) => this._pin.prompt(length, title),
      accountToken: this._config.plex_account_token,
      machineId: this._config.machine_id,
      onSuccess: async ({ plexToken, accountToken, userId }) => {
        this._config.plex_token = plexToken;
        this._config.plex_account_token = accountToken;
        this._activeUserId = userId;
        this._closeProfileOverlay();
        await loadAll(this);
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
      this._recommendedRowCache[view] = shuffle(pool).slice(0, rowSize);
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
      const pool = shuffle([...genreRows, ...aiRows]).slice(
        0,
        Math.max(0, this._config.max_genre_rows - collectionRows.length)
      );
      this._genreRowsCache[view] = shuffle([...pool, ...collectionRows]);
    }
    return this._genreRowsCache[view];
  }

  /* Collection rows: title = a real Plex Collection's name, items = its actual movies -
     picked randomly per real page load in _loadAll (see _collectionRowPicks), unlike
     genre/AI rows which are recomputed from the full pool every time. No totalSize>=5
     floor here (unlike _mergeGenreRows) - collections are hand-curated and small ones
     (e.g. a 2-film franchise) are still worth showing as-is. */
  _typeFilterForView(view) {
    const sectionFilters = SECTION_TYPE_FILTERS[this._sectionTypeForView(view)];
    const serverFilter = this._serverFilterForView(view);
    return (m) => (sectionFilters ? m.type === sectionFilters.other : true) && serverFilter(m);
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
      ...(this._watchlistRaw || []).filter(this._watchlistFilterForView(view)),
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
    const typeFilter = this._typeFilterForView(view);
    const rows = buildAiRows(this._aiRowsRaw, typeFilter, {
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      rowSize: this._config.row_size,
    });
    return rows.map((r) => (r.hasMore ? { ...r, loadMore: () => this._loadAiRowFull(r.genres, typeFilter) } : r));
  }

  _mergeGenreRows(sections) {
    const rows = mergeGenreRows(sections, {
      genreBySection: this._genreBySection,
      mapItem: (m, withProgress) => this._mapItem(m, withProgress),
      shuffle: (arr) => shuffle(arr),
      rowSize: this._config.row_size,
    });
    return rows.map((r) =>
      r.hasMore ? { ...r, loadMore: () => this._loadGenreRowFull(r.sectionGenreKeys) } : r
    );
  }

  /* "See More" fetchers for rows whose source data was already capped by
     X-Plex-Container-Size when first loaded (data.js) - re-runs the identical filter with
     ROW_SEE_MORE_LIMIT instead, same pattern as search-page.js's buildYearMatchHubs/
     expandSearchSection. Collection rows need no equivalent (see catalog.js's
     buildCollectionRows) - their source fetch is already unbounded. */
  async _loadGenreRowFull(sectionGenreKeys) {
    const perSection = await Promise.all(
      (sectionGenreKeys || []).map(async ({ key, type, genreKey, server_id }) => {
        try {
          const data = await plexFetch(
            this,
            `/library/sections/${key}/all`,
            { type, genre: genreKey, sort: "addedAt:desc", "X-Plex-Container-Size": ROW_SEE_MORE_LIMIT },
            serverForSection(this, { server_id })
          );
          return data?.MediaContainer?.Metadata || [];
        } catch (e) {
          return [];
        }
      })
    );
    return perSection.flat();
  }

  async _loadAiRowFull(genres, typeFilter) {
    const perSection = await Promise.all(
      (this._config.sections || []).map(async (s) => {
        const genreEntries = (this._genreBySection && this._genreBySection.get(`${s.server_id}:${s.key}`)) || [];
        const keys = (genres || []).map((g) => {
          const norm = g.trim().toLowerCase();
          const match = genreEntries.find((e) => e.title.trim().toLowerCase() === norm);
          return match ? match.key : null;
        });
        if (!keys.length || keys.some((k) => !k)) return [];
        try {
          const data = await plexFetch(
            this,
            `/library/sections/${s.key}/all`,
            { type: s.type, genre: keys, sort: "addedAt:desc", "X-Plex-Container-Size": ROW_SEE_MORE_LIMIT },
            serverForSection(this, s)
          );
          return data?.MediaContainer?.Metadata || [];
        } catch (e) {
          return [];
        }
      })
    );
    return perSection.flat().filter(typeFilter);
  }

  /* Genre-affinity recommender: scores every unwatched library item by how much its
     genres overlap with genres pulled from watch history, weighted so more-recently-
     watched items count for more. Pure local-PMS data (history + genre listings already
     fetched elsewhere) - no Plex cloud/Discover dependency, unlike the watchlist fetch. */
  _buildRecommendedRaw(historyRaw) {
    return buildRecommendedRaw(historyRaw, {
      genreBySection: this._genreBySection,
      onDeckRaw: this._onDeckRaw,
    });
  }

  /* "What's Popular": a blended recency + audience-rating score computed entirely from local
     Plex metadata (year + audienceRating, sourced from Rotten Tomatoes by the PMS agent), with
     no external API call - TMDb trending skews hard toward brand-new theatrical releases and
     had near-zero overlap with an older library. Year is normalized against the library's own
     min/max release year, so "recent" is relative to the library rather than the calendar;
     weighted 50/50 with rating, adjust freely. */
  _buildPopularRaw() {
    return buildPopularRaw({ genreBySection: this._genreBySection });
  }

  /* episodeFallbackGenres: an episode's own Plex metadata carries no Genre (that lives
     on the show) - fall back to whatever show-level genres the open title-info modal
     already resolved (see _renderTitleInfoDetail) rather than going undetected by
     player.js's shader auto-detection. */
  _mapItem(m, withProgress) {
    return mapItem(m, withProgress, {
      plexImageUrl: (path) => this._plexImageUrl(path, m.__server),
      plexThumbUrl: (path) => this._plexThumbUrl(path, undefined, undefined, m.__server),
      episodeFallbackGenres: this._titleInfo?.item?.genres || [],
      episodeFallbackStudio: this._titleInfo?.item?.studio || "",
    });
  }

  _tapUrl(item, source) {
    const server = item.server || primaryServer(this);
    return tapUrl(item, source, {
      machineId: server.id,
      plexUrl: server.url,
      userAgent: navigator.userAgent,
    });
  }

  get _rowCtx() {
    return {
      isInWatchlist: (item) => isInWatchlist(item, this._watchlistRaw),
      paintWatchlistButton,
      onAddToWatchlist: (item, btnEl) => this._addToWatchlist(item, btnEl),
      onRemoveFromWatchlist: (item, btnEl) => this._removeFromWatchlist(item, btnEl),
      onOpenTitleInfo: (item, source) => this._titleInfo.open(item, source),
      onSeeMoreRow: (row) => openRowSeeMore(this, row),
    };
  }











  /* A "My List" item's ratingKey is scoped to discover.provider.plex.tv, a different ID
     space than this server's /library/metadata - using it directly there 404s. Resolve
     the local ratingKey (if the title is actually in this server's library) via
     /hubs/search before fetching detail. */
  /* Searches every active server, not just the primary/owned one - a watchlist item's
     title may only live on a shared/remote server, and a hub search scoped to just the
     primary server silently finds nothing for those, leaving the title-info modal with
     no detail fetch at all (see open()'s "no ratingKey" bail-out). Prefers a match on
     the primary server when more than one server happens to have the title, matching
     this function's old (single-server) behavior for the common case. Returns the
     matching server alongside the ratingKey - open() needs both, since every downstream
     ctx.plexFetch call for this item defaults to whatever server gets stamped there. */
  async _resolveLocalRatingKey(item) {
    const attempts = await Promise.all(
      activeServers(this).map(async (server) => {
        const match = await findOnServer(this, item, server);
        return match?.ratingKey ? { ratingKey: match.ratingKey, server } : null;
      })
    );
    const primary = primaryServer(this);
    return attempts.find((a) => a?.server?.id === primary.id) || attempts.find(Boolean) || null;
  }

  /* An item's own cross-server "sources" list, for the two title-info cases whose
     `sources` can't be trusted to already reflect every server:
       - an on-deck episode redirect (title-info.js's openForEpisode) - the episode's own
         `sources` (collapseByGuid, run on the raw on-deck episode) only reflects a
         cross-server match when both servers happen to have the SAME episode currently
         on-deck. Each server tracks its own watch progress independently, so two
         different current episodes (the common case) never collapse together, even
         though the show itself really is on both.
       - a watchlist ("My List") item - Plex's account-level Discover API never stamps a
         server on these at all (see mapItem's comment), so `sources` starts out as a
         single null-server entry regardless of type, filtered out entirely by
         _renderSourcesTag.
     Keeps the item's already-known server/ratingKey for its own entry rather than
     re-searching for it (that search could only ever confirm what's already known), and
     only searches every OTHER active server for additional copies - same hub-search-by-
     title approach as _resolveLocalRatingKey above, just fanned out to every source
     instead of stopping at the first. Filtered by item.type so this works for a movie
     watchlist item too, not just shows. Returns null only when there's truly nothing to
     tell a caller (no own server known AND no other server has a copy either) - a
     genuinely single-source item still gets its one real entry back (not null), since a
     watchlist caller's own fallback is a useless null-server placeholder, not a valid
     single entry the way an episode-redirect caller's already is. */
  async _resolveItemSources(item) {
    const ownServer = item.server || null;
    const ownEntry = ownServer ? [{ server: ownServer, ratingKey: item.ratingKey, key: item.key }] : [];
    const others = activeServers(this).filter((s) => s.id !== ownServer?.id);
    if (!others.length) return ownEntry.length ? ownEntry : null;
    const found = await Promise.all(
      others.map(async (server) => {
        const match = await findOnServer(this, item, server);
        return match ? { server, ratingKey: match.ratingKey, key: match.key } : null;
      })
    );
    const extra = found.filter(Boolean);
    if (!extra.length && !ownEntry.length) return null;
    return dedupeSourcesByServer([...ownEntry, ...extra]);
  }

  async _onWatchlistMutated() {
    this._watchlistRaw = await fetchWatchlistRaw(this);
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



}

if (!customElements.get("plex-netflix-card")) {
  customElements.define("plex-netflix-card", PlexNetflixCard);
}
