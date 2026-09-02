import { focusAfterPaint, registerNavHandler } from "../core/focus-nav.js";
import { escapeHtml } from "../core/html.js";
import { NAV_COMMAND, APP_EVENT, VIEW } from "../constants.js";
import { player } from "../player/player.js";
import { createRowScroll } from "./row-scroll.js";
import { wireArrowVisibility } from "./rows.js";
import { exitSearch } from "./search-page.js";

/* Sidenav: rendering one tab per fetched library, wiring each tab's click, and the
   2D D-pad/gamepad navigation across sidenav + hero + poster rows (there's no single
   1D list here - see wireHomeNav's own comment). Takes the PlexNetflixCard instance as
   an explicit first argument (same pattern as data.js/search-page.js). */

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

/* Rows scroll horizontally independent of one another, so the same array index in two rows
   can sit at completely different on-screen columns - matching by index made up/down land on
   a poster with no visual relationship to the one just left. Matching by actual horizontal
   center position is what "roughly preserving column position" actually requires. */
function closestByPosition(posters, referenceEl) {
  if (!posters.length) return null;
  const refCenter = referenceEl.getBoundingClientRect().left + referenceEl.getBoundingClientRect().width / 2;
  return posters.reduce((best, el) => {
    const center = el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
    const bestCenter = best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2;
    return Math.abs(center - refCenter) < Math.abs(bestCenter - refCenter) ? el : best;
  });
}

/* Shared by every place that changes card._currentView to a nav-tab view (a nav-item
   click, renderNavSections' initial render, search-page.js's exitSearch) - besides the
   plain per-item .active toggle (matched by view, not by `el` itself, since the same
   view has two nav elements now: one in the mobile sidenav, one in the desktop
   header-nav strip), the mobile-only .nav-libraries button (see renderNavSections below)
   needs its own active state too, since none of its own library tabs are ever visible on
   mobile to carry that highlight themselves. */
export function updateNavActiveState(card) {
  card._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === card._currentView));
  const librariesBtn = card.shadowRoot.querySelector(".nav-libraries");
  librariesBtn?.classList.toggle(
    "active",
    card._currentView.startsWith("section-") ||
      card._currentView.startsWith("server-") ||
      card._currentView === VIEW.MOVIES ||
      card._currentView === VIEW.TV
  );
}

export function wireNavItem(card, el) {
  el.addEventListener("click", () => {
    const view = el.dataset.view;
    card._clearSearchInput();
    card._searchWrap.classList.remove("expanded");
    if (view === card._currentView) return;
    card._currentView = view;
    updateNavActiveState(card);
    card.shadowRoot.querySelector(".content")?.scrollTo({ top: 0, behavior: "instant" });
    card._renderCurrentView();
    card._hero.advance();
    card._centerActiveHeaderNav?.(true);
  });
}

/* Builds the ordered list of dynamic tabs. Movies/TV Shows (cross-server aggregates,
   independently toggleable - see settings.js's movies_enabled/tv_enabled) come first when
   enabled, then config.servers/config.sections drive the rest: one "everything on this
   server" tab per server whose own show_tab is set, then that server's own libraries whose
   own show_tab is set (subtitled with the server's name so a library tab reads
   unambiguously once more than one server is in play) - repeated per server, in discovery
   order. A server/library that's enabled (feeds Home/Movies/TV Shows via all_enabled/
   enabled) but not show_tab still has no tab of its own - see sectionsForView (data.js),
   which filters on `enabled`/`all_enabled`, not `show_tab`; this is what lets a user with
   several servers collapse the nav down to just Home/Movies/TV Shows while every server
   still feeds them. A section whose server was never (re-)discovered this session (a
   config saved before this app tracked servers, or a server that's since vanished from
   the account) still gets a tab, just without a subtitle. */
function buildNavTabs(card) {
  const servers = card._config.servers || [];
  const sections = card._config.sections || [];
  const tabs = [];
  if (card._config.movies_enabled !== false) tabs.push({ view: VIEW.MOVIES, label: "Movies", sublabel: "" });
  if (card._config.tv_enabled !== false) tabs.push({ view: VIEW.TV, label: "TV Shows", sublabel: "" });
  const seenServerIds = new Set();
  for (const sv of servers) {
    seenServerIds.add(sv.id);
    if (sv.all_enabled !== false && sv.show_tab) tabs.push({ view: `server-${sv.id}`, label: sv.name, sublabel: "" });
    for (const s of sections.filter((x) => x.server_id === sv.id && x.show_tab)) {
      tabs.push({ view: `section-${sv.id}:${s.key}`, label: s.label, sublabel: sv.name });
    }
  }
  for (const s of sections.filter((x) => !seenServerIds.has(x.server_id) && x.show_tab)) {
    tabs.push({ view: `section-${s.server_id}:${s.key}`, label: s.label, sublabel: "" });
  }
  return tabs;
}

