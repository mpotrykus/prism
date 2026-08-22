import { focusAfterPaint, registerNavHandler } from "../../focus-nav.js";
import { player } from "../../plex-player.js";
import { createRowScroll } from "./row-scroll.js";
import { wireArrowVisibility } from "./rows.js";

/* Sidenav: rendering one tab per fetched library, wiring each tab's click, and the
   2D D-pad/gamepad navigation across sidenav + hero + poster rows (there's no single
   1D list here - see wireHomeNav's own comment). Takes the PlexNetflixCard instance as
   an explicit first argument (same pattern as data.js/search-page.js). */

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

export function wireNavItem(card, el) {
  el.addEventListener("click", () => {
    const view = el.dataset.view;
    card._clearSearchInput();
    card._searchWrap.classList.remove("expanded");
    if (view === card._currentView) return;
    card._currentView = view;
    /* Matched by view, not by `el` itself - the same view has two nav elements now (one
       in the mobile sidenav, one in the desktop header-nav strip, see renderNavSections
       below), and only one of them is ever the one actually clicked. */
    card._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === view));
    card.shadowRoot.querySelector(".content")?.scrollTo({ top: 0, behavior: "instant" });
    card._renderCurrentView();
    card._advanceHero();
    card._centerActiveHeaderNav?.(true);
  });
}

/* Renders one nav tab per fetched library (config.sections) instead of fixed Movies/TV
   entries - lets Settings' "Fetch Libraries" list drive the tabs directly, so it
   naturally covers however many/whatever-named libraries the server actually has.
   Re-run on every setConfig() after the initial build so re-fetching/renaming/toggling
   libraries in Settings updates the nav without a full rebuild. Home stays a separate
   static item since it's the fixed "everything combined" view, not tied to any one
   section. */
export function renderNavSections(card) {
  const homeItem = card.shadowRoot.querySelector('.nav-top .nav-item[data-view="home"]');
  const headerHomeItem = card.shadowRoot.querySelector('.header-nav-item[data-view="home"]');
  card.shadowRoot.querySelectorAll(".nav-item-dynamic, .header-nav-item-dynamic").forEach((el) => el.remove());
  const sections = card._config.sections || [];
  const html = sections
    .map(
      (s, i) => `
          <div class="nav-item nav-item-dynamic${i >= MOBILE_VISIBLE_SECTION_CAP ? " nav-item-overflow" : ""}" data-view="section-${s.key}" tabindex="0">
            <span class="nav-icon">${iconForLibraryLabel(s.label)}</span>
            <span class="nav-label">${card._escape(s.label)}</span>
          </div>`
    )
    .join("");
  /* No overflow cap here - the desktop strip has no "more" sheet to spill into, every
     section stays reachable by scrolling the strip (see wireHeaderNav's arrows). */
  const headerHtml = sections
    .map(
      (s) => `
          <div class="nav-item header-nav-item header-nav-item-dynamic" data-view="section-${s.key}" tabindex="0">
            <span class="nav-icon">${iconForLibraryLabel(s.label)}</span>
            <span class="nav-label">${card._escape(s.label)}</span>
          </div>`
    )
    .join("");
  if (html) homeItem.insertAdjacentHTML("afterend", html);
  if (headerHtml) headerHomeItem.insertAdjacentHTML("afterend", headerHtml);
  card._navItems = [...card.shadowRoot.querySelectorAll(".nav-item[data-view]")];
  card.shadowRoot.querySelectorAll(".nav-item-dynamic, .header-nav-item-dynamic").forEach((el) => wireNavItem(card, el));
  if (card._currentView !== "home" && card._currentView !== "search" && !sections.some((s) => `section-${s.key}` === card._currentView)) {
    card._currentView = "home";
  }
  card._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === card._currentView));
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

  card._centerActiveHeaderNav = (animate = true) => {
    const el = track.querySelector(".header-nav-item.active");
    if (el) rowScroll.scrollIntoView(el, { inline: "center", animate });
  };
  requestAnimationFrame(() => card._centerActiveHeaderNav(false));
}

/* Shared "no better target" fallback for every place that drops focus out of the search
   input without a specific destination in mind. The sidenav's Home tab used to be that
   fallback everywhere, but it's a poor landing spot - it's not "the first thing on
   screen," it's a tab you weren't navigating to. Home's actual first item is the hero's
   More Info button; the search results page has real posters to land on instead. */
