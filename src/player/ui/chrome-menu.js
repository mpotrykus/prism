import { hideControls, showControls } from "./chrome-controls.js";
import { wireLinearNav, focusAfterPaint } from "../../core/focus-nav.js";
import { setAutoQualityEnabled, bandwidthSource } from "../core/abr.js";
import { usesGamepadChrome } from "../core/platform.js";
import { setStatsOverlayEnabled } from "../stats-overlay.js";
import {
    QUALITY_CAP_PRESETS,
    episodesIconMarkup,
    chaptersIconMarkup,
    audioSubtitlesIconMarkup,
    versionIconMarkup,
    qualityCapIconMarkup,
    effectsIconMarkup,
    optionsIconMarkup,
    performanceIconMarkup,
} from "./shared.js";
import { ensurePlayerStyles } from "./styles.js";
/* Circular with episode-list.js (which imports playQueuedTitle/formatTime from
   chrome-transport.js) - safe here because both sides only reference the other module's
   export from inside a function body (openChapterListOverlay/openEpisodeListOverlay are
   called from a click handler, long after both modules have finished loading), never at
   top-level module-evaluation time. */
import { openChapterListOverlay, openEpisodeListOverlay } from "./episode-list.js";
/* Same circularity reasoning as episode-list.js above - chrome-subtitles.js imports
   closeInlineMenu/renderPickerList from this file, and this file's own use of
   openAudioSubtitlesOverlay is confined to a `nav` callback below, never called until long
   after both modules have finished loading. */
import { openAudioSubtitlesOverlay } from "./chrome-subtitles.js";
import { renderEffectsList } from "./chrome-menu-effects.js";
import { renderOptionsList } from "./chrome-menu-options.js";

/* The hamburger "More" sheet: its top-level accordion list (Episodes/Chapters/Audio &
   Subtitles/Version/Quality Cap/Options/Effects/Performance Overlay), the
   accordion-row/picker-list primitives
   shared with its Effects (chrome-menu-effects.js) and Options (chrome-menu-options.js)
   sub-screens, and the Version/Quality Cap pickers that stay inline here. Takes the
   StreamingPlayerController instance as an explicit first argument (see native-bridge.js/
   shader-pipeline.js for why) rather than owning independent state - the idle-fade timer
   and inline-menu bookkeeping are shared with the rest of the player chrome. */

export function renderPickerList(content, items, { rowGap = 0 } = {}) {
    items.forEach((item, index) => {
        /* A plain, non-interactive section label (chrome-menu.js's server-grouped Version
           list is the only caller today) - a <div>, deliberately NOT one of this list's
           <button> rows, so it never becomes a focusable dead-end for D-pad/gamepad nav
           (wireLinearNav's selector for this sheet only matches `button`, see
           openHamburgerMenu's own comment on why every row here needs a real onSelect). */
        if (item.header) {
            const headerEl = document.createElement("div");
            headerEl.className = "prism-player-picker-header";
            headerEl.textContent = item.label;
            content.appendChild(headerEl);
            return;
        }
        const row = document.createElement("button");
        row.type = "button";
        row.classList.add("prism-player-focusable", "prism-player-menu-row", "prism-player-picker-row");
        if (rowGap && index < items.length - 1) row.style.marginBottom = `${rowGap}px`;
        /* Only the Chapters section sets item.thumb - every other picker (speed, sleep
           timer, audio track...) leaves it undefined, so this is a no-op there. Hidden
           on error rather than left to show a broken-image icon - Plex's chapterImages
           endpoint isn't guaranteed pre-generated for every chapter. */
        if (item.thumb) {
            const thumb = document.createElement("img");
            thumb.src = item.thumb;
            thumb.loading = "lazy";
            thumb.alt = "";
            thumb.className = "prism-player-picker-thumb";
            thumb.addEventListener("error", () => thumb.remove());
            row.appendChild(thumb);
        }
        const label = document.createElement("span");
        label.className = "prism-player-picker-label";
        label.textContent = item.label;
        row.appendChild(label);
        row.addEventListener("click", () => item.onSelect && item.onSelect());
        content.appendChild(row);
    });
}