function navItemHtml(card, t, classes) {
  const label = escapeHtml(t.label);
  const labelHtml = t.sublabel
    ? `<div class="nav-label-wrap"><span class="nav-label">${label}</span><span class="nav-sublabel">${escapeHtml(t.sublabel)}</span></div>`
    : `<span class="nav-label">${label}</span>`;
  return `
          <div class="${classes}" data-view="${t.view}" tabindex="0">
            <span class="nav-icon">${iconForLibraryLabel(t.label)}</span>
            ${labelHtml}
          </div>`;
}

/* One nav tab per server-All/library entry, so Settings' "Discover Libraries" list drives the
   tabs directly and naturally covers however many servers and libraries the account has access
   to. Re-run on every setConfig() after the initial build, so re-discovering, renaming or
   toggling in Settings updates the nav without a full rebuild. Home is the one static item,
   hideable via config.home_enabled. */
export function renderNavSections(card) {
  const homeItem = card.shadowRoot.querySelector(`.nav-top .nav-item[data-view="${VIEW.HOME}"]`);
  const headerHomeItem = card.shadowRoot.querySelector(`.header-nav-item[data-view="${VIEW.HOME}"]`);
  card.shadowRoot.querySelectorAll(".nav-item-dynamic, .header-nav-item-dynamic").forEach((el) => el.remove());

  const homeEnabled = card._config.home_enabled !== false;
  homeItem.style.display = homeEnabled ? "" : "none";
  headerHomeItem.style.display = homeEnabled ? "" : "none";

  const tabs = buildNavTabs(card);
  /* The mobile sidenav copy of every tab is never shown directly on that breakpoint
     any more (see responsive.css's .nav-item-dynamic rule) - .nav-libraries is the one
     mobile entry point for all of them, via _renderLibrariesSheet's own query for this
     same class. Still rendered here (not skipped) since the desktop hover-sidenav has
     room to show them directly, and D-pad/gamepad nav (wireHomeNav) walks this same
     list regardless of breakpoint. */
  const html = tabs.map((t) => navItemHtml(card, t, "nav-item nav-item-dynamic")).join("");
  const headerHtml = tabs.map((t) => navItemHtml(card, t, "nav-item header-nav-item header-nav-item-dynamic")).join("");
  if (html) homeItem.insertAdjacentHTML("afterend", html);
  if (headerHtml) headerHomeItem.insertAdjacentHTML("afterend", headerHtml);
  card._navItems = [...card.shadowRoot.querySelectorAll(".nav-item[data-view]")];
  card.shadowRoot.querySelectorAll(".nav-item-dynamic, .header-nav-item-dynamic").forEach((el) => wireNavItem(card, el));

  /* Only worth showing the mobile Libraries button at all when there's actually a choice
     to make - a single tab has nothing to switch between (and, if Home is disabled too,
     it's already what card._currentView falls back to below). */
  const librariesBtn = card.shadowRoot.querySelector(".nav-libraries");
  if (librariesBtn) librariesBtn.style.display = tabs.length > 1 ? "" : "none";

  const validViews = new Set([VIEW.SEARCH, ...tabs.map((t) => t.view)]);
  if (homeEnabled) validViews.add(VIEW.HOME);
  if (!validViews.has(card._currentView)) {
    card._currentView = homeEnabled ? VIEW.HOME : tabs[0]?.view || VIEW.HOME;
  }
  updateNavActiveState(card);
  card._centerActiveHeaderNav?.(false);
  card._headerNavScroll?.refresh();
}

/* The desktop header-nav strip's own scroll/arrow wiring (see header-nav.css) - a
   createRowScroll instance over the same scroller/track element pair the poster rows use
   (row-scroll.js), so "center the selected library" and "hide an arrow with nothing
   further that way" both come from the exact machinery already proven there instead of a
   second implementation. Wired once against the template's stable scroller/track/arrow
   elements; renderNavSections above only ever adds/removes children of the track, so a
   single long-lived instance plus refresh()/scrollIntoView() calls is enough - no need to
   recreate it per render. */
