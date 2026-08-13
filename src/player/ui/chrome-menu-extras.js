import { Capacitor } from "@capacitor/core";
import { setNativePlaybackRate } from "../native-bridge.js";
import { PLAYBACK_RATES, SLEEP_TIMER_PRESETS_MIN, ZOOM_LEVELS, speedIconMarkup, zoomIconMarkup, sleepIconMarkup } from "./shared.js";
/* Circular with chrome-menu.js (which imports renderExtrasList/applyZoomTransform from
   this file for its "Extras" row and its Zoom picker's onSelect) - safe here because
   both sides only reference the other module's export from inside a function body
   (renderPickerList/buildAccordionRow/makeBackRow are only called once renderExtrasList
   itself actually runs, well after both modules have finished loading), never at
   top-level module-evaluation time. */
import { renderPickerList, buildAccordionRow, makeBackRow } from "./chrome-menu.js";

/* The hamburger "More" sheet's Extras sub-screen: Playback Speed/Zoom/Sleep Timer, each
   an accordion section (see renderExtrasList) - grouped together since none of the three
   relate to each other the way Effects' three GPU-pipeline controls do, but each is
   simple/single-picker enough that squeezing all three top-level rows down to one still
   reads as a sensible cluster. Also owns zoom pan/transform, since Zoom is one of these
   pickers. */

function renderSpeedSection(controller, content, { setValue, collapse }) {
    const current = controller._session?.playbackRate || 1;
    renderPickerList(content, PLAYBACK_RATES.map((rate) => ({
        label: `${rate}x${rate === current ? "  ✓" : ""}`,
        onSelect: () => {
            setPlaybackRate(controller, rate);
            setValue(`${rate}x`);
            collapse();
        },
    })));
}

async function setPlaybackRate(controller, rate) {
    if (!controller._session) return;
    controller._session.playbackRate = rate;
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
        await setNativePlaybackRate(rate);
    } else if (controller._videoEl) {
        controller._videoEl.playbackRate = rate;
    }
}

function renderSleepSection(controller, content, { setValue, collapse }) {
    renderPickerList(content, [
        { label: `Off${!controller._sleepMinutes ? "  ✓" : ""}`, onSelect: () => { setSleepTimer(controller, 0); setValue(null); collapse(); } },
        ...SLEEP_TIMER_PRESETS_MIN.map((min) => ({
            label: `${min} min${controller._sleepMinutes === min ? "  ✓" : ""}`,
            onSelect: () => { setSleepTimer(controller, min * 60000); setValue(`${min}m`); collapse(); },
        })),
        { label: "End of episode", onSelect: () => { setSleepTimer(controller, 0); setValue(null); collapse(); } },
    ]);
}

/* ms=0 clears any pending timer - used by both "Off" (don't pause early) and "End of
   episode" (rely on the existing `ended` handling instead of a timer at all). */
function setSleepTimer(controller, ms) {
    clearTimeout(controller._sleepTimer);
    controller._sleepTimer = ms > 0 ? setTimeout(() => controller.pause(), ms) : null;
    controller._sleepMinutes = ms > 0 ? Math.round(ms / 60000) : 0;
}

function renderZoomSection(controller, content, { setValue, collapse }) {
    renderPickerList(content, ZOOM_LEVELS.map((level, idx) => ({
        label: `${level}x${idx === controller._zoomIndex ? "  ✓" : ""}`,
        onSelect: () => {
            controller._zoomIndex = idx;
            controller._zoomPanX = 0;
            controller._zoomPanY = 0;
            applyZoomTransform(controller);
            setValue(`${level}x`);
            collapse();
        },
    })));
}

export function applyZoomTransform(controller) {
    if (!controller._videoEl) return;
    const scale = ZOOM_LEVELS[controller._zoomIndex];
    const transform = `translate(${controller._zoomPanX}px, ${controller._zoomPanY}px) scale(${scale})`;
    controller._videoEl.style.transform = transform;
    /* The shader canvas sits exactly on top of the (now-invisible) video at the same
       position/size, so it needs the same transform to stay aligned with it - pan/zoom
       itself is still driven entirely off the video's own pointer events, since the
       canvas is pointer-events:none and lets clicks/drags fall through to it. */
    if (controller._shaderCanvas) controller._shaderCanvas.style.transform = transform;
}

/* "Extras" - same dedicated-screen pattern as chrome-menu-effects.js's renderEffectsList,
   for Playback Speed/Zoom/Sleep Timer instead of the shader/color/ambient trio. */
export function renderExtrasList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    const state = { expandedCollapse: null };
    buildAccordionRow(list, state, {
        key: "speed",
        label: "Playback Speed",
        icon: speedIconMarkup(),
        getValue: () => `${controller._session?.playbackRate || 1}x`,
        render: (content, helpers) => renderSpeedSection(controller, content, helpers),
    });
    buildAccordionRow(list, state, {
        key: "zoom",
        label: "Zoom",
        icon: zoomIconMarkup(),
        getValue: () => `${ZOOM_LEVELS[controller._zoomIndex]}x`,
        render: (content, helpers) => renderZoomSection(controller, content, helpers),
    });
    buildAccordionRow(list, state, {
        key: "sleep",
        label: "Sleep Timer",
        icon: sleepIconMarkup(),
        getValue: () => (controller._sleepMinutes ? `${controller._sleepMinutes}m` : null),
        render: (content, helpers) => renderSleepSection(controller, content, helpers),
    });
}

/* Pan only engages once zoomed past 1x, and only within the padding introduced by that
   zoom - clamped against the video's own unscaled box size so the frame can never be
   dragged edge-past-edge and leave black space. */
export function wireZoomPan(controller) {
    const video = controller._videoEl;
    if (!video) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    video.addEventListener("pointerdown", (e) => {
        if (ZOOM_LEVELS[controller._zoomIndex] <= 1) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        originX = controller._zoomPanX;
        originY = controller._zoomPanY;
        video.setPointerCapture(e.pointerId);
    });
    video.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const scale = ZOOM_LEVELS[controller._zoomIndex];
        const maxX = ((scale - 1) * video.clientWidth) / 2;
        const maxY = ((scale - 1) * video.clientHeight) / 2;
        controller._zoomPanX = Math.max(-maxX, Math.min(maxX, originX + (e.clientX - startX)));
        controller._zoomPanY = Math.max(-maxY, Math.min(maxY, originY + (e.clientY - startY)));
        applyZoomTransform(controller);
    });
    const endDrag = () => {
        dragging = false;
    };
    video.addEventListener("pointerup", endDrag);
    video.addEventListener("pointercancel", endDrag);
}