/* One row of the More sheet (also used by chrome-menu-options.js's Options sub-screen).
   Sections with `render` expand in place (accordion, one section open at a time per
   `state` - opening a new one collapses whatever else was open, via
   `state.expandedCollapse`); sections with `nav` instead replace the whole list with a
   different screen (see renderEffectsList/renderOptionsList) rather than expanding in
   place - used for "Effects"/"Options", whose sub-controls read better as their own
   dedicated list than squeezed inline under a fourth row. Sections with only `toggle`
   (Auto-Play, Auto-Skip Intro & Credits, Performance Overlay) are plain on/off rows with
   nothing to expand or navigate to. `toggle` and `render` are independent - Ambient
   Lighting has both, flipping on/off without affecting whether its opacity section is
   open. `disabled: true` greys a toggle-only row out (see setDisabled below) without
   touching its underlying persisted value - Auto-Skip Intro & Credits stays whatever it
   was last set to while Auto-Play is off, it just can't do anything until Auto-Play is
   back on. */
export function buildAccordionRow(list, state, section) {
    const wrap = document.createElement("div");
    wrap.className = "prism-player-accordion";

    const header = document.createElement("button");
    header.type = "button";
    header.classList.add("prism-player-focusable", "prism-player-menu-row", "prism-player-accordion-header");
    if (!(section.render || section.nav || section.toggle)) header.classList.add("is-inert");

    const labelStack = document.createElement("span");
    labelStack.className = "prism-player-accordion-labels";
    const labelEl = document.createElement("span");
    labelEl.className = "prism-player-accordion-label";
    labelEl.textContent = section.label;
    labelStack.appendChild(labelEl);
    let valueEl = null;
    const setValue = (text) => {
        if (text) {
            if (!valueEl) {
                valueEl = document.createElement("span");
                valueEl.className = "prism-player-accordion-value";
                labelStack.appendChild(valueEl);
            }
            valueEl.textContent = text;
        } else if (valueEl) {
            valueEl.remove();
            valueEl = null;
        }
    };
    setValue(section.getValue ? section.getValue() : null);

    /* Icon + labelStack share one flex container (leftSide) rather than being direct
       children of `header` - header's own justify-content:space-between only reads as
       "label left, controls right" with exactly two children; a bare 3rd child (the
       icon) would get pushed to the middle instead of hugging the label. */
    const leftSide = document.createElement("span");
    leftSide.className = "prism-player-accordion-left";
    if (section.icon) {
        const iconEl = document.createElement("span");
        iconEl.className = "prism-player-accordion-icon";
        iconEl.innerHTML = section.icon;
        leftSide.appendChild(iconEl);
    }
    leftSide.appendChild(labelStack);
    header.appendChild(leftSide);

    const rightSide = document.createElement("span");
    rightSide.className = "prism-player-accordion-right";
    let toggleEl = null;
    if (section.toggle) {
        toggleEl = makeToggleSwitch(section.toggle.checked, (checked) => setValue(section.toggle.onChange(checked)));
        rightSide.appendChild(toggleEl);
    }

    let chevronEl = null;
    if (section.render || section.nav) {
        chevronEl = document.createElement("span");
        chevronEl.className = "prism-player-chevron";
        chevronEl.textContent = "›";
        rightSide.appendChild(chevronEl);
    }
    if (rightSide.children.length) header.appendChild(rightSide);
    wrap.appendChild(header);

    if (section.render) {
        const content = document.createElement("div");
        content.className = "prism-player-accordion-content";
        wrap.appendChild(content);

        header.setAttribute("aria-expanded", "false");
        let built = false;
        const collapse = () => {
            content.classList.remove("is-open");
            header.setAttribute("aria-expanded", "false");
            if (state.expandedCollapse === collapse) state.expandedCollapse = null;
            /* Whatever was focused when this ran was a button inside `content` (a picker row's
               onSelect calls setValue+collapse right after the viewer activates it) - display:none
               drops a focused descendant out of the focus order entirely, same as removing it from
               the DOM outright (see refocusList's own comment above), and nothing else claims focus
               in its place. Left alone, the very next command (including B) would stop responding:
               wireLinearNav's handler only acts when focus is already inside its list. header stays
               visible and focusable either way (collapsing never hides it), so it's always a safe
               landing spot regardless of which row this collapse belongs to. */
            focusAfterPaint(header);
        };
        header.addEventListener("click", () => {
            if (content.classList.contains("is-open")) {
                collapse();
                return;
            }
            if (state.expandedCollapse) state.expandedCollapse();
            if (!built) {
                built = true;
                section.render(content, { setValue, collapse });
            }
            content.classList.add("is-open");
            header.setAttribute("aria-expanded", "true");
            state.expandedCollapse = collapse;
        });
    } else if (section.nav) {
        header.addEventListener("click", () => section.nav());
    } else if (toggleEl) {
        /* Sections with only `toggle` (Auto-Play, Performance Overlay) never wired the header
           itself to do anything - the switch's own click handler is the only thing that ever
           flipped it, which works fine for a mouse click landing directly on the switch but left
           the row completely inert for D-pad/keyboard: wireLinearNav only ever focuses `header`
           (the switch is a plain div, not a button - see makeToggleSwitch - so it's never a focus
           target itself), and activating an unwired button does nothing. Delegating to the switch's
           own click() reuses its existing flip-the-UI-and-call-onChange logic instead of duplicating
           it here; that handler's own stopPropagation keeps a direct mouse click on the switch from
           looping back through this same listener. */
        header.addEventListener("click", () => toggleEl.click());
    }

    /* Lets a sibling row's own onChange (e.g. Auto-Play, see the "autoskip" row below) grey
       this one out live without rebuilding the whole list. header.disabled already blocks both
       the click and D-pad activation for free; the switch is a plain div, so it needs its own
       class - same split chrome-menu-effects.js's noUpscaleNeeded case uses. */
    const setDisabled = (disabled) => {
        header.disabled = disabled;
        toggleEl?.classList.toggle("is-disabled", disabled);
    };
    if (section.disabled) setDisabled(true);

    list.appendChild(wrap);
    return { setDisabled };
}

