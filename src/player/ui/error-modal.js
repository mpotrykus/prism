import { wireLinearNav } from "../../core/focus-nav.js";
import { ensurePlayerStyles } from "./styles.js";

/* Surfaces a fatal playback error (web <video> "error", Android's native "error" event,
   Xbox's own "error" bridge message - see web-fallback.js/native-bridge.js/xbox-bridge.js)
   instead of the three of them silently calling controller.stop() straight away, which
   just kicked the viewer back to the app with no explanation. Deliberately NOT part of
   the player chrome torn down by _teardownMedia - stop() is only called once the viewer
   dismisses this, so it's mounted and unmounted independently at document.body level and
   survives (in fact expects) the chrome underneath it disappearing mid-display. */
export function showPlaybackErrorModal(controller, message) {
    closePlaybackErrorModal(controller);
    ensurePlayerStyles();

    const scrim = document.createElement("div");
    scrim.className = "prism-player-error-scrim";

    const panel = document.createElement("div");
    panel.className = "prism-player-error-panel";
    scrim.appendChild(panel);

    const heading = document.createElement("div");
    heading.className = "prism-player-error-heading";
    heading.textContent = "Playback Error";
    panel.appendChild(heading);

    const body = document.createElement("div");
    body.className = "prism-player-error-body";
    body.textContent = message || "Something went wrong during playback.";
    panel.appendChild(body);

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "OK";
    okBtn.classList.add("prism-player-focusable", "prism-player-error-ok");
    panel.appendChild(okBtn);

    /* Both the button and an outside click land on the same dismiss - unlike the picker/menu
       overlays elsewhere in this UI, there's nothing left to navigate back INTO once playback
       has already fatally errored, so "dismiss" and "stop" are always the same action here. */
    function dismiss() {
        closePlaybackErrorModal(controller);
        controller.stop();
    }
    okBtn.addEventListener("click", dismiss);
    scrim.addEventListener("click", (e) => {
        if (e.target === scrim) dismiss();
    });

    document.body.appendChild(scrim);
    controller._errorModalEl = scrim;
    controller._errorModalNav = wireLinearNav(document, ".prism-player-error-scrim button", {
        orientation: "vertical",
        loop: true,
        onBack: dismiss,
    });
    controller._errorModalNav.focusFirst();
}

export function closePlaybackErrorModal(controller) {
    if (controller._errorModalNav) {
        controller._errorModalNav.destroy();
        controller._errorModalNav = null;
    }
    if (controller._errorModalEl) {
        controller._errorModalEl.remove();
        controller._errorModalEl = null;
    }
}
