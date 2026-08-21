import { skipIconMarkup, audioLevelingIconMarkup } from "./shared.js";
/* Circular with chrome-menu.js (which imports renderOptionsList from this file for its
   "Options" row) - safe here for the same reason chrome-menu-effects.js/chrome-menu-extras.js's
   identical cycles are: buildAccordionRow/makeBackRow are only referenced inside
   renderOptionsList's own function body below, never at module-evaluation time. */
import { buildAccordionRow, makeBackRow } from "./chrome-menu.js";

/* The hamburger "More" sheet's Options sub-screen: Normalize Audio/Auto-Play/Auto-Skip Intro &
   Credits - three plain on/off toggles with nothing to expand or drill into (see
   buildAccordionRow's own `toggle`-only row shape), grouped into their own screen rather than
   sitting at the main list's top level. Moved here from chrome-menu.js's main list (Auto-Play/
   Auto-Skip) and chrome-menu-effects.js's Effects screen (Normalize Audio, formerly named
   "Audio Leveling") - same rows, same behavior, just relocated and (for that one) relabeled. */
export function renderOptionsList(controller, list, onBack) {
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
}