/* Every navigated-to sub-list (Effects', Options', Quality Cap's) gets the same dimmed,
   divider-topped "back up a level" row instead of each screen styling its own -
   distinguishes "leave this screen" from a selectable option in a way a plain row
   sharing the same style as everything else couldn't. */
export function makeBackRow(onClick) {
    const row = document.createElement("button");
    row.type = "button";
    row.classList.add("prism-player-focusable", "prism-player-menu-row", "prism-player-back-row");
    row.textContent = "‹  Back";
    row.addEventListener("click", onClick);
    return row;
}

/* A full nav swap (Quality Cap/Effects/Options, Options' own sub-screens, or renderMainList
   itself) replaces the focused button with a brand-new DOM subtree, and nothing claims focus in
   its place, so the browser drops it to <body>. That silently breaks every subsequent D-pad
   command: wireLinearNav only acts when focus is already inside its own list, so the whole sheet
   stops responding to B *and* the arrows the moment a viewer navigates anywhere. Exported rather
   than closing over one `list` so chrome-menu-options.js's nested screens can call it too. */
export function refocusList(list) {
    focusAfterPaint(list.querySelector("button"));
}

export function openHamburgerMenu(controller, anchor) {
    closeInlineMenu(controller);
    ensurePlayerStyles();
    const session = controller._session;

    const scrim = document.createElement("div");
    scrim.className = "prism-player-scrim";
    scrim.addEventListener("click", () => closeInlineMenu(controller));

    /* The header+list card is what's vertically centered, not the backdrop: a backdrop that
       shrank to a short list's height left a stretch of plain, undarkened video below the
       card. */
    const sheet = document.createElement("div");
    sheet.className = "prism-player-sheet";

    /* The actual visible "menu" - header plus scrollable row list, capped at 82vh and
       otherwise sized to its own content (a short row list, e.g. the Effects/Options
       sub-screens, centers as a short card rather than stretching to fill the full
       backdrop). */
    const card = document.createElement("div");
    card.className = "prism-player-sheet-card";
    sheet.appendChild(card);

    const header = document.createElement("div");
    header.className = "prism-player-sheet-header";
    const heading = document.createElement("div");
    heading.className = "prism-player-sheet-heading";
    heading.textContent = "More";
    header.appendChild(heading);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.classList.add("prism-player-focusable", "prism-player-overlay-close");
    closeBtn.setAttribute("aria-label", "Close menu");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => closeInlineMenu(controller));
    header.appendChild(closeBtn);
    card.appendChild(header);

    const list = document.createElement("div");
    list.className = "prism-player-scroll prism-player-sheet-list";
    card.appendChild(list);

    /* Tracks "what should B/Escape do right now" - closeInlineMenu at the main list, or back up to
       the main list from whichever sub-screen (Quality Cap/Effects/Options) is currently showing in
       this same `list` element. Reassigned by renderMainList and by each sub-screen's own `nav`
       entry below, rather than menuNav's onBack hardcoding one or the other, so gamepad/keyboard
       "back" matches exactly what the mouse-driven "‹ Back" row (makeBackRow) already does.
       Options nests one level deeper still (its own Playback Speed/Aspect/Sleep Timer screens) -
       see setGoBack below for why a plain reassignment here isn't enough on its own for that case. */
    let goBack = () => closeInlineMenu(controller);
    /* Passed into renderOptionsList so its own nav callbacks can point `goBack` at Options' own
       screen (not all the way back to Main) when the viewer drills one level deeper still, then
       back at `renderMainList` again once they return to Options' top screen - chrome-menu.js owns
       `goBack` itself, so a sub-screen module has no other way to redirect it correctly for its own
       nested "back" targets. */
    function setGoBack(fn) {
        goBack = fn;
    }

    function renderMainList() {
    list.innerHTML = "";
    goBack = () => closeInlineMenu(controller);
    const state = { expandedCollapse: null };
    /* Ordered to match the Android native player's own More menu (PlayerUiHelper.java) so the
       two platforms read as the same app: source/quality (Version/Quality Cap) first;
       Options/Effects/Performance Overlay last, in that order - the three rows here most
       people set once and never revisit.

       Episodes and Audio & Subtitles are deliberately NOT duplicated here on web (or PC - see
       usesGamepadChrome()) - each already has its own dedicated transport-bar icon
       (chrome-transport.js's leftCell/rightCell, both gated to !usesGamepadChrome()). This file
       is shared between web AND Xbox (see this module's own header, and xbox-bridge.js's "the
       chrome stays in JS" comment) but Xbox's transport bar never gets those two icons - it has
       no mouse/hover row at all, just the floating play button (chrome-transport.js's
       buildFloatingPlayButton) - so the two rows below are the ONLY way Xbox reaches either
       overlay, gated the opposite way from the web icons rather than dropped for every platform.
       (A previous pass here removed both rows unconditionally to match Android's menu, which has
       no top-level icon for either either - fine for Android, since this whole file never renders
       there, but it silently orphaned Xbox's only path to both overlays until this comment's own
       fix.) Chapters has no icon on any platform, so it always stays here regardless.

       Exception: Auto-Skip Intro & Credits (inside the "Options" screen - see
       chrome-menu-options.js) has its own native mirror instead of appearing there on Android.
       Android's WebView, and this whole chrome.js UI along with it, is paused for as long as
       its native PlayerActivity is foregrounded, so the toggle itself lives in
       PlayerUiHelper.java's own Options screen (PlayerActivity's autoSkipIntroCreditsEnabled
       pref) - native-bridge.js's "progress" listener still makes the actual skip/countdown
       decision in JS (it already has controller._session.markers, which never existed natively),
       it just mirrors the native pref locally instead of reading controller._autoSkipIntroCreditsEnabled. */
    const sections = [];
    if (usesGamepadChrome() && session?.queueRatingKeys?.length > 1) {
        sections.push({
            key: "episodes",
            label: session.seasonNumber != null ? "Episodes" : "Up Next",
            icon: episodesIconMarkup(),
            /* openEpisodeListOverlay already closes this sheet itself (same pattern as Chapters
               below), so there's nothing else to do here. */
            nav: () => openEpisodeListOverlay(controller),
        });
    }
    if (session?.chapters?.length) {
        sections.push({
            /* Opens the same horizontally-scrolling card overlay episode-list.js uses
               for browsing episodes/queue items, rather than an inline text-row picker
               - chapters read better as thumbnail cards than plain rows, same as
               episodes do. Closes the More sheet on the way there (see
               openChapterListOverlay). */
            key: "chapters",
            label: "Chapters",
            icon: chaptersIconMarkup(),
            nav: () => openChapterListOverlay(controller),
        });
    }
    if (usesGamepadChrome()) {
        sections.push({
            /* openAudioSubtitlesOverlay already closes this sheet itself, same as
               Chapters/Episodes above. */
            key: "audiosubtitles",
            label: "Audio & Subtitles",
            icon: audioSubtitlesIconMarkup(),
            nav: () => openAudioSubtitlesOverlay(controller),
        });
    }
    /* Version is only shown when there's an actual choice to make - more than one group or
       server, or one group with more than one Media[] entry - following the same "never a dead
       affordance" rule as Audio Track and Chapters. Quality Cap is always shown, since it always
       has at least "Original". */
    const versionGroups = session?.mediaVersions || [];
    if (versionGroups.length > 1 || versionGroups.some((g) => g.versions?.length > 1)) {
        sections.push({
            key: "version",
            label: "Version",
            icon: versionIconMarkup(),
            getValue: () => currentVersionLabel(session),
            render: (content, helpers) => renderVersionSection(controller, content, helpers),
        });
    }
    sections.push({
        /* Own dedicated screen (see renderQualityCapList), not an inline expand - same
           reasoning as Effects/Options below. */
        key: "qualitycap",
        label: "Quality Cap",
        icon: qualityCapIconMarkup(),
        getValue: () => qualityCapMenuLabel(controller),
        nav: () => {
            goBack = renderMainList;
            renderQualityCapList(controller, list, renderMainList);
            refocusList(list);
        },
    });
    sections.push({
        /* Navigates to a dedicated Normalize Audio / Auto-Play / Auto-Skip / Playback Speed /
           Aspect / Sleep Timer screen (chrome-menu-options.js). None of the six relate to each
           other the way Effects' GPU-pipeline controls do, but each is a simple enough single
           picker that one combined "everything else" screen reads as a sensible cluster. */
        key: "options",
        label: "Options",
        icon: optionsIconMarkup(),
        nav: () => {
            goBack = renderMainList;
            /* Options nests one level deeper than Effects/Quality Cap - its own Playback Speed/
               Aspect/Sleep Timer rows each navigate to their own screen too, rather than expanding
               in place - so it needs a way to point `goBack` at its own top screen (not all the way
               to Main) while one of those is open. See setGoBack's own comment above. */
            renderOptionsList(controller, list, renderMainList, setGoBack);
            refocusList(list);
        },
    });
    sections.push({
        /* Navigates to a dedicated AI Upscaling/Sharpening/Color Boost/Ambient Lighting
           list (see chrome-menu-effects.js's renderEffectsList) rather than expanding in
           place - four sub-controls read better as their own screen than squeezed
           inline under a fifth row. */
        key: "effects",
        label: "Effects",
        icon: effectsIconMarkup(),
        nav: () => {
            goBack = renderMainList;
            renderEffectsList(controller, list, renderMainList);
            refocusList(list);
        },
    });
    sections.push({
        key: "stats",
        label: "Performance Overlay",
        /* No expand - nothing to drill into (no strength/opacity slider, unlike Shader
           Upscaling/Color Boost/Ambient Lighting above), just a plain on/off toggle. */
        icon: performanceIconMarkup(),
        getValue: () => (controller._statsOverlayEnabled ? "On" : null),
        toggle: {
            checked: controller._statsOverlayEnabled,
            onChange: (checked) => {
                setStatsOverlayEnabled(controller, checked);
                return checked ? "On" : null;
            },
        },
    });

    sections.forEach((section) => buildAccordionRow(list, state, section));
    refocusList(list);
    }

    renderMainList();

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    controller._inlineMenuEl = sheet;
    controller._inlineMenuScrim = scrim;
    /* wireLinearNav is given `document` as its root rather than the sheet itself: it reads
       root.activeElement, which only exists on Document and ShadowRoot - a plain <div> would report
       undefined and the handler would never consider itself in scope. The selector below scopes it
       back to this sheet. */
    /* Without this the sheet opens with focus still nowhere, so wireLinearNav's own "is focus inside my
       list" guard never passes and D-pad input does nothing. Also includes input[type=range] (only
       present on chrome-menu-effects.js's Effects sub-screen) so its Shader Upscaling/Color Boost/
       Ambient Lighting sliders are themselves reachable Up/Down stops, not just their Auto/On/Off
       mode buttons - a disabled slider (see buildModeRow's applyStrengthDisplay) is skipped for free,
       since items() already filters out disabled elements. */
    const menuNav = wireLinearNav(document, '.prism-player-sheet button:not(.prism-player-overlay-close), .prism-player-sheet input[type="range"]', {
        orientation: "vertical",
        loop: true,
        /* Back up a screen (Quality Cap/Effects/Options -> the main list) if one is open, else close
           the whole sheet - see `goBack`'s own comment above for why this is a reassignable variable
           rather than always closeInlineMenu directly. */
        onBack: () => goBack(),
    });
    /* wireLinearNav does not focus anything itself - it returns focusFirst for the caller to call.
       Required here: its handler ignores every command unless focus is already inside its list, so
       without this the sheet would open and swallow nothing. */
    menuNav.focusFirst();
    controller._inlineMenuNav = menuNav;
    controller._inlineMenuAnchor = anchor;
    hideControls(controller);
    requestAnimationFrame(() => {
        sheet.classList.add("is-open");
    });
}