export function wireHeaderNav(card) {
  const scroller = card._headerNavScroller;
  const track = card._headerNavTrack;
  const leftArrow = card.shadowRoot.querySelector(".header-nav-arrow.left");
  const rightArrow = card.shadowRoot.querySelector(".header-nav-arrow.right");
  const rowScroll = createRowScroll(scroller, track);
  card._headerNavScroll = rowScroll;

  leftArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    rowScroll.scrollBy(-scroller.clientWidth * 0.9, { animate: true });
  });
  rightArrow.addEventListener("click", (e) => {
    e.stopPropagation();
    rowScroll.scrollBy(scroller.clientWidth * 0.9, { animate: true });
  });
  wireArrowVisibility(rowScroll, leftArrow, rightArrow);
  /* Fades the scroller's own overflow:hidden clip via a mask instead of a hard edge -
     scoped to header-nav locally rather than folded into wireArrowVisibility above, since
     that helper is shared with poster rows/episode lists that don't want this. Mirrors the
     same offset/max thresholds wireArrowVisibility uses for the arrows' own hidden class,
     so a side only fades when there's actually more content clipped that way - otherwise
     the first/last pill would fade for no reason once fully scrolled to an end. */
  rowScroll.onChange((offset, max) => {
    scroller.classList.toggle("can-scroll-left", offset > 0);
    scroller.classList.toggle("can-scroll-right", max > 0 && offset < max);
  });

  card._centerActiveHeaderNav = (animate = true) => {
    const el = track.querySelector(".header-nav-item.active");
    if (el) rowScroll.scrollIntoView(el, { inline: "center", animate });
  };
  requestAnimationFrame(() => card._centerActiveHeaderNav(false));

  /* Centers whatever pill actually has focus, not just the active one - a single
     focusin listener here (rather than threading a helper through every place
     wireHomeNav/wireSearchNav can land focus on a nav item: Left/Right, Tab, the
     hero's "up", search's row-exit fallback...) covers all of them at once, including
     plain Tab focus, which none of those call sites handle specially anyway. Needed at
     all because this scroller's track is transform-driven (row-scroll.js), not native
     overflow - a bare .focus() brings nothing into view the way it would in a real
     scrollport, so without this a focused pill could sit clipped behind the fade mask
     or off the edge entirely. animate:true mirrors focusPoster's own rowScroll
     centering (nav.js) - a held D-pad repeat re-triggers this transform-based
     transition cleanly every step, unlike native smooth-scroll's interrupt issue noted
     elsewhere in this file. */
  track.addEventListener("focusin", (e) => {
    rowScroll.scrollIntoView(e.target, { inline: "center", animate: true });
  });
}

/* Shared "no better target" fallback for every place that drops focus out of the search input
   without a specific destination in mind. Deliberately not the sidenav's Home tab: that's a
   tab you weren't navigating to, not the first thing on screen. Home's actual first item is
   the hero's More Info button; the search results page has real posters to land on. */
/* card._navItems holds both the mobile-sidenav and desktop-header-nav copy of every view
   (see renderNavSections) - only one of the two is ever actually visible/focusable at a
   given breakpoint, so callers need the visible one, not just [0] (which is always the
   sidenav copy, in DOM order). */
function firstVisibleNavItem(card) {
  return card._navItems.find((n) => n.offsetParent !== null) || card._navItems[0];
}

export function focusFirstAvailable(card) {
  if (card._currentView === VIEW.SEARCH) {
    return card.shadowRoot.querySelector(".search-page-grid .poster") || firstVisibleNavItem(card);
  }
  if (card._currentView === VIEW.HOME) {
    return card.shadowRoot.querySelector(".hero-info-btn") || firstVisibleNavItem(card);
  }
  return firstVisibleNavItem(card);
}

/* Shared restore-on-exit for every place that drops focus out of the search input and wants
   to resume wherever focus was *before* the box was opened, rather than landing on
   focusFirstAvailable's generic default. card._searchReturnFocusEl is populated either
   explicitly (gamepad Y toggle, hero up-hand-off below) or generically via the input's own
   "focus" listener in card.js (FocusEvent.relatedTarget, covers mouse/Tab entry).
   The remembered element is often stale by the time this runs - typing a query re-renders
   .rows out from under whatever row was focused - hence the still-focusable check. */
export function restoreFocusAfterSearch(card) {
  const prev = card._searchReturnFocusEl;
  card._searchReturnFocusEl = null;
  const usable = prev?.isConnected && prev.tabIndex >= 0 && prev.offsetParent !== null;
  focusAfterPaint(usable ? prev : focusFirstAvailable(card));
}

/* Shared by every "the on-screen keyboard just closed" path below (gamepad B, real Escape,
   VirtualKeyboard geometrychange) - closing the keyboard is not the same gesture as leaving
   search entirely. With results on screen, landing on the first result lets the user start
   browsing them immediately; only an empty results page (nothing to browse into) falls back
   to fully exiting search and restoring whatever had focus before search was opened. */
export function dismissSearchKeyboard(card) {
  const firstResult = card._currentView === VIEW.SEARCH ? card.shadowRoot.querySelector(".search-page-grid .poster") : null;
  card._searchInput.blur();
  if (firstResult) {
    focusAfterPaint(firstResult);
    return;
  }
  card._clearSearchInput();
  exitSearch(card);
  card._searchWrap.classList.remove("expanded");
  restoreFocusAfterSearch(card);
}

/* Whether any overlay/modal (or the player) currently owns the screen - shared by every
   handler that needs to know "is the home screen actually what's in front of the user"
   rather than deciding purely from focus membership, since document.activeElement alone
   can't tell the two apart (see wireHomeNav's own use of this below). */
function inMainApp(card) {
  return (
    !card._titleInfo.isOpen() &&
    !card._pin.isOpen() &&
    !card._profileOverlay.classList.contains("open") &&
    !card._moreOverlay.classList.contains("open") &&
    card._profileDropdown.hidden &&
    !document.querySelector("streaming-settings-modal")?.isOpen() &&
    !document.querySelector("streaming-plex-signin-modal")?.isOpen() &&
    !player.isOpen()
  );
}

