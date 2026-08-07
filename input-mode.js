/* input-mode.js

   Two related but distinct questions, both needed before any button-to-gesture
   migration can start:

   1. Is touch *possible* on this device at all? (hasTouch) - a static hardware-capability
      check, decided once.
   2. What is the user *actually* driving the app with right now? (getInputMode) - a live
      value that flips as the user switches between touch, mouse, and D-pad/keyboard/gamepad
      nav (see focus-nav.js), since a single hybrid device (a touch laptop, a tablet with a
      paired keyboard) can genuinely use more than one of these in the same session.

   UI that wants to show buttons on remote/keyboard nav but swap to gesture hints on touch
   should read getInputMode()/listen for "input-mode-change" (or key CSS off
   documentElement's [data-input-mode], set here) rather than re-deriving any of this
   itself. */

import { KEY_TO_COMMAND } from "./focus-nav.js";

/* `any-pointer: coarse` (not `pointer: coarse`) so a hybrid device isn't missed just
   because a mouse happens to also be attached - `pointer` only reports the *primary*
   pointing device. maxTouchPoints is the fallback for hosts where matchMedia's
   interaction-media-feature support is spotty. */
export function hasTouch() {
  const coarse = window.matchMedia && window.matchMedia("(any-pointer: coarse)").matches;
  return coarse || navigator.maxTouchPoints > 0;
}

/* Fire TV (Silk browser) and the Xbox WebView2 shell are remote/gamepad-only - there's no
   pointer at all. Matched by UA (Xbox, Fire TV's "AFT" / "Fire TV" model codes) plus
   `pointer: none`, the CSS spec's own signal for "no pointing device", which catches any
   other remote-driven browser that doesn't match either UA pattern. Shared with
   plex-signin.js, which needs the same check to decide how Plex sign-in is presented. */
export function isRemoteDrivenDevice() {
  const ua = navigator.userAgent || "";
  if (/Xbox/i.test(ua)) return true;
  if (/AFT[A-Z0-9]|Fire TV/i.test(ua)) return true;
  if (window.matchMedia && window.matchMedia("(pointer: none)").matches) return true;
  return false;
}

/* First-paint guess, before any real input has happened. Devices with only a coarse
   pointer (no mouse attached) are overwhelmingly touched first; anything else (including
   hybrids with both a coarse and fine pointer) defaults to mouse, matching this app's
   mouse/click/hover-only history (see focus-nav.js) until proven otherwise. */
function computeInitialMode() {
  if (isRemoteDrivenDevice()) return "keyboard";
  const fine = window.matchMedia && window.matchMedia("(any-pointer: fine)").matches;
  if (hasTouch() && !fine) return "touch";
  return "mouse";
}

let mode = computeInitialMode();
document.documentElement.dataset.inputMode = mode;

function setMode(next) {
  if (next === mode) return;
  mode = next;
  document.documentElement.dataset.inputMode = mode;
  document.dispatchEvent(new CustomEvent("input-mode-change", { detail: { mode } }));
}

export function getInputMode() {
  return mode;
}

/* Capture-phase, document-level - one shared listener rather than every future
   gesture/button consumer polling or guessing independently, same "one source of truth"
   reasoning as focus-nav.js's own keydown listener. */
document.addEventListener(
  "pointerdown",
  (e) => {
    if (e.pointerType === "touch") setMode("touch");
    else if (e.pointerType === "mouse" || e.pointerType === "pen") setMode("mouse");
  },
  true
);

/* Only counts recognized nav keys (Arrow/Enter/Escape/Backspace - see focus-nav.js),
   not every keydown - typing in a search box on a touch device shouldn't flip the whole
   app into keyboard/remote mode. This also catches the gamepad poller's synthetic
   KeyboardEvents for free, since those dispatch through the same key names. */
document.addEventListener(
  "keydown",
  (e) => {
    if (KEY_TO_COMMAND[e.key]) setMode("keyboard");
  },
  true
);