/* "Auto (720p (10 Mbps))" while Auto Quality is actively adjusting the cap, else the
   plain preset label. Shared by the top-level "Quality Cap" row's own value and its
   expanded picker list so the two never show a different answer for the same state. */
function qualityCapMenuLabel(controller) {
    const label = QUALITY_CAP_PRESETS.find((p) => (p.kbps ?? null) === (controller._session?.qualityCapKbps ?? null))?.label || null;
    return controller._autoQualityEnabled ? `Auto (${label})` : label;
}

/* The current group is whichever one's server/ratingKey match the live session - not
   necessarily the first group in the list, since _switchToSource (player.js) keeps
   every group in session.mediaVersions selectable even after switching away from one. */
function currentVersionGroup(session) {
    const groups = session?.mediaVersions || [];
    return groups.find((g) => String(g.ratingKey) === String(session.ratingKey)) || groups[0] || null;
}

function currentVersionLabel(session) {
    const group = currentVersionGroup(session);
    return group?.versions?.find((v) => v.mediaIndex === session.mediaIndex)?.label || null;
}

/* Server-grouped picker - a plain (unselectable) server-name header per group, its own
   versions listed beneath, e.g.:
     PotrykusPlex
       1080p
       480p
     LookingGlass
       3840p
   Only rendered as headers when there's more than one group - a single-server item's
   Version list looks exactly like it always has, no server name intruding on it. */
