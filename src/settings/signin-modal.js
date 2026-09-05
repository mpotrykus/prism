/* Plex sign-in, split out from <streaming-settings-modal> so it can gate the whole app
   at boot (see app.js) - blocking until a server is connected - while everything else
   configurable (libraries, trailers, AI rows, display) lives in Settings. */
import { wireLinearNav, focusAfterPaint } from "../core/focus-nav.js";
import { PrismModalElement } from "./modal-element.js";
import { escapeHtml } from "../core/html.js";
import { APP_EVENT } from "../constants.js";
import * as StreamingPlexAuth from "../plex/auth.js";
import { plexGetJson } from "../plex/auth.js";
import { loadPlain, savePlain } from "../core/config.js";
import { hasSecrets, loadSecrets, saveSecrets } from "../core/vault.js";
import { platformTag, isXboxDevice } from "../player/core/platform.js";
import qrcode from "qrcode-generator";
import SIGNIN_MODAL_STYLE from "../styles/signin-modal.css?inline";

/* Flip to true when actively debugging sign-in on a real device - shows the raw
   UA/pointer/platform dump and a "Reset client ID" escape hatch for Plex's per-client PIN
   rate limit (see debug-reset-client's own comment). Both are gamepad-reachable since
   there's no keyboard/mouse on Xbox to open DevTools by hand. Leave false otherwise; these
   expose raw client info that has no reason to be on screen for a normal user. */
const DEBUG_SIGNIN = false;

/* Plex's PIN rate limit (HTTP 429) is transient - auto-retrying after its own Retry-After
   delay (or a conservative default when it doesn't send one) recovers on its own instead of
   leaving the user stuck on a dead-end error they'd have to notice and manually retry.
   Capped rather than unbounded, in case the limit is actually a long-window account/IP-wide
   block a short retry loop can't outlast - at that point surfacing the real error (which
   still leaves the button available to try again by hand) is the honest answer, not an
   endless silent loop. */
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRY_SECONDS = 30;

class StreamingPlexSigninModal extends PrismModalElement {
    connectedCallback() {
        if (this._built) return;
        this._built = true;
        this._signInGeneration = 0;
        this._buildShell(SIGNIN_MODAL_STYLE, `
      <div class="overlay">
        <div class="modal">
          <button type="button" class="modal-close" aria-label="Close" hidden>✕</button>
          <img class="signin-logo" src="./assets/prism-logo.svg" alt="Prism" />
          <div class="debug-ua" hidden></div>
          <a href="#" class="debug-reset-client" hidden>Reset client ID (dev)</a>

          <div class="connecting-screen">
            <div class="connecting-icon">
              <div class="spinner"></div>
              <div class="checkmark" hidden>✓</div>
              <div class="error-icon" hidden>✕</div>
            </div>
            <div class="status connecting-status"></div>
            <button type="button" class="signin-link-btn retry-btn" hidden>Try again</button>
            <div class="server-picker"></div>
          </div>

          <div class="signin-screen" hidden>
            <div class="signin-columns" hidden>
              <div class="signin-col">
                <div class="col-label">Visit this link in a browser</div>
                <a class="pin-link" href="https://plex.tv/link" target="_blank" rel="noopener">plex.tv/link</a>
                <div class="col-label col-label-code">enter this code</div>
                <div class="pin-code"></div>
              </div>
              <div class="signin-divider"><span>OR</span></div>
              <div class="signin-col">
                <div class="col-label">Use the camera on your mobile device to scan the QR code</div>
                <div class="qr-code"></div>
              </div>
            </div>
            <div class="subtitle">
              <span class="subtitle-standalone">Connect your Plex account to load your library.</span>
              <button type="button" class="signin-link-btn btn-plex-signin">Sign in with Plex</button>
              <span class="subtitle-suffix">to load your library.</span>
            </div>
          </div>
        </div>
      </div>
    `);
        this._wire();
    }

