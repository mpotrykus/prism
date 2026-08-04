/* Plex sign-in, split out from <streaming-settings-modal> so it can gate the whole app
   at boot (see app.js) - blocking until a server is connected - while everything else
   configurable (libraries, trailers, AI rows, kids mode, display) lives in Settings. */
const SECTION_TYPE_MAP = { movie: 1, show: 2 };

const SIGNIN_MODAL_STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: "Roboto", sans-serif; }
  .overlay {
    position: fixed; inset: 0; z-index: 1500;
    background: rgba(0,0,0,0.86);
    backdrop-filter: blur(6px);
    display: none;
    align-items: center; justify-content: center;
    padding: 24px;
  }
  .overlay.open { display: flex; }
  .modal {
    width: 420px; max-width: 100%;
    background: #161619;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    color: #fff;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
    padding: 30px 26px 26px;
    text-align: center;
    position: relative;
  }
  .modal-close {
    position: absolute; top: 12px; right: 12px;
    border: none; background: transparent; color: rgba(255,255,255,0.6);
    font-size: 20px; cursor: pointer; line-height: 1; padding: 4px;
  }
  .modal-close:hover { color: #fff; }
  .modal-close[hidden] { display: none; }
  h2 { font-size: 18px; font-weight: 700; margin: 0 0 8px; }
  .subtitle { font-size: 13px; color: rgba(255,255,255,0.55); margin: 0 0 20px; }
  .btn {
    border: none; border-radius: 8px; padding: 11px 20px; font-size: 14px; font-weight: 700;
    cursor: pointer; white-space: nowrap;
  }
  .btn-primary { background: #e5a00d; color: #161619; }
  .btn-primary:hover { background: #f0ad1a; }
  .btn-secondary { background: rgba(255,255,255,0.1); color: #fff; }
  .btn-secondary:hover { background: rgba(255,255,255,0.18); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .status { font-size: 12px; font-weight: 600; margin-top: 14px; min-height: 15px; }
  .status.ok { color: #4caf7d; }
  .status.err { color: #ff6b6b; }
  .server-picker { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
  .server-choice { display: block; width: 100%; }
`;

class StreamingPlexSigninModal extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${SIGNIN_MODAL_STYLE}</style>
      <div class="overlay">
        <div class="modal">
          <button type="button" class="modal-close" aria-label="Close" hidden>✕</button>
          <h2>Sign in to Plex</h2>
          <div class="subtitle">Connect your Plex account to load your library.</div>
          <button type="button" class="btn btn-primary btn-plex-signin">Sign in with Plex</button>
          <div class="status signin-status"></div>
          <div class="server-picker"></div>
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
    this._overlay.addEventListener("click", (e) => {
      if (e.target === this._overlay) this.close();
    });
    this._el(".btn-plex-signin").addEventListener("click", () => this._signInWithPlex());
  }

  open({ blocking = false } = {}) {
    this._blocking = blocking;
    this._el(".modal-close").hidden = blocking;
    this._el(".signin-status").textContent = "";
    this._el(".signin-status").className = "status signin-status";
    this._el(".server-picker").innerHTML = "";
    this._overlay.classList.add("open");
  }

  close() {
    if (this._blocking) return;
    this._overlay.classList.remove("open");
  }

  /* Opens the blank tab synchronously, before any await, so browsers don't treat it as
     an unrequested pop-up - its location is set once the pin/auth URL is ready. */
  async _signInWithPlex() {
    const btn = this._el(".btn-plex-signin");
    const statusEl = this._el(".signin-status");
    this._el(".server-picker").innerHTML = "";
    btn.disabled = true;
    statusEl.textContent = "Opening Plex sign-in…";
    statusEl.className = "status signin-status";
    const authWindow = window.open("about:blank", "_blank");
    try {
      const pin = await window.StreamingPlexAuth.requestPin();
      const authUrl = window.StreamingPlexAuth.buildAuthUrl(pin);
      if (authWindow) {
        authWindow.location.href = authUrl;
        statusEl.textContent = "Waiting for you to approve access in the Plex tab that just opened…";
      } else {
        statusEl.innerHTML = `Pop-up blocked — <a href="${authUrl}" target="_blank" rel="noopener">click here to sign in</a>, then come back.`;
      }
      const authToken = await window.StreamingPlexAuth.pollPin(pin.id);
      this._plexAccountToken = authToken;
      statusEl.textContent = "Finding your servers…";
      statusEl.className = "status signin-status";
      const discovered = await window.StreamingPlexAuth.discoverServers(authToken);
      if (!discovered.length) {
        statusEl.textContent = "Signed in, but no Plex servers were found on this account.";
        statusEl.className = "status signin-status err";
        return;
      }
      /* Prefer servers this account owns - shared servers (someone else's, granted to
         this account) only come into play when there's no owned server at all. */
      const owned = discovered.filter((s) => s.owned);
      const servers = owned.length ? owned : discovered;
      if (servers.length === 1) {
        await this._chooseServer(servers[0]);
      } else {
        statusEl.textContent = "Choose a server:";
        this._renderServerPicker(servers);
      }
    } catch (e) {
      if (authWindow && !authWindow.closed) authWindow.close();
      statusEl.textContent = `Sign-in failed: ${e.message}`;
      statusEl.className = "status signin-status err";
    } finally {
      btn.disabled = false;
    }
  }

  _renderServerPicker(servers) {
    const pickerEl = this._el(".server-picker");
    pickerEl.innerHTML = servers
      .map(
        (s, i) => `<button type="button" class="btn btn-secondary server-choice" data-index="${i}">${this._escape(s.name)}${s.owned ? "" : " (shared)"}</button>`
      )
      .join("");
    pickerEl.querySelectorAll(".server-choice").forEach((choiceBtn) => {
      choiceBtn.addEventListener("click", () => this._chooseServer(servers[Number(choiceBtn.dataset.index)]));
    });
  }

  async _chooseServer(server) {
    const statusEl = this._el(".signin-status");
    this._el(".server-picker").innerHTML = "";
    statusEl.textContent = `Connecting to ${server.name}…`;
    statusEl.className = "status signin-status";
    const uri = await window.StreamingPlexAuth.resolveBestConnection(server);
    if (!uri) {
      statusEl.textContent = `Couldn't reach ${server.name} - it may be offline or unreachable from this network.`;
      statusEl.className = "status signin-status err";
      return;
    }
    statusEl.textContent = `Connected to ${server.name} - fetching libraries…`;
    let machineId = "";
    try {
      const identity = await this._plexGet(uri, server.accessToken, "/identity");
      machineId = identity?.MediaContainer?.machineIdentifier || "";
    } catch (e) {
      /* non-fatal - machine_id is only needed for Android deep links */
    }
    let sections;
    try {
      const data = await this._plexGet(uri, server.accessToken, "/library/sections");
      const dirs = data?.MediaContainer?.Directory || [];
      sections = dirs.filter((d) => SECTION_TYPE_MAP[d.type]).map((d) => ({ key: Number(d.key), type: SECTION_TYPE_MAP[d.type], label: d.title, enabled: true }));
    } catch (e) {
      statusEl.textContent = `Connected, but couldn't fetch libraries: ${e.message}`;
      statusEl.className = "status signin-status err";
      return;
    }

    const plain = { ...window.StreamingSettings.loadPlain(), plex_url: uri, machine_id: machineId, sections };
    const existingSecrets = window.StreamingVault.hasSecrets() ? await window.StreamingVault.loadSecrets() : {};
    const secrets = { ...existingSecrets, plex_token: server.accessToken, plex_account_token: this._plexAccountToken || existingSecrets.plex_account_token || "" };
    window.StreamingSettings.savePlain(plain);
    await window.StreamingVault.saveSecrets(secrets);

    statusEl.textContent = `Connected to ${server.name}.`;
    statusEl.className = "status signin-status ok";
    const wasBlocking = this._blocking;
    this._blocking = false;
    this.dispatchEvent(
      new CustomEvent("plex-connected", { bubbles: true, composed: true, detail: { config: { ...plain, ...secrets }, wasBlocking } })
    );
    this.close();
  }

  async _plexGet(url, token, path) {
    const u = new URL(url + path);
    u.searchParams.set("X-Plex-Token", token);
    const res = await fetch(u, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  _escape(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
}

if (!customElements.get("streaming-plex-signin-modal")) {
  customElements.define("streaming-plex-signin-modal", StreamingPlexSigninModal);
}
