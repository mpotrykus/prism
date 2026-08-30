/* constants.js

   Frozen string-enum objects for values that get compared/dispatched/switched-on across
   multiple files. Plain string values underneath (not Symbols) - these have to survive
   JSON.stringify (localStorage, event.detail, native-bridge JSON) and match Plex's own API
   vocabulary (MEDIA_TYPE) - only the shared, spelled-out name is what these buy you.
   Root-level (not under src/) so both root-level files and deeply-nested files under src
   reach it with a shallow relative import, same convention already used for
   focus-nav.js/input-mode.js. */

/* Canonical command vocabulary focus-nav.js's KEY_TO_COMMAND/COMMAND_TO_KEY translate real
   and synthetic key events into. Every registerNavHandler/wireLinearNav consumer compares
   against these instead of retyping the raw string. */
export const NAV_COMMAND = Object.freeze({
  UP: "up",
  DOWN: "down",
  LEFT: "left",
  RIGHT: "right",
  ACTIVATE: "activate",
  BACK: "back",
  SEARCH: "search",
  CHAPTER_PREV: "chapterPrev",
  CHAPTER_NEXT: "chapterNext",
  REWIND: "rewind",
  FORWARD: "forward",
  MENU: "menu",
  PROFILE: "profile",
});

/* CustomEvent names dispatched on `document` and picked up in a different file (sometimes a
   different language - MainPage.xaml.cs dispatches XBOX_INPUT_ACTIVE_CHANGE/
   XBOX_KEYBOARD_HIDING as raw strings from C#, so those two names must stay in sync with the
   literals there by hand; everything else here is JS-to-JS). */
export const APP_EVENT = Object.freeze({
  OPEN_SETTINGS: "open-settings",
  SETTINGS_SAVED: "settings-saved",
  REQUEST_PLEX_REAUTH: "request-plex-reauth",
  PLEX_CONNECTED: "plex-connected",
  PLAYER_OPEN: "streaming-player-open",
  PLAYER_CLOSE: "streaming-player-close",
  TITLE_INFO_OPEN: "streaming-title-info-open",
  TITLE_INFO_CLOSE: "streaming-title-info-close",
  INPUT_MODE_CHANGE: "input-mode-change",
  CONTROLLER_ACTIVE_CHANGE: "controller-active-change",
  XBOX_INPUT_ACTIVE_CHANGE: "xbox-input-active-change",
  XBOX_KEYBOARD_HIDING: "xbox-keyboard-hiding",
});

/* input-mode.js's live "what's driving the app right now" value. */
export const INPUT_MODE = Object.freeze({
  MOUSE: "mouse",
  TOUCH: "touch",
  KEYBOARD: "keyboard",
});

/* Plex's own `type` field on library/metadata objects - these spellings are Plex's API
   vocabulary, not ours to invent, so this aliases them for typo-safety rather than
   redefining them. */
export const MEDIA_TYPE = Object.freeze({
  MOVIE: "movie",
  SHOW: "show",
  SEASON: "season",
  EPISODE: "episode",
  COLLECTION: "collection",
  PLAYLIST: "playlist",
});

/* The fixed `_currentView` sentinels. The field also carries dynamic user-configured
   Plex section/server ids, so this intentionally does not attempt to enumerate every
   possible value of that field - only the ones that are actually fixed across the app.
   MOVIES/TV are cross-server aggregates (every enabled library of that type, on every
   server), toggleable/hideable the same way HOME is - see settings.js's movies_enabled/
   tv_enabled and nav.js's buildNavTabs. */
export const VIEW = Object.freeze({
  HOME: "home",
  MOVIES: "movies",
  TV: "tv",
  SEARCH: "search",
});

/* Plex library-section `type` (the numeric field on config.sections[], distinct from
   MEDIA_TYPE's per-item string) - 1/2 is Plex's own convention (plex-auth.js's
   SECTION_TYPE_MAP), aliased here for the cross-server Movies/TV aggregate views
   (data.js's sectionsForView, plex-netflix-card.js's _sectionTypeForView). */
export const SECTION_TYPE = Object.freeze({
  MOVIE: 1,
  SHOW: 2,
});

/* The one shader/upscaling state that isn't a real preset id from shaders.js's own
   SHADER_TYPES registry. */
export const SHADER_OFF = "off";

/* The Auto/On/Off three-way mode chrome-menu-effects.js's mode buttons present for Shader
   Upscaling and each Color Boost component (see shader-pipeline.js's upscaleModeOf/
   colorBoostSaturationModeOf/colorBoostContrastModeOf) - a UI-facing collapse of an
   enabled+auto flag pair, distinct from SHADER_OFF above (which is _shaderType's own
   "no preset active" value, not a mode selector state), though the "off" string happens
   to coincide. */
export const TRIPLE_MODE = Object.freeze({
  AUTO: "auto",
  ON: "on",
  OFF: "off",
});

/* The one CSS class marking "this item is on the Plex Watchlist" on a watchlist button -
   written in exactly one place (watchlist.js's paintWatchlistButton), read back via
   classList.contains in hero.js/rows.js/title-info.js. */
export const WATCHLIST_ADDED_CLASS = "added";
