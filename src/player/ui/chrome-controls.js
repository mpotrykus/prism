import { CONTROLS_HIDE_DELAY_MS } from "./shared.js";

/* The idle-fade control row: every corner button and the transport bar share one fade
   timer instead of each reinventing idle-hide logic, plus the buffering spinner - the one
   piece of chrome that deliberately does NOT follow the idle-fade row (see
   buildLoadingSpinner below). */

/* One corner button. Doesn't position or register itself - callers pass the result to
   registerControlButton so every button shares one fade timer. */
export function makeControlButton({ ariaLabel, content, onClick }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = content;
    btn.setAttribute("aria-label", ariaLabel);
    btn.classList.add("prism-player-focusable", "prism-player-control-btn");
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
    controller._controlButtons.forEach((b) => b.classList.remove("prism-player-chrome-hidden"));
    scheduleHideControls(controller);
}

/* Used instead of scheduleHideControls's delayed fade when the episode list overlay
   opens - that overlay is a full-width bottom sheet occupying the same screen real
   estate as the transport bar, so the corner buttons/transport bar need to disappear
   immediately rather than linger underneath it until the idle timer catches up. */
export function hideControls(controller) {
    clearTimeout(controller._controlsHideTimer);
    controller._controlButtons.forEach((b) => b.classList.add("prism-player-chrome-hidden"));
}

export function scheduleHideControls(controller) {
    clearTimeout(controller._controlsHideTimer);
    if (controller._controlsHovering || controller._inlineMenuEl || controller._episodeListEl || controller._chapterListEl || controller._audioSubtitlesEl) return;
    controller._controlsHideTimer = setTimeout(() => {
        /* An in-progress left-stick scrub (see player.js's _adjustScrub/_cancelScrub)
           has no meaning once its own preview UI is about to disappear with the rest of the
           chrome - idling out is treated the same as the user pressing B, snapping the
           transport bar back to wherever playback actually is rather than leaving a stale
           pending seek that a later A could still commit unexpectedly. */
        if (controller._scrubActive) controller._cancelScrub();
        controller._controlButtons.forEach((b) => b.classList.add("prism-player-chrome-hidden"));
    }, CONTROLS_HIDE_DELAY_MS);
}

/* Buffering indicator - independent of the idle-fade control row (same "contextual, not
   ambient chrome" reasoning as the skip button): it reflects actual network/decode
   state, not user activity, so it has to stay visible even while the rest of the chrome
   has faded out from inactivity. pointerEvents:none so it never blocks clicks on the
   center play/pause button or video underneath it while overlapping them. */
export function buildLoadingSpinner(controller, video) {
    const spinner = document.createElement("div");
    spinner.className = "prism-player-spinner";
    document.body.appendChild(spinner);
    controller._spinnerEl = spinner;

    const show = () => spinner.classList.add("is-visible");
    const hide = () => spinner.classList.remove("is-visible");
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
