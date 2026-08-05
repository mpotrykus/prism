import { focusAfterPaint, registerNavHandler } from "../../focus-nav.js";

/* Custom numeric-keypad modal replacing window.prompt/alert for PIN entry - this card
   has no native browser-dialog usage elsewhere, and a Netflix-style kiosk dashboard
   (often touch/TV, no physical keyboard) needs a tappable keypad rather than an OS
   text-input dialog. Shared by Kids Mode's exit gate and the Plex profile switcher's
   PIN prompt rather than each owning its own copy - prompt() resolves with the entered
   digit string once `length` digits are typed, or null if cancelled. Checking those
   digits against anything is the caller's job, not this modal's, since Kids Mode
   verifies locally but a Plex profile PIN can only be verified by Plex itself. */
const PIN_GRID_COLS = 3;

export class PinEntry {
  constructor(shadowRoot) {
    this._shadowRoot = shadowRoot;
    this._overlay = shadowRoot.querySelector(".pin-overlay");
    this._modal = shadowRoot.querySelector(".pin-modal");
    this._titleEl = shadowRoot.querySelector(".pin-title");
    this._dots = shadowRoot.querySelector(".pin-dots");
    this._errorEl = shadowRoot.querySelector(".pin-error");
    this._cancelBtn = shadowRoot.querySelector(".pin-cancel");
    this._entry = "";
    this._length = 4;
    this._resolve = null;
    this._wire();
  }

  isOpen() {
    return this._overlay.classList.contains("open");
  }

  prompt(length, title) {
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._entry = "";
      this._length = length;
      this._titleEl.textContent = title;
      this._errorEl.classList.remove("visible");
      this._modal.classList.remove("shake");
      this._renderDots();
      this._overlay.classList.add("open");
      focusAfterPaint(this._shadowRoot.querySelector(".pin-key[data-digit]"));
    });
  }

  /* Wrong-PIN feedback (shake + clear) without closing the modal - used by Kids Mode's
     retry loop. The profile switcher doesn't use this: a wrong Plex PIN is a server
     round-trip away, not a local comparison, so it just reports the error and lets the
     user press "Switch" again rather than auto-retrying. */
  shake() {
    this._errorEl.classList.add("visible");
    this._modal.classList.remove("shake");
    void this._modal.offsetWidth;
    this._modal.classList.add("shake");
    this._entry = "";
    this._renderDots();
  }

  cancel() {
    this._resolvePin(null);
  }

  _resolvePin(result) {
    this._overlay.classList.remove("open");
    const resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve(result);
  }

  _renderDots() {
    const pinLength = this._length || 4;
    if (this._dots.children.length !== pinLength) {
      this._dots.innerHTML = Array.from({ length: pinLength }, () => '<span class="pin-dot"></span>').join("");
    }
    [...this._dots.children].forEach((dot, i) => dot.classList.toggle("filled", i < this._entry.length));
  }

  _wire() {
    const pressDigit = (digit) => {
      const length = this._length || 4;
      if (this._entry.length >= length) return;
      this._entry += digit;
      this._renderDots();
      if (this._entry.length === length) this._resolvePin(this._entry);
    };
    const pressBackspace = () => {
      this._entry = this._entry.slice(0, -1);
      this._errorEl.classList.remove("visible");
      this._renderDots();
    };
    this._shadowRoot.querySelectorAll(".pin-key[data-digit]").forEach((btn) => {
      btn.addEventListener("click", () => pressDigit(btn.dataset.digit));
    });
    this._shadowRoot.querySelector(".pin-backspace").addEventListener("click", pressBackspace);
    this._cancelBtn.addEventListener("click", () => this._resolvePin(null));
    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this._resolvePin(null);
    });
    this._overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._resolvePin(null);
      else if (e.key === "Backspace") pressBackspace();
      else if (/^[0-9]$/.test(e.key)) pressDigit(e.key);
    });
    /* Deliberately not wireLinearNav here - a gamepad has no digit keys, and the keypad's
       3-column grid needs real Left/Right movement within a row, not a single vertical
       list. Row/col math is derived from index against PIN_GRID_COLS rather than reading
       actual pixel layout, since the grid is a fixed 3-column CSS grid. */
    const pinGridKeys = () => Array.from(this._shadowRoot.querySelectorAll(".pin-keypad .pin-key"));
    registerNavHandler((command, e, active) => {
      if (!this._overlay.classList.contains("open")) return false;
      const keys = pinGridKeys();
      const idx = keys.indexOf(active);
      if (idx === -1) {
        if (active !== this._cancelBtn) return false;
        if (command === "up") {
          keys[keys.length - 1].focus();
          return true;
        }
        if (command === "activate") {
          active.click();
          return true;
        }
        return false;
      }
      if (command === "activate") {
        active.click();
        return true;
      }
      if (command === "back") {
        this._resolvePin(null);
        return true;
      }
      const row = Math.floor(idx / PIN_GRID_COLS);
      const col = idx % PIN_GRID_COLS;
      let targetIdx;
      if (command === "right") targetIdx = row * PIN_GRID_COLS + Math.min(col + 1, PIN_GRID_COLS - 1);
      else if (command === "left") targetIdx = row * PIN_GRID_COLS + Math.max(col - 1, 0);
      else if (command === "down") targetIdx = idx + PIN_GRID_COLS;
      else if (command === "up") targetIdx = idx - PIN_GRID_COLS;
      else return false;

      if (targetIdx < 0) return true; // nothing above the top row - swallow, don't fall through
      if (targetIdx >= keys.length) {
        // Below the keypad's last row is Cancel, not a dead end.
        this._cancelBtn.focus();
        return true;
      }
      /* Grid cell (row 3, col 0) has no real button under it - .pin-key-empty is just a
         layout spacer (tabindex="-1") so "0" (its row-neighbor) is the intended landing
         spot whenever navigation would otherwise land on it. */
      if (targetIdx === 9) targetIdx = 10;
      keys[targetIdx]?.focus();
      return true;
    });
  }
}
