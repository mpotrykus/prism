import { CONTROLS_HIDE_DELAY_MS } from "./shared.js";

/* The idle-fade control row: every corner button and the transport bar share one fade
   timer instead of each reinventing idle-hide logic, plus the buffering spinner - the one
   piece of chrome that deliberately does NOT follow the idle-fade row (see
   buildLoadingSpinner below). */

/* One 44px circular button matching this player's existing inline-style chrome
   convention. Doesn't position or register itself - callers pass the result to
   registerControlButton so every button shares one fade timer instead of each
   reinventing idle-hide logic. */
export function makeControlButton({ ariaLabel, content, onClick }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = content;
    btn.setAttribute("aria-label", ariaLabel);
    Object.assign(btn.style, {
        position: "fixed",
        top: "24px",
        zIndex: "10001",
        width: "40px",
        height: "40px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "0",
        border: "none",
        background: "transparent",
        color: "#fff",
        fontSize: "22px",
        fontWeight: "600",
        lineHeight: "1",
        cursor: "pointer",
        opacity: "1",
        textShadow: "0 1px 4px rgba(0,0,0,0.85)",
        transition: "opacity 0.25s ease",
    });
    if (onClick) btn.addEventListener("click", onClick);
    return btn;
}

/* Registers an element into the shared fade-timer row: anchored to the given corner
   (stacking further from the edge as more buttons join that same side) unless
   anchor:false (used by the full-width transport bar, which positions itself), and
   wired so hovering/focusing *any* registered element keeps the whole row visible - not
   just itself - matching how a single physical control bar behaves. */
export function registerControlButton(controller, el, { anchor = true, side = "right" } = {}) {
    if (anchor) {
        const stacked = controller._controlButtons.filter((b) => b.dataset.anchorSide === side).length;
        el.dataset.anchorSide = side;
        el.style[side] = `${24 + stacked * 44}px`;
    }
    controller._controlButtons.push(el);
    document.body.appendChild(el);
    const onEnter = () => {
        controller._controlsHovering = true;
        clearTimeout(controller._controlsHideTimer);
        showControls(controller);
    };
    const onLeave = () => {
        controller._controlsHovering = false;
        scheduleHideControls(controller);
    };
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("focus", onEnter);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("blur", onLeave);
    return el;
}

export function showControls(controller) {
    controller._controlButtons.forEach((b) => {
        b.style.opacity = "1";
        b.style.pointerEvents = "auto";
    });
    scheduleHideControls(controller);
}

/* Used instead of scheduleHideControls's delayed fade when the episode list overlay
   opens - that overlay is a full-width bottom sheet occupying the same screen real
   estate as the transport bar, so the corner buttons/transport bar need to disappear
   immediately rather than linger underneath it until the idle timer catches up. */
export function hideControls(controller) {
    clearTimeout(controller._controlsHideTimer);
    controller._controlButtons.forEach((b) => {
        b.style.opacity = "0";
        b.style.pointerEvents = "none";
    });
}

/* pointerEvents is toggled alongside opacity, not just opacity alone - a faded-out
   transport bar spanning the full screen width would otherwise still intercept clicks
   (opacity:0 doesn't remove a hit target), swallowing taps on the video underneath that
   are meant to toggle play/pause or reshow the controls. */
export function scheduleHideControls(controller) {
    clearTimeout(controller._controlsHideTimer);
    if (controller._controlsHovering || controller._inlineMenuEl || controller._episodeListEl || controller._chapterListEl || controller._audioSubtitlesEl) return;
    controller._controlsHideTimer = setTimeout(() => {
        controller._controlButtons.forEach((b) => {
            b.style.opacity = "0";
            b.style.pointerEvents = "none";
        });
    }, CONTROLS_HIDE_DELAY_MS);
}

/* Buffering indicator - independent of the idle-fade control row (same "contextual, not
   ambient chrome" reasoning as the skip button): it reflects actual network/decode
   state, not user activity, so it has to stay visible even while the rest of the chrome
   has faded out from inactivity. pointerEvents:none so it never blocks clicks on the
   center play/pause button or video underneath it while overlapping them. */
export function buildLoadingSpinner(controller, video) {
    if (!document.getElementById("streaming-player-spinner-style")) {
        const style = document.createElement("style");
        style.id = "streaming-player-spinner-style";
        style.textContent = "@keyframes streaming-player-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }";
        document.head.appendChild(style);
    }

    const spinner = document.createElement("div");
    Object.assign(spinner.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: "10002",
        width: "48px",
        height: "48px",
        borderRadius: "50%",
        border: "4px solid rgba(255,255,255,0.25)",
        borderTopColor: "#fff",
        animation: "streaming-player-spin 0.8s linear infinite",
        pointerEvents: "none",
    });
    document.body.appendChild(spinner);
    controller._spinnerEl = spinner;

    const show = () => {
        spinner.style.display = "block";
    };
    const hide = () => {
        spinner.style.display = "none";
    };
    video.addEventListener("waiting", show);
    video.addEventListener("seeking", show);
    video.addEventListener("playing", hide);
    video.addEventListener("canplay", hide);
    video.addEventListener("pause", hide);
    video.addEventListener("seeked", () => {
        if (!video.paused) hide();
    });
    show();
}
