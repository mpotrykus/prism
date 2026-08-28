import { wireLinearNav } from "../../../focus-nav.js";
import { PLAYER_FOCUSABLE_CLASS, ensurePlayerFocusStyle } from "./shared.js";

/* Surfaces a fatal playback error (web <video> "error", Android's native "error" event,
   Xbox's own "error" bridge message - see web-fallback.js/native-bridge.js/xbox-bridge.js)
   instead of the three of them silently calling controller.stop() straight away, which
   just kicked the viewer back to the app with no explanation. Deliberately NOT part of
   the player chrome torn down by _teardownMedia - stop() is only called once the viewer
   dismisses this, so it's mounted and unmounted independently at document.body level and
   survives (in fact expects) the chrome underneath it disappearing mid-display. */
const ERROR_MODAL_CLASS = "streaming-player-error-modal";

export function showPlaybackErrorModal(controller, message) {
    closePlaybackErrorModal(controller);
    ensurePlayerFocusStyle();

    const scrim = document.createElement("div");
    scrim.classList.add(ERROR_MODAL_CLASS);
    Object.assign(scrim.style, {
        position: "fixed",
        inset: "0",
        zIndex: "10010",
        background: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        width: "min(420px, 90vw)",
        background: "#181818",
        borderRadius: "12px",
        padding: "28px 24px 20px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        fontFamily: '"Roboto", sans-serif',
        color: "#fff",
        textAlign: "center",
        boxSizing: "border-box",
    });
    scrim.appendChild(panel);

    const heading = document.createElement("div");
    heading.textContent = "Playback Error";
    Object.assign(heading.style, { fontSize: "18px", fontWeight: "700", marginBottom: "12px" });
    panel.appendChild(heading);

    const body = document.createElement("div");
    body.textContent = message || "Something went wrong during playback.";
    Object.assign(body.style, {
        fontSize: "14px",
        color: "rgba(255,255,255,0.8)",
        lineHeight: "1.5",
        marginBottom: "22px",
    });
    panel.appendChild(body);

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "OK";
    okBtn.classList.add(PLAYER_FOCUSABLE_CLASS);
    Object.assign(okBtn.style, {
        minWidth: "120px",
        padding: "10px 24px",
        borderRadius: "6px",
        border: "none",
        background: "#e5a00d",
        color: "#000",
        fontSize: "14px",
        fontWeight: "700",
        cursor: "pointer",
    });
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
    controller._errorModalNav = wireLinearNav(document, `.${ERROR_MODAL_CLASS} button`, {
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
