import { wireLinearNav, focusAfterPaint, isControllerActive, registerNavHandler } from "./focus-nav.js";
import { hasSecrets, loadSecrets, saveSecrets } from "./vault.js";
import { discoverLibraries } from "./plex-auth.js";
import { isXboxDevice } from "./src/player/core/platform.js";
import MODAL_STYLE from "./src/styles/settings-modal.css?inline";

/* Only non-sensitive fields live here in plain localStorage. plex_token,
   openrouter_api_key, and plex_account_token go through vault.js instead - see there for
   why (encrypted at rest, not plaintext). Trailer discovery uses a TMDB API key bundled
   with the app itself (see src/card/logic/tmdb.js) rather than a user-supplied secret, so
   there's no youtube/tmdb key stored here at all anymore.
   plex_account_token is the Plex.tv account token from the Sign in with Plex flow
   (plex-auth.js) - kept separately from plex_token (the per-server access token the
   card actually uses) so "refresh servers" can re-run discovery later without a
   full re-login. */
const PLAIN_STORAGE_KEY = "prism.config";

const DEFAULT_PLAIN_CONFIG = {
    plex_url: "",
    machine_id: "",
    home_enabled: true,
    servers: [],
    sections: [],
    default_view: "home",
    ai_rows_cadence_ms: 7 * 24 * 60 * 60 * 1000,
    max_genre_rows: 12,
    row_size: 20,
    subtitle_provider: "plex",
    trailers_enabled: true,
    title_trailers_enabled: true,
    ai_rows_enabled: true,
    xbox_hdr_always_on: false,
    title_audio_enabled: true,
    title_audio_volume: 0.65,
};

export function loadPlain() {
    try {
        const raw = JSON.parse(localStorage.getItem(PLAIN_STORAGE_KEY) || "null") || {};
        return {...DEFAULT_PLAIN_CONFIG, ...raw };
    } catch (e) {
        return {...DEFAULT_PLAIN_CONFIG };
    }
}
export function savePlain(config) {
    localStorage.setItem(PLAIN_STORAGE_KEY, JSON.stringify(config));
}
/* Full config = plain fields + decrypted secrets, merged - what the card's
   setConfig()/refreshConfig() actually expects. Per-server access tokens are secrets
   (server_tokens, keyed by clientIdentifier) but the servers they belong to are plain
   metadata (name/url/owned/...) - merged back onto each server here rather than via the
   flat {...plain, ...secrets} spread below, which would otherwise let a `servers` key on
   `secrets` blow away plain's non-secret server list instead of extending it. */
export async function loadFull() {
    const plain = loadPlain();
    const secrets = hasSecrets() ? await loadSecrets() : {};
    const servers = (plain.servers || []).map((s) => ({...s, token: secrets.server_tokens?.[s.id] || "" }));
    return {...plain, ...secrets, servers };
}
export function isConfigured(fullConfig) {
    return !!(fullConfig && fullConfig.plex_url && fullConfig.plex_token);
}

const TABS = [
    { key: "plex", label: "Plex" },
    { key: "preferences", label: "Preferences" },
    { key: "integrations", label: "Integrations" },
    { key: "about", label: "About" },
];

/* Same hand-drawn inline-SVG style as nav.js's sidenav icons (24x24 viewBox,
   stroke-width 1.6, currentColor) - kept here rather than shared since these are
   settings-specific and nav.js's are library-type-specific. */
