import { focusAfterPaint, registerNavHandler } from "../../focus-nav.js";
import { player } from "../../plex-player.js";

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
    card._navItems.forEach((n) => n.classList.toggle("active", n === el));
    window.scrollTo({ top: 0, behavior: "instant" });
    card._renderCurrentView();
    card._advanceHero();
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
  const homeItem = card.shadowRoot.querySelector('.nav-item[data-view="home"]');
  card.shadowRoot.querySelectorAll(".nav-item-dynamic").forEach((el) => el.remove());
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
  if (html) homeItem.insertAdjacentHTML("afterend", html);
  card._navItems = [...card.shadowRoot.querySelectorAll(".nav-item[data-view]")];
  card.shadowRoot.querySelectorAll(".nav-item-dynamic").forEach((el) => wireNavItem(card, el));
  if (card._currentView !== "home" && card._currentView !== "search" && !sections.some((s) => `section-${s.key}` === card._currentView)) {
    card._currentView = "home";
  }
  card._navItems.forEach((n) => n.classList.toggle("active", n.dataset.view === card._currentView));
}

/* Shared "no better target" fallback for every place that drops focus out of the search
   input without a specific destination in mind. The sidenav's Home tab used to be that
   fallback everywhere, but it's a poor landing spot - it's not "the first thing on
   screen," it's a tab you weren't navigating to. Home's actual first item is the hero's
   More Info button; the search results page has real posters to land on instead. */
export function focusFirstAvailable(card) {
  if (card._currentView === "search") {
    return card.shadowRoot.querySelector(".search-page-grid .poster") || card._navItems[0];
  }
  if (card._currentView === "home") {
    return card.shadowRoot.querySelector(".hero-info-btn") || card._navItems[0];
  }
  return card._navItems[0];
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

/* Gamepad Y toggles the header search box in and out of focus. Every other command in this
   app is focus-scoped (only meaningful to whichever handler currently owns focus), but "jump
   to search" is meaningful from anywhere in the browsing UI, so this one has to be gated on
   app scope explicitly - suppressed while any overlay or the player is up - rather than
   deciding by focus membership the way wireHomeNav below does. */
export function wireSearchToggle(card) {
  const inMainApp = () =>
    !card._titleInfo.isOpen() &&
    !card._pin.isOpen() &&
    !card._profileOverlay.classList.contains("open") &&
    !card._moreOverlay.classList.contains("open") &&
    !document.querySelector("streaming-settings-modal")?.isOpen() &&
    !document.querySelector("streaming-plex-signin-modal")?.isOpen() &&
    !player.isOpen();

  registerNavHandler((command, e, active) => {
    if (command !== "search") return false;
    if (!inMainApp()) return false;

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

  /* Gamepad B while browsing the search results page backs all the way out, same as
     clearing the query by hand (search-page.js's onSearchInput already exits search once
     the box is empty). Unlike every other handler here, this isn't gated on `active` being
     the search input - wireSearchNav below gives results-grid posters their own Up/Down/
     Left/Right, but never registers a "back" of its own, so a poster having focus left B
     unhandled entirely before this existed. */
  registerNavHandler((command, e, active) => {
    if (command !== "back") return false;
    if (!inMainApp() || card._currentView !== "search") return false;
    card._clearSearchInput();
    card._exitSearch();
    card._searchWrap.classList.remove("expanded");
    card._searchInput.blur();
    focusAfterPaint(focusFirstAvailable(card));
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
}

/* WebView2's on-screen keyboard (Xbox) is a platform-level overlay, not page content -
   dismissing it (gamepad B) is very likely consumed entirely by the platform before it
   ever reaches this app's keydown pipeline, the same way Android's back button eats an
   IME-dismiss press - so the search input is left focused with no page-level event ever
   firing to blur it, and only a subsequent Y press (wireSearchToggle above) clears focus.
   The VirtualKeyboard API's geometrychange event is the one cross-platform signal for
   "the keyboard just closed" that's independent of whatever button/gesture caused it.
   Feature-detected: older WebView2/Android WebView builds without it just keep relying on
   the Y-toggle/Escape paths as before. Unverified on real Xbox hardware whether WebView2
   actually fires geometrychange for the platform keyboard - confirm before building
   anything further on top of this. */
export function wireVirtualKeyboardDismiss(card) {
  if (!navigator.virtualKeyboard) return;
  navigator.virtualKeyboard.overlaysContent = true;
  let wasVisible = false;
  navigator.virtualKeyboard.addEventListener("geometrychange", () => {
    const visible = navigator.virtualKeyboard.boundingRect.height > 0;
    const justClosed = wasVisible && !visible;
    wasVisible = visible;
    if (!justClosed || card.shadowRoot.activeElement !== card._searchInput) return;
    card._searchInput.blur();
    if (card._currentView !== "search") card._searchWrap.classList.remove("expanded");
    restoreFocusAfterSearch(card);
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
    el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  };
  /* The hero banner sits at the very top of the page's scroll container, so any focus
     landing on one of its buttons needs the page scrolled all the way up too - otherwise
     a D-pad/gamepad user coming up from a poster row sees the hero cut off mid-scroll
     instead of in full. */
  const focusHero = (el) => {
    el?.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
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
         this handler stealing focus mid-interaction with some other overlay. */
      const nothingFocusedYet = !active || active === document.body || active === card;
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
        const heroTarget = heroItems()[0];
        if (heroTarget) focusHero(heroTarget);
        else focusPoster(postersIn(rowSections()[0])[0]);
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
        if (idx <= 0) sidenavItems()[0]?.focus();
        else focusHero(list[idx - 1]);
        return true;
      }
      if (command === "down") {
        focusPoster(postersIn(rowSections()[0])[0]);
        return true;
      }
      if (command === "up") {
        // same hand-off wireSearchToggle's "search" command does - up from the hero has
        // nowhere else to go, and the search box sits directly above it in the header.
        // (card._searchReturnFocusEl is already `active` via the focusin tracker.)
        card._searchWrap.classList.add("expanded");
        focusAfterPaint(card._searchInput);
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
      if (idx <= 0) sidenavItems()[0]?.focus();
      else focusPoster(posters[idx - 1]);
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
    el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
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
       wireHomeNav's sidenav "right" does on the home screen - its fallback
       (postersIn(rowSections()[0])) also comes up empty since .row-section never
       exists on this page, so without this the event was swallowed with nowhere to
       go. Enter the grid directly instead. */
    if (sidenavItems().includes(active)) {
      if (command !== "right") return false;
      focusPoster(allPosters()[0]);
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
      if (idx === 0) sidenavItems()[0]?.focus();
      else focusPoster(posters[idx - 1]);
      return true;
    }
    if (command === "up" || command === "down") {
      const rows = rowsOf(posters);
      const rowIdx = rows.findIndex((r) => r.items.includes(active));
      const targetRowIdx = rowIdx + (command === "down" ? 1 : -1);
      if (targetRowIdx < 0) {
        // no hero to hand off to during search (see the sidenav branch above) - sidenav is it
        sidenavItems()[0]?.focus();
        return true;
      }
      if (targetRowIdx >= rows.length) return true; // last row on the page - swallow
      focusPoster(closestByPosition(rows[targetRowIdx].items, active));
      return true;
    }
    return false;
  });
}
