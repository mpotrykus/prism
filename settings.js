import { wireLinearNav, focusAfterPaint } from "./focus-nav.js";
import { hasSecrets, loadSecrets, saveSecrets } from "./vault.js";
import MODAL_STYLE from "./src/styles/settings-modal.css?inline";

/* Only non-sensitive fields live here in plain localStorage. plex_token,
   youtube_api_key, openrouter_api_key, and plex_account_token go through vault.js
   instead - see there for why (encrypted at rest, not plaintext).
   plex_account_token is the Plex.tv account token from the Sign in with Plex flow
   (plex-auth.js) - kept separately from plex_token (the per-server access token the
   card actually uses) so "refresh servers" can re-run discovery later without a
   full re-login. */
const PLAIN_STORAGE_KEY = "prism.config";

const DEFAULT_PLAIN_CONFIG = {
  plex_url: "",
  machine_id: "",
  sections: [],
  ai_rows_cadence_ms: 7 * 24 * 60 * 60 * 1000,
  max_genre_rows: 12,
  row_size: 20,
  subtitle_provider: "plex",
  trailers_enabled: true,
  ai_rows_enabled: true,
};

const SECTION_TYPE_MAP = { movie: 1, show: 2 };

export function loadPlain() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAIN_STORAGE_KEY) || "null") || {};
    return { ...DEFAULT_PLAIN_CONFIG, ...raw };
  } catch (e) {
    return { ...DEFAULT_PLAIN_CONFIG };
  }
}
export function savePlain(config) {
  localStorage.setItem(PLAIN_STORAGE_KEY, JSON.stringify(config));
}
/* Full config = plain fields + decrypted secrets, merged - what the card's
   setConfig()/refreshConfig() actually expects. */
export async function loadFull() {
  const plain = loadPlain();
  const secrets = hasSecrets() ? await loadSecrets() : {};
  return { ...plain, ...secrets };
}
export function isConfigured(fullConfig) {
  return !!(fullConfig && fullConfig.plex_url && fullConfig.plex_token);
}