    _wire() {
        this._el(".btn-plex-signin").addEventListener("click", () => this._signInWithPlex());
        /* Unlike the sign-in button, this always means "start completely over" - there's no
           "already have a link, just reopen it" shortcut here, since retry is only ever reached
           after something failed. */
        this._el(".retry-btn").addEventListener("click", () => {
            this._linkUrl = null;
            this._signInWithPlex();
        });
        // Plex's own PIN-status rate limit (HTTP 429) is keyed off X-Plex-Client-Identifier,
        // which auth.js persists forever in localStorage ("prism.plexClientId") - once tripped
        // by repeated testing under the same identifier, no code fix here can clear it, only
        // time or a fresh identifier can. Element itself stays hidden unless DEBUG_SIGNIN is on
        // (see open()); wiring the listener regardless is harmless since a hidden element can't
        // be clicked.
        this._el(".debug-reset-client").addEventListener("click", (e) => {
            e.preventDefault();
            localStorage.removeItem("prism.plexClientId");
            location.reload();
        });
        /* This is the app's mandatory first screen and the current hard blocker on Xbox -
           a gamepad/D-pad user has no mouse to fall back on, so this can't be an afterthought
           the way keyboard nav might be elsewhere. Selector re-queries live on every move, so
           the dynamically-added .server-choice buttons (see _renderServerPicker) are picked up
           automatically without re-wiring - same for .btn-plex-signin/.retry-btn/.pin-link,
           which come and go as _showConnecting()/_showSigninScreen() toggle which screen (and
           which of the connecting-screen's icon/retry-button states) is visible; only one of
           the two screens' interactive elements has a real offsetParent at any given time, so
           there's no ambiguity about which one this lands on. */
        wireLinearNav(this.shadowRoot, ".modal-close, .debug-reset-client, .btn-plex-signin, .pin-link, .retry-btn, .server-choice", {
            orientation: "vertical",
            onBack: () => this.close(),
        });
    }

    open({ blocking = false } = {}) {
        this._blocking = blocking;
        this._el(".modal-close").hidden = blocking;
        this._el(".server-picker").innerHTML = "";
        this._el(".signin-columns").hidden = true;
        this._el(".qr-code").innerHTML = "";
        this._el(".pin-code").textContent = "";
        this._linkUrl = null;
        if (DEBUG_SIGNIN) {
            // On-screen UA/pointer/platform dump, readable directly off a console/TV with no
            // remote DevTools needed - see DEBUG_SIGNIN's own comment.
            const pointer = (q) => (window.matchMedia && window.matchMedia(`(pointer: ${q})`).matches);
            this._el(".debug-ua").hidden = false;
            this._el(".debug-ua").textContent =
                `UA: ${navigator.userAgent} | pointer none/coarse/fine: ${pointer("none")}/${pointer("coarse")}/${pointer("fine")}` +
                ` | platformTag: ${platformTag()} | isXboxDevice: ${isXboxDevice()}`;
            this._el(".debug-reset-client").hidden = false;
        }
        this._overlay.classList.add("open");
        this._signInWithPlex();
    }

    /* The modal has exactly two mutually-exclusive screens - this one (logo + a big
       spinner/checkmark/error icon, matching what the user actually needs while nothing is
       interactive yet) and .signin-screen (the button/code/QR, once there's something to act
       on). Switching screens is always paired with resetting the connecting-screen's own
       sub-state (icon, retry button) so a later _showConnecting() call never inherits a
       previous call's leftover error/retry/checkmark state. */
    _showConnecting(text, { icon = "spinner", ok = false, err = false } = {}) {
        this._el(".signin-screen").hidden = true;
        this._el(".connecting-screen").hidden = false;
        this._el(".spinner").hidden = icon !== "spinner";
        this._el(".checkmark").hidden = icon !== "success";
        this._el(".error-icon").hidden = icon !== "error";
        this._el(".retry-btn").hidden = true;
        const statusEl = this._el(".connecting-status");
        statusEl.textContent = text;
        statusEl.className = `status connecting-status${ok ? " ok" : ""}${err ? " err" : ""}`;
    }

    /* Every failure path in _signInWithPlex()/_chooseServer() lands here rather than leaving
       the sign-in button on screen - it's simpler and more honest than trying to decide, per
       failure site, whether "click Sign in with Plex again" would actually still make sense
       (sometimes the pin/link is already spent, sometimes the account's already authenticated
       and only server discovery failed) - "Try again" always means "start completely over",
       which is always correct even when it's not the minimal possible retry. */
    _showConnectingError(text) {
        this._showConnecting(text, { icon: "error", err: true });
        const retryBtn = this._el(".retry-btn");
        retryBtn.hidden = false;
        focusAfterPaint(retryBtn);
    }

    /* Deliberately awaited by the caller before it dispatches PLEX_CONNECTED/closes - a pure
       "success + immediately gone" would mean the checkmark this was built for is never
       actually seen. Deliberately just "Connected", not the full server/section/count detail
       the original message had - the checkmark already says "it worked", the text only needs
       to confirm what, not the specifics. */
    async _showConnectingSuccess() {
        this._showConnecting("Connected", { icon: "success", ok: true });
        await this._delay(1200);
    }

    _showSigninScreen() {
        this._el(".connecting-screen").hidden = true;
        this._el(".signin-screen").hidden = false;
        focusAfterPaint(this._el(".btn-plex-signin"));
    }

