import { hideControls, showControls } from "./chrome-controls.js";
import { wireLinearNav, focusAfterPaint } from "../../../focus-nav.js";
import { setAutoQualityEnabled, bandwidthSource } from "../core/abr.js";
import {
    QUALITY_CAP_PRESETS,
    SHEET_GRADIENT,
    MENU_SCROLL_CLASS,
    OVERLAY_CLOSE_BTN_CLASS,
    PLAYER_FOCUSABLE_CLASS,
    ensureMenuScrollStyle,
    episodesIconMarkup,
    chaptersIconMarkup,
    audioSubtitlesIconMarkup,
    versionIconMarkup,
    qualityCapIconMarkup,
    effectsIconMarkup,
    extrasIconMarkup,
    performanceIconMarkup,
    skipIconMarkup,
    PLAYER_MENU_ROW_CLASS,
} from "./shared.js";
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
import { renderExtrasList } from "./chrome-menu-extras.js";

/* The hamburger "More" sheet: its top-level accordion list (Episodes/Chapters/Audio &
   Subtitles/Version/Quality Cap/Auto-Play/Effects/Extras/Performance Overlay), the
   accordion-row/picker-list primitives
   shared with its Effects (chrome-menu-effects.js) and Extras (chrome-menu-extras.js)
   sub-screens, and the Version/Quality Cap pickers that stay inline here. Takes the
   StreamingPlayerController instance as an explicit first argument (see native-bridge.js/
   shader-pipeline.js for why) rather than owning independent state - the idle-fade timer
   and inline-menu bookkeeping are shared with the rest of the player chrome. */

/* Shared row look for every tap-to-pick item inside an expanded accordion section
   (speed/sleep/zoom/audio/chapters/quality-cap/version presets) - one visual
   definition instead of each render function styling its own. */
const INLINE_MENU_CLASS = "streaming-player-inline-menu";

export function renderPickerList(content, items, { rowGap = 0 } = {}) {
    items.forEach((item, index) => {
        const row = document.createElement("button");
        row.type = "button";
        row.classList.add(PLAYER_FOCUSABLE_CLASS, PLAYER_MENU_ROW_CLASS);
        Object.assign(row.style, {
            display: "flex",
            alignItems: "center",
            gap: "12px",
            width: "100%",
            textAlign: "left",
            padding: "9px 16px",
            background: "transparent",
            color: "#fff",
            border: "none",
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: "500",
            fontFamily: '"Roboto", sans-serif',
            marginBottom: index < items.length - 1 ? `${rowGap}px` : "0",
        });
        /* Only the Chapters section sets item.thumb - every other picker (speed, sleep
           timer, audio track...) leaves it undefined, so this is a no-op there. Hidden
           on error rather than left to show a broken-image icon - Plex's chapterImages
           endpoint isn't guaranteed pre-generated for every chapter. */
        if (item.thumb) {
            const thumb = document.createElement("img");
            thumb.src = item.thumb;
            thumb.loading = "lazy";
            thumb.alt = "";
            Object.assign(thumb.style, {
                width: "64px",
                height: "36px",
                borderRadius: "4px",
                objectFit: "cover",
                flex: "0 0 auto",
                background: "rgba(255,255,255,0.08)",
            });
            thumb.addEventListener("error", () => thumb.remove());
            row.appendChild(thumb);
        }
        const label = document.createElement("span");
        label.textContent = item.label;
        label.style.flex = "1 1 auto";
        row.appendChild(label);
        row.addEventListener("mouseenter", () => {
            row.style.background = "rgba(255,255,255,0.08)";
        });
        row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
        });
        row.addEventListener("click", () => item.onSelect && item.onSelect());
        content.appendChild(row);
    });
}

/* One row of the More sheet (also used by chrome-menu-extras.js's Extras sub-screen).
   Sections with `render` expand in place (accordion, one section open at a time per
   `state` - opening a new one collapses whatever else was open, via
   `state.expandedCollapse`); sections with `nav` instead replace the whole list with a
   different screen (see renderEffectsList/renderExtrasList) rather than expanding in
   place - used for "Effects"/"Extras", whose sub-controls read better as their own
   dedicated list than squeezed inline under a fourth row. Sections with only `toggle`
   (Auto-Play, Performance Overlay) are plain on/off rows with nothing to expand or
   navigate to. `toggle` and `render` are independent - Ambient Lighting has both,
   flipping on/off without affecting whether its opacity section is open. */
