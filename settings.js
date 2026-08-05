import { wireLinearNav, focusAfterPaint } from "./focus-nav.js";

/* Only non-sensitive fields live here in plain localStorage. plex_token,
   youtube_api_key, openrouter_api_key, and plex_account_token go through vault.js
   instead - see there for why (encrypted at rest, not plaintext).
   plex_account_token is the Plex.tv account token from the Sign in with Plex flow
   (plex-auth.js) - kept separately from plex_token (the per-server access token the
   card actually uses) so "refresh servers" can re-run discovery later without a
   full re-login. */
const PLAIN_STORAGE_KEY = "prism.config";
const SECRET_FIELDS = [
  "plex_token",
  "youtube_api_key",
  "openrouter_api_key",
  "plex_account_token",
  "opensubtitles_api_key",
  "opensubtitles_username",
  "opensubtitles_password",
];

const DEFAULT_PLAIN_CONFIG = {
  plex_url: "",
  machine_id: "",
  sections: [],
  ai_rows_cadence_ms: 7 * 24 * 60 * 60 * 1000,
  kids_mode_pin: "1233",
  max_genre_rows: 12,
  row_size: 20,
};

const SECTION_TYPE_MAP = { movie: 1, show: 2 };

const StreamingSettings = {
  loadPlain() {
    try {
      const raw = JSON.parse(localStorage.getItem(PLAIN_STORAGE_KEY) || "null");
      return { ...DEFAULT_PLAIN_CONFIG, ...(raw || {}) };
    } catch (e) {
      return { ...DEFAULT_PLAIN_CONFIG };
    }
  },
  savePlain(config) {
    localStorage.setItem(PLAIN_STORAGE_KEY, JSON.stringify(config));
  },
  /* Full config = plain fields + decrypted secrets, merged - what the card's
     setConfig()/refreshConfig() actually expects. */
  async loadFull() {
    const plain = this.loadPlain();
    const secrets = window.StreamingVault.hasSecrets() ? await window.StreamingVault.loadSecrets() : {};
    return { ...plain, ...secrets };
  },
  isConfigured(fullConfig) {
    return !!(fullConfig && fullConfig.plex_url && fullConfig.plex_token);
  },
};
window.StreamingSettings = StreamingSettings;

