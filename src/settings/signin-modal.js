/* Plex sign-in, split out from <streaming-settings-modal> so it can gate the whole app
   at boot (see app.js) - blocking until a server is connected - while everything else
   configurable (libraries, trailers, AI rows, display) lives in Settings. */
import { wireLinearNav, focusAfterPaint } from "../core/focus-nav.js";
import { PrismModalElement } from "./modal-element.js";
import { escapeHtml } from "../core/html.js";
import { isRemoteDrivenDevice } from "../core/input-mode.js";
import { APP_EVENT } from "../constants.js";
import * as StreamingPlexAuth from "../plex/auth.js";
import { plexGetJson } from "../plex/auth.js";
import { loadPlain, savePlain } from "../core/config.js";
import { hasSecrets, loadSecrets, saveSecrets } from "../core/vault.js";
import SIGNIN_MODAL_STYLE from "../styles/signin-modal.css?inline";

class StreamingPlexSigninModal extends PrismModalElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._buildShell(SIGNIN_MODAL_STYLE, `
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
    `);
    this._wire();
  }

  _wire() {
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

  /* Overridden because this modal gates the whole app at boot: while blocking, there is
     nothing to return to, so neither the "✕" nor a backdrop click may dismiss it. */
  close() {
    if (this._blocking) return;
    super.close();
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
      /* btn.disabled = true above blurred the button the instant it ran, since it held
         real D-pad focus from being "activated" - browsers unfocus a focused element the
         moment it's disabled. On the success path something else takes over the nav list
         (a server picker, or this modal closing), but on failure nothing else moves focus,
         so without this the modal is left with no focused element and every D-pad command
         (including Back, on a blocking modal with no close button) silently does nothing -
         same bug/fix as chrome-subtitles.js's applySubtitleResult. */
      focusAfterPaint(btn);
    }
  }

  _renderServerPicker(servers) {
    const pickerEl = this._el(".server-picker");
    pickerEl.innerHTML = servers
      .map(
        (s, i) => `<button type="button" class="btn btn-secondary server-choice" data-index="${i}">${escapeHtml(s.name)}${s.owned ? "" : " (shared)"}</button>`
      )
      .join("");
    pickerEl.querySelectorAll(".server-choice").forEach((choiceBtn) => {
      choiceBtn.addEventListener("click", () => this._chooseServer(servers[Number(choiceBtn.dataset.index)]));
    });
    /* innerHTML= above just destroyed whatever the viewer had focus on (the sign-in button,
       still disabled at this point in the flow) to build these buttons fresh - same
       destroyed-focus gap as the disabled-button case above, left alone this would strand
       the D-pad on a modal with no close button. */
    focusAfterPaint(pickerEl.querySelector(".server-choice"));
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
    let machineId = "";
    try {
      const identity = await plexGetJson(uri, server.accessToken, "/identity");
      machineId = identity?.MediaContainer?.machineIdentifier || "";
    } catch (e) {
      /* non-fatal - machine_id is only needed for Android deep links */
    }

    /* Discover every server on the account (owned + shared), not just the one just
       picked - a fresh sign-in should land with everything already browsable, same
       discovery Settings' "refresh servers" runs later (see plex/auth.js's
       discoverLibraries). The picked server only decides the legacy plex_url/
       machine_id/plex_token fields below (still needed for Android deep links and
       settings.isConfigured()'s reachability check). */
    statusEl.textContent = `Connected to ${server.name} - discovering your libraries…`;
    let servers, sections, unreachableCount;
    try {
      ({ servers, sections, unreachableCount } = await StreamingPlexAuth.discoverLibraries(this._plexAccountToken));
    } catch (e) {
      statusEl.textContent = `Connected, but couldn't discover libraries: ${e.message}`;
      statusEl.className = "status signin-status err";
      return;
    }
    if (!sections.length) {
      statusEl.textContent = `Connected to ${server.name}, but no movie/show libraries were found.`;
      statusEl.className = "status signin-status err";
      return;
    }

    const plain = {
      ...loadPlain(),
      plex_url: uri,
      machine_id: machineId,
      servers: servers.map(({ token, ...rest }) => rest),
      sections,
    };
    const existingSecrets = hasSecrets() ? await loadSecrets() : {};
    const secrets = {
      ...existingSecrets,
      plex_token: server.accessToken,
      plex_account_token: this._plexAccountToken || existingSecrets.plex_account_token || "",
      server_tokens: Object.fromEntries(servers.map((sv) => [sv.id, sv.token])),
    };
    savePlain(plain);
    await saveSecrets(secrets);

    const unreachableSuffix = unreachableCount ? ` (${unreachableCount} other server(s) were unreachable and skipped)` : "";
    statusEl.textContent = `Connected to ${server.name} - found ${sections.length} library section(s) across ${servers.length} server(s)${unreachableSuffix}.`;
    statusEl.className = "status signin-status ok";
    const wasBlocking = this._blocking;
    this._blocking = false;
    this.dispatchEvent(
      new CustomEvent(APP_EVENT.PLEX_CONNECTED, { bubbles: true, composed: true, detail: { config: { ...plain, ...secrets }, wasBlocking } })
    );
    this.close();
  }

}

if (!customElements.get("streaming-plex-signin-modal")) {
  customElements.define("streaming-plex-signin-modal", StreamingPlexSigninModal);
}