const ICONS = {
    server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="7.5" r="1" fill="currentColor"/><circle cx="7" cy="16.5" r="1" fill="currentColor"/></svg>',
    libraries: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13" y="3" width="8" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="13" width="8" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="13" y="13" width="8" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    play: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 8.3l6 3.7-6 3.7z" fill="currentColor"/></svg>',
    sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" fill="currentColor"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" fill="currentColor"/></svg>',
    captions: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="6" y="10.1" width="5" height="1.8" rx="0.9" fill="currentColor"/><rect x="6" y="13.3" width="7" height="1.8" rx="0.9" fill="currentColor"/><rect x="13" y="10.1" width="5" height="1.8" rx="0.9" fill="currentColor"/></svg>',
    display: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="1.6"/><line x1="9" y1="10" x2="9" y2="20" stroke="currentColor" stroke-width="1.6"/></svg>',
    speaker: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 9a4 4 0 010 6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M19 7a7.5 7.5 0 010 10" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
    hdr: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><line x1="12" y1="2" x2="12" y2="5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="2" y1="12" x2="5" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="19" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="4.9" y1="4.9" x2="7" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="17" y1="17" x2="19.1" y2="19.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="4.9" y1="19.1" x2="7" y2="17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><line x1="17" y1="7" x2="19.1" y2="4.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

/* icon param is optional - the About tab's card has no icon/desc header. */
function groupHead(icon, title, desc, switchHtml = "") {
    return `
    <div class="group-head">
      ${icon ? `<div class="group-icon">${icon}</div>` : ""}
      <div class="group-head-text">
        <div class="group-title">${title}</div>
        ${desc ? `<div class="group-desc">${desc}</div>` : ""}
      </div>
      ${switchHtml}
    </div>`;
}

class StreamingSettingsModal extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._sections = [];
    this._servers = [];
    this._homeEnabled = true;
    /* Reflected onto this host element, not read via a :root selector inside the shadow
       stylesheet below - see focus-nav.js's own comment on why :root never matches there. */
    this.toggleAttribute("controller-active", isControllerActive());
    document.addEventListener("controller-active-change", (e) => {
      this.toggleAttribute("controller-active", e.detail.active);
    });
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${MODAL_STYLE}</style>
      <div class="overlay">
        <div class="modal">
          <div class="modal-header">
            <h2>Settings</h2>
            <button type="button" class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="tabs">
            ${TABS.map((t) => `<button type="button" class="tab-btn" data-tab="${t.key}" data-nav-group="tabs">${t.label}</button>`).join("")}
          </div>
          <div class="modal-body">
            <div class="tab-panel" data-tab="plex">
              <section class="group">
                ${groupHead(ICONS.server, "Plex Server", "The server this app is signed in to")}
                <div class="plex-server-card">
                  <div class="plex-server-info">
                    <span class="plex-server-dot"></span>
                    <div class="status plex-server-status"></div>
                  </div>
                  <button type="button" class="btn btn-secondary btn-reauth">Reauthenticate</button>
                </div>
              </section>

              <section class="group">
                ${groupHead(ICONS.libraries, "Libraries", "Choose which libraries show up as browsing tabs, and pick your default screen")}
                <button type="button" class="btn btn-secondary btn-fetch-libraries">Discover Libraries</button>
                <div class="hint">Finds every server on your account, including ones friends have shared with you, and lists their libraries below.</div>
                <div class="status fetch-status"></div>
                <div class="section-list"></div>
              </section>
            </div>

            <div class="tab-panel" data-tab="preferences">
              <section class="group">
                ${groupHead(ICONS.play, "Trailers", "Show trailer previews on the home screen and in each title's info panel")}
                <div class="subtoggle-row">
                  <span class="subtoggle-label">Home Screen</span>
                  <label class="switch">
                    <input type="checkbox" class="f-trailers-enabled" />
                    <span class="switch-track"></span>
                  </label>
                </div>
                <div class="subtoggle-row">
                  <span class="subtoggle-label">Title Info</span>
                  <label class="switch">
                    <input type="checkbox" class="f-title-trailers-enabled" />
                    <span class="switch-track"></span>
                  </label>
                </div>
                <div class="hint">Falls back to a trailer looked up on TMDB when Plex doesn't have one.</div>
              </section>

              <section class="group">
                ${groupHead(ICONS.display, "Display", "Tune how many rows and titles appear on the home screen")}
                <div class="row-2col">
                  <div class="field">
                    <label>Max Genre Rows</label>
                    <input type="number" class="f-max-genre-rows" min="0" max="40" data-nav-group="prefs-display" />
                  </div>
                  <div class="field">
                    <label>Row Size</label>
                    <input type="number" class="f-row-size" min="5" max="60" data-nav-group="prefs-display" />
                  </div>
                </div>
              </section>

              <section class="group">
                ${groupHead(
                  ICONS.speaker,
                  "Title Audio",
                  "Fades in a title's theme song when its info panel opens, and fades it out when you close it or move on",
                  `<label class="switch"><input type="checkbox" class="f-title-audio-enabled" /><span class="switch-track"></span></label>`
                )}
                <div class="field title-audio-fields">
                  <label>Volume</label>
                  <div class="field-row">
                    <input type="range" class="f-title-audio-volume" min="0" max="100" step="5" />
                    <span class="range-value title-audio-volume-value"></span>
                  </div>
                </div>
              </section>

              <section class="group xbox-only-group">
                ${groupHead(
                  ICONS.hdr,
                  "HDR — Stay On During Playback",
                  "Plays everything in HDR10, including SDR titles, instead of switching per-title. Avoids the TV renegotiating between back-to-back titles. Returns to SDR once playback stops.",
                  `<label class="switch"><input type="checkbox" class="f-xbox-hdr-always-on" /><span class="switch-track"></span></label>`
                )}
              </section>
            </div>

            <div class="tab-panel" data-tab="integrations">
              <section class="group">
                ${groupHead(
                  ICONS.sparkle,
                  "AI Rows",
                  "Personalized genre rows generated from your library on a schedule",
                  `<label class="switch"><input type="checkbox" class="f-ai-enabled" /><span class="switch-track"></span></label>`
                )}
                <div class="row-2col ai-fields">
                  <div class="field">
                    <label>OpenRouter API Key</label>
                    <input type="password" class="f-openrouter-key" data-nav-group="ai-row" />
                  </div>
                  <div class="field">
                    <label>Refresh Cadence</label>
                    <select class="f-ai-cadence" data-nav-group="ai-row">
                      <option value="86400000">Daily</option>
                      <option value="604800000">Weekly</option>
                    </select>
                  </div>
                </div>
              </section>

              <section class="group">
                ${groupHead(ICONS.captions, "Subtitles", "Choose where subtitle search and downloads come from")}
                <div class="field">
                  <label>Subtitle Provider</label>
                  <select class="f-subtitle-provider">
                    <option value="plex">Plex (searches/downloads via your server)</option>
                    <option value="opensubtitles">OpenSubtitles (direct, needs your own account)</option>
                  </select>
                </div>
                <div class="row-2col opensubtitles-fields">
                  <div class="field">
                    <label>Username</label>
                    <input type="text" class="f-opensubtitles-username" placeholder="Needed to download, not just search" data-nav-group="opensubs-creds" />
                  </div>
                  <div class="field">
                    <label>Password</label>
                    <input type="password" class="f-opensubtitles-password" data-nav-group="opensubs-creds" />
                  </div>
                </div>
                <div class="field opensubtitles-fields">
                  <label>API Key</label>
                  <input type="password" class="f-opensubtitles-key" />
                </div>
              </section>

            </div>

            <div class="tab-panel" data-tab="about">
              <section class="group about-group">
                <img class="about-logo" src="./assets/prism-logo.svg" alt="Prism" />
                <div class="hint">Prism is an independent app and is not affiliated with, endorsed by, or sponsored by Plex, Inc.</div>
                <div class="hint">This product uses the TMDB API but is not endorsed or certified by TMDB.</div>
                <div class="about-links">
                  <a class="about-privacy-link" href="https://mpotrykus.github.io/prism/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
                  <span class="about-links-sep">·</span>
                  <a class="about-privacy-link" href="https://github.com/mpotrykus/prism" target="_blank" rel="noopener noreferrer">GitHub</a>
                  <span class="about-links-sep">·</span>
                  <a class="about-privacy-link" href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">TMDB</a>
                </div>
              </section>
            </div>
          </div>
          <div class="status save-status"></div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary btn-cancel" data-nav-group="footer">Cancel</button>
            <button type="button" class="btn btn-primary btn-save" data-nav-group="footer">Save</button>
          </div>
        </div>
      </div>
    `;
    this._wire();
  }

  _el(sel) {
    return this.shadowRoot.querySelector(sel);
  }

  _wire() {
    this._overlay = this._el(".overlay");
    this._el(".modal-close").addEventListener("click", () => this.close());
    this._el(".btn-cancel").addEventListener("click", () => this.close());
    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this.close();
    });
    this._el(".btn-reauth").addEventListener("click", () => this._reauthenticate());
    this._el(".btn-fetch-libraries").addEventListener("click", () => this._fetchLibraries());
    this._el(".btn-save").addEventListener("click", () => this._save());
    this._el(".f-subtitle-provider").addEventListener("change", () => this._syncSubtitleProviderFields());
    this._el(".f-ai-enabled").addEventListener("change", () => this._syncIntegrationToggleFields());
    this._el(".f-title-audio-enabled").addEventListener("change", () => this._syncTitleAudioFields());
    this._el(".f-title-audio-volume").addEventListener("input", () => this._updateTitleAudioVolumeLabel());
    /* Delegated on .section-list itself (not the individual radios) since those are
       torn down and rebuilt by every _renderSectionList() call - the container div is
       the one element in this area that survives across renders. */
    this._el(".section-list").addEventListener("change", (e) => {
      if (e.target.classList.contains("default-view-radio")) this._defaultView = e.target.value;
    });
    this.shadowRoot.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
    });
    /* One long vertical list rather than per-row/per-section sub-navigation - simpler,
       and good enough for a screen that isn't the primary Xbox-blocking flow the way
       sign-in is. Tab buttons share data-nav-group="tabs" (set in the template above) so
       they're treated as one horizontal row - Up/Down passes over all of them as a single
       stop, Left/Right steps between them - instead of Down walking through each tab
       individually the way the rest of this list works. Fields that sit side-by-side in a
       .row-2col share their own per-row data-nav-group for the same reason (Up/Down should
       skip the pair as one visual row, Left/Right moves within it), matching how they
       actually appear on screen rather than raw DOM order. Cancel/Save share data-nav-
       group="footer" for the same reason - they sit side by side in .modal-footer. A hidden tab panel's fields are
       automatically excluded already, since items() filters on offsetParent !== null and
       inactive .tab-panels are display:none. Text/password/number inputs don't take real
       focus (and so don't pop the on-screen keyboard) until an explicit "activate" - see
       focus-nav.js. */
    wireLinearNav(
      this.shadowRoot,
      ".modal-close, .tab-btn, .btn-reauth, .btn-fetch-libraries, .home-enabled, .server-all-row .sv-enabled, " +
        ".section-row .s-enabled, .section-row .s-label, .section-row .default-view-radio, " +
        ".f-trailers-enabled, .f-title-trailers-enabled, .f-ai-enabled, .f-openrouter-key, .f-subtitle-provider, " +
        ".f-opensubtitles-username, .f-opensubtitles-password, .f-opensubtitles-key, " +
        ".f-ai-cadence, .f-max-genre-rows, .f-row-size, .f-title-audio-enabled, .f-title-audio-volume, .f-xbox-hdr-always-on, " +
        ".about-privacy-link, .btn-cancel, .btn-save",
      { orientation: "vertical", onBack: () => this.close() }
    );
    /* LB/RB (see focus-nav.js's chapterPrev/chapterNext) switch tabs directly regardless of
       which field currently has focus, rather than requiring the user to nav up to the tab
       row and step Left/Right through it - a global shortcut layered on top of the linear
       nav above, not a replacement for it. Registered separately since wireLinearNav's own
       handler already owns Left/Right within the tab row's data-nav-group="tabs". */
    registerNavHandler((command) => {
      if (!this.isOpen()) return false;
      if (command !== "chapterPrev" && command !== "chapterNext") return false;
      const keys = TABS.map((t) => t.key);
      const idx = keys.indexOf(this.shadowRoot.querySelector(".tab-btn.active")?.dataset.tab);
      if (idx === -1) return false;
      const nextIdx = Math.max(0, Math.min(keys.length - 1, idx + (command === "chapterNext" ? 1 : -1)));
      if (nextIdx !== idx) {
        this._switchTab(keys[nextIdx]);
        focusAfterPaint(this._el(`.tab-btn[data-tab="${keys[nextIdx]}"]`));
      }
      return true;
    });
  }

  /* Toggles the OpenSubtitles credential fields' actual display (not just a CSS class)
     since they're split across two different base layouts (.row-2col's grid, a plain
     .field's block) - clearing the inline style reverts each to its own default rather
     than forcing one shared display value onto both. Hiding them via display:none also
     doubles as excluding them from wireLinearNav's list for free (see _wire's own
     comment on offsetParent !== null). */
  _syncSubtitleProviderFields() {
    const show = this._el(".f-subtitle-provider").value === "opensubtitles";
    this.shadowRoot.querySelectorAll(".opensubtitles-fields").forEach((el) => {
      el.style.display = show ? "" : "none";
    });
  }

  /* Toggling AI Rows off only hides its input fields - it doesn't clear the underlying
     secret, so flipping back on later still has the credential in place (see
     _collectSecrets below, which reads the field values directly rather than clearing
     them on toggle-off). */
  _syncIntegrationToggleFields() {
    this.shadowRoot.querySelectorAll(".ai-fields").forEach((el) => {
      el.style.display = this._el(".f-ai-enabled").checked ? "" : "none";
    });
  }

  /* Same show/hide-on-toggle pattern as _syncIntegrationToggleFields above, kept
     separate since this toggle lives in the Preferences tab, not Integrations. */
  _syncTitleAudioFields() {
    this.shadowRoot.querySelectorAll(".title-audio-fields").forEach((el) => {
      el.style.display = this._el(".f-title-audio-enabled").checked ? "" : "none";
    });
  }

  _updateTitleAudioVolumeLabel() {
    this._el(".title-audio-volume-value").textContent = `${this._el(".f-title-audio-volume").value}%`;
  }

  _switchTab(key) {
    this.shadowRoot.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === key));
    this.shadowRoot.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.tab === key));
  }

  async open() {
    const config = loadPlain();
    this._plexUrl = config.plex_url || "";
    this._el(".plex-server-status").textContent = this._plexUrl ? `Connected — ${this._plexUrl}` : "Not connected.";
    this._el(".plex-server-status").className = this._plexUrl ? "status plex-server-status ok" : "status plex-server-status err";
    this._el(".f-ai-cadence").value = String(config.ai_rows_cadence_ms || 604800000);
    this._defaultView = config.default_view || "home";
    this._el(".f-max-genre-rows").value = config.max_genre_rows ?? 12;
    this._el(".f-row-size").value = config.row_size ?? 20;
    this._machineId = config.machine_id || "";
    this._sections = config.sections || [];
    /* Tokens merged in below (after secrets are unlocked, further down this method) -
       config here is loadPlain()'s output, which never carries them. Kept as plain
       metadata until then so _renderSectionList() can still show something immediately. */
    this._servers = config.servers || [];
    this._homeEnabled = config.home_enabled !== false;
    this._el(".f-trailers-enabled").checked = config.trailers_enabled !== false;
    this._el(".f-title-trailers-enabled").checked = config.title_trailers_enabled !== false;
    this._el(".f-ai-enabled").checked = config.ai_rows_enabled !== false;
    this._el(".f-title-audio-enabled").checked = config.title_audio_enabled !== false;
    this._el(".f-title-audio-volume").value = String(Math.round((config.title_audio_volume ?? 0.65) * 100));
    this._updateTitleAudioVolumeLabel();
    this._syncTitleAudioFields();
    this._el(".f-xbox-hdr-always-on").checked = config.xbox_hdr_always_on === true;
    /* Xbox/UWP-only (see HdrDisplayController.cs) - hidden rather than removed, so
       wireLinearNav's own offsetParent!==null filtering excludes it from the nav list
       on every other platform for free, same as the OpenSubtitles fields above. */
    const showXboxHdr = isXboxDevice();
    this.shadowRoot.querySelectorAll(".xbox-only-group").forEach((el) => {
      el.style.display = showXboxHdr ? "" : "none";
    });
    /* Reset per-open so a stale in-memory copy from a previous session never lingers -
       fields re-read from the vault rather than silently reusing whatever was decrypted
       last time this modal was open. */
    this._unlockedSecrets = null;
    this._el(".f-subtitle-provider").value = config.subtitle_provider || "plex";
    /* All credential fields below are shown filled in with the real stored value rather
       than blank+placeholder - the toggle above is what lets a credential stay saved
       while unused, so there's no "don't echo a secret back" concern; being able to
       see/edit what's actually saved matters more, since a stale/wrong key otherwise
       only surfaces as an opaque failure later. */
    const secrets = await this._getEffectiveSecrets();
    this._servers = this._servers.map((s) => ({ ...s, token: secrets.server_tokens?.[s.id] || "" }));
    this._el(".f-openrouter-key").value = secrets.openrouter_api_key || "";
    this._el(".f-opensubtitles-username").value = secrets.opensubtitles_username || "";
    this._el(".f-opensubtitles-password").value = secrets.opensubtitles_password || "";
    this._el(".f-opensubtitles-key").value = secrets.opensubtitles_api_key || "";
    this._syncSubtitleProviderFields();
    this._syncIntegrationToggleFields();
    this._switchTab(TABS[0].key);
    this._renderSectionList();
    this._el(".fetch-status").textContent = "";
    this._el(".fetch-status").className = "status fetch-status";
    this._el(".save-status").textContent = "";
    this._el(".save-status").className = "status save-status";
    this._overlay.classList.add("open");
    focusAfterPaint(this._el(`.tab-btn[data-tab="${TABS[0].key}"]`));
  }

  /* Decrypts (once per open() - see above) whatever secrets are already stored, so
     Fetch Libraries/Save can fall back to them when their field was left blank,
     without re-decrypting on every call within the same modal session. */
  async _getEffectiveSecrets() {
    if (this._unlockedSecrets) return this._unlockedSecrets;
    this._unlockedSecrets = hasSecrets() ? await loadSecrets() : {};
    return this._unlockedSecrets;
  }

  close() {
    this._overlay.classList.remove("open");
  }

  isOpen() {
    return this._overlay.classList.contains("open");
  }

  /* Delegates to <streaming-plex-signin-modal> (see app.js) rather than re-implementing
     the PIN flow here - Settings only needs to ask for it, not run it. */
  _reauthenticate() {
    this.close();
    this.dispatchEvent(new CustomEvent("request-plex-reauth", { bubbles: true, composed: true }));
  }

  /* Discovers every server on the signed-in account - the owned one plus any a friend
     has shared - not just the single server the app originally connected to. Re-running
     this later re-probes connections and re-lists libraries but preserves every
     existing enabled/label/all_enabled toggle (see plex-auth.js's discoverLibraries,
     shared with the sign-in flow which now runs this same discovery automatically). */
  async _fetchLibraries() {
    const statusEl = this._el(".fetch-status");
    const accountToken = (await this._getEffectiveSecrets()).plex_account_token || "";
    if (!accountToken) {
      statusEl.textContent = "Sign in with Plex first.";
      statusEl.className = "status fetch-status err";
      return;
    }
    statusEl.textContent = "Discovering servers…";
    statusEl.className = "status fetch-status";
    try {
      const { servers, sections, unreachableCount } = await discoverLibraries(accountToken, {
        prevServers: this._servers || [],
        prevSections: this._sections || [],
      });
      this._servers = servers;
      this._sections = sections;
      this._renderSectionList();
      const suffix = unreachableCount ? ` — ${unreachableCount} server(s) unreachable right now` : "";
      statusEl.textContent = `Found ${sections.length} library section(s) across ${servers.length} server(s)${suffix}.`;
      statusEl.className = "status fetch-status ok";
    } catch (e) {
      statusEl.textContent = `Couldn't discover Plex servers: ${e.message}`;
      statusEl.className = "status fetch-status err";
    }
  }

  /* Renders, in order: a top "Home" toggle (everything, across every server - mirrors
     nav.js's static Home tab), then one group per discovered server, each with its own
     "All" toggle (everything on just that server, tab titled with the server's own
     name) followed by that server's individual libraries, each subtitled with the
     server it's from. All three levels are independent checkboxes, not a single picker -
     see nav.js's renderNavSections for how each one turns into an actual nav tab. */
  _renderSectionList() {
    const list = this._el(".section-list");
    if (!this._servers.length) {
      list.innerHTML = "";
      return;
    }
    const sectionsByServer = new Map();
    (this._sections || []).forEach((s, i) => {
      if (!sectionsByServer.has(s.server_id)) sectionsByServer.set(s.server_id, []);
      sectionsByServer.get(s.server_id).push(i);
    });
    /* Radio "Default" - one per row (Home/server-All/library), all sharing name=
       "default-view" so the browser's own native radio-group behavior (checking one
       unchecks the rest) does the mutual-exclusion work - see nav.js's buildNavTabs for
       why these exact view-key strings ("home"/"server-<id>"/"section-<id>:<key>") are
       what plex-netflix-card.js's _currentView expects. A disabled row's radio is
       disabled too (can't be the default if it won't even be a tab); _reconcileDefaultView
       below moves the selection off a row the instant its own toggle turns it off. */
    const homeHtml = `
      <div class="section-row home-row">
        <label class="switch">
          <input type="checkbox" class="home-enabled" data-nav-group="home-row" ${this._homeEnabled !== false ? "checked" : ""} />
          <span class="switch-track"></span>
        </label>
        <div class="section-row-main">
          <span class="section-row-title">Home</span>
          <span class="section-row-server">Everything, across every server</span>
        </div>
        <label class="default-radio">
          <input type="radio" name="default-view" class="default-view-radio" value="home" data-nav-group="home-row" ${this._defaultView === "home" ? "checked" : ""} ${this._homeEnabled === false ? "disabled" : ""} />
          <span>Default</span>
        </label>
      </div>`;
    const serverGroupsHtml = this._servers
      .map((sv) => {
        const indices = sectionsByServer.get(sv.id) || [];
        const ownerHtml = sv.owned
          ? ""
          : ` <span class="server-group-shared">shared by ${this._escape(sv.sourceTitle || "a friend")}</span>`;
        const rowsHtml = indices
          .map((i) => {
            const s = this._sections[i];
            const view = `section-${sv.id}:${s.key}`;
            return `
          <div class="section-row" data-index="${i}">
            <label class="switch">
              <input type="checkbox" class="s-enabled" data-nav-group="section-row-${i}" ${s.enabled !== false ? "checked" : ""} />
              <span class="switch-track"></span>
            </label>
            <div class="section-row-main">
              <input type="text" class="s-label" data-nav-group="section-row-${i}" value="${this._escape(s.label)}" />
              <span class="section-row-server">${this._escape(sv.name)}</span>
            </div>
            <span class="type-badge">${s.type === 1 ? "Movies" : "TV"}</span>
            <label class="default-radio">
              <input type="radio" name="default-view" class="default-view-radio" value="${this._escape(view)}" data-nav-group="section-row-${i}" ${this._defaultView === view ? "checked" : ""} ${s.enabled === false ? "disabled" : ""} />
              <span>Default</span>
            </label>
          </div>`;
          })
          .join("");
        const serverView = `server-${sv.id}`;
        return `
        <div class="server-group">
          <div class="server-group-header">
            <span class="server-group-name">${this._escape(sv.name)}</span>${ownerHtml}
          </div>
          <div class="section-row server-all-row" data-server="${this._escape(sv.id)}">
            <label class="switch">
              <input type="checkbox" class="sv-enabled" data-nav-group="server-row-${this._escape(sv.id)}" ${sv.all_enabled !== false ? "checked" : ""} />
              <span class="switch-track"></span>
            </label>
            <div class="section-row-main">
              <span class="section-row-title">${this._escape(sv.name)}</span>
              <span class="section-row-server">All libraries on this server</span>
            </div>
            <label class="default-radio">
              <input type="radio" name="default-view" class="default-view-radio" value="${this._escape(serverView)}" data-nav-group="server-row-${this._escape(sv.id)}" ${this._defaultView === serverView ? "checked" : ""} ${sv.all_enabled === false ? "disabled" : ""} />
              <span>Default</span>
            </label>
          </div>
          ${rowsHtml}
        </div>`;
      })
      .join("");
    list.innerHTML = homeHtml + serverGroupsHtml;

    list.querySelector(".home-enabled").addEventListener("change", (e) => {
      this._homeEnabled = e.target.checked;
      list.querySelector(".home-row .default-view-radio").disabled = !e.target.checked;
      this._reconcileDefaultView();
    });
    list.querySelectorAll(".server-all-row").forEach((row) => {
      row.querySelector(".sv-enabled").addEventListener("change", (e) => {
        const sv = this._servers.find((s) => s.id === row.dataset.server);
        if (sv) sv.all_enabled = e.target.checked;
        row.querySelector(".default-view-radio").disabled = !e.target.checked;
        this._reconcileDefaultView();
      });
    });
    list.querySelectorAll(".section-row[data-index]").forEach((row) => {
      const i = Number(row.dataset.index);
      row.querySelector(".s-enabled").addEventListener("change", (e) => {
        this._sections[i].enabled = e.target.checked;
        row.querySelector(".default-view-radio").disabled = !e.target.checked;
        this._reconcileDefaultView();
      });
      row.querySelector(".s-label").addEventListener("input", (e) => {
        this._sections[i].label = e.target.value;
      });
    });
    this._reconcileDefaultView();
  }

  /* Moves the Default selection off a row the moment that row's own enable toggle turns
     it off - a disabled row's radio can't be interacted with (see the `disabled`
     attributes set above/inline in the change handlers), but a browser doesn't
     auto-uncheck a radio just because it becomes disabled, so without this the
     previously-checked-but-now-disabled radio would stay "checked" and get read back
     as the default at Save time despite being greyed out and unreachable in the UI.
     Prefers Home, then falls back to the first remaining enabled row. */
  _reconcileDefaultView() {
    const list = this._el(".section-list");
    const checked = list.querySelector(".default-view-radio:checked");
    if (checked && !checked.disabled) return;
    const fallback =
      list.querySelector(".home-row .default-view-radio:not(:disabled)") ||
      list.querySelector(".default-view-radio:not(:disabled)");
    if (!fallback) return;
    fallback.checked = true;
    this._defaultView = fallback.value;
  }

  _escape(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  _collectPlainConfig() {
    return {
      plex_url: (this._plexUrl || "").replace(/\/$/, ""),
      machine_id: this._machineId || "",
      home_enabled: this._homeEnabled !== false,
      /* Tokens live in secrets (see _collectSecrets' server_tokens below), not here. */
      servers: (this._servers || []).map(({ token, ...rest }) => rest),
      sections: (this._sections || [])
        .filter((s) => s.enabled !== false)
        .map((s) => ({ key: s.key, type: s.type, label: s.label, server_id: s.server_id })),
      default_view: this.shadowRoot.querySelector(".default-view-radio:checked")?.value || "home",
      ai_rows_cadence_ms: Number(this._el(".f-ai-cadence").value),
      max_genre_rows: Number(this._el(".f-max-genre-rows").value) || 12,
      row_size: Number(this._el(".f-row-size").value) || 20,
      subtitle_provider: this._el(".f-subtitle-provider").value || "plex",
      trailers_enabled: this._el(".f-trailers-enabled").checked,
      title_trailers_enabled: this._el(".f-title-trailers-enabled").checked,
      ai_rows_enabled: this._el(".f-ai-enabled").checked,
      xbox_hdr_always_on: this._el(".f-xbox-hdr-always-on").checked,
      title_audio_enabled: this._el(".f-title-audio-enabled").checked,
      title_audio_volume: Number(this._el(".f-title-audio-volume").value) / 100,
    };
  }

  /* Every credential field is now shown filled with its real stored value (see open()),
     so whatever's in each one now - including blank, if the user actually cleared it -
     is taken as-is rather than falling back to the existing stored value. */
  async _collectSecrets() {
    const existing = await this._getEffectiveSecrets();
    return {
      plex_token: existing.plex_token || "",
      openrouter_api_key: this._el(".f-openrouter-key").value.trim(),
      plex_account_token: existing.plex_account_token || "",
      opensubtitles_username: this._el(".f-opensubtitles-username").value.trim(),
      opensubtitles_password: this._el(".f-opensubtitles-password").value.trim(),
      opensubtitles_api_key: this._el(".f-opensubtitles-key").value.trim(),
      server_tokens: Object.fromEntries((this._servers || []).map((s) => [s.id, s.token || ""])),
    };
  }

  async _save() {
    const statusEl = this._el(".save-status");
    const saveBtn = this._el(".btn-save");
    statusEl.textContent = "Saving…";
    statusEl.className = "status save-status";
    saveBtn.disabled = true;
    try {
      const plain = this._collectPlainConfig();
      const secrets = await this._collectSecrets();
      await saveSecrets(secrets);
      savePlain(plain);
      /* Same server+token merge as loadFull() - plain.servers has no token field (see
         _collectPlainConfig's comment) and secrets only carries the id-keyed
         server_tokens map, so naively spreading both here would hand refreshConfig()
         servers with no token at all. That undefined token was then round-tripping
         through data.js's loadAll (which re-persists server_tokens keyed off whatever
         card._config.servers already has) back into the vault as an empty string,
         permanently wiping every server's real token on the very next save - each
         later _playItem call then failed with a missing plexToken and silently fell
         back to opening Plex's own web/app link instead of this app's player. */
      const servers = (plain.servers || []).map((s) => ({ ...s, token: secrets.server_tokens?.[s.id] || "" }));
      const fullConfig = { ...plain, ...secrets, servers };
      this.dispatchEvent(new CustomEvent("settings-saved", { bubbles: true, composed: true, detail: fullConfig }));
      this.close();
    } catch (e) {
      statusEl.textContent = `Couldn't save: ${e.message}`;
      statusEl.className = "status save-status err";
    } finally {
      saveBtn.disabled = false;
    }
  }

}

if (!customElements.get("streaming-settings-modal")) {
  customElements.define("streaming-settings-modal", StreamingSettingsModal);
}