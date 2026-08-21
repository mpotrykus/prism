import { loadFull, isConfigured } from "./settings.js";
import { primeDecodeCapabilities, platformTag } from "./src/player/core/platform.js";
import { postAlwaysOnHdr } from "./src/player/xbox-bridge.js";
import "./input-mode.js";

(async function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("[app] SW registration failed:", err));
  }
  /* Fire-and-forget: resolves well before the user reaches a title's Play button, but must
     never block boot - see platform.js's own comment on why a failed probe is safe. */
  primeDecodeCapabilities();

  const modal = document.querySelector("streaming-settings-modal");
  const signinModal = document.querySelector("streaming-plex-signin-modal");

  /* setConfig() must run before the element is ever connected - connectedCallback
     kicks off _loadAll() immediately, which needs this._config to already exist.
     Creating detached + configuring + appending (rather than putting a static
     <plex-netflix-card> tag in index.html) mirrors how Home Assistant's own Lovelace
     always drove this same class. */
  const card = document.createElement("plex-netflix-card");
  card.addEventListener("open-settings", () => modal.open());
  modal.addEventListener("settings-saved", (e) => {
    card.refreshConfig(e.detail);
    if (platformTag() === "xbox") postAlwaysOnHdr(e.detail.xbox_hdr_always_on === true);
  });
  modal.addEventListener("request-plex-reauth", () => signinModal.open({ blocking: false }));
  /* Reopening Settings after a reauth (but not after the first-run gate, which had no
     Settings open to return to) lets the user see the freshly-discovered libraries
     without having to find the gear icon again. */
  signinModal.addEventListener("plex-connected", (e) => {
    card.refreshConfig(e.detail.config);
    if (!e.detail.wasBlocking) modal.open();
  });

  function boot(fullConfig) {
    card.setConfig(fullConfig);
    document.body.appendChild(card);
    if (!isConfigured(fullConfig)) signinModal.open({ blocking: true });
    /* Applied at every launch, not just read once and left to NativePlayerHost's own default -
       it doesn't persist this natively across app restarts on its own. Only affects in-session
       title switches (see postAlwaysOnHdr's own comment), so it's safe to send here at boot,
       well before any playback session exists. */
    if (platformTag() === "xbox") postAlwaysOnHdr(fullConfig.xbox_hdr_always_on === true);
  }

  boot(await loadFull());
})();
