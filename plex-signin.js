/* Plex sign-in, split out from <streaming-settings-modal> so it can gate the whole app
   at boot (see app.js) - blocking until a server is connected - while everything else
   configurable (libraries, trailers, AI rows, display) lives in Settings. */
import { wireLinearNav, focusAfterPaint } from "./focus-nav.js";
import { isRemoteDrivenDevice } from "./input-mode.js";
import * as StreamingPlexAuth from "./plex-auth.js";
import { loadPlain, savePlain } from "./settings.js";
import { hasSecrets, loadSecrets, saveSecrets } from "./vault.js";
import SIGNIN_MODAL_STYLE from "./src/styles/signin-modal.css?inline";

const SECTION_TYPE_MAP = { movie: 1, show: 2 };

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
          <div class="link-code" hidden></div>
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
    /* This is the app's mandatory first screen and the current hard blocker on Xbox -
       a gamepad/D-pad user has no mouse to fall back on, so this can't be an afterthought
       the way keyboard nav might be elsewhere. Selector re-queries live on every move, so
       the dynamically-added .server-choice buttons (see _renderServerPicker) are picked up
       automatically without re-wiring. */
    wireLinearNav(this.shadowRoot, ".modal-close, .btn-plex-signin, .server-choice", {
      orientation: "vertical",
      onBack: () => this.close(),
    });
  }

  open({ blocking = false } = {}) {
    this._blocking = blocking;
    this._el(".modal-close").hidden = blocking;
    this._el(".signin-status").textContent = "";
    this._el(".signin-status").className = "status signin-status";
    this._el(".server-picker").innerHTML = "";
    this._el(".link-code").hidden = true;
    this._overlay.classList.add("open");
    focusAfterPaint(this._el(".btn-plex-signin"));
  }

  close() {
    if (this._blocking) return;
    this._overlay.classList.remove("open");
  }

  isOpen() {
    return this._overlay.classList.contains("open");
  }

  /* Fire TV (Silk browser) and the Xbox WebView2 shell are remote/gamepad-only - there's no
     pointer at all, so opening a second browser tab for Plex's full sign-in form means typing
     a username/password with a D-pad, which is exactly the unintuitive flow this branches
     around. See input-mode.js's isRemoteDrivenDevice() for how that's detected - shared with
     the touch/gesture input-mode tracking, since both need the same "is there a pointer at
     all" answer. */

  /* Two branches share the same PIN (plex.tv/api/v2/pins) and the same pollPin() loop -
     only how the code gets in front of the user differs. Touch/mouse devices get the
     familiar browser-popup sign-in; remote/gamepad-only devices (see
     isRemoteDrivenDevice()) instead just display the raw code and point the user at
     plex.tv/link on a device that actually has a keyboard. The popup, when used, is opened
     synchronously here, before any await, so browsers don't treat it as an unrequested
     pop-up - its location is set once the auth URL is ready. */
  async _signInWithPlex() {
    const btn = this._el(".btn-plex-signin");
    const statusEl = this._el(".signin-status");
    const codeEl = this._el(".link-code");
    this._el(".server-picker").innerHTML = "";
    codeEl.hidden = true;
    codeEl.textContent = "";
    btn.disabled = true;
    statusEl.className = "status signin-status";

    const remote = isRemoteDrivenDevice();
    statusEl.textContent = remote ? "Requesting a sign-in code…" : "Opening Plex sign-in…";
    const authWindow = remote ? null : window.open("about:blank", "_blank");
    try {
      const pin = await StreamingPlexAuth.requestPin({ strong: !remote });
      if (remote) {
        codeEl.textContent = pin.code;
        codeEl.hidden = false;
        statusEl.textContent = "On your phone or computer, go to plex.tv/link and enter this code.";
      } else {
        const authUrl = StreamingPlexAuth.buildAuthUrl(pin);
        if (authWindow) {
          authWindow.location.href = authUrl;
          statusEl.textContent = "Waiting for you to approve access in the Plex tab that just opened…";
        } else {
          statusEl.innerHTML = `Pop-up blocked — <a href="${authUrl}" target="_blank" rel="noopener">click here to sign in</a>, then come back.`;
        }
      }
      const authToken = await StreamingPlexAuth.pollPin(pin.id);
      codeEl.hidden = true;
      this._plexAccountToken = authToken;
      statusEl.textContent = "Finding your servers…";
      statusEl.className = "status signin-status";
      const discovered = await StreamingPlexAuth.discoverServers(authToken);
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
    const uri = await StreamingPlexAuth.resolveBestConnection(server);
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

    const plain = { ...loadPlain(), plex_url: uri, machine_id: machineId, sections };
    const existingSecrets = hasSecrets() ? await loadSecrets() : {};
    const secrets = { ...existingSecrets, plex_token: server.accessToken, plex_account_token: this._plexAccountToken || existingSecrets.plex_account_token || "" };
    savePlain(plain);
    await saveSecrets(secrets);

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
