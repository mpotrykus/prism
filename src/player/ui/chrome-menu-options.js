import { media } from "../core/media-facade.js";
import { postAspectMode } from "../xbox-bridge.js";
import {
    skipIconMarkup,
    audioLevelingIconMarkup,
    PLAYBACK_RATES,
    SLEEP_TIMER_PRESETS_MIN,
    FIT_MODES,
    speedIconMarkup,
    aspectIconMarkup,
    sleepIconMarkup,
} from "./shared.js";
/* Circular with chrome-menu.js (which imports renderOptionsList/applyFitMode from
   this file for its "Options" row and its Aspect picker's onSelect) - safe here for the
   same reason chrome-menu-effects.js's identical cycle is: renderPickerList/
   buildAccordionRow/makeBackRow/refocusList are only referenced inside renderOptionsList's
   own function body below, never at module-evaluation time. */
import { renderPickerList, buildAccordionRow, makeBackRow, refocusList } from "./chrome-menu.js";

/* The hamburger "More" sheet's Options sub-screen: Normalize Audio/Auto-Play/Auto-Skip
   Intro & Credits (plain on/off toggles, nothing to expand or drill into - see
   buildAccordionRow's own `toggle`-only row shape) plus Playback Speed/Aspect/Sleep Timer
   (each its own dedicated nav screen, folded in from the former standalone "Extras" row -
   none of these six relate to each other the way Effects' GPU-pipeline controls do, but
   each is simple enough to live in one combined "everything else" screen rather than its
   own top-level row). Also owns applyFitMode, since Aspect is one of these pickers. */
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

/* Not gated on hasNativePlayer() the way native-bridge.js's own Android bridge calls are
   elsewhere in this codebase - this whole module only ever mounts for the web and Xbox
   legs (Android has its own native menu, PlayerUiHelper.java, with no equivalent of this
   file at all), and media(controller) already resolves to the right thing on both: the
   real <video> element on web, a NativeMediaFacade relaying to the Xbox bridge otherwise
   (see core/media-facade.js). Routing through native-bridge.js's Capacitor-only
   setNativePlaybackRate here - as an earlier version of this function did - reached a
   plugin that only exists on Android, silently doing nothing on Xbox. */