/* Gamepad Y toggles the header search box in and out of focus. Every other command in this
   app is focus-scoped (only meaningful to whichever handler currently owns focus), but "jump
   to search" is meaningful from anywhere in the browsing UI, so this one has to be gated on
   app scope explicitly - suppressed while any overlay or the player is up - rather than
   deciding by focus membership the way wireHomeNav below does. */
export function wireSearchToggle(card) {
  registerNavHandler((command, e, active) => {
    if (command !== NAV_COMMAND.SEARCH) return false;
    if (!inMainApp(card)) return false;

    if (active !== card._searchInput) {
      /* No explicit card._searchReturnFocusEl assignment here - the shadowRoot-wide
         focusin tracker in card.js already captured `active` the moment it
         was focused by whatever nav command landed on it. */
      card._searchWrap.classList.add("expanded");
      focusAfterPaint(card._searchInput);
      return true;
    }

    card._searchInput.blur();
    /* Same condition as the input's own blur listener: the box stays expanded while the
       search results page is what's on screen. */
    if (card._currentView !== VIEW.SEARCH) card._searchWrap.classList.remove("expanded");
    /* Blurring alone would leave focus on nothing at all, so the next D-pad press would
       restart from wireHomeNav's lazy first-press fallback instead of resuming where the
       user was. */
    restoreFocusAfterSearch(card);
    return true;
  });

  /* Gamepad B while the search input itself is focused just dismisses the keyboard
     (dismissSearchKeyboard - lands on the first result if there are any, otherwise backs
     all the way out). B while a *result poster* already has focus is a different gesture -
     wireSearchNav below gives results-grid posters their own Up/Down/Left/Right/Activate but
     never registers a "back" of its own, so without this a poster having focus left B
     unhandled entirely - there, B always backs all the way out, same as clearing the query
     by hand (search-page.js's onSearchInput already exits search once the box is empty). */
  registerNavHandler((command, e, active) => {
    if (command !== NAV_COMMAND.BACK) return false;
    if (!inMainApp(card) || card._currentView !== VIEW.SEARCH) return false;
    if (active === card._searchInput) {
      /* Backspace and Escape both map to "back" (focus-nav.js's KEY_TO_COMMAND) - on real
         Xbox hardware, selecting the on-screen keyboard's Backspace glyph and pressing A
         fires a real Backspace keydown, which this handler was dismissing the keyboard for
         instead of letting the input delete a character (same root cause as
         wireLinearNav's own text-entry "back" handling in focus-nav.js). Only a genuine
         Escape (real Esc, or gamepad B's synthetic Escape - never Backspace) should
         dismiss here. */
      if (e?.key === "Backspace") return false;
      dismissSearchKeyboard(card);
      return true;
    }
    card._clearSearchInput();
    exitSearch(card);
    card._searchWrap.classList.remove("expanded");
    card._searchInput.blur();
    restoreFocusAfterSearch(card);
    return true;
  });

  /* Left/Right are left to the input's own caret movement, but Down needs an owner: a text
     input is in neither wireHomeNav's nor wireSearchNav's scope (not sidenav, hero or a
     poster), so a D-pad press there would otherwise just sit in the box. Down always means
     "leave the input and go into the content below it" - unlike the Y toggle above, which
     restores wherever focus was before search opened - so it lands on focusFirstAvailable
     rather than card._searchReturnFocusEl. */
  registerNavHandler((command, e, active) => {
    if (active !== card._searchInput || command !== NAV_COMMAND.DOWN) return false;
    card._searchInput.blur();
    if (card._currentView !== VIEW.SEARCH) card._searchWrap.classList.remove("expanded");
    focusAfterPaint(focusFirstAvailable(card));
    return true;
  });

  /* Mirrors wireHomeNav's sidenav "right" hand-off (last nav item -> search, which sits
     immediately to its right in the header): Left out of the search box goes back to the
     nav strip/sidenav, which sits immediately to its left. Only once the caret is already
     at the very start of the field - otherwise Left is real caret movement through typed
     text and must fall through to the input's own native handling untouched. */
  registerNavHandler((command, e, active) => {
    if (active !== card._searchInput || command !== NAV_COMMAND.LEFT) return false;
    if (card._searchInput.selectionStart !== 0 || card._searchInput.selectionEnd !== 0) return false;
    const list = card._navItems.filter((n) => n.offsetParent !== null && !n.classList.contains("nav-profile"));
    list[list.length - 1]?.focus();
    return true;
  });
}

/* WebView2's on-screen keyboard (Xbox) is a platform-level overlay, not page content -
   dismissing it (gamepad B) is confirmed on real Xbox hardware to be consumed entirely by
   the platform before it ever reaches this app's keydown pipeline (nor even
   focus-nav.js's Gamepad API poller, which reads raw HID state directly - CoreWindow never
   deactivates for the on-screen keyboard the way it does for the Guide, so that's not why),
   the same way Android's back button eats an IME-dismiss press - so the search input is
   left focused with no page-level event ever firing to blur it, and only a subsequent Y
   press (wireSearchToggle above) clears focus.

   Two independent "the keyboard just closed" signals are listened for here, since neither
   is guaranteed to exist/fire on every build this app runs on:
   - The web-standard VirtualKeyboard API's geometrychange event. Confirmed NOT to fire on
     the Xbox WebView2 build tested (focus stayed on the search input after a real B press,
     which this handler would have blurred) - kept for whatever platform/WebView2 version
     it does work on, feature-detected so its absence is silent elsewhere.
   - MainPage.xaml.cs's OnInputPaneHiding, forwarding Windows' actual InputPane.Hiding
     event (the true on-screen-keyboard-visibility signal, independent of both the web API
     above and of whatever control/button triggered the dismissal) as a plain
     "xbox-keyboard-hiding" CustomEvent - this is the one confirmed reachable from JS on
     real Xbox hardware. */