const MODAL_STYLE = `
  :host {
    all: initial;
    /* See plex-netflix-card.js's :host for why both env() and var() are needed -
       env(safe-area-inset-*) is iOS/web only, Capacitor's Android SystemBars plugin
       instead injects --safe-area-inset-* on <html>, which inherits down here since
       this modal is a separate top-level element (not nested under the card's :host). */
    --safe-top: max(env(safe-area-inset-top, 0px), var(--safe-area-inset-top, 0px));
    --safe-bottom: max(env(safe-area-inset-bottom, 0px), var(--safe-area-inset-bottom, 0px));
  }
  * { box-sizing: border-box; font-family: "Roboto", sans-serif; }
  .overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,0.72);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center; justify-content: center;
    padding: calc(24px + var(--safe-top)) 24px calc(24px + var(--safe-bottom));
  }
  .overlay.open { display: flex; }
  .modal {
    width: 560px; max-width: 100%; max-height: 88vh;
    overflow-y: auto;
    background: #161619;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    color: #fff;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  }
  .modal-header {
    position: sticky; top: 0;
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 24px; background: #161619;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .modal-header h2 { font-size: 17px; font-weight: 700; margin: 0; }
  .modal-close {
    border: none; background: transparent; color: rgba(255,255,255,0.6);
    font-size: 20px; cursor: pointer; line-height: 1; padding: 4px;
  }
  .modal-close:hover { color: #fff; }
  .modal-body { padding: 8px 24px 24px; }
  section.group { margin-top: 22px; }
  section.group:first-child { margin-top: 18px; }
  .group-title {
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: rgba(255,255,255,0.45); margin-bottom: 10px;
  }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: rgba(255,255,255,0.85); }
  .field { margin-bottom: 12px; }
  .field-row { display: flex; gap: 10px; align-items: center; }
  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%; padding: 9px 12px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06);
    color: #fff; font-size: 13px; outline: none;
  }
  input:focus, select:focus { border-color: #e5a00d; }
  .btn {
    border: none; border-radius: 8px; padding: 9px 16px; font-size: 13px; font-weight: 700;
    cursor: pointer; white-space: nowrap;
  }
  .btn-primary { background: #e5a00d; color: #161619; }
  .btn-primary:hover { background: #f0ad1a; }
  .btn-secondary { background: rgba(255,255,255,0.1); color: #fff; }
  .btn-secondary:hover { background: rgba(255,255,255,0.18); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn:focus-visible, .modal-close:focus-visible, input:focus-visible, select:focus-visible {
    outline: 2px solid #e5a00d; outline-offset: 2px;
  }
  .status { font-size: 12px; font-weight: 600; margin-top: 6px; min-height: 15px; }
  .status.ok { color: #4caf7d; }
  .status.err { color: #ff6b6b; }
  .save-status { padding: 0 24px; margin-top: -6px; }
  .section-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .section-row {
    display: flex; align-items: center; gap: 10px;
    background: rgba(255,255,255,0.05); border-radius: 8px; padding: 8px 10px;
  }
  .section-row input[type="checkbox"] { width: 16px; height: 16px; flex: none; }
  .section-row input[type="text"] { flex: 1; padding: 6px 10px; }
  .section-row .type-badge {
    flex: none; font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 5px; padding: 2px 6px;
  }
  .row-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .modal-footer {
    display: flex; justify-content: space-between; align-items: center; gap: 10px;
    padding: 16px 24px 22px;
  }
  .modal-footer .left { display: flex; gap: 8px; }
  .modal-footer .right { display: flex; gap: 8px; }
  input[type="file"] { display: none; }
  @media (max-width: 700px) {
    .overlay { padding: 0; overflow-y: auto; align-items: flex-start; }
    .modal { width: 100%; max-width: 100%; min-height: 100dvh; max-height: none; overflow-y: visible; border-radius: 0; border: none; }
    .modal-close { display: none; }
    .modal-header { padding: calc(20px + var(--safe-top)) 24px 20px; }
    .modal-footer { padding: 16px 24px calc(22px + var(--safe-bottom)); }
  }
`;