    /* Overridden because this modal gates the whole app at boot: while blocking, there is
       nothing to return to, so neither the "✕" nor a backdrop click may dismiss it. */
    close() {
        if (this._blocking) return;
        this._signInGeneration++;
        this._pollAbort?.abort();
        super.close();
    }

    /* Detecting "is this a remote/gamepad-only device" (Xbox, Fire TV) to decide how sign-in
       is presented used to gate a whole separate code path - fragile in a different way than
       first suspected. Confirmed on real Xbox hardware: the WebView2 UA is a plain desktop
       Chrome/Edge string with no "Xbox" token at all ("Mozilla/5.0 (Windows NT 10.0; Win64;
       x64) ... Edg/150.0.0.0"), so the UA check never matched - but pointer:none *did* report
       true there, so that part of isRemoteDrivenDevice() would actually have classified it
       correctly. Rather than keep patching a heuristic that's already proven partly wrong on
       the one console it exists for, there is now exactly one flow regardless of device: as
       soon as the modal opens, request one pin and show the button, the QR code, and the
       human-typeable code all at once, unconditionally - matching how Plex's own native apps
       present this screen. A mouse user can click the button; anyone else can scan the code,
       type it at plex.tv/link, or read the code to someone else - no per-platform guessing. */
    async _signInWithPlex() {
        /* Once the link URL is already known (the common case - it's fetched as soon as the
           modal opens), clicking the button just opens it in a new tab. That's still a real,
           synchronous user gesture, so it isn't treated as an unrequested pop-up.

           Deliberately checked *before* bumping the generation counter below: this branch
           doesn't start a new attempt, it just opens a tab alongside the poll loop that's
           already running from the original attempt - bumping the counter here invalidated
           that same in-flight loop's own eventual success (`if (gen !== this._signInGeneration)
           return;`, further down and inside _pollPinWithRetry, would then see a stale gen and
           silently drop it). Confirmed the hard way: approving via the QR worked (nothing else
           touched the counter), but approving after clicking the button - which calls this
           function a second time on the same still-running attempt - did not, because that
           second call's own generation bump orphaned the first call's poll. */
        if (this._linkUrl) {
            window.open(this._linkUrl, "_blank", "noopener");
            return;
        }

        const gen = ++this._signInGeneration;
        this._el(".server-picker").innerHTML = "";

        /* Aborts any still-running pollPin loop from a previous attempt (e.g. the modal was
           closed and reopened, or open() ran again, within the same page) - otherwise that loop
           has no reason to stop on its own and keeps hitting plex.tv/api/v2/pins/<id> every
           1.5s for up to its full 5-minute timeout. Confirmed the hard way: repeated
           open()/close() cycles during dev iteration piled up enough concurrent polling loops
           to trip Plex's own rate limit (HTTP 429) on that endpoint. */
        this._pollAbort?.abort();
        const pollAbort = new AbortController();
        this._pollAbort = pollAbort;

        this._showConnecting("Preparing sign-in…");
        try {
            const pin = await this._requestPinWithRetry(gen, pollAbort.signal);
            if (gen !== this._signInGeneration) return;
            this._linkUrl = StreamingPlexAuth.buildLinkUrl(pin);
            this._renderColumns(this._linkUrl, pin.code);
            this._el(".signin-columns").hidden = false;
            this._showSigninScreen();
            const authToken = await this._pollPinWithRetry(pin.id, gen, pollAbort.signal);
            if (gen !== this._signInGeneration) return;
            this._plexAccountToken = authToken;
            this._showConnecting("Finding your servers…");
            const discovered = await StreamingPlexAuth.discoverServers(authToken);
            if (!discovered.length) {
                this._showConnectingError("Signed in, but no Plex servers were found on this account.");
                return;
            }
            /* Prefer servers this account owns - shared servers (someone else's, granted to
               this account) only come into play when there's no owned server at all. */
            const owned = discovered.filter((s) => s.owned);
            const servers = owned.length ? owned : discovered;
            if (servers.length === 1) {
                await this._chooseServer(servers[0]);
            } else {
                this._showConnecting("Choose a server:", { icon: "none" });
                this._renderServerPicker(servers);
            }
        } catch (e) {
            if (gen !== this._signInGeneration) return;
            this._showConnectingError(`Sign-in failed: ${e.message}`);
        }
    }