export function wireVirtualKeyboardDismiss(card) {
  const dismissIfSearchFocused = () => {
    if (card.shadowRoot.activeElement !== card._searchInput) return;
    dismissSearchKeyboard(card);
  };

  document.addEventListener(APP_EVENT.XBOX_KEYBOARD_HIDING, dismissIfSearchFocused);

  if (!navigator.virtualKeyboard) return;
  navigator.virtualKeyboard.overlaysContent = true;
  let wasVisible = false;
  navigator.virtualKeyboard.addEventListener("geometrychange", () => {
    const visible = navigator.virtualKeyboard.boundingRect.height > 0;
    const justClosed = wasVisible && !visible;
    wasVisible = visible;
    if (justClosed) dismissIfSearchFocused();
  });
}

/* Gamepad Start ("menu" command) opens the player's own hamburger menu while a session is
   active (see player.js's constructor-level registerNavHandler, gated on this._session) -
   outside the player there's no equivalent overlay, so Start instead surfaces the app's
   Settings modal, same as clicking the sidenav's Settings button. Scoped the same way
   wireSearchToggle is (suppressed while player/title-info/settings/signin are already up)
   so Start doesn't fight the player's own handler or reopen Settings on top of itself. */
export function wireStartButton(card) {
  registerNavHandler((command) => {
    if (command !== NAV_COMMAND.MENU) return false;
    if (player.isOpen()) return false;
    if (document.querySelector("streaming-settings-modal")?.isOpen()) return false;
    if (document.querySelector("streaming-plex-signin-modal")?.isOpen()) return false;

    if (card._titleInfo.isOpen()) card._titleInfo.close();
    card.dispatchEvent(new CustomEvent(APP_EVENT.OPEN_SETTINGS, { bubbles: true, composed: true }));
    return true;
  });
}

/* Gamepad Back/Select ("profile" command) opens the Plex Home profile switcher directly, so a
   controller user doesn't have to drill into Settings to switch profiles. Only meaningful when
   there's more than one Home profile (card._hasMultipleProfiles), and scoped the same way
   wireStartButton is, so it doesn't fight the player's own handler or reopen the switcher on
   top of another overlay. */
export function wireProfileButton(card) {
  registerNavHandler((command) => {
    if (command !== NAV_COMMAND.PROFILE) return false;
    if (!card._hasMultipleProfiles) return false;
    if (player.isOpen()) return false;
    if (document.querySelector("streaming-settings-modal")?.isOpen()) return false;
    if (document.querySelector("streaming-plex-signin-modal")?.isOpen()) return false;

    if (card._titleInfo.isOpen()) card._titleInfo.close();
    card.openProfileSwitcher();
    return true;
  });
}

/* Escape/Backspace ("back") closes the header's Settings/Profile dropdown (see
   card.js's profile-menu-wrap) the same way it closes every other overlay in
   this app - the dropdown itself is a plain click target with no gamepad path of its own
   (see wireHomeNav's own note on why .nav-profile is excluded from D-pad nav), so this only
   ever fires for a real keyboard Escape/Backspace. */
export function wireProfileMenu(card) {
  registerNavHandler((command) => {
    if (command !== NAV_COMMAND.BACK) return false;
    if (card._profileDropdown.hidden) return false;
    card._closeProfileDropdown();
    focusAfterPaint(card._profileNavItem);
    return true;
  });
}

/* The home screen (sidenav + hero + a 2D grid of poster rows) isn't a single list -
   wireLinearNav's 1D model doesn't cover "Left/Right moves within whichever row
   currently has focus, Up/Down moves between rows while roughly preserving column
   position." Scoped by checking active-element membership first, so it never fires
   while a modal overlay (which registers its own handler elsewhere) currently owns
   focus - only one handler ever actually acts on a given keypress since focus is a
   singleton. */