export function buildAccordionRow(list, state, section) {
    const wrap = document.createElement("div");
    wrap.style.borderBottom = "1px solid rgba(255,255,255,0.07)";

    const header = document.createElement("button");
    header.type = "button";
    header.classList.add(PLAYER_FOCUSABLE_CLASS, PLAYER_MENU_ROW_CLASS);
    Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        width: "100%",
        textAlign: "left",
        padding: "14px 16px",
        background: "transparent",
        border: "none",
        cursor: section.render || section.nav || section.toggle ? "pointer" : "default",
        fontFamily: '"Roboto", sans-serif',
    });

    const labelStack = document.createElement("span");
    Object.assign(labelStack.style, { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" });
    const labelEl = document.createElement("span");
    labelEl.textContent = section.label;
    Object.assign(labelEl.style, { color: "#fff", fontSize: "15px", fontWeight: "600" });
    labelStack.appendChild(labelEl);
    let valueEl = null;
    const setValue = (text) => {
        if (text) {
            if (!valueEl) {
                valueEl = document.createElement("span");
                Object.assign(valueEl.style, { fontSize: "12px", fontWeight: "400", color: "rgba(255,255,255,0.45)" });
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
    Object.assign(leftSide.style, { display: "flex", alignItems: "center", gap: "12px", minWidth: "0", flex: "1 1 auto" });
    if (section.icon) {
        const iconEl = document.createElement("span");
        iconEl.innerHTML = section.icon;
        Object.assign(iconEl.style, { display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto", width: "20px", height: "20px", color: "rgba(255,255,255,0.75)" });
        leftSide.appendChild(iconEl);
    }
    leftSide.appendChild(labelStack);
    header.appendChild(leftSide);

    const rightSide = document.createElement("span");
    Object.assign(rightSide.style, { display: "flex", alignItems: "center", gap: "12px", flex: "0 0 auto" });
    let toggleEl = null;
    if (section.toggle) {
        toggleEl = makeToggleSwitch(section.toggle.checked, (checked) => setValue(section.toggle.onChange(checked)));
        rightSide.appendChild(toggleEl);
    }

    let chevronEl = null;
    if (section.render || section.nav) {
        chevronEl = document.createElement("span");
        chevronEl.textContent = "›";
        Object.assign(chevronEl.style, { color: "rgba(255,255,255,0.35)", fontSize: "17px", display: "inline-block", transition: "transform 0.15s ease" });
        rightSide.appendChild(chevronEl);
    }
    if (rightSide.children.length) header.appendChild(rightSide);
    wrap.appendChild(header);

    if (section.render) {
        const content = document.createElement("div");
        content.style.display = "none";
        content.style.padding = "0 0 12px";
        wrap.appendChild(content);

        header.setAttribute("aria-expanded", "false");
        let built = false;
        const collapse = () => {
            content.style.display = "none";
            chevronEl.style.transform = "rotate(0deg)";
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
            if (content.style.display !== "none") {
                collapse();
                return;
            }
            if (state.expandedCollapse) state.expandedCollapse();
            if (!built) {
                built = true;
                section.render(content, { setValue, collapse });
            }
            content.style.display = "block";
            chevronEl.style.transform = "rotate(90deg)";
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

    list.appendChild(wrap);
}

/* Every navigated-to sub-list (Effects', Extras', Quality Cap's) gets the same dimmed,
   divider-topped "back up a level" row instead of each screen styling its own -
   distinguishes "leave this screen" from a selectable option in a way a plain row
   sharing the same style as everything else couldn't. */
export function makeBackRow(onClick) {
    const row = document.createElement("button");
    row.type = "button";
    row.classList.add(PLAYER_FOCUSABLE_CLASS, PLAYER_MENU_ROW_CLASS);
    row.textContent = "‹  Back";
    Object.assign(row.style, {
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
        color: "rgba(255,255,255,0.55)",
        fontSize: "12px",
        fontWeight: "700",
        letterSpacing: "0.02em",
        cursor: "pointer",
        padding: "14px 16px",
        fontFamily: '"Roboto", sans-serif',
    });
    row.addEventListener("mouseenter", () => {
        row.style.color = "#fff";
    });
    row.addEventListener("mouseleave", () => {
        row.style.color = "rgba(255,255,255,0.55)";
    });
    row.addEventListener("click", onClick);
    return row;
}

/* Rebuilding a screen's list (a full nav swap - Quality Cap/Effects/Extras and Extras' own
   Playback Speed/Zoom/Sleep Timer screens - or renderMainList itself) replaces whatever button
   was focused with a brand-new DOM subtree - the old element is gone, and nothing else claims
   focus in its place, so the browser drops it to <body>. Left alone, that silently breaks every
   subsequent D-pad/keyboard command: wireLinearNav's handler only ever acts when focus is
   already inside its own list, so the whole sheet would stop responding to B *and*
   Up/Down/Left/Right the moment a viewer navigated anywhere - it just happened to read as "B
   doesn't back out" because that's the one thing a mouse user would notice too. Exported (rather
   than a private helper closing over one `list`) so chrome-menu-extras.js's own nested screens
   can call it too - see its renderExtrasList. */
export function refocusList(list) {
    focusAfterPaint(list.querySelector("button"));
}

export function openHamburgerMenu(controller, anchor) {
    closeInlineMenu(controller);
    ensureMenuScrollStyle();
    const session = controller._session;

    const scrim = document.createElement("div");
    Object.assign(scrim.style, { position: "fixed", inset: "0", zIndex: "10002", background: "transparent" });
    scrim.addEventListener("click", () => closeInlineMenu(controller));

    /* Full-height, right-hugging gradient backdrop (unchanged from the drawer this
       replaced) - the header+list card inside it (see `card` below) is what's actually
       vertically centered, via justifyContent, rather than the gradient itself
       shrinking to the card's height. A full-height backdrop that shrank to a short
       row list's own height left a stretch of plain, undarkened video below a
       vertically-centered card - the backdrop needs to keep covering the full screen
       height regardless of how tall the card inside it happens to be. */
    const sheet = document.createElement("div");
    Object.assign(sheet.style, {
        position: "fixed",
        top: "0",
        right: "0",
        bottom: "0",
        width: "min(400px, 100vw)",
        zIndex: "10003",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: SHEET_GRADIENT,
        fontFamily: '"Roboto", sans-serif',
        boxSizing: "border-box",
        opacity: "0",
        transform: "translateX(20px)",
        transition: "opacity 0.2s ease, transform 0.2s ease",
    });

    /* The actual visible "menu" - header plus scrollable row list, capped at 82vh and
       otherwise sized to its own content (a short row list, e.g. the Effects/Extras
       sub-screens, centers as a short card rather than stretching to fill the full
       backdrop). */
    const card = document.createElement("div");
    Object.assign(card.style, { display: "flex", flexDirection: "column", maxHeight: "82vh", minHeight: "0" });
    sheet.appendChild(card);

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", flex: "0 0 auto", padding: "24px 16px 12px" });
    const heading = document.createElement("div");
    heading.textContent = "More";
    Object.assign(heading.style, { color: "#fff", fontSize: "18px", fontWeight: "700" });
    header.appendChild(heading);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.classList.add(OVERLAY_CLOSE_BTN_CLASS, PLAYER_FOCUSABLE_CLASS);
    closeBtn.setAttribute("aria-label", "Close menu");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, {
        width: "32px",
        height: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        background: "transparent",
        color: "#fff",
        fontSize: "16px",
        cursor: "pointer",
        padding: "0",
    });
    closeBtn.addEventListener("click", () => closeInlineMenu(controller));
    header.appendChild(closeBtn);
    card.appendChild(header);

    const list = document.createElement("div");
    list.className = MENU_SCROLL_CLASS;
    Object.assign(list.style, { flex: "1 1 auto", minHeight: "0", overflowY: "auto", padding: "0 0 20px" });
    card.appendChild(list);

    /* Tracks "what should B/Escape do right now" - closeInlineMenu at the main list, or back up to
       the main list from whichever sub-screen (Quality Cap/Effects/Extras) is currently showing in
       this same `list` element. Reassigned by renderMainList and by each sub-screen's own `nav`
       entry below, rather than menuNav's onBack hardcoding one or the other, so gamepad/keyboard
       "back" matches exactly what the mouse-driven "‹ Back" row (makeBackRow) already does.
       Extras nests one level deeper still (its own Playback Speed/Zoom/Sleep Timer screens) - see
       setGoBack below for why a plain reassignment here isn't enough on its own for that case. */
    let goBack = () => closeInlineMenu(controller);
    /* Passed into renderExtrasList so its own nav callbacks can point `goBack` at Extras' own
       screen (not all the way back to Main) when the viewer drills one level deeper still, then
       back at `renderMainList` again once they return to Extras' top screen - chrome-menu.js owns
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
       two platforms read as the same app: what-you're-watching controls (Episodes/Chapters/
       Audio & Subtitles) first, since those get touched per-video; source/quality (Version/
       Quality Cap) and the Auto-Play toggle next; Effects/Extras/Performance Overlay last, in
       that order - the three rows here most people set once and never revisit. */
    const sections = [];
    /* Used to be a standalone transport-bar button (chrome-transport.js's leftCell) - moved here
       to match Android, whose chrome has no standalone Episodes icon either. Same "seasonNumber
       present means a TV episode with siblings to browse" wording that button and episode-list.js's
       own overlay heading already used - see formatEpisodeListItem's neighbouring reasoning. */
    if (session?.queueRatingKeys?.length > 1) {
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
               openChapterListOverlay), matching how opening the Episodes overlay
               already closes this sheet too. */
            key: "chapters",
            label: "Chapters",
            icon: chaptersIconMarkup(),
            nav: () => openChapterListOverlay(controller),
        });
    }
    sections.push({
        /* Used to be its own standalone transport-bar icon (chrome-transport.js's rightCell) -
           moved here to match Android, whose chrome puts this in its More menu too rather than a
           top-level icon (see PlayerUiHelper.java). openAudioSubtitlesOverlay already closes this
           sheet itself, same as Chapters/Episodes above. */
        key: "audiosubtitles",
        label: "Audio & Subtitles",
        icon: audioSubtitlesIconMarkup(),
        nav: () => openAudioSubtitlesOverlay(controller),
    });
    /* Version and Quality Cap used to live one level deeper, behind a "Video Quality"
       row - flattened to their own top-level rows (Version only shown when this item
       actually has more than one Media[] entry, same "never an empty/dead affordance"
       rule Audio Track/Chapters follow) so changing either is one fewer tap. Quality
       Cap is always shown since it always has at least "Original" to show. */
    if (session?.mediaVersions?.length > 1) {
        sections.push({
            key: "version",
            label: "Version",
            icon: versionIconMarkup(),
            getValue: () => session.mediaVersions.find((v) => v.mediaIndex === session.mediaIndex)?.label || null,
            render: (content, helpers) => renderVersionSection(controller, content, helpers),
        });
    }
    sections.push({
        /* Own dedicated screen (see renderQualityCapList), not an inline expand - same
           reasoning as Subtitles above. */
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
        key: "autoplay",
        label: "Auto-Play",
        /* No expand - same plain on/off toggle as Performance Overlay below, nothing
           to drill into (advancing to whatever's next in the queue is the whole
           feature, no strength/opacity to tune). Icon reuses skipIconMarkup's "next"
           glyph - advancing to the next queued item is exactly what this toggle does. */
        icon: skipIconMarkup("next"),
        getValue: () => (controller._autoPlayEnabled ? "On" : null),
        toggle: {
            checked: controller._autoPlayEnabled,
            onChange: (checked) => {
                controller._setAutoPlayEnabled(checked);
                return checked ? "On" : null;
            },
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
        /* Same "own dedicated screen" reasoning as Effects above, for Playback Speed/
           Zoom/Sleep Timer (see chrome-menu-extras.js's renderExtrasList) - grouped as
           "Extras" since none of the three relate to each other the way Effects' three
           GPU-pipeline controls do, but each is simple/single-picker enough that
           squeezing all three top-level rows down to one still reads as a sensible
           cluster (playback tweaks that aren't part of the everyday audio/subtitle/
           quality set above). */
        key: "extras",
        label: "Extras",
        icon: extrasIconMarkup(),
        nav: () => {
            goBack = renderMainList;
            /* Extras nests one level deeper than Effects/Quality Cap - its own three rows (Playback
               Speed/Zoom/Sleep Timer) each navigate to their own screen too, rather than expanding
               in place - so it needs a way to point `goBack` at its own top screen (not all the way
               to Main) while one of those is open. See setGoBack's own comment above. */
            renderExtrasList(controller, list, renderMainList, setGoBack);
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
                controller._setStatsOverlayEnabled(checked);
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
    /* A stable class so gamepad navigation can scope a selector to this sheet. wireLinearNav is given
       `document` as its root rather than the sheet itself: it reads root.activeElement, which only
       exists on Document and ShadowRoot - a plain <div> would report undefined and the handler would
       never consider itself in scope. */
    sheet.classList.add(INLINE_MENU_CLASS);
    /* Without this the sheet opens with focus still nowhere, so wireLinearNav's own "is focus inside my
       list" guard never passes and D-pad input does nothing. Also includes input[type=range] (only
       present on chrome-menu-effects.js's Effects sub-screen) so its Shader Upscaling/Color Boost/
       Ambient Lighting sliders are themselves reachable Up/Down stops, not just their Auto/On/Off
       mode buttons - a disabled slider (see buildModeRow's applyStrengthDisplay) is skipped for free,
       since items() already filters out disabled elements. */
    const menuNav = wireLinearNav(document, `.${INLINE_MENU_CLASS} button:not(.${OVERLAY_CLOSE_BTN_CLASS}), .${INLINE_MENU_CLASS} input[type="range"]`, {
        orientation: "vertical",
        loop: true,
        /* Back up a screen (Quality Cap/Effects/Extras -> the main list) if one is open, else close
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
        sheet.style.opacity = "1";
        sheet.style.transform = "translateX(0)";
    });
}

/* "Auto (720p (10 Mbps))" while Auto Quality is actively adjusting the cap, else the
   plain preset label. Shared by the top-level "Quality Cap" row's own value and its
   expanded picker list so the two never show a different answer for the same state. */
function qualityCapMenuLabel(controller) {
    const label = QUALITY_CAP_PRESETS.find((p) => (p.kbps ?? null) === (controller._session?.qualityCapKbps ?? null))?.label || null;
    return controller._autoQualityEnabled ? `Auto (${label})` : label;
}

function renderVersionSection(controller, content, { setValue, collapse }) {
    const session = controller._session;
    const versions = session?.mediaVersions || [];
    renderPickerList(content, versions.map((v) => ({
        label: `${v.label}${v.mediaIndex === session.mediaIndex ? "  ✓" : ""}`,
        onSelect: () => {
            controller._reloadSource({ mediaIndex: v.mediaIndex });
            setValue(v.label);
            collapse();
        },
    })));
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
   rather than expanding in place - same reasoning as Effects/Extras, just for one
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
    el.setAttribute("role", "switch");
    el.setAttribute("aria-checked", String(isOn));
    Object.assign(el.style, {
        position: "relative",
        width: "34px",
        height: "20px",
        flex: "0 0 auto",
        borderRadius: "10px",
        background: isOn ? "#e5a00d" : "rgba(255,255,255,0.25)",
        transition: "background 0.15s ease",
        cursor: "pointer",
    });
    const thumb = document.createElement("div");
    Object.assign(thumb.style, {
        position: "absolute",
        top: "2px",
        left: isOn ? "16px" : "2px",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        transition: "left 0.15s ease",
    });
    el.appendChild(thumb);
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        isOn = !isOn;
        el.setAttribute("aria-checked", String(isOn));
        el.style.background = isOn ? "#e5a00d" : "rgba(255,255,255,0.25)";
        thumb.style.left = isOn ? "16px" : "2px";
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