function renderVersionSection(controller, content, { setValue, collapse }) {
    const session = controller._session;
    const groups = session?.mediaVersions || [];
    const activeGroup = currentVersionGroup(session);
    const multiServer = groups.length > 1;
    const items = groups.flatMap((group) => {
        const header = multiServer
            ? [{ label: group.server?.name || "Server", header: true }]
            : [];
        const versionRows = (group.versions || []).map((v) => {
            const isCurrent = group === activeGroup && v.mediaIndex === session.mediaIndex;
            return {
                label: `${v.label}${isCurrent ? "  ✓" : ""}`,
                onSelect: () => {
                    if (group === activeGroup) {
                        controller._reloadSource({ mediaIndex: v.mediaIndex });
                    } else {
                        controller._switchToSource(group, v);
                    }
                    setValue(currentVersionLabel(controller._session) || v.label);
                    collapse();
                },
            };
        });
        return [...header, ...versionRows];
    });
    renderPickerList(content, items);
}

function renderQualityCapSection(controller, content, { setValue, collapse }) {
    const session = controller._session;
    const current = session?.qualityCapKbps ?? null;
    const autoOn = controller._autoQualityEnabled;
    /* No bandwidth signal exists on Safari's native-HLS <video> branch (no source is
       registered there, see web-fallback.js's attachSource) - Auto Quality has nothing to
       evaluate against, so the row is omitted entirely rather than shown disabled.
       The persisted flag itself is untouched either way, so it still takes effect on
       a future session/device whose backend can measure bandwidth. */
    const autoAvailable = !!bandwidthSource(controller) || !!controller._abrStallDriven;
    const items = [];
    if (autoAvailable) {
        items.push({
            label: `Auto${autoOn ? "  ✓" : ""}`,
            onSelect: () => {
                setAutoQualityEnabled(controller, true);
                setValue(qualityCapMenuLabel(controller));
                collapse();
            },
        });
    }
    renderPickerList(
        content,
        [
            ...items,
            ...QUALITY_CAP_PRESETS.map((preset) => ({
                label: `${preset.label}${!autoOn && (preset.kbps ?? null) === current ? "  ✓" : ""}`,
                onSelect: () => {
                    setAutoQualityEnabled(controller, false);
                    controller._reloadSource({ qualityCapKbps: preset.kbps });
                    setValue(qualityCapMenuLabel(controller));
                    collapse();
                },
            })),
        ],
        { rowGap: 8 }
    );
}