const TABS = [
  { key: "plex", label: "Plex" },
  { key: "integrations", label: "Integrations" },
  { key: "preferences", label: "Preferences" },
];

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
          <div class="tabs">
            ${TABS.map((t) => `<button type="button" class="tab-btn" data-tab="${t.key}">${t.label}</button>`).join("")}
          </div>
          <div class="modal-body">
            <div class="tab-panel" data-tab="plex">
              <section class="group">
                <div class="group-title">Plex Server</div>
                <div class="plex-server-card">
                  <div class="plex-server-info">
                    <span class="plex-server-dot"></span>
                    <div class="status plex-server-status"></div>
                  </div>
                  <button type="button" class="btn btn-secondary btn-reauth">Reauthenticate</button>
                </div>
              </section>

              <section class="group">
                <div class="group-title">Libraries</div>
                <button type="button" class="btn btn-secondary btn-fetch-libraries">Fetch Libraries</button>
                <div class="status fetch-status"></div>
                <div class="section-list"></div>
              </section>
            </div>

            <div class="tab-panel" data-tab="integrations">
              <section class="group">
                <div class="group-title-row">
                  <div class="group-title">Trailers</div>
                  <label class="switch">
                    <input type="checkbox" class="f-trailers-enabled" />
                    <span class="switch-track"></span>
                  </label>
                </div>
                <div class="field trailers-fields">
                  <label>YouTube Data API Key</label>
                  <input type="password" class="f-youtube-key" placeholder="Used as a fallback when Plex has no trailer" />
                </div>
              </section>

              <section class="group">
                <div class="group-title-row">
                  <div class="group-title">AI Rows</div>
                  <label class="switch">
                    <input type="checkbox" class="f-ai-enabled" />
                    <span class="switch-track"></span>
                  </label>
                </div>
                <div class="row-2col ai-fields">
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
                <div class="group-title">Subtitles</div>
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
                    <input type="text" class="f-opensubtitles-username" placeholder="Needed to download, not just search" />
                  </div>
                  <div class="field">
                    <label>Password</label>
                    <input type="password" class="f-opensubtitles-password" />
                  </div>
                </div>
                <div class="field opensubtitles-fields">
                  <label>API Key</label>
                  <input type="password" class="f-opensubtitles-key" />
                </div>
              </section>

            </div>

            <div class="tab-panel" data-tab="preferences">
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
          </div>
          <div class="status save-status"></div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary btn-cancel">Cancel</button>
            <button type="button" class="btn btn-primary btn-save">Save</button>
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
    this._el(".f-trailers-enabled").addEventListener("change", () => this._syncIntegrationToggleFields());
    this._el(".f-ai-enabled").addEventListener("change", () => this._syncIntegrationToggleFields());
    this.shadowRoot.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
    });
    /* One long vertical list rather than per-row/per-section sub-navigation - simpler,
       and good enough for a screen that isn't the primary Xbox-blocking flow the way
       sign-in is. Tab buttons are included in this same vertical list (Down/Up walks
       through them like any other item, Enter clicks one via wireLinearNav's default
       onActivate) rather than getting their own horizontal sub-nav - a hidden tab
       panel's fields are automatically excluded already, since items() filters on
       offsetParent !== null and inactive .tab-panels are display:none. Native
       Left/Right cursor movement inside text/number inputs is left alone (this only
       claims Up/Down/Enter/Escape - see focus-nav.js's orientation handling), though
       that does mean Up/Down no longer increments/decrements a number input via its
       native spinner behavior - an accepted trade-off since moving between fields has
       to win for gamepad nav to work at all. */
    wireLinearNav(
      this.shadowRoot,
      ".modal-close, .tab-btn, .btn-reauth, .btn-fetch-libraries, .section-row .s-enabled, .section-row .s-label, " +
        ".f-trailers-enabled, .f-youtube-key, .f-ai-enabled, .f-openrouter-key, .f-subtitle-provider, " +
        ".f-opensubtitles-username, .f-opensubtitles-password, .f-opensubtitles-key, " +
        ".f-ai-cadence, .f-max-genre-rows, .f-row-size, " +
        ".btn-cancel, .btn-save",
      { orientation: "vertical", onBack: () => this.close() }
    );
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

  /* Toggling Trailers/AI Rows off only hides their input fields - it doesn't clear the
     underlying secret, so flipping back on later still has the credential in place (see
     _collectSecrets below, which reads the field values directly rather than clearing
     them on toggle-off). */
  _syncIntegrationToggleFields() {
    this.shadowRoot.querySelectorAll(".trailers-fields").forEach((el) => {
      el.style.display = this._el(".f-trailers-enabled").checked ? "" : "none";
    });
    this.shadowRoot.querySelectorAll(".ai-fields").forEach((el) => {
      el.style.display = this._el(".f-ai-enabled").checked ? "" : "none";
    });
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
    this._el(".f-max-genre-rows").value = config.max_genre_rows ?? 12;
    this._el(".f-row-size").value = config.row_size ?? 20;
    this._machineId = config.machine_id || "";
    this._sections = config.sections || [];
    this._el(".f-trailers-enabled").checked = config.trailers_enabled !== false;
    this._el(".f-ai-enabled").checked = config.ai_rows_enabled !== false;
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
    this._el(".f-youtube-key").value = secrets.youtube_api_key || "";
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
    focusAfterPaint(this._el(".modal-close"));
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
      max_genre_rows: Number(this._el(".f-max-genre-rows").value) || 12,
      row_size: Number(this._el(".f-row-size").value) || 20,
      subtitle_provider: this._el(".f-subtitle-provider").value || "plex",
      trailers_enabled: this._el(".f-trailers-enabled").checked,
      ai_rows_enabled: this._el(".f-ai-enabled").checked,
    };
  }

  /* Every credential field is now shown filled with its real stored value (see open()),
     so whatever's in each one now - including blank, if the user actually cleared it -
     is taken as-is rather than falling back to the existing stored value. */
  async _collectSecrets() {
    const existing = await this._getEffectiveSecrets();
    return {
      plex_token: existing.plex_token || "",
      youtube_api_key: this._el(".f-youtube-key").value.trim(),
      openrouter_api_key: this._el(".f-openrouter-key").value.trim(),
      plex_account_token: existing.plex_account_token || "",
      opensubtitles_username: this._el(".f-opensubtitles-username").value.trim(),
      opensubtitles_password: this._el(".f-opensubtitles-password").value.trim(),
      opensubtitles_api_key: this._el(".f-opensubtitles-key").value.trim(),
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

}

if (!customElements.get("streaming-settings-modal")) {
  customElements.define("streaming-settings-modal", StreamingSettingsModal);
}
