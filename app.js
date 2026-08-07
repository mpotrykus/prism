import { loadFull, isConfigured } from "./settings.js";
import "./input-mode.js";

(async function () {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("[app] SW registration failed:", err));
  }

  const modal = document.querySelector("streaming-settings-modal");
  const signinModal = document.querySelector("streaming-plex-signin-modal");

  /* setConfig() must run before the element is ever connected - connectedCallback
     kicks off _loadAll() immediately, which needs this._config to already exist.
     Creating detached + configuring + appending (rather than putting a static
     <plex-netflix-card> tag in index.html) mirrors how Home Assistant's own Lovelace
     always drove this same class. */
  const card = document.createElement("plex-netflix-card");
  card.addEventListener("open-settings", () => modal.open());
  modal.addEventListener("settings-saved", (e) => card.refreshConfig(e.detail));
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
  }

  boot(await loadFull());
})();