export function wireHomeNav(card) {
  /* .nav-profile shares the .nav-item class purely for styling (see card.js's
     template) but sits in the header next to the search box, not in the vertical sidenav
     it's styled to match - this list's Up/Down/index-based traversal has no sensible
     relationship to that position, which is exactly the "doesn't work well with
     controllers" bug this exclusion fixes. Mouse/touch clicks on it still work via its own
     click listener, entirely independent of this D-pad list. */
  const sidenavItems = () =>
    Array.from(card.shadowRoot.querySelectorAll(".nav-item:not(.nav-profile)")).filter((el) => el.offsetParent !== null);
  const heroItems = () =>
    Array.from(card.shadowRoot.querySelectorAll(".hero-info-btn, .hero-watchlist-btn, .hero-play-btn, .hero-mute-btn")).filter(
      (el) => el.offsetParent !== null
    );
  const rowSections = () =>
    Array.from(card.shadowRoot.querySelectorAll(".row-section")).filter((s) => s.offsetParent !== null);
  const postersIn = (section) =>
    section ? Array.from(section.querySelectorAll(".poster")).filter((el) => el.offsetParent !== null) : [];
  /* Preferred landing spot for a fresh D-pad/gamepad press with nothing focused yet -
     the in-progress item a returning viewer almost always wants, not the sidenav's own
     top entry. Falls back to the sidenav below when there's no Continue Watching row at
     all (empty on-deck, or the current view isn't Home) rather than focusing nothing. */
  const continueWatchingFirstPoster = () =>
    postersIn(card.shadowRoot.querySelector('.row-section[data-row-key="on-deck"]'))[0] || null;
  /* Posters live in a vertically-stacked, independently-scrollable row inside the page's
     own scroll container - focusing one is not guaranteed to bring its whole row toward
     the viewport's center the way a plain .focus() call would (browsers default to the
     minimal "nearest" scroll). Centering it explicitly means landing on a row always
     shows its neighbors above/below too, not just a sliver of the row you jumped to. */
  const focusPoster = (el) => {
    el?.focus();
    if (!el) return;
    /* Smooth on both axes, but retest this before assuming it's fine: a held d-pad or stick
       fires the next move every REPEAT_RATE_MS (150ms), and native scrollIntoView's "smooth"
       was confirmed on real hardware to sometimes not retarget cleanly when interrupted before
       it finished, leaving a held stick never quite settling centered. row-scroll.js's
       transform-driven horizontal centering doesn't have that failure mode (CSS transitions
       retarget predictably when interrupted); vertical centering below is still a real
       scrollIntoView against .content, so that's the one at risk. If it reproduces, the fix is
       giving .content the same transform-driven treatment, not reverting to instant. */
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    el.closest(".row-scroller")?.rowScroll?.scrollIntoView(el, { inline: "center", animate: true });
  };
  /* The hero banner sits at the very top of the page's scroll container, so any focus
     landing on one of its buttons needs the page scrolled all the way up too - otherwise
     a D-pad/gamepad user coming up from a poster row sees the hero cut off mid-scroll
     instead of in full. */
  const focusHero = (el) => {
    el?.focus();
    card.shadowRoot.querySelector(".content")?.scrollTo({ top: 0, behavior: "smooth" });
  };

  registerNavHandler((command, e, active) => {
    const inSidenav = sidenavItems().includes(active);
    const inHero = !inSidenav && heroItems().includes(active);
    const posterSection = !inSidenav && !inHero && active?.classList?.contains("poster") ? active.closest(".row-section") : null;

    if (!inSidenav && !inHero && !posterSection) {
      /* Every registered handler sees every keydown regardless of which owns focus, so
         returning false here must NOT be read as "nothing is focused", only "not focused in my
         scope" - a modal overlay's handler may legitimately own this press. Only a true
         fresh-load (no active element anywhere, or just document.body/the card host with
         nothing focused inside) gets the lazy first-D-pad-press starting point.

         document.activeElement resting on document.body is NOT unique to a fresh load, though:
         wireLinearNav's focusItem blurs the previously-active element without calling .focus()
         on a text/password/number field it lands on (real focus there would pop the on-screen
         keyboard just for passing through), leaving activeElement on document.body while the
         Settings modal is open with one of its fields only virtually highlighted. Without the
         inMainApp(card) check that state looks identical to "nothing focused anywhere", and
         this handler grabs a home-screen poster out from under the open modal - confirmed on
         hardware: D-pad left/right on a highlighted Settings field silently scrolled the home
         row behind it. */
      const nothingFocusedYet = (!active || active === document.body || active === card) && inMainApp(card);
      if (nothingFocusedYet && [NAV_COMMAND.UP, NAV_COMMAND.DOWN, NAV_COMMAND.LEFT, NAV_COMMAND.RIGHT].includes(command)) {
        const target = continueWatchingFirstPoster();
        if (target) focusPoster(target);
        else sidenavItems()[0]?.focus();
        return true;
      }
      return false;
    }

    if (command === NAV_COMMAND.ACTIVATE) {
      active.click();
      return true;
    }

    if (inSidenav) {
      /* Horizontal on both breakpoints now - the mobile bottom bar was already a row, and
         the desktop nav moved from a vertical sidenav into a horizontal header strip (see
         header-nav.css) - so Left/Right move within the list and Down enters the main
         content below it, on both. (D-pad/gamepad nav realistically only ever happens at
         the desktop breakpoint - Fire TV/Xbox, not a phone - so there's no real mobile
         case to keep this list's old vertical Up/Down semantics working for.) */
      const list = sidenavItems();
      const idx = list.indexOf(active);
      if (command === NAV_COMMAND.RIGHT) {
        if (idx < list.length - 1) {
          list[idx + 1].focus();
          return true;
        }
        // last nav item - hand off to search, which sits immediately to its right in the header.
        card._searchWrap.classList.add("expanded");
        focusAfterPaint(card._searchInput);
        return true;
      }
      if (command === NAV_COMMAND.LEFT) {
        if (idx > 0) list[idx - 1].focus();
        return true; // first item - nothing further left, swallow
      }
      if (command === NAV_COMMAND.DOWN) {
        const remembered = card._lastContentFocusEl;
        const rememberedUsable = remembered?.isConnected && remembered.tabIndex >= 0 && remembered.offsetParent !== null;
        if (rememberedUsable && heroItems().includes(remembered)) {
          focusHero(remembered);
        } else if (rememberedUsable && remembered.classList.contains("poster") && remembered.closest(".row-section")) {
          focusPoster(remembered);
        } else {
          const heroTarget = heroItems()[0];
          if (heroTarget) focusHero(heroTarget);
          else focusPoster(postersIn(rowSections()[0])[0]);
        }
        return true;
      }
      return false;
    }

    if (inHero) {
      const list = heroItems();
      const idx = list.indexOf(active);
      if (command === NAV_COMMAND.RIGHT) {
        focusHero(list[Math.min(idx + 1, list.length - 1)]);
        return true;
      }
      if (command === NAV_COMMAND.LEFT) {
        if (idx > 0) focusHero(list[idx - 1]);
        return true; // first hero button - nothing further left, swallow
      }
      if (command === NAV_COMMAND.DOWN) {
        focusPoster(postersIn(rowSections()[0])[0]);
        return true;
      }
      if (command === NAV_COMMAND.UP) {
        // The nav strip sits directly above the hero on both breakpoints now (see
        // header-nav.css) - land on whichever of its items is currently active, not
        // search (search sits beside the nav strip, not above the hero).
        const list = sidenavItems();
        (list.find((n) => n.classList.contains("active")) || list[0])?.focus();
        return true;
      }
      return false;
    }

    // posterSection
    const posters = postersIn(posterSection);
    const idx = posters.indexOf(active);
    if (command === NAV_COMMAND.RIGHT) {
      focusPoster(posters[Math.min(idx + 1, posters.length - 1)]);
      return true;
    }
    if (command === NAV_COMMAND.LEFT) {
      if (idx > 0) focusPoster(posters[idx - 1]);
      return true; // start of the row - nothing further left, swallow
    }
    /* LB/RB (see focus-nav.js's chapterPrev/chapterNext - named for their other use in the
       player's chapter skip, not row-specific) jump 4 posters at once instead of 1, clamped
       to the row's own ends rather than leaving the row the way a plain Left off the row's
       start does - a fast-scroll gesture landing on "nothing further this way" reads
       as reaching the end of the row, not as a request to leave it. */
    if (command === NAV_COMMAND.CHAPTER_PREV || command === NAV_COMMAND.CHAPTER_NEXT) {
      const delta = command === NAV_COMMAND.CHAPTER_NEXT ? 4 : -4;
      focusPoster(posters[Math.max(0, Math.min(posters.length - 1, idx + delta))]);
      return true;
    }
    if (command === NAV_COMMAND.DOWN || command === NAV_COMMAND.UP) {
      const sections = rowSections();
      const sectionIdx = sections.indexOf(posterSection);
      if (command === NAV_COMMAND.UP && sectionIdx === 0) {
        focusHero(heroItems()[0]);
        return true;
      }
      const targetSection = sections[sectionIdx + (command === NAV_COMMAND.DOWN ? 1 : -1)];
      if (!targetSection) return true; // no more rows that way - swallow
      const targetPosters = postersIn(targetSection);
      focusPoster(closestByPosition(targetPosters, active));
      return true;
    }
    return false;
  });
}

