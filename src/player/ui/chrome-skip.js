/* Bottom-center skip-intro/credits button and its marker-range helpers. Deliberately
   independent of the idle-fade control row in chrome-controls.js - see updateSkipButton
   below for why. */
import { media } from "../core/media-facade.js";
import { PLAYER_FOCUSABLE_CLASS } from "./shared.js";

/* Shared by both playback paths so the marker-range check isn't duplicated even though
   web/native render totally different skip-button UI. Assumes Plex's Marker objects use
   startTimeOffset/endTimeOffset in ms, consistent with duration/viewOffset elsewhere in
   this codebase - unverified against a real response, see this phase's open risks. */
export function activeMarkerAt(controller, timeMs) {
    const markers = controller._session?.markers || [];
    return markers.find((m) => timeMs >= (m.startTimeOffset ?? 0) && timeMs <= (m.endTimeOffset ?? 0)) || null;
}

export function skipLabelFor(marker) {
    return marker?.type === "credits" ? "Skip Credits" : "Skip Intro";
}

/* Bottom-center, separate from the top-right fading control row (matching where
   Plex/Netflix conventionally put this) - force-shown for as long as a marker is active
   rather than joining the idle-fade timer, since it's a contextual action ("this is
   available right now"), not ambient chrome. */
export function updateSkipButton(controller, marker) {
    controller._activeSkipMarker = marker;
    if (!marker) {
        if (controller._skipBtnEl) controller._skipBtnEl.style.display = "none";
        return;
    }
    if (!controller._skipBtnEl) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.classList.add(PLAYER_FOCUSABLE_CLASS);
        Object.assign(btn.style, {
            position: "fixed",
            bottom: "170px",
            right: "40px",
            zIndex: "10001",
            padding: "10px 22px",
            borderRadius: "4px",
            border: "1px solid rgba(255,255,255,0.7)",
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            fontSize: "13px",
            fontWeight: "700",
            letterSpacing: "0.03em",
            cursor: "pointer",
        });
        btn.addEventListener("click", () => {
            const el = media(controller);
            if (el && controller._activeSkipMarker) {
                el.currentTime = (controller._activeSkipMarker.endTimeOffset ?? 0) / 1000;
            }
        });
        document.body.appendChild(btn);
        controller._skipBtnEl = btn;
    }
    controller._skipBtnEl.textContent = skipLabelFor(marker);
    controller._skipBtnEl.style.display = "block";
}