    /* Shared by _requestPinWithRetry/_pollPinWithRetry below - a cancellable sleep tied to the
       same AbortSignal as the actual fetches, so closing the modal (or a new attempt aborting
       this one) interrupts a pending backoff wait immediately instead of it running out
       pointlessly in the background. */
    _delay(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new DOMException("Sign-in cancelled", "AbortError"));
            const t = setTimeout(resolve, ms);
            signal?.addEventListener("abort", () => {
                clearTimeout(t);
                reject(new DOMException("Sign-in cancelled", "AbortError"));
            });
        });
    }

    /* No pin/QR/code exists on screen yet at this stage, so a 429 here has nothing to
       preserve - just wait out Plex's own Retry-After (or a conservative default) and try
       again, up to MAX_RATE_LIMIT_RETRIES. Deliberately silent: nothing about what the user
       sees or can do actually changes while this retries in the background (there's no
       button/code/QR on screen yet either way), so surfacing a rate-limit error here would be
       alarming noise about an internal detail rather than something the user needs to act on -
       the outer catch still shows a real error if every retry is exhausted. */
    async _requestPinWithRetry(gen, signal) {
        for (let attempt = 1;; attempt++) {
            try {
                return await StreamingPlexAuth.requestPin();
            } catch (e) {
                const isRateLimited = e instanceof StreamingPlexAuth.PlexApiError && e.status === 429;
                if (!isRateLimited || attempt > MAX_RATE_LIMIT_RETRIES) throw e;
                await this._delay((e.retryAfter || DEFAULT_RETRY_SECONDS) * 1000, signal);
                if (gen !== this._signInGeneration) throw new DOMException("Sign-in cancelled", "AbortError");
            }
        }
    }

    /* A 429 here happens *after* a real pin/QR/code is already on screen - unlike the request
       stage, there is something to lose. Retries the exact same pin.id rather than starting
       over with a fresh pin (a fresh one would just be one more creation call feeding the same
       rate limit, and would throw away a code the user may have already scanned or typed), and
       deliberately never touches .signin-columns or the status text - the pin is still exactly
       as valid as before, and the user's own path forward (scan the code, type it, click the
       button) hasn't changed at all; only *our* background status check got rate-limited. */
    async _pollPinWithRetry(pinId, gen, signal) {
        for (let attempt = 1;; attempt++) {
            try {
                return await StreamingPlexAuth.pollPin(pinId, { signal });
            } catch (e) {
                if (e.name === "AbortError") throw e;
                const isRateLimited = e instanceof StreamingPlexAuth.PlexApiError && e.status === 429;
                if (!isRateLimited || attempt > MAX_RATE_LIMIT_RETRIES) throw e;
                await this._delay((e.retryAfter || DEFAULT_RETRY_SECONDS) * 1000, signal);
                if (gen !== this._signInGeneration) throw new DOMException("Sign-in cancelled", "AbortError");
            }
        }
    }

    _renderColumns(linkUrl, pinCode) {
        const qr = qrcode(0, "M");
        qr.addData(linkUrl);
        qr.make();
        /* createSvgTag has no color option - it always emits a white background rect and black
           module squares - so the dark-grey/white inversion is done here as a string swap. */
        const svg = qr
            .createSvgTag({ cellSize: 4, margin: 2 })
            .replace('fill="white"', 'fill="none"')
            .replace('fill="black"', 'fill="white"');
        this._el(".qr-code").innerHTML = svg;
        this._el(".pin-code").textContent = pinCode;
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
        focusAfterPaint(pickerEl.querySelector(".server-choice"));
    }

    async _chooseServer(server) {
        this._el(".server-picker").innerHTML = "";
        this._showConnecting(`Connecting to ${server.name}…`);
        const uri = await StreamingPlexAuth.resolveBestConnection(server);
        if (!uri) {
            this._showConnectingError(`Couldn't reach ${server.name} - it may be offline or unreachable from this network.`);
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
        this._showConnecting(`Connected to ${server.name} - discovering your libraries…`);
        let servers, sections;
        try {
            ({ servers, sections } = await StreamingPlexAuth.discoverLibraries(this._plexAccountToken));
        } catch (e) {
            this._showConnectingError(`Connected, but couldn't discover libraries: ${e.message}`);
            return;
        }
        if (!sections.length) {
            this._showConnectingError(`Connected to ${server.name}, but no movie/show libraries were found.`);
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

        await this._showConnectingSuccess();
        const wasBlocking = this._blocking;
        this._blocking = false;
        this.dispatchEvent(
            new CustomEvent(APP_EVENT.PLEX_CONNECTED, { bubbles: true, composed: true, detail: { config: {...plain, ...secrets }, wasBlocking } })
        );
        this.close();
    }

}

if (!customElements.get("streaming-plex-signin-modal")) {
    customElements.define("streaming-plex-signin-modal", StreamingPlexSigninModal);
}