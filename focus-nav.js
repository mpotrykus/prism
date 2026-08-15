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
const DEADZONE = 0.5;

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
document.addEventListener(
  "keydown",
  (e) => {
    if (KEY_TO_COMMAND[e.key]) controllerActive = true;
  },
  true
);
document.addEventListener("pointerdown", () => (controllerActive = false), true);

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
   registerNavHandler() directly instead - see plex-netflix-card.js. */
export function wireLinearNav(root, selector, { orientation = "vertical", onActivate, onBack, loop = false } = {}) {
  const forwardCommand = orientation === "vertical" ? "down" : "right";
  const backwardCommand = orientation === "vertical" ? "up" : "left";

  function items() {
    return Array.from(root.querySelectorAll(selector)).filter(
      (el) => !el.disabled && el.offsetParent !== null
    );
  }

  function focusFirst() {
    focusAfterPaint(items()[0]);
  }

  function move(delta) {
    const list = items();
    if (!list.length) return;
    let idx = list.indexOf(root.activeElement);
    if (idx === -1) {
      list[0].focus();
      return;
    }
    idx += delta;
    if (loop) idx = (idx + list.length) % list.length;
    else idx = Math.max(0, Math.min(list.length - 1, idx));
    list[idx].focus();
  }

  const unregister = registerNavHandler((command) => {
    const list = items();
    if (!list.includes(root.activeElement)) return false;
    if (command === forwardCommand) {
      move(1);
      return true;
    }
    if (command === backwardCommand) {
      move(-1);
      return true;
    }
    if (command === "activate") {
      (onActivate || ((el) => el.click()))(root.activeElement);
      return true;
    }
    if (command === "back" && onBack) {
      onBack();
      return true;
    }
    return false;
  });

  return { focusFirst, destroy: unregister };
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
const GAMEPAD_BUTTONS = { 0: "activate", 1: "back", 3: "search", 4: "chapterPrev", 5: "chapterNext", 9: "menu" }; // standard mapping: A, B, Y, LB, RB, Start

function dispatchSyntheticKey(key) {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
}

function pollGamepads(now) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (!gp) continue;
    const axisX = gp.axes[0] || 0;
    const axisY = gp.axes[1] || 0;
    const active = {
      up: !!gp.buttons[12]?.pressed || axisY < -DEADZONE,
      down: !!gp.buttons[13]?.pressed || axisY > DEADZONE,
      left: !!gp.buttons[14]?.pressed || axisX < -DEADZONE,
      right: !!gp.buttons[15]?.pressed || axisX > DEADZONE,
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
