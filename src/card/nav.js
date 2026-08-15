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
      card._searchReturnFocusEl = active;
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
       user was. The remembered element is often not a usable target by now - typing a query
       re-renders .rows over whatever row was focused, and it's the card host or <body> in
       the first place if nothing was focused when search was opened - hence the
       still-focusable check and the sidenav fallback, the sidenav being the one thing always
       on screen and always D-pad navigable. */
    const prev = card._searchReturnFocusEl;
    card._searchReturnFocusEl = null;
    const usable = prev?.isConnected && prev.tabIndex >= 0 && prev.offsetParent !== null;
    focusAfterPaint(usable ? prev : card._navItems[0]);
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
  const sidenavItems = () =>
    Array.from(card.shadowRoot.querySelectorAll(".nav-item")).filter((el) => el.offsetParent !== null);
  const heroItems = () =>
    Array.from(card.shadowRoot.querySelectorAll(".hero-info-btn, .hero-watchlist-btn, .hero-play-btn, .hero-mute-btn")).filter(
      (el) => el.offsetParent !== null
    );
  const rowSections = () =>
    Array.from(card.shadowRoot.querySelectorAll(".row-section")).filter((s) => s.offsetParent !== null);
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
      const nothingFocusedYet = !active || active === document.body || active === card;
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