/* LB/RB (CHAPTER_PREV/CHAPTER_NEXT) switch between top-level tabs (sidenav/header-nav
   items) whenever focus isn't on a poster - wireHomeNav's own posterSection branch above
   already claims LB/RB there for its row fast-scroll-by-4 gesture, so this only ever fires
   for the sidenav/hero/search-input/nothing-focused cases, never stealing the row gesture.
   Scoped to the main app via inMainApp so it doesn't fight the player's own use of the same
   command for chapter skip (player.js). Clamped at the tab list's own ends, same as
   the sidenav's own Left/Right handling in wireHomeNav - no wraparound. */
export function wireTabSwitch(card) {
  registerNavHandler((command, e, active) => {
    if (command !== NAV_COMMAND.CHAPTER_PREV && command !== NAV_COMMAND.CHAPTER_NEXT) return false;
    if (!inMainApp(card)) return false;
    if (active?.classList?.contains("poster")) return false;
    if (active === card._searchInput) return false;

    const list = card._navItems.filter((n) => n.offsetParent !== null && !n.classList.contains("nav-profile"));
    if (!list.length) return false;
    const activeIdx = list.findIndex((n) => n.classList.contains("active"));
    const idx = activeIdx === -1 ? 0 : activeIdx;
    const delta = command === NAV_COMMAND.CHAPTER_NEXT ? 1 : -1;
    const next = list[Math.max(0, Math.min(list.length - 1, idx + delta))];
    if (next === list[idx]) return true;
    next.click();
    focusAfterPaint(next);
    return true;
  });
}