/* card._navItems holds both the mobile-sidenav and desktop-header-nav copy of every view
   (see renderNavSections) - only one of the two is ever actually visible/focusable at a
   given breakpoint, so callers need the visible one, not just [0] (which is always the
   sidenav copy, in DOM order). */
function firstVisibleNavItem(card) {
  return card._navItems.find((n) => n.offsetParent !== null) || card._navItems[0];
}

export function focusFirstAvailable(card) {
  if (card._currentView === "search") {
    return card.shadowRoot.querySelector(".search-page-grid .poster") || firstVisibleNavItem(card);
  }
  if (card._currentView === "home") {
    return card.shadowRoot.querySelector(".hero-info-btn") || firstVisibleNavItem(card);
  }
  return firstVisibleNavItem(card);
}

/* Shared restore-on-exit for every place that drops focus out of the search input and wants
   to resume wherever focus was *before* the box was opened, rather than landing on
   focusFirstAvailable's generic default. card._searchReturnFocusEl is populated either
   explicitly (gamepad Y toggle, hero up-hand-off below) or generically via the input's own
   "focus" listener in plex-netflix-card.js (FocusEvent.relatedTarget, covers mouse/Tab entry).
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
  const firstResult = card._currentView === "search" ? card.shadowRoot.querySelector(".search-page-grid .poster") : null;
  card._searchInput.blur();
  if (firstResult) {
    focusAfterPaint(firstResult);
    return;
  }
  card._clearSearchInput();
  card._exitSearch();
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
    if (command !== "search") return false;
    if (!inMainApp(card)) return false;

    if (active !== card._searchInput) {
      /* No explicit card._searchReturnFocusEl assignment here - the shadowRoot-wide
         focusin tracker in plex-netflix-card.js already captured `active` the moment it
         was focused by whatever nav command landed on it. */
      card._searchWrap.classList.add("expanded");
      focusAfterPaint(card._searchInput);
      return true;
    }

    card._searchInput.blur();
    /* Same condition as the input's own blur listener: the box stays expanded while the
       search results page is what's on screen. */
    if (card._currentView !== "search") card._searchWrap.classList.remove("expanded");
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
    if (command !== "back") return false;
    if (!inMainApp(card) || card._currentView !== "search") return false;
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
    card._exitSearch();
    card._searchWrap.classList.remove("expanded");
    card._searchInput.blur();
    restoreFocusAfterSearch(card);
    return true;
  });

  /* Left/Right are left to the input's own native caret movement, but nothing previously
     handled Down at all - a text input isn't in wireHomeNav's/wireSearchNav's scope
     (neither sidenav, hero, nor a poster), so a D-pad/gamepad press there had no owner
     and just sat in the box. Down always means "leave the input and go into the content
     below it," unlike the Y toggle above (which restores wherever focus was before
     search was opened) - so this always lands on focusFirstAvailable rather than
     card._searchReturnFocusEl. */
  registerNavHandler((command, e, active) => {
    if (active !== card._searchInput || command !== "down") return false;
    card._searchInput.blur();
    if (card._currentView !== "search") card._searchWrap.classList.remove("expanded");
    focusAfterPaint(focusFirstAvailable(card));
    return true;
  });

  /* Mirrors wireHomeNav's sidenav "right" hand-off (last nav item -> search, which sits
     immediately to its right in the header): Left out of the search box goes back to the
     nav strip/sidenav, which sits immediately to its left. Only once the caret is already
     at the very start of the field - otherwise Left is real caret movement through typed
     text and must fall through to the input's own native handling untouched. */
  registerNavHandler((command, e, active) => {
    if (active !== card._searchInput || command !== "left") return false;
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

  document.addEventListener("xbox-keyboard-hiding", dismissIfSearchFocused);

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
   active (see plex-player.js's constructor-level registerNavHandler, gated on this._session) -
   outside the player there's no equivalent overlay, so Start instead surfaces the app's
   Settings modal, same as clicking the sidenav's Settings button. Scoped the same way
   wireSearchToggle is (suppressed while player/title-info/settings/signin are already up)
   so Start doesn't fight the player's own handler or reopen Settings on top of itself. */
export function wireStartButton(card) {
  registerNavHandler((command) => {
    if (command !== "menu") return false;
    if (player.isOpen()) return false;
    if (document.querySelector("streaming-settings-modal")?.isOpen()) return false;
    if (document.querySelector("streaming-plex-signin-modal")?.isOpen()) return false;

    if (card._titleInfo.isOpen()) card._titleInfo.close();
    card.dispatchEvent(new CustomEvent("open-settings", { bubbles: true, composed: true }));
    return true;
  });
}

/* Gamepad Back/Select ("profile" command) opens the Plex Home profile switcher directly,
   replacing the old Settings > Profiles tab - a controller user no longer has to drill
   into Settings just to switch profiles. Only meaningful when there's actually more than
   one Home profile to switch between (card._hasMultipleProfiles - see
   plex-netflix-card.js's _renderProfileNav), and scoped the same way wireStartButton is,
   so it doesn't fight the player's own handler or reopen the switcher on top of another
   overlay. */
export function wireProfileButton(card) {
  registerNavHandler((command) => {
    if (command !== "profile") return false;
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
   plex-netflix-card.js's profile-menu-wrap) the same way it closes every other overlay in
   this app - the dropdown itself is a plain click target with no gamepad path of its own
   (see wireHomeNav's own note on why .nav-profile is excluded from D-pad nav), so this only
   ever fires for a real keyboard Escape/Backspace. */
export function wireProfileMenu(card) {
  registerNavHandler((command) => {
    if (command !== "back") return false;
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
  /* .nav-profile shares the .nav-item class purely for styling (see plex-netflix-card.js's
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
    /* Smooth again on both axes - retest against the exact bug that made this instant in
       the first place before assuming it's fine: a held/repeating d-pad or stick fires the
       next move every REPEAT_RATE_MS (150ms, focus-nav.js), and native scrollIntoView's
       "smooth" was previously confirmed on real hardware to sometimes not retarget cleanly
       when interrupted by the next move before it finished, leaving a held stick never
       quite settling centered. row-scroll.js's own transform-driven inline (horizontal)
       centering doesn't have that failure mode (CSS transitions retarget smoothly and
       predictably when interrupted, unlike that scroll API) - block (vertical) centering
       below is still the real scrollIntoView against .content, so it's the one actually at
       risk of reproducing the old bug. If it does, the fix is giving .content the same
       transform-driven treatment row-scroll.js already gives rows, not reverting to instant. */
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
  /* Rows scroll horizontally independent of one another, so the same array index in two
     rows can sit at completely different on-screen columns - matching by index made
     up/down land on a poster with no visual relationship to the one just left. Matching
     by actual horizontal center position is what "roughly preserving column position"
     (the comment above wireHomeNav) actually requires. */
  const closestByPosition = (posters, referenceEl) => {
    if (!posters.length) return null;
    const refCenter = referenceEl.getBoundingClientRect().left + referenceEl.getBoundingClientRect().width / 2;
    return posters.reduce((best, el) => {
      const center = el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
      const bestCenter = best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2;
      return Math.abs(center - refCenter) < Math.abs(bestCenter - refCenter) ? el : best;
    });
  };

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
         this handler stealing focus mid-interaction with some other overlay.
         document.activeElement resting on document.body is NOT unique to a true fresh
         load, though - wireLinearNav's focusItem deliberately blurs the previously-active
         element without calling .focus() on a text/password/number field it's landing on
         (real focus there would pop the on-screen keyboard just for passing through it -
         see focus-nav.js), leaving document.activeElement on document.body while, say, the
         Settings modal is legitimately open and one of its fields is only virtually
         highlighted. Without the inMainApp(card) check here too, that state looked
         identical to "nothing focused anywhere" and this handler grabbed a home-screen
         poster out from under the open modal - confirmed on real hardware: D-pad/stick
         left-right on a virtually-highlighted Settings field was silently scrolling the
         home row behind it. */
      const nothingFocusedYet = (!active || active === document.body || active === card) && inMainApp(card);
      if (nothingFocusedYet && ["up", "down", "left", "right"].includes(command)) {
        const target = continueWatchingFirstPoster();
        if (target) focusPoster(target);
        else sidenavItems()[0]?.focus();
        return true;
      }
      return false;
    }

    if (command === "activate") {
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
      if (command === "right") {
        if (idx < list.length - 1) {
          list[idx + 1].focus();
          return true;
        }
        // last nav item - hand off to search, which sits immediately to its right in the header.
        card._searchWrap.classList.add("expanded");
        focusAfterPaint(card._searchInput);
        return true;
      }
      if (command === "left") {
        if (idx > 0) list[idx - 1].focus();
        return true; // first item - nothing further left, swallow
      }
      if (command === "down") {
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
      if (command === "right") {
        focusHero(list[Math.min(idx + 1, list.length - 1)]);
        return true;
      }
      if (command === "left") {
        if (idx > 0) focusHero(list[idx - 1]);
        return true; // first hero button - nothing further left, swallow
      }
      if (command === "down") {
        focusPoster(postersIn(rowSections()[0])[0]);
        return true;
      }
      if (command === "up") {
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
    if (command === "right") {
      focusPoster(posters[Math.min(idx + 1, posters.length - 1)]);
      return true;
    }
    if (command === "left") {
      if (idx > 0) focusPoster(posters[idx - 1]);
      return true; // start of the row - nothing further left, swallow
    }
    /* LB/RB (see focus-nav.js's chapterPrev/chapterNext - named for their other use in the
       player's chapter skip, not row-specific) jump 4 posters at once instead of 1, clamped
       to the row's own ends rather than leaving the row the way a plain Left off the row's
       start does - a fast-scroll gesture landing on "nothing further this way" reads
       as reaching the end of the row, not as a request to leave it. */
    if (command === "chapterPrev" || command === "chapterNext") {
      const delta = command === "chapterNext" ? 4 : -4;
      focusPoster(posters[Math.max(0, Math.min(posters.length - 1, idx + delta))]);
      return true;
    }
    if (command === "down" || command === "up") {
      const sections = rowSections();
      const sectionIdx = sections.indexOf(posterSection);
      if (command === "up" && sectionIdx === 0) {
        focusHero(heroItems()[0]);
        return true;
      }
      const targetSection = sections[sectionIdx + (command === "down" ? 1 : -1)];
      if (!targetSection) return true; // no more rows that way - swallow
      const targetPosters = postersIn(targetSection);
      focusPoster(closestByPosition(targetPosters, active));
      return true;
    }
    return false;
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
  const closestByPosition = (posters, referenceEl) => {
    if (!posters.length) return null;
    const refCenter = referenceEl.getBoundingClientRect().left + referenceEl.getBoundingClientRect().width / 2;
    return posters.reduce((best, el) => {
      const center = el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
      const bestCenter = best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2;
      return Math.abs(center - refCenter) < Math.abs(bestCenter - refCenter) ? el : best;
    });
  };

  registerNavHandler((command, e, active) => {
    if (card._currentView !== "search") return false;

    /* hero.js's show() forces display:none for the whole hero banner whenever
       getCurrentView() === "search", so there's no hero to hand off to here the way
       wireHomeNav's sidenav "down" does on the home screen - its fallback
       (postersIn(rowSections()[0])) also comes up empty since .row-section never
       exists on this page, so without this the event was swallowed with nowhere to
       go. Enter the grid directly instead. */
    if (sidenavItems().includes(active)) {
      if (command !== "down") return false;
      const remembered = card._lastContentFocusEl;
      const rememberedUsable =
        remembered?.isConnected && remembered.tabIndex >= 0 && remembered.offsetParent !== null && allPosters().includes(remembered);
      focusPoster(rememberedUsable ? remembered : allPosters()[0]);
      return true;
    }

    if (!active?.classList?.contains("poster") || !active.closest(".search-page-grid")) return false;

    if (command === "activate") {
      active.click();
      return true;
    }

    const posters = allPosters();
    const idx = posters.indexOf(active);
    if (idx === -1) return false;

    if (command === "right") {
      if (idx < posters.length - 1) focusPoster(posters[idx + 1]);
      return true; // last poster on the page - nowhere further right, swallow
    }
    if (command === "left") {
      if (idx > 0) focusPoster(posters[idx - 1]);
      return true; // first poster on the page - nothing further left, swallow
    }
    if (command === "up" || command === "down") {
      const rows = rowsOf(posters);
      const rowIdx = rows.findIndex((r) => r.items.includes(active));
      const targetRowIdx = rowIdx + (command === "down" ? 1 : -1);
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