/* "Quality Cap" navigates to its own screen (see buildAccordionRow's `nav` case)
   rather than expanding in place - same reasoning as Effects/Options, just for one
   control instead of a cluster of several. Reuses renderQualityCapSection's picker-
   list body unchanged: `list` stands in for the accordion `content` div it normally
   renders into, and `onBack` (navigate to the main list, which re-derives every row's
   value fresh) stands in for `collapse`, so picking a preset here needs no separate
   "update this row's value" step of its own. */
function renderQualityCapList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    renderQualityCapSection(controller, list, { setValue: () => {}, collapse: onBack });
}

/* A small on/off pill, e.g. Shader Upscaling's row in openHamburgerMenu - plain divs
   rather than a native <input type="checkbox">/<label> pair, since this nests inside a
   row that's itself a <button> and interactive controls can't nest inside one per the
   HTML content model. stopPropagation on click keeps a tap on the switch from also
   bubbling up into the row's own onSelect (which opens a submenu). */
export function makeToggleSwitch(checked, onChange) {
    let isOn = checked;
    const el = document.createElement("div");
    el.className = "prism-player-switch";
    el.setAttribute("role", "switch");
    el.setAttribute("aria-checked", String(isOn));
    const thumb = document.createElement("div");
    thumb.className = "prism-player-switch-thumb";
    el.appendChild(thumb);
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        isOn = !isOn;
        el.setAttribute("aria-checked", String(isOn));
        onChange(isOn);
    });
    return el;
}

export function closeInlineMenu(controller) {
    const wasOpen = !!controller._inlineMenuEl;
    if (controller._inlineMenuNav) {
        controller._inlineMenuNav.destroy();
        controller._inlineMenuNav = null;
    }
    if (controller._inlineMenuEl) {
        controller._inlineMenuEl.remove();
        controller._inlineMenuEl = null;
    }
    if (controller._inlineMenuScrim) {
        controller._inlineMenuScrim.remove();
        controller._inlineMenuScrim = null;
    }
    controller._inlineMenuAnchor = null;
    if (wasOpen) showControls(controller);
}