/* Search results: D-pad/gamepad navigation for the results grid search-page.js renders
   into card._rowsEl. Kept separate from wireHomeNav above because .search-page-grid
   (header-search.css) is a flex-wrap flow that wraps to however many columns the
   viewport fits, not a horizontal-scrolling single-line .row-section - "row" here can't
   be assumed from markup structure the way it can on the home screen, only discovered
   from actual rendered layout. Without this, search-page posters were still Tab-focusable
   (buildPoster gives every poster tabIndex 0) but had no D-pad/gamepad handler at all -
   wireHomeNav's posterSection lookup requires a .row-section ancestor, which the search
   page never has, so every arrow press and Activate on a search result silently no-opped. */
export function wireSearchNav(card) {
  const sidenavItems = () => Array.from(card.shadowRoot.querySelectorAll(".nav-item:not(.nav-profile)")).filter((el) => el.offsetParent !== null);
  const allPosters = () =>
    Array.from(card.shadowRoot.querySelectorAll(".search-page-grid .poster")).filter((el) => el.offsetParent !== null);

  const focusPoster = (el) => {
    el?.focus();
    /* Not "smooth" - a held/repeating d-pad or stick fires the next move every
       REPEAT_RATE_MS (150ms, focus-nav.js), faster than a smooth scroll's own animation
       takes to finish. Each new move interrupted the previous one's in-flight smooth
       scroll before it ever reached center - confirmed via logging on real hardware, a
       held stick hit this on nearly every step while an isolated single d-pad tap (no
       following move to interrupt it) centered correctly. An instant jump can't be
       interrupted mid-animation, so every step - however fast they arrive - lands
       exactly centered. */
    el?.scrollIntoView({ block: "center", inline: "center" });
  };

  /* Column count varies with viewport width and each hub's grid wraps independently, so
     rows can't be derived from index math the way pin.js's fixed 3-column keypad can be -
     they're discovered empirically by clustering posters that share a vertical position,
     the same positional-matching idea closestByPosition uses for column alignment below. */
  const rowsOf = (posters) => {
    const rows = [];
    for (const el of posters) {
      const top = el.getBoundingClientRect().top;
      let row = rows.find((r) => Math.abs(r.top - top) < 2);
      if (!row) {
        row = { top, items: [] };
        rows.push(row);
      }
      row.items.push(el);
    }
    return rows.sort((a, b) => a.top - b.top);
  };

  registerNavHandler((command, e, active) => {
    if (card._currentView !== VIEW.SEARCH) return false;

    /* hero.js's show() forces display:none for the whole hero banner whenever
       getCurrentView() === "search", so there's no hero to hand off to here the way
       wireHomeNav's sidenav "down" does on the home screen - its fallback
       (postersIn(rowSections()[0])) also comes up empty since .row-section never
       exists on this page, so without this the event was swallowed with nowhere to
       go. Enter the grid directly instead. */
    if (sidenavItems().includes(active)) {
      if (command !== NAV_COMMAND.DOWN) return false;
      const remembered = card._lastContentFocusEl;
      const rememberedUsable =
        remembered?.isConnected && remembered.tabIndex >= 0 && remembered.offsetParent !== null && allPosters().includes(remembered);
      focusPoster(rememberedUsable ? remembered : allPosters()[0]);
      return true;
    }

    if (!active?.classList?.contains("poster") || !active.closest(".search-page-grid")) return false;

    if (command === NAV_COMMAND.ACTIVATE) {
      active.click();
      return true;
    }

    const posters = allPosters();
    const idx = posters.indexOf(active);
    if (idx === -1) return false;

    if (command === NAV_COMMAND.RIGHT) {
      if (idx < posters.length - 1) focusPoster(posters[idx + 1]);
      return true; // last poster on the page - nowhere further right, swallow
    }
    if (command === NAV_COMMAND.LEFT) {
      if (idx > 0) focusPoster(posters[idx - 1]);
      return true; // first poster on the page - nothing further left, swallow
    }
    if (command === NAV_COMMAND.UP || command === NAV_COMMAND.DOWN) {
      const rows = rowsOf(posters);
      const rowIdx = rows.findIndex((r) => r.items.includes(active));
      const targetRowIdx = rowIdx + (command === NAV_COMMAND.DOWN ? 1 : -1);
      if (targetRowIdx < 0) {
        // no hero to hand off to during search (see the sidenav branch above) - the nav
        // strip, directly above the grid, is it
        (sidenavItems().find((n) => n.classList.contains("active")) || sidenavItems()[0])?.focus();
        return true;
      }
      if (targetRowIdx >= rows.length) return true; // last row on the page - swallow
      focusPoster(closestByPosition(rows[targetRowIdx].items, active));
      return true;
    }
    return false;
  });
}
