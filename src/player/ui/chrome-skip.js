/* Bottom-center skip-intro/credits button and its marker-range helpers. Joins the
   idle-fade control row in chrome-controls.js (registerControlButton) rather than
   maintaining its own independent visibility state - see ensureSkipButtonEl/
   showSkipButton below for how the two directions of that coupling actually work. */
import { media } from "../core/media-facade.js";
import { PLAYER_FOCUSABLE_CLASS } from "./shared.js";
import { registerControlButton, showControls } from "./chrome-controls.js";

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

/* Gates chrome-menu.js's "Auto-Skip Intro & Credits" toggle - deliberately requires
   Auto-Play too (see that row's disabled state), not just its own flag, since an
   auto-skipped credits marker only makes sense as part of "keep watching automatically". */
export function shouldAutoSkip(controller) {
    return !!(controller._autoPlayEnabled && controller._autoSkipIntroCreditsEnabled);
}

/* How long the "Playing next in…" warning counts down for once auto-skipped credits
   become active - independent of how long the credits marker itself actually runs
   (Samurai Champloo's tagged "Ending" chapter is ~105s; a Netflix-style up-next warning
   is a short, fixed heads-up regardless of how much runtime is technically left). See
   upNextSkipAtMs below for how a credits window shorter than this gets reconciled. */
const UP_NEXT_COUNTDOWN_MS = 10000;

/* The real position credits playback jumps to once the countdown reaches zero - the
   marker's own endTimeOffset (same target a manual click on this same button - see
   ensureSkipButtonEl's click handler - and intro auto-skip both already use), so "skip"
   still means "skip the rest of the credits", not "stop counting down where the
   countdown happened to land". Clamped to the marker's own end for the rare case a
   credits window is shorter than the countdown itself. */
function upNextSkipAtMs(marker) {
    return Math.min((marker.startTimeOffset ?? 0) + UP_NEXT_COUNTDOWN_MS, marker.endTimeOffset ?? 0);
}

/* Lazily creates the one tap-to-skip button, shared between the plain "Skip Intro"/"Skip
   Credits" case and the "Playing next in…" auto-skip countdown - same element, same
   click-to-skip-now handler, just different textContent, per this feature's own design
   (a countdown is still a skip button, just one that also counts down out loud). Joins
   controller._controlButtons (registerControlButton) so it fades with the rest of the
   chrome once idle, the same as the close/menu buttons and transport bar, instead of
   maintaining its own independent visibility. `anchor: false` because it keeps its own
   fixed bottom-right position instead of the corner-stacking anchor system.

   The coupling runs the other way too, see showSkipButton below: for as long as this
   button itself is relevant (a marker active, a countdown ticking), it forces the WHOLE
   row visible rather than just riding along with whatever the idle timer already
   decided - an intro/credits window is exactly the moment a viewer is most likely to
   have let go of the mouse, and that's precisely when this button matters most. */
function ensureSkipButtonEl(controller) {
    if (controller._skipBtnEl) return controller._skipBtnEl;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add(PLAYER_FOCUSABLE_CLASS);
    const reference = controller._controlButtons?.[0];
    Object.assign(btn.style, {
        position: "fixed",
        bottom: "170px",
        right: "40px",
        zIndex: "10001",
        padding: "10px 22px",
        borderRadius: "4px",
        border: "none",
        /* Same brand yellow + near-black text pairing as every other filled button in
           the player chrome (chrome-subtitles.js's Search button, chrome-menu-effects.js's
           selected mode buttons) - #e5a00d is this app's one shared accent color, not
           specific to this button. */
        background: "#e5a00d",
        color: "#161619",
        fontSize: "13px",
        fontWeight: "700",
        fontFamily: '"Roboto", sans-serif',
        letterSpacing: "0.03em",
        cursor: "pointer",
        display: "none",
        opacity: reference?.style.opacity || "1",
        pointerEvents: reference?.style.pointerEvents || "auto",
        transition: "opacity 0.25s ease",
    });
    /* Always seeks to the currently active marker's own end, regardless of whether this
       click landed on the plain "Skip Intro"/"Skip Credits" label or mid-countdown on
       "Playing next in…" - a manual tap always means "skip now", countdown or not. */
    btn.addEventListener("click", () => {
        const el = media(controller);
        if (el && controller._activeSkipMarker) {
            el.currentTime = (controller._activeSkipMarker.endTimeOffset ?? 0) / 1000;
        }
    });
    registerControlButton(controller, btn, { anchor: false });
    controller._skipBtnEl = btn;
    return btn;
}

function showSkipButton(controller, label) {
    const btn = ensureSkipButtonEl(controller);
    btn.textContent = label;
    btn.style.display = "block";
    /* Called every tick this button is showing (matching how often updateSkipButton
       itself now runs - see its own header comment), which keeps re-triggering
       chrome-controls.js's idle-hide timer via showControls' own scheduleHideControls
       call - so the row never actually reaches the end of that timer, and stays visible,
       for as long as ticks keep arriving with an active marker/countdown. The moment
       marker becomes null (window ends) this stops being called, and whatever hide timer
       was already pending catches up and fades everything out again, same as ordinary
       mouse inactivity. */
    showControls(controller);
}

function hideSkipButton(controller) {
    if (controller._skipBtnEl) controller._skipBtnEl.style.display = "none";
}

export function updateSkipButton(controller, marker) {
    /* xbox-bridge.js calls this unconditionally every tick (web-fallback.js's own
       timeupdate handler now does too, see its comment on why the old marker !==
       _activeSkipMarker guard there had to go), so the same marker object can arrive here
       repeatedly - both while its auto-skip seek is still catching up to the new position,
       and, for a credits countdown still ticking down, every single tick on purpose.
       _autoSkippedMarker (distinct from _activeSkipMarker below) is only ever set once the
       actual skip has fired, so it's what tells those two cases apart. */
    if (marker && marker === controller._autoSkippedMarker) return;
    if (marker && shouldAutoSkip(controller)) {
        controller._activeSkipMarker = marker;
        if (marker.type === "credits") {
            const positionMs = controller._session?.lastTimeMs ?? 0;
            const secondsLeft = Math.ceil((upNextSkipAtMs(marker) - positionMs) / 1000);
            if (secondsLeft > 0) {
                showSkipButton(controller, `Playing next in ${secondsLeft}s…`);
                return;
            }
        }
        controller._autoSkippedMarker = marker;
        hideSkipButton(controller);
        const el = media(controller);
        if (el) el.currentTime = (marker.endTimeOffset ?? 0) / 1000;
        return;
    }
    if (!marker) controller._autoSkippedMarker = null;
    controller._activeSkipMarker = marker;
    if (!marker) {
        hideSkipButton(controller);
        return;
    }
    showSkipButton(controller, skipLabelFor(marker));
}