class StreamingSettingsModal extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._sections = [];
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${MODAL_STYLE}</style>
      <div class="overlay">
        <div class="modal">
          <div class="modal-header">
            <h2>Settings</h2>
            <button type="button" class="modal-close" aria-label="Close">✕</button>
          </div>
          <div class="modal-body">
            <section class="group">
              <div class="group-title">Plex Server</div>
              <div class="status plex-server-status"></div>
              <div class="field-row">
                <button type="button" class="btn btn-secondary btn-reauth">Reauthenticate</button>
              </div>
            </section>

            <section class="group">
              <div class="group-title">Libraries</div>
              <button type="button" class="btn btn-secondary btn-fetch-libraries">Fetch Libraries</button>
              <div class="status fetch-status"></div>
              <div class="section-list"></div>
            </section>

            <section class="group">
              <div class="group-title">Trailers (optional)</div>
              <div class="field">
                <label>YouTube Data API Key</label>
                <input type="password" class="f-youtube-key" placeholder="Used as a fallback when Plex has no trailer" />
              </div>
            </section>

            <section class="group">
              <div class="group-title">AI Rows (optional)</div>
              <div class="row-2col">
                <div class="field">
                  <label>OpenRouter API Key</label>
                  <input type="password" class="f-openrouter-key" />
                </div>
                <div class="field">
                  <label>Refresh Cadence</label>
                  <select class="f-ai-cadence">
                    <option value="86400000">Daily</option>
                    <option value="604800000">Weekly</option>
                  </select>
                </div>
              </div>
            </section>

            <section class="group">
              <div class="group-title">Subtitles (optional)</div>
              <div class="field">
                <label>OpenSubtitles API Key</label>
                <input type="password" class="f-opensubtitles-key" placeholder="Used by the player's subtitle search" />
              </div>
              <div class="row-2col">
                <div class="field">
                  <label>OpenSubtitles Username</label>
                  <input type="text" class="f-opensubtitles-username" placeholder="Needed to download, not just search" />
                </div>
                <div class="field">
                  <label>OpenSubtitles Password</label>
                  <input type="password" class="f-opensubtitles-password" />
                </div>
              </div>
            </section>

            <section class="group">
              <div class="group-title">Kids Mode</div>
              <div class="field">
                <label>Exit PIN</label>
                <input type="text" class="f-kids-pin" inputmode="numeric" maxlength="8" placeholder="1233" />
              </div>
            </section>

            <section class="group">
              <div class="group-title">Display</div>
              <div class="row-2col">
                <div class="field">
                  <label>Max Genre Rows</label>
                  <input type="number" class="f-max-genre-rows" min="0" max="40" />
                </div>
                <div class="field">
                  <label>Row Size</label>
                  <input type="number" class="f-row-size" min="5" max="60" />
                </div>
              </div>
            </section>
          </div>
          <div class="status save-status"></div>
          <div class="modal-footer">
            <div class="left">
              <button type="button" class="btn btn-secondary btn-export" title="Includes your keys in plain text - only share this file with people you trust">Export</button>
              <button type="button" class="btn btn-secondary btn-import">Import</button>
              <input type="file" class="f-import-file" accept="application/json" />
            </div>
            <div class="right">
              <button type="button" class="btn btn-secondary btn-cancel">Cancel</button>
              <button type="button" class="btn btn-primary btn-save">Save</button>
            </div>
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
    this._el(".btn-export").addEventListener("click", () => this._exportConfig());
    this._el(".btn-import").addEventListener("click", () => this._el(".f-import-file").click());
    this._el(".f-import-file").addEventListener("change", (e) => this._importConfig(e));
    /* One long vertical list rather than per-row/per-section sub-navigation - simpler,
       and good enough for a screen that isn't the primary Xbox-blocking flow the way
       sign-in is. Native Left/Right cursor movement inside text/number inputs is left
       alone (this only claims Up/Down/Enter/Escape - see focus-nav.js's orientation
       handling), though that does mean Up/Down no longer increments/decrements a
       number input via its native spinner behavior - an accepted trade-off since
       moving between fields has to win for gamepad nav to work at all. */
    wireLinearNav(
      this.shadowRoot,
      ".modal-close, .btn-reauth, .btn-fetch-libraries, .section-row .s-enabled, .section-row .s-label, " +
        ".f-youtube-key, .f-openrouter-key, .f-opensubtitles-key, .f-opensubtitles-username, .f-opensubtitles-password, " +
        ".f-ai-cadence, .f-kids-pin, .f-max-genre-rows, .f-row-size, " +
        ".btn-export, .btn-import, .btn-cancel, .btn-save",
      { orientation: "vertical", onBack: () => this.close() }
    );
  }

  open() {
    const config = window.StreamingSettings.loadPlain();
    /* Secret fields are deliberately left blank rather than pre-filled - no reason to
       ever echo an already-stored API key back into a password input. Left blank +
       saved, they're treated as "keep whatever's already stored" (see
       _getEffectiveSecrets/_save below); only a typed value overrides. */
    const hasSecrets = window.StreamingVault.hasSecrets();
    this._el(".f-youtube-key").value = "";
    this._el(".f-youtube-key").placeholder = hasSecrets
      ? "•••••••• (leave blank to keep current)"
      : "Used as a fallback when Plex has no trailer";
    this._el(".f-openrouter-key").value = "";
    this._el(".f-openrouter-key").placeholder = hasSecrets ? "•••••••• (leave blank to keep current)" : "";
    this._el(".f-opensubtitles-key").value = "";
    this._el(".f-opensubtitles-key").placeholder = hasSecrets
      ? "•••••••• (leave blank to keep current)"
      : "Used by the player's subtitle search";
    this._el(".f-opensubtitles-username").value = "";
    this._el(".f-opensubtitles-username").placeholder = hasSecrets
      ? "•••••••• (leave blank to keep current)"
      : "Needed to download, not just search";
    this._el(".f-opensubtitles-password").value = "";
    this._el(".f-opensubtitles-password").placeholder = hasSecrets ? "•••••••• (leave blank to keep current)" : "";
    this._plexUrl = config.plex_url || "";
    this._el(".plex-server-status").textContent = this._plexUrl ? `Connected — ${this._plexUrl}` : "Not connected.";
    this._el(".plex-server-status").className = this._plexUrl ? "status plex-server-status ok" : "status plex-server-status err";
    this._el(".f-ai-cadence").value = String(config.ai_rows_cadence_ms || 604800000);
    this._el(".f-kids-pin").value = config.kids_mode_pin || "";
    this._el(".f-max-genre-rows").value = config.max_genre_rows ?? 12;
    this._el(".f-row-size").value = config.row_size ?? 20;
    this._machineId = config.machine_id || "";
    this._sections = config.sections || [];
    /* Reset per-open so a stale in-memory copy from a previous session never lingers -
       any field left blank this time re-reads from the vault rather than silently
       reusing whatever was decrypted last time this modal was open. */
    this._unlockedSecrets = null;
    this._renderSectionList();
    this._el(".fetch-status").textContent = "";
    this._el(".fetch-status").className = "status fetch-status";
    this._el(".save-status").textContent = "";
    this._el(".save-status").className = "status save-status";
    this._overlay.classList.add("open");
    focusAfterPaint(this._el(".modal-close"));
  }

  /* Decrypts (once per open() - see above) whatever secrets are already stored, so
     Fetch Libraries/Save can fall back to them when their field was left blank,
     without re-decrypting on every call within the same modal session. */
  async _getEffectiveSecrets() {
    if (this._unlockedSecrets) return this._unlockedSecrets;
    this._unlockedSecrets = window.StreamingVault.hasSecrets() ? await window.StreamingVault.loadSecrets() : {};
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

  async _fetchLibraries() {
    const statusEl = this._el(".fetch-status");
    const url = (this._plexUrl || "").replace(/\/$/, "");
    const token = (await this._getEffectiveSecrets()).plex_token || "";
    if (!url || !token) {
      statusEl.textContent = "Sign in with Plex first.";
      statusEl.className = "status fetch-status err";
      return;
    }
    statusEl.textContent = "Fetching…";
    statusEl.className = "status fetch-status";
    try {
      const data = await this._plexGet(url, token, "/library/sections");
      const dirs = data?.MediaContainer?.Directory || [];
      const existingByKey = new Map(this._sections.map((s) => [String(s.key), s]));
      this._sections = dirs
        .filter((d) => SECTION_TYPE_MAP[d.type])
        .map((d) => {
          const prev = existingByKey.get(String(d.key));
          return {
            key: Number(d.key),
            type: SECTION_TYPE_MAP[d.type],
            label: prev?.label || d.title,
            enabled: prev ? prev.enabled !== false : true,
          };
        });
      this._renderSectionList();
      statusEl.textContent = `Found ${this._sections.length} library section(s).`;
      statusEl.className = "status fetch-status ok";
    } catch (e) {
      statusEl.textContent = `Couldn't fetch libraries: ${e.message}`;
      statusEl.className = "status fetch-status err";
    }
  }

  async _plexGet(url, token, path) {
    const u = new URL(url + path);
    u.searchParams.set("X-Plex-Token", token);
    const res = await fetch(u, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  _renderSectionList() {
    const list = this._el(".section-list");
    if (!this._sections.length) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = this._sections
      .map(
        (s, i) => `
      <div class="section-row" data-index="${i}">
        <input type="checkbox" class="s-enabled" ${s.enabled !== false ? "checked" : ""} />
        <input type="text" class="s-label" value="${this._escape(s.label)}" />
        <span class="type-badge">${s.type === 1 ? "Movies" : "TV"}</span>
      </div>`
      )
      .join("");
    list.querySelectorAll(".section-row").forEach((row) => {
      const i = Number(row.dataset.index);
      row.querySelector(".s-enabled").addEventListener("change", (e) => {
        this._sections[i].enabled = e.target.checked;
      });
      row.querySelector(".s-label").addEventListener("input", (e) => {
        this._sections[i].label = e.target.value;
      });
    });
  }

  _escape(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  _collectPlainConfig() {
    return {
      plex_url: (this._plexUrl || "").replace(/\/$/, ""),
      machine_id: this._machineId || "",
      sections: (this._sections || []).filter((s) => s.enabled !== false).map((s) => ({ key: s.key, type: s.type, label: s.label })),
      ai_rows_cadence_ms: Number(this._el(".f-ai-cadence").value),
      kids_mode_pin: this._el(".f-kids-pin").value.trim() || "1233",
      max_genre_rows: Number(this._el(".f-max-genre-rows").value) || 12,
      row_size: Number(this._el(".f-row-size").value) || 20,
    };
  }

  /* A blank secret field means "keep whatever's already stored", not "clear it" -
     that's why this needs the decrypted existing values (see _getEffectiveSecrets)
     rather than just reading the inputs directly. */
  async _collectSecrets() {
    const existing = await this._getEffectiveSecrets();
    return {
      plex_token: existing.plex_token || "",
      youtube_api_key: this._el(".f-youtube-key").value.trim() || existing.youtube_api_key || "",
      openrouter_api_key: this._el(".f-openrouter-key").value.trim() || existing.openrouter_api_key || "",
      plex_account_token: existing.plex_account_token || "",
      opensubtitles_api_key: this._el(".f-opensubtitles-key").value.trim() || existing.opensubtitles_api_key || "",
      opensubtitles_username: this._el(".f-opensubtitles-username").value.trim() || existing.opensubtitles_username || "",
      opensubtitles_password: this._el(".f-opensubtitles-password").value.trim() || existing.opensubtitles_password || "",
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
      await window.StreamingVault.saveSecrets(secrets);
      window.StreamingSettings.savePlain(plain);
      const fullConfig = { ...plain, ...secrets };
      this.dispatchEvent(new CustomEvent("settings-saved", { bubbles: true, composed: true, detail: fullConfig }));
      this.close();
    } catch (e) {
      statusEl.textContent = `Couldn't save: ${e.message}`;
      statusEl.className = "status save-status err";
    } finally {
      saveBtn.disabled = false;
    }
  }

  async _exportConfig() {
    const plain = this._collectPlainConfig();
    let secrets;
    try {
      secrets = await this._collectSecrets();
    } catch (e) {
      const statusEl = this._el(".save-status");
      statusEl.textContent = `Couldn't unlock stored keys: ${e.message}`;
      statusEl.className = "status save-status err";
      return;
    }
    /* Deliberately plaintext on disk - this file exists so you can carry your own
       setup to another device/browser. The hint text next to Export says as much. */
    const blob = new Blob([JSON.stringify({ ...plain, ...secrets }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "prism-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _importConfig(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const imported = JSON.parse(reader.result);
        const plain = { ...window.StreamingSettings.loadPlain(), ...imported };
        const secrets = {};
        for (const field of SECRET_FIELDS) {
          if (imported[field]) secrets[field] = imported[field];
          delete plain[field];
        }
        window.StreamingSettings.savePlain(plain);
        if (Object.keys(secrets).length) {
          const merged = { ...(await this._getEffectiveSecrets()), ...secrets };
          await window.StreamingVault.saveSecrets(merged);
        }
        this.open();
      } catch (err) {
        const statusEl = this._el(".save-status");
        statusEl.textContent = `Import failed: ${err.message}`;
        statusEl.className = "status save-status err";
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }
}

if (!customElements.get("streaming-settings-modal")) {
  customElements.define("streaming-settings-modal", StreamingSettingsModal);
}
