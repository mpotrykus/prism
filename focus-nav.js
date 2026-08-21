/* focus-nav.js

   Central input normalization for D-pad/gamepad/keyboard navigation. Nothing in this app
   needed focus-based navigation before Xbox - it's been mouse/click/hover-only since the
   original HA card. Two independent concerns, kept separate:

   1. A single document-level (capture-phase) keydown listener is the only place
      Arrow/Enter/Escape/Backspace get interpreted as navigation commands. Every component
      registers against it via registerNavHandler()/wireLinearNav() rather than adding its
      own keydown listener, so there's one source of truth for what a command means and one
      shared cooldown to dedupe it (see below) - not N independent listeners racing.

   2. A requestAnimationFrame Gamepad API poller that translates D-pad/left-stick/A/B into
      synthetic KeyboardEvents fed into that exact same pathway, rather than duplicating
      navigation logic per input source. It's not knowable up front whether a given host
      (Xbox's WebView2 in particular) delivers D-pad input as real key events, raw gamepad
      state, or both - CLAUDE.md flags this as something that needs hardware verification,
      not assumption. Building both paths against one shared cooldown-per-command sidesteps
      having to guess correctly: if a single physical press somehow produces both a real
      keydown and a synthetic one, the second is dropped as a duplicate rather than double-
      navigating.
*/

/* WebView2 (confirmed on the Xbox/UWP shell, reproduces on desktop too) won't accept
   .focus() on an element in the same synchronous tick its display:none is lifted (e.g.
   right after classList.add("open")) - the element silently stays unfocused until
   something else (Tab, a click) forces a layout pass first. Chrome/Firefox don't have
   this problem, which is why every modal/overlay in this app called .focus() inline for
   so long without issue. Deferring to the next animation frame guarantees a layout pass
   has already happened. */
export function focusAfterPaint(el) {
  requestAnimationFrame(() => el?.focus());
}

const COOLDOWN_MS = 120;
const REPEAT_DELAY_MS = 400;
const REPEAT_RATE_MS = 150;
/* Two different thresholds (hysteresis), not one - a single DEADZONE compared fresh every
   animation frame let the stick's own analog noise flicker active[command] false/true/false
   across consecutive frames whenever the raw axis sat right around the line, each flicker
   back to true read as a brand-new press (see repeatState below) and re-fired. Requiring a
   bigger push to register a press than to release it means once the stick reads as "pressed"
   it stays pressed through any noise that doesn't clearly cross back past the lower line -
   the same on/off stability a real digital d-pad switch has for free. */
const STICK_PRESS_THRESHOLD = 0.5;
const STICK_RELEASE_THRESHOLD = 0.3;

/* "GamepadY" is not a real keyboard key and no keyboard produces it - the gamepad poller
   below is its only source. Y has no keyboard equivalent worth binding (any letter key
   would fire while typing in the search box it toggles), so rather than give the Y button
   its own separate dispatch path it gets an invented key name fed through this same
   pathway, borrowing Windows' own GamepadY virtual-key naming. Same reasoning for the
   bumper/trigger/Start entries below - chapter-skip, seek, and "open the player's more
   menu" have no sensible keyboard equivalent either, only a gamepad. */
export const KEY_TO_COMMAND = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "activate",
  Escape: "back",
  Backspace: "back",
  GamepadY: "search",
  GamepadLB: "chapterPrev",
  GamepadRB: "chapterNext",
  GamepadLT: "rewind",
  GamepadRT: "forward",
  GamepadStart: "menu",
  GamepadSelect: "profile",
};

const COMMAND_TO_KEY = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  activate: "Enter",
  back: "Escape",
  search: "GamepadY",
  chapterPrev: "GamepadLB",
  chapterNext: "GamepadRB",
  rewind: "GamepadLT",
  forward: "GamepadRT",
  menu: "GamepadStart",
  profile: "GamepadSelect",
};

/* Tracks whether the most recent input was D-pad/gamepad/keyboard nav (real or synthetic
   key events through this module) vs. a mouse/touch pointer - the only signal available
   for "is a controller/remote driving this session," since there's no Gamepad-vs-Fire TV-
   vs-keyboard distinction worth making (see the file header) and touch/mouse never fire
   the keys in KEY_TO_COMMAND. Consulted by modals that want to land focus on a different
   default target for controller users than they would for a mouse/touch tap (e.g.
   title-info.js landing on Play/Resume instead of its own first nav item). */
let controllerActive = false;
export function isControllerActive() {
  return controllerActive;
}
/* Mirrored onto documentElement (same pattern as input-mode.js's data-input-mode) for any
   light-DOM CSS, plus a "controller-active-change" event so shadow-DOM components (the card,
   whose own CSS is inlined into its shadow root - a :root selector there would never match,
   since a shadow tree's root node is the ShadowRoot itself, not an Element) can toggle an
   attribute on their own host instead and key :host([...]) rules off that. Used to hide the
   per-poster watchlist-btn (rows.js), which sits inside a .poster and is never reachable by
   D-pad/gamepad nav (wireHomeNav only moves focus between whole .poster elements, never into
   a nested button), unlike the hero/title-info watchlist buttons which are proper stops in
   that nav. */
function setControllerActive(next) {
  if (next === controllerActive) return;
  controllerActive = next;
  document.documentElement.dataset.controllerActive = String(next);
  document.dispatchEvent(new CustomEvent("controller-active-change", { detail: { active: next } }));
}
document.addEventListener(
  "keydown",
  (e) => {
    if (KEY_TO_COMMAND[e.key]) setControllerActive(true);
  },
  true
);
document.addEventListener("pointerdown", () => setControllerActive(false), true);

const lastCommandAt = Object.create(null);

/* Every component in the app registers its own handler (one per modal/overlay/screen),
   and every one of them sees every keydown - only the handler whose scope currently owns
   focus is ever supposed to act, since focus is a singleton. The cooldown's job is purely
   to dedupe two separate physical-press signals for the same command arriving close
   together (a real keydown and this module's own synthetic gamepad-driven one) - it must
   NOT gate which handler gets consulted, or only the first-registered handler in the whole
   app would ever fire. Memoizing the decision on the event object itself (once per actual
   keydown, however many listeners are attached) keeps those two concerns separate: this
   was a real bug caught by hand-testing (Enter on the app's own sidenav did nothing,
   because an earlier-registered modal's handler was silently eating the cooldown window
   for every keypress in the whole app, not just its own). */
function isEventAllowed(e, command) {
  if (e.__navAllowed === undefined) {
    const now = performance.now();
    if (now - (lastCommandAt[command] || 0) < COOLDOWN_MS) {
      e.__navAllowed = false;
    } else {
      lastCommandAt[command] = now;
      e.__navAllowed = true;
    }
  }
  return e.__navAllowed;
}

/* Registers a handler that's consulted on every recognized keydown, regardless of source
   (real or synthetic). `handler(command, event, activeElement)` returns true if it acted on
   the command, which preventDefault()'s the key event - an unhandled command (this scope
   doesn't currently own focus) passes through cleanly to whatever else is listening.
   Returns an unregister function. */
export function registerNavHandler(handler) {
  function onKeydown(e) {
    const command = KEY_TO_COMMAND[e.key];
    if (!command) return;
    if (!isEventAllowed(e, command)) return;
    const active = document.activeElement;
    const handled = handler(command, e, resolveDeepActiveElement(active));
    if (handled) e.preventDefault();
  }
  document.addEventListener("keydown", onKeydown, true);
  return () => document.removeEventListener("keydown", onKeydown, true);
}

/* document.activeElement stops at the first shadow host, not the actually-focused element
   inside it - every component here lives in its own shadow root, so without this, `active`
   would just be e.g. <plex-netflix-card>, never the poster/button actually focused inside it. */