function setPlaybackRate(controller, rate) {
    if (!controller._session) return;
    controller._session.playbackRate = rate;
    const el = media(controller);
    if (el) el.playbackRate = rate;
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

function renderAspectSection(controller, content, { setValue, collapse }) {
    renderPickerList(content, FIT_MODES.map(({ key, label }) => ({
        label: `${label}${key === controller._fitMode ? "  ✓" : ""}`,
        onSelect: () => {
            applyFitMode(controller, key);
            setValue(label);
            collapse();
        },
    })));
}

/* "fit"/"cover"/"stretch" -> CSS object-fit's own keywords, except "stretch" itself
   (object-fit has no "stretch" value - "fill" is the one that ignores aspect ratio and
   distorts the picture to exactly cover the box, which is what "Stretch" means here). */
function cssObjectFitFor(mode) {
    return mode === "cover" ? "cover" : mode === "stretch" ? "fill" : "contain";
}

/* Replaces the old scale+pan zoom transform (applyZoomTransform/wireZoomPan) with a
   plain aspect-fit switch - Fit (letterbox, the old 1x), Cover (crop to fill, no
   letterbox) or Stretch (fill exactly, distorting the picture). No pan needed for any
   of the three, so this is also why wireZoomPan's drag-to-pan handling is gone
   entirely rather than ported over.

   controller._videoEl is null on Xbox (no real <video> element - the native surface
   sits behind the transparent WebView2, see xbox-bridge.js's header), so that leg
   relays the mode across the bridge instead for NativePlayerHost.SetStretch to apply
   to its MediaPlayerElement.Stretch - same "no _videoEl means Xbox" branch
   ambient-pipeline.js's computePictureRect already uses. */
export function applyFitMode(controller, mode) {
    controller._fitMode = mode;
    if (controller._videoEl) {
        const cssFit = cssObjectFitFor(mode);
        controller._videoEl.style.objectFit = cssFit;
        /* The shader canvas sits exactly on top of the (now-invisible) video at the
           same position/size, so it needs the same object-fit to stay visually
           aligned with it - see shader-pipeline.js's ensureShaderPipeline, which gives
           a freshly-created canvas this same treatment for whatever mode is already
           current. */
        if (controller._shaderCanvas) controller._shaderCanvas.style.objectFit = cssFit;
    } else {
        postAspectMode(mode);
    }
}

/* Moved here from chrome-menu.js's main list (Auto-Play/Auto-Skip), chrome-menu-effects.js's
   Effects screen (Normalize Audio, formerly named "Audio Leveling"), and the former standalone
   "Extras" screen (Playback Speed/Aspect/Sleep Timer) - same rows, same behavior, just
   relocated (and, for Normalize Audio, relabeled) into one "everything else" screen.

   `onBack` is what Back should do at THIS screen (return to the main list) - `setGoBack` is
   chrome-menu.js's own goBack setter, needed here because entering Playback Speed/Aspect/Sleep
   Timer has to point `goBack` at showThisScreen (return to Options) instead, then back at
   `onBack` again once the viewer returns here - see chrome-menu.js's own setGoBack comment for
   why a sub-screen module can't just reassign that variable directly. */
export function renderOptionsList(controller, list, onBack, setGoBack) {
    const showThisScreen = () => {
        setGoBack(onBack);
        renderOptionsList(controller, list, onBack, setGoBack);
        refocusList(list);
    };

    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    const state = { expandedCollapse: null };
    const rowHandles = {};

    rowHandles.normalizeAudio = buildAccordionRow(list, state, {
        key: "normalizeAudio",
        label: "Normalize Audio",
        icon: audioLevelingIconMarkup(),
        getValue: () => (controller._audioLevelingEnabled ? "On" : null),
        toggle: {
            checked: controller._audioLevelingEnabled,
            onChange: (checked) => {
                controller._setAudioLevelingEnabled(checked);
                return checked ? "On" : null;
            },
        },
    });
    rowHandles.autoplay = buildAccordionRow(list, state, {
        key: "autoplay",
        label: "Auto-Play",
        icon: skipIconMarkup("next"),
        getValue: () => (controller._autoPlayEnabled ? "On" : null),
        toggle: {
            checked: controller._autoPlayEnabled,
            onChange: (checked) => {
                controller._setAutoPlayEnabled(checked);
                /* Greys the row below live rather than waiting for the sheet to be
                   reopened - see buildAccordionRow's setDisabled. */
                rowHandles.autoskip?.setDisabled(!checked);
                return checked ? "On" : null;
            },
        },
    });
    rowHandles.autoskip = buildAccordionRow(list, state, {
        key: "autoskip",
        label: "Auto-Skip Intro & Credits",
        /* Only meaningful as part of "keep watching automatically" - an auto-skipped
           credits marker with Auto-Play off would just auto-seek to the end of a title
           with nothing queued to advance to, same reasoning chrome-skip.js's
           shouldAutoSkip requires both flags. Double-triangle skip glyph (vs. Auto-Play's
           single triangle above) to read as a distinct row at a glance. */
        icon: skipIconMarkup("next", { double: true }),
        disabled: !controller._autoPlayEnabled,
        getValue: () => (controller._autoSkipIntroCreditsEnabled ? "On" : null),
        toggle: {
            checked: controller._autoSkipIntroCreditsEnabled,
            onChange: (checked) => {
                controller._setAutoSkipIntroCreditsEnabled(checked);
                return checked ? "On" : null;
            },
        },
    });
    buildAccordionRow(list, state, {
        key: "speed",
        label: "Playback Speed",
        icon: speedIconMarkup(),
        getValue: () => `${controller._session?.playbackRate || 1}x`,
        nav: () => {
            setGoBack(showThisScreen);
            renderSpeedList(controller, list, showThisScreen);
            refocusList(list);
        },
    });
    buildAccordionRow(list, state, {
        key: "aspect",
        label: "Aspect",
        icon: aspectIconMarkup(),
        getValue: () => FIT_MODES.find((m) => m.key === controller._fitMode)?.label || "Fit",
        nav: () => {
            setGoBack(showThisScreen);
            renderAspectList(controller, list, showThisScreen);
            refocusList(list);
        },
    });
    buildAccordionRow(list, state, {
        key: "sleep",
        label: "Sleep Timer",
        icon: sleepIconMarkup(),
        getValue: () => (controller._sleepMinutes ? `${controller._sleepMinutes}m` : null),
        nav: () => {
            setGoBack(showThisScreen);
            renderSleepList(controller, list, showThisScreen);
            refocusList(list);
        },
    });
}

/* Reuses renderSpeedSection/renderAspectSection/renderSleepSection's picker-list body unchanged
   (same "own dedicated screen" wiring as chrome-menu.js's renderQualityCapList) - `onBack`
   stands in for the accordion's own `collapse`, so picking a rate/fit-mode/sleep-duration returns
   straight to the Options screen instead of needing a separate "update this row's value" step. */
function renderSpeedList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    renderSpeedSection(controller, list, { setValue: () => {}, collapse: onBack });
}

function renderAspectList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    renderAspectSection(controller, list, { setValue: () => {}, collapse: onBack });
}

function renderSleepList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    renderSleepSection(controller, list, { setValue: () => {}, collapse: onBack });
}
