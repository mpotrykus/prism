import { hideControls, showControls } from "./chrome-controls.js";
import { reloadWebSource } from "../web-fallback.js";
import { setAutoQualityEnabled } from "../core/abr.js";
import {
    QUALITY_CAP_PRESETS,
    SHEET_GRADIENT,
    MENU_SCROLL_CLASS,
    ensureMenuScrollStyle,
    chaptersIconMarkup,
    versionIconMarkup,
    qualityCapIconMarkup,
    effectsIconMarkup,
    extrasIconMarkup,
    performanceIconMarkup,
    skipIconMarkup,
} from "./shared.js";
/* Circular with episode-list.js (which imports playQueuedTitle/formatTime from
   chrome-transport.js) - safe here because both sides only reference the other module's
   export from inside a function body (openChapterListOverlay is called from a click
   handler, long after both modules have finished loading), never at top-level module-
   evaluation time. */
import { openChapterListOverlay } from "./episode-list.js";
import { renderEffectsList } from "./chrome-menu-effects.js";
import { renderExtrasList } from "./chrome-menu-extras.js";

/* The hamburger "More" sheet: its top-level accordion list (Chapters/Version/Quality Cap/
   Auto-Play/Effects/Extras/Performance Overlay), the accordion-row/picker-list primitives
   shared with its Effects (chrome-menu-effects.js) and Extras (chrome-menu-extras.js)
   sub-screens, and the Version/Quality Cap pickers that stay inline here. Takes the
   StreamingPlayerController instance as an explicit first argument (see native-bridge.js/
   shader-pipeline.js for why) rather than owning independent state - the idle-fade timer
   and inline-menu bookkeeping are shared with the rest of the player chrome. */

/* Shared row look for every tap-to-pick item inside an expanded accordion section
   (speed/sleep/zoom/audio/chapters/quality-cap/version presets) - one visual
   definition instead of each render function styling its own. */
export function renderPickerList(content, items, { rowGap = 0 } = {}) {
    items.forEach((item, index) => {
        const row = document.createElement("button");
        row.type = "button";
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
        cursor: section.render || section.nav ? "pointer" : "default",
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
    if (section.toggle) {
        rightSide.appendChild(makeToggleSwitch(section.toggle.checked, (checked) => setValue(section.toggle.onChange(checked))));
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

    function renderMainList() {
    list.innerHTML = "";
    const state = { expandedCollapse: null };
    /* Ordered by how often a row is actually touched, not the order features shipped
       in: what-you're-watching controls (Chapters/Audio & Subtitles) first, since
       those get touched per-video; source/quality (Version/Quality Cap) and the
       Auto-Play toggle next; Effects/Extras/Performance Overlay last, in that order -
       the three rows here most people set once and never revisit. */
    const sections = [];
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
        nav: () => renderQualityCapList(controller, list, renderMainList),
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
        /* Navigates to a dedicated Shader Upscaling/Color Boost/Ambient Lighting list
           (see chrome-menu-effects.js's renderEffectsList) rather than expanding in
           place - three sub-controls read better as their own screen than squeezed
           inline under a fourth row. */
        key: "effects",
        label: "Effects",
        icon: effectsIconMarkup(),
        nav: () => renderEffectsList(controller, list, renderMainList),
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
        nav: () => renderExtrasList(controller, list, renderMainList),
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
    }

    renderMainList();

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    controller._inlineMenuEl = sheet;
    controller._inlineMenuScrim = scrim;
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
            reloadWebSource(controller, { mediaIndex: v.mediaIndex });
            setValue(v.label);
            collapse();
        },
    })));
}

function renderQualityCapSection(controller, content, { setValue, collapse }) {
    const session = controller._session;
    const current = session?.qualityCapKbps ?? null;
    const autoOn = controller._autoQualityEnabled;
    /* No bandwidth signal exists on the native-HLS <video> branch (controller._hls is
       null there, see web-fallback.js's attachSource) - Auto Quality has nothing to
       evaluate against, so the row is omitted entirely rather than shown disabled.
       The persisted flag itself is untouched either way, so it still takes effect on
       a future session/device that does use hls.js. */
    const autoAvailable = !!controller._hls;
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
                    reloadWebSource(controller, { qualityCapKbps: preset.kbps });
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