function resolveDeepActiveElement(el) {
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/* Roving-tabindex keyboard/gamepad navigation among elements matching `selector` inside
   `root` (a shadow root or plain container) - covers every simple linear list in the app
   (a modal's buttons, a settings form, an overlay's keypad). The card's home screen (sidenav
   + 2D grid of rows/posters) needs bespoke Up/Down-by-position logic and uses
   registerNavHandler() directly instead - see plex-netflix-card.js.

   Items sharing a `data-nav-group` value (e.g. chrome-menu-effects.js's Auto/On/Off mode
   buttons, or title-info.js dynamically row-grouping its wrapping "More Like This" grid -
   see _assignSimilarRowGroups there) are treated as one horizontal row rather than
   individually-steppable stops: in a vertical list, Up/Down skips the whole group in one
   step, landing on whichever of the new group's members sits closest (by horizontal
   center) to the item just left rather than always the group's first/last member - see
   moveAcrossGroup's own comment - while Left/Right moves within the group only, clamped to
   its own edges even when `loop` is set for the rest of the list - wrapping Off back to
   Auto reads as a different gesture than wrapping the top of a long list to the bottom. A
   focused <input type=range> (ungrouped) instead has Left/Right adjust its value directly
   (see adjustRange below). Any other ungrouped item leaves Left/Right unhandled, same as
   before this existed. */
export function wireLinearNav(root, selector, { orientation = "vertical", onActivate, onBack, loop = false } = {}) {
  const forwardCommand = orientation === "vertical" ? "down" : "right";
  const backwardCommand = orientation === "vertical" ? "up" : "left";
  const acrossCommands = orientation === "vertical" ? ["left", "right"] : ["up", "down"];

  function items() {
    return Array.from(root.querySelectorAll(selector)).filter(
      (el) => !el.disabled && el.offsetParent !== null
    );
  }

  /* Giving a text/password/number input real DOM focus is what triggers Xbox/WebView2's
     on-screen keyboard - doing that on mere arrival (every other stop in a linear nav list
     gets focused as soon as nav lands on it) means just passing over a field on the way to
     something else pops the keyboard for no reason. These three types instead get a
     "selected but not focused" virtual highlight (see setHighlight/currentActive below);
     real focus - and the keyboard - only happens on an explicit "activate" (A/Enter). */
  function isTextEntry(el) {
    return el?.tagName === "INPUT" && (el.type === "text" || el.type === "password" || el.type === "number");
  }

  let virtualActive = null;
  const HIGHLIGHT_CLASS = "nav-text-highlight";
  function setHighlight(el) {
    if (virtualActive && virtualActive !== el) virtualActive.classList.remove(HIGHLIGHT_CLASS);
    virtualActive = el;
    el.classList.add(HIGHLIGHT_CLASS);
  }
  function clearHighlight() {
    if (virtualActive) virtualActive.classList.remove(HIGHLIGHT_CLASS);
    virtualActive = null;
  }
  /* The item nav currently treats as "here" - a really-focused element if there is one,
     else whatever's virtually highlighted. Used everywhere below in place of a bare
     root.activeElement so the two focus styles are interchangeable to the rest of this
     function. */
  function currentActive() {
    /* root.activeElement !== document.body, not a bare truthiness check - on a ShadowRoot,
       "nothing focused inside me" reads back as null, but on `document` itself (this
       overlay's root - see wireLinearNav's call site comment) it reads back as <body>,
       which is truthy. Falling through to virtualActive needs "nothing real is focused",
       and for `document` that means body, not null - a bare `root.activeElement ||
       virtualActive` never fell through once cur.blur() (the text-entry "back" path below)
       sent focus to body, leaving currentActive() stuck returning <body> forever - not in
       any nav list, so the handler's `!list.includes(cur)` bailed out on every command with
       no way to recover short of reloading. */
    const active = root.activeElement;
    return active && active !== document.body ? active : virtualActive;
  }
  /* A stray highlight can outlive its own move (e.g. a mouse/touch click landing real
     focus somewhere else entirely) - clearing it whenever real focus lands on a different
     element keeps at most one visual indicator on screen at a time. */
  root.addEventListener("focusin", (e) => {
    if (virtualActive && e.target !== virtualActive) clearHighlight();
  });

  function focusFirst() {
    requestAnimationFrame(() => focusItem(items()[0]));
  }

  /* Centers the newly-focused item along the list's own scroll axis (e.g. title-info.js's
     top-to-bottom overlay, or episode-list.js's/openChapterListOverlay's left-to-right card
     row) - D-pad/gamepad nav has no hover/cursor to show where focus went, so a focused item
     scrolled just barely into view (or half-clipped at an edge) is easy to lose track of. The
     cross axis stays "nearest" so a vertical list's rows don't also jump sideways (or a
     horizontal row jump vertically) just because an item near its edge got focus. */
  function focusItem(el) {
    if (!el) return;
    if (isTextEntry(el)) {
      root.activeElement?.blur();
      setHighlight(el);
    } else {
      clearHighlight();
      el.focus();
    }
    el.scrollIntoView(
      orientation === "vertical" ? { block: "center", inline: "nearest" } : { block: "nearest", inline: "center" }
    );
  }

  /* closest(), not a bare el.dataset read - lets a whole container (e.g.
     chrome-subtitles.js's two side-by-side Audio/Subtitles columns) carry one
     data-nav-group for every item inside it, including ones added later by a re-render,
     instead of every individual item needing the attribute set on itself. Still finds the
     attribute on `el` itself first when it's set there directly (chrome-menu-effects.js's
     mode buttons, title-info.js's grouped cards), so existing per-element usage is unchanged. */
  function groupOf(el) {
    return el?.closest?.("[data-nav-group]")?.dataset.navGroup || null;
  }

  /* Left/Right on a focused <input type=range> (e.g. chrome-menu-effects.js's Shader
     Upscaling/Color Boost/Ambient Lighting strength/opacity sliders) adjusts its value
     directly rather than falling through to the browser's own native range-input key
     handling - that native behavior only fires for a *trusted* keydown, but the gamepad
     poller's dispatchSyntheticKey below produces untrusted synthetic KeyboardEvents (a
     physical D-pad press on Xbox is very likely delivered this way, see this file's own
     header comment on that still-unverified-on-hardware question), which the browser
     silently ignores for a form control's default action. Firing a real "input" event
     keeps this working the same way as a manual drag - every slider's own listener
     reacts to "input", not "change". */
  function adjustRange(el, delta) {
    const step = Number(el.step) || 1;
    const min = el.min !== "" ? Number(el.min) : 0;
    const max = el.max !== "" ? Number(el.max) : 100;
    const next = Math.max(min, Math.min(max, Number(el.value) + delta * step));
    if (next === Number(el.value)) return;
    el.value = String(next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* LB/RB's big-jump equivalent for a focused range input (e.g. chrome-menu-effects.js's
     Effects sliders) - a fixed 10% of the slider's own min/max span, not step-multiplied
     like adjustRange's Left/Right, so it's still a real 10% jump on a slider whose step
     isn't 1. */
  function jumpRange(el, percent) {
    const min = el.min !== "" ? Number(el.min) : 0;
    const max = el.max !== "" ? Number(el.max) : 100;
    const delta = ((max - min) * percent) / 100;
    const next = Math.max(min, Math.min(max, Number(el.value) + delta));
    if (next === Number(el.value)) return;
    el.value = String(next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* Steps past every remaining member of the active element's own group in one go before
     applying the final +/-1 - so a group reads as a single stop for Up/Down (or Left/Right
     in a horizontal list) regardless of which of its members currently has focus. */
  /* The axis groups are laid out along depends on orientation: a vertical list's groups
     are horizontally-adjacent rows (title-info.js's wrapping poster grid, chrome-menu-
     effects.js's mode buttons) so matching is by X; a horizontal list's groups are
     vertically-stacked columns (chrome-subtitles.js's side-by-side Audio/Subtitles panels)
     so matching is by Y. Using the wrong axis would match by the axis that's constant
     within a group instead of the one that actually varies member-to-member. */
  function crossAxisCenter(el) {
    const r = el.getBoundingClientRect();
    return orientation === "vertical" ? r.left + r.width / 2 : r.top + r.height / 2;
  }

  /* When crossing into a *different* group of more than one member (e.g. title-info.js
     dynamically row-grouping a wrapping poster grid so Left/Right stays within a visual
     row - see assignRowNavGroups there), landing on that group's first/last member by
     index alone puts focus wherever the group happens to start in DOM order, with no
     relationship to the item just left. Picking the member whose position on the cross
     axis (see crossAxisCenter above) is closest to the departing element's is what makes
     the across-group command actually track "the item roughly here in the next
     group" instead, the same positional-matching idea nav.js's closestByPosition uses for
     the home screen's poster rows. */
  function closestOnCrossAxis(elements, referenceEl) {
    const ref = crossAxisCenter(referenceEl);
    return elements.reduce((best, el) => (Math.abs(crossAxisCenter(el) - ref) < Math.abs(crossAxisCenter(best) - ref) ? el : best));
  }

  function moveAcrossGroup(delta) {
    const list = items();
    if (!list.length) return;
    const activeEl = currentActive();
    let idx = list.indexOf(activeEl);
    if (idx === -1) {
      focusItem(list[0]);
      return;
    }
    const group = groupOf(list[idx]);
    if (group) {
      while (idx + delta >= 0 && idx + delta < list.length && groupOf(list[idx + delta]) === group) {
        idx += delta;
      }
    }
    idx += delta;
    if (loop) idx = (idx + list.length) % list.length;
    else idx = Math.max(0, Math.min(list.length - 1, idx));
    const targetGroup = groupOf(list[idx]);
    if (targetGroup && targetGroup !== group) {
      const groupMembers = list.filter((el) => groupOf(el) === targetGroup);
      if (groupMembers.length > 1) {
        focusItem(closestOnCrossAxis(groupMembers, activeEl));
        return;
      }
    }
    focusItem(list[idx]);
  }

  /* Moves within the active element's own group only. Returns false (leaving the command
     unhandled) when the active element isn't grouped at all. */
  function moveWithinGroup(delta) {
    const active = currentActive();
    const group = groupOf(active);
    if (!group) return false;
    const list = items().filter((el) => groupOf(el) === group);
    let idx = Math.max(0, Math.min(list.length - 1, list.indexOf(active) + delta));
    focusItem(list[idx]);
    return true;
  }

  const unregister = registerNavHandler((command, e) => {
    const list = items();
    const cur = currentActive();
    if (!list.includes(cur)) return false;

    /* Really-focused (not just highlighted) text entry: hand every command except "back"
       to the input's own native handling (caret movement, number spinner, typing) rather
       than letting this list's Up/Down/Left/Right hijack it mid-edit. "back" exits edit
       mode (blur + re-highlight) instead of reaching onBack, so Escape/B backs out of
       typing one step at a time instead of also closing the whole modal/overlay. */
    const editing = isTextEntry(cur) && cur === root.activeElement;
    if (command === "back") {
      /* Backspace and Escape both map to "back" (KEY_TO_COMMAND) since a real keyboard's
         Backspace is Fire TV/Android's back-equivalent - but while genuinely editing text,
         Backspace instead means "delete the character behind the caret", confirmed on real
         Xbox hardware: selecting the on-screen keyboard's Backspace glyph with the thumbstick
         and pressing A fires a real Backspace keydown, and this handler was intercepting it
         as "exit edit mode" before the input's own native deletion ever ran - preventDefault
         killed the deletion, leaving no way to delete anything typed. Only a genuine Escape
         (real Esc key, or the gamepad B button, which dispatches a synthetic Escape - see
         COMMAND_TO_KEY - never Backspace) should exit edit mode; leaving Backspace unhandled
         here lets it fall through to the input untouched. */
      if (editing && e?.key === "Backspace") return false;
      if (editing) {
        cur.blur();
        setHighlight(cur);
        return true;
      }
      if (onBack) {
        onBack();
        return true;
      }
      return false;
    }
    if (editing) return false;

    if (command === "activate") {
      if (isTextEntry(cur)) {
        clearHighlight();
        cur.focus();
        return true;
      }
      (onActivate || ((el) => el.click()))(cur);
      return true;
    }
    if (command === forwardCommand) {
      moveAcrossGroup(1);
      return true;
    }
    if (command === backwardCommand) {
      moveAcrossGroup(-1);
      return true;
    }
    if (acrossCommands.includes(command)) {
      const delta = command === acrossCommands[1] ? 1 : -1;
      if (cur?.tagName === "INPUT" && cur.type === "range") {
        adjustRange(cur, delta);
        return true;
      }
      return moveWithinGroup(delta);
    }
    if ((command === "chapterPrev" || command === "chapterNext") && cur?.tagName === "INPUT" && cur.type === "range") {
      jumpRange(cur, command === "chapterNext" ? 10 : -10);
      return true;
    }
    return false;
  });

  /* Confirmed on real Xbox hardware: dismissing the on-screen keyboard with B is consumed
     entirely by the platform before any keydown reaches this app (see the "back" branch
     above and nav.js's own wireVirtualKeyboardDismiss, which hit the exact same thing for
     the header search box) - the keyboard visually closes but the input this list gave real
     focus to via "activate" never gets a page-level event telling it to blur, so `editing`
     above stays true and every command silently no-ops until a *second* B press finally
     produces a real Escape keydown. Two independent "the keyboard just closed" signals,
     since neither is guaranteed to exist/fire on every build (see nav.js's own comment for
     why): MainPage.xaml.cs's OnInputPaneHiding (forwarded as "xbox-keyboard-hiding", the one
     confirmed reachable on real hardware) and the web-standard VirtualKeyboard API's
     geometrychange (not confirmed to fire on this WebView2 build, kept for whatever
     platform/version it does work on). Listened for here instead of duplicating this per
     caller so every wireLinearNav-driven text input gets it for free - a no-op via
     isTextEntry's own guard when nothing here is really focused. */
  function exitEditIfFocused() {
    const cur = root.activeElement;
    if (isTextEntry(cur)) {
      cur.blur();
      setHighlight(cur);
    }
  }
  document.addEventListener("xbox-keyboard-hiding", exitEditIfFocused);
  let vkWasVisible = false;
  function onVirtualKeyboardGeometryChange() {
    const visible = navigator.virtualKeyboard.boundingRect.height > 0;
    const justClosed = vkWasVisible && !visible;
    vkWasVisible = visible;
    if (justClosed) exitEditIfFocused();
  }
  if (navigator.virtualKeyboard) {
    navigator.virtualKeyboard.addEventListener("geometrychange", onVirtualKeyboardGeometryChange);
  }

  return {
    focusFirst,
    /* Each overlay open calls wireLinearNav fresh (see e.g. openAudioSubtitlesOverlay) -
       the two listeners above must come off again here, or every reopen would pile up one
       more of each rather than replacing the last. */
    destroy: () => {
      unregister();
      document.removeEventListener("xbox-keyboard-hiding", exitEditIfFocused);
      if (navigator.virtualKeyboard) {
        navigator.virtualKeyboard.removeEventListener("geometrychange", onVirtualKeyboardGeometryChange);
      }
    },
  };
}

/* --- Gamepad bridge: translates raw pad state into the same synthetic KeyboardEvents a
   real keyboard would produce, dispatched on whatever currently has focus (falling back to
   document if nothing does yet, e.g. before a modal's first auto-focus runs). --- */

/* Directions repeat while held (D-pad/left-stick, same as before) - triggers join them here rather
   than living in GAMEPAD_BUTTONS below, because holding LT/RT to fast-seek needs the same
   held/repeat treatment a directional press gets, not a single edge-triggered fire like a button
   press. Bumpers and Start stay one-shot (GAMEPAD_BUTTONS below) - jumping a chapter or opening the
   menu on every repeat tick while the button is held would be a bug, not a feature. */
const REPEATABLE_COMMANDS = ["up", "down", "left", "right", "rewind", "forward"];
const repeatState = Object.fromEntries(REPEATABLE_COMMANDS.map((c) => [c, { active: false, heldSince: 0, lastRepeatAt: 0 }]));
const buttonState = Object.create(null);
/* Persists across animation frames (unlike active[] below, which is recomputed fresh every
   frame) - this is the stick's own virtual d-pad-button state, carrying the hysteresis
   band's "stay pressed" memory from one frame to the next. */
const stickButtonState = { up: false, down: false, left: false, right: false };
const GAMEPAD_BUTTONS = { 0: "activate", 1: "back", 3: "search", 4: "chapterPrev", 5: "chapterNext", 8: "profile", 9: "menu" }; // standard mapping: A, B, Y, LB, RB, Back/Select, Start

/* PrismXbox's MainPage.xaml.cs also forwards d-pad/thumbstick/A/B natively via
   CoreWindow.KeyDown, in principle covering the same input this poller does - but with
   WebView2 hosted as its own visual island, CoreWindow input delivery while the control
   holds focus is one of this project's two flagged-unverified Xbox risks (see CLAUDE.md's
   "gamepad focus trap" note). Disabling this poller's handling of those commands on Xbox
   on the assumption the native path covers them broke every button and the stick on real
   hardware - the native path evidently isn't reaching the DOM here, and this poller was
   the only thing actually working. Left unconditional until that native path is confirmed
   to fire on real hardware. */

/* Confirmed on real Xbox hardware: this poller reads raw Gamepad API state directly, which
   keeps working even while the system Guide overlay is open on top of the app - the Guide
   takes over the gamepad's buttons, but nothing tells the *browsing context* that happened,
   so a D-pad move or A/B press drives Guide navigation and this app's own nav at the same
   time. MainPage.xaml.cs's OnCoreWindowActivated relays CoreWindow's Deactivated/Activated
   transition (the OS's own signal that something else now owns input) into this flag via a
   custom event - default true so the web-only (non-Xbox) build, which never receives that
   event, behaves exactly as before. */
let inputActive = window.__prismXboxInputActive !== false;
document.addEventListener("xbox-input-active-change", (e) => {
  inputActive = e.detail.active;
  if (!inputActive) {
    for (const state of Object.values(repeatState)) state.active = false;
    for (const key of Object.keys(buttonState)) buttonState[key] = false;
  }
});

function dispatchSyntheticKey(key) {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
  /* cancelable defaults to false on a constructed event (unlike a real trusted keydown) -
     without it, registerNavHandler's e.preventDefault() is a silent no-op for every
     gamepad-driven command, so the browser's native arrow-key scroll still runs alongside
     (and fights) each handler's own scrollIntoView/focus centering. */
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
}

/* Turns the raw stick axes into the same true/false "is this direction pressed" shape a
   real d-pad button already reports, so everything downstream (active[] below, and every
   handler beyond it) treats the stick as nothing more than four virtual d-pad buttons -
   one path, not an analog signal OR'd into it. Hysteresis (STICK_PRESS_THRESHOLD to turn
   on, the lower STICK_RELEASE_THRESHOLD to turn off) gives each virtual button the same
   on/off stability a real digital switch has for free - analog noise sitting between the
   two thresholds can't flicker it. */
function updateStickButtonState(axisX, axisY) {
  // An analog stick almost never reports a perfectly clean push - a slight diagonal drift
  // means both axes can read past the press threshold on the same frame, unlike a real
  // d-pad's mechanical cross where only one direction can physically register. Zeroing out
  // whichever axis isn't dominant keeps the stick's virtual buttons collapsed to a single
  // direction at a time, same as the d-pad.
  const stickIsHorizontal = Math.abs(axisX) > Math.abs(axisY);
  const y = stickIsHorizontal ? 0 : axisY;
  const x = stickIsHorizontal ? axisX : 0;

  if (y < -STICK_PRESS_THRESHOLD) stickButtonState.up = true;
  else if (y > -STICK_RELEASE_THRESHOLD) stickButtonState.up = false;
  if (y > STICK_PRESS_THRESHOLD) stickButtonState.down = true;
  else if (y < STICK_RELEASE_THRESHOLD) stickButtonState.down = false;
  if (x < -STICK_PRESS_THRESHOLD) stickButtonState.left = true;
  else if (x > -STICK_RELEASE_THRESHOLD) stickButtonState.left = false;
  if (x > STICK_PRESS_THRESHOLD) stickButtonState.right = true;
  else if (x < STICK_RELEASE_THRESHOLD) stickButtonState.right = false;
}

function pollGamepads(now) {
  // repeatState/buttonState were already reset to "nothing held" the instant Guide took
  // over (see the xbox-input-active-change listener above) - skipping the whole body here
  // just keeps them that way for as long as Guide stays open, so nothing fires until the
  // gamepad's actual current state is read fresh below.
  if (!inputActive) {
    requestAnimationFrame(pollGamepads);
    return;
  }
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    updateStickButtonState(gp.axes[0] || 0, gp.axes[1] || 0);
    const active = {
      up: !!gp.buttons[12]?.pressed || stickButtonState.up,
      down: !!gp.buttons[13]?.pressed || stickButtonState.down,
      left: !!gp.buttons[14]?.pressed || stickButtonState.left,
      right: !!gp.buttons[15]?.pressed || stickButtonState.right,
      rewind: !!gp.buttons[6]?.pressed,
      forward: !!gp.buttons[7]?.pressed,
    };
    for (const command of REPEATABLE_COMMANDS) {
      const state = repeatState[command];
      if (active[command]) {
        if (!state.active) {
          state.active = true;
          state.heldSince = now;
          state.lastRepeatAt = now;
          dispatchSyntheticKey(COMMAND_TO_KEY[command]);
        } else if (now - state.heldSince > REPEAT_DELAY_MS && now - state.lastRepeatAt > REPEAT_RATE_MS) {
          state.lastRepeatAt = now;
          dispatchSyntheticKey(COMMAND_TO_KEY[command]);
        }
      } else {
        state.active = false;
      }
    }
    for (const [index, command] of Object.entries(GAMEPAD_BUTTONS)) {
      const pressed = !!gp.buttons[index]?.pressed;
      const key = `btn_${command}`;
      if (pressed && !buttonState[key]) dispatchSyntheticKey(COMMAND_TO_KEY[command]);
      buttonState[key] = pressed;
    }
  }
  requestAnimationFrame(pollGamepads);
}
requestAnimationFrame(pollGamepads);
