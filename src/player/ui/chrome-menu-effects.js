import { SHADER_TYPES } from "../shader/shaders.js";
import {
    setShaderStrength,
    setColorBoostSaturationStrength,
    setColorBoostContrastStrength,
    upscaleModeOf,
    setUpscaleMode,
    colorBoostSaturationModeOf,
    setColorBoostSaturationMode,
    colorBoostContrastModeOf,
    setColorBoostContrastMode,
    idleUpgradeLabel,
} from "../shader-pipeline.js";
import { setAmbientOpacity } from "../ambient-pipeline.js";
import { fullscreenIconMarkup, colorBoostIconMarkup, ambientIconMarkup, aiUpscalingIconMarkup, PLAYER_FOCUSABLE_CLASS } from "./shared.js";
/* Circular with chrome-menu.js (which imports renderEffectsList from this file for its
   "Effects" row) - safe here because both sides only reference the other module's
   export from inside a function body (makeBackRow/makeToggleSwitch are only called once
   renderEffectsList itself actually runs, well after both modules have finished
   loading), never at top-level module-evaluation time. */
import { makeBackRow, makeToggleSwitch } from "./chrome-menu.js";

/* The hamburger "More" sheet's Effects sub-screen: AI Upscaling/Sharpening/Color Boost/
   Ambient Lighting, each a plain always-visible row (not an accordion section, see
   renderEffectsList). Sharpening and AI Upscaling used to be one row that silently swapped
   which algorithm it meant depending on runtime state - split into two independent toggles
   since they're genuinely different algorithms (a hand-written sharpen kernel vs. a trained
   CNN/analytic upscaler) with different costs and no reason to share one on/off state. */

/* "Effects" navigates to a whole separate list (see chrome-menu.js's buildAccordionRow
   `nav` case) rather than expanding in place - these four read better as their own
   dedicated screen than squeezed inline under a fifth row. Clears and rebuilds `list` in
   place (same element, new contents) rather than swapping in a second list element, so the
   sheet's own scroll position/height logic doesn't need to know which screen is currently
   showing. Unlike the main list's rows, these are plain always-visible rows (see
   buildEffectRow) rather than accordion sections - each one landing on either a slider or a
   toggle, so tap-to-expand would only have added a step between opening "Effects" and
   reaching the control someone came here for. */
export function renderEffectsList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    buildAiUpscalingEffectRow(controller, list);
    buildShaderEffectRow(controller, list);
    buildColorBoostEffectRow(controller, list);
    buildAmbientEffectRow(controller, list);
}

const MODE_OPTIONS = [
    { key: "auto", label: "Auto" },
    { key: "on", label: "On" },
    { key: "off", label: "Off" },
];

/* Shared by buildShaderEffectRow/buildColorBoostEffectRow - a 3-way Auto/On/Off segmented control
   replacing the old separate enabled-toggle (hamburger row) + "Auto strength" checkbox
   (panel) pair, collapsed into shader-pipeline.js's upscaleModeOf/setUpscaleMode (and the
   Color Boost equivalents) - see those functions' own comments for why the underlying
   _shaderEnabled/_upscaleAuto flags stay as they were rather than being replaced outright.
   Disables the manual slider and snapshots the current auto-resolved value into it only
   in "auto" mode - "on" and "off" both leave it showing/editable at the manual value,
   same as the old enabled-toggle-off case always did (adjusting the remembered strength
   while the effect itself isn't currently applied). Snapshotting only happens at
   mode-switch time (not live-ticking while the panel stays open) since
   content-analysis.js only updates every ~750ms and the panel is normally only glanced
   at, not watched.

   `strips` is a list of {strengthInput, strengthLabel, getAutoValue, getManualValue, label}
   rather than one flat set of those params - Color Boost's Saturation and Contrast are two
   independent sliders sharing this one mode row (there's only one avgSaturation-driven auto
   signal, so both strips read the same getAutoValue in "auto"), while Sharpening still just
   passes a single-entry array. */
function buildModeRow({ groupId, mode, onModeChange, strips }) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", padding: "0 0 10px" });

    let currentMode = mode;
    const applyStrengthDisplay = (m) => {
        const auto = m === "auto";
        /* Only "on" leaves the slider interactive - "auto" because the value isn't
           user-driven, and "off" because there's no effect running for it to tune, same
           reasoning "off" already gets a dimmed/disabled mode button of its own. */
        const enabled = m === "on";
        strips.forEach(({ strengthInput, strengthLabel, getAutoValue, getManualValue, label }) => {
            strengthInput.disabled = !enabled;
            strengthInput.style.opacity = enabled ? "1" : "0.5";
            strengthInput.style.cursor = enabled ? "pointer" : "default";
            const value = auto ? (getAutoValue() ?? 0) : getManualValue();
            strengthInput.value = String(Math.round(value * 100));
            strengthLabel.textContent = `${label}: ${Math.round(value * 100)}%${auto ? " (auto)" : ""}`;
        });
    };

    const buttons = MODE_OPTIONS.map((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.classList.add(PLAYER_FOCUSABLE_CLASS);
        /* See focus-nav.js's wireLinearNav: the same data-nav-group value on every button in
           this row makes Left/Right cycle between the modes while Up/Down skips the whole row
           in one step, landing on the slider (or whatever's next) instead of stepping through
           each mode button individually. */
        btn.dataset.navGroup = groupId;
        btn.textContent = opt.label;
        Object.assign(btn.style, {
            width: "44px",
            textAlign: "center",
            boxSizing: "border-box",
            padding: "6px 0",
            fontSize: "12px",
            fontWeight: "600",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "6px",
            cursor: "pointer",
            background: "transparent",
            color: "rgba(255,255,255,0.7)",
        });
        btn.addEventListener("click", () => {
            currentMode = opt.key;
            onModeChange(opt.key);
            setActive(opt.key);
            applyStrengthDisplay(opt.key);
        });
        row.appendChild(btn);
        return { key: opt.key, btn };
    });

    const setActive = (activeMode) => {
        buttons.forEach(({ key, btn }) => {
            const selected = key === activeMode;
            btn.style.background = selected ? "#e5a00d" : "transparent";
            btn.style.color = selected ? "#1a1a1a" : "rgba(255,255,255,0.7)";
            btn.style.borderColor = selected ? "#e5a00d" : "rgba(255,255,255,0.15)";
        });
    };
    setActive(mode);
    applyStrengthDisplay(mode);

    /* Lets the caller re-run the auto-value refresh (see startLiveAutoRefresh below)
       without duplicating applyStrengthDisplay's formatting/disabled-state logic - a
       no-op whenever this row isn't currently in "auto" mode, so it's safe to call
       blindly on a timer. */
    const refreshIfAuto = () => {
        if (currentMode === "auto") applyStrengthDisplay("auto");
    };

    return { row, refreshIfAuto };
}

/* Ticks `refresh` while `el` stays in the DOM, then stops itself - used by the two
   Effects rows with an Auto mode (Shader Upscaling/Color Boost) to reflect
   content-analysis.js's background strength recalculation (every ~750ms, see
   CONTENT_SAMPLE_INTERVAL_MS there) instead of leaving a stale snapshot from whenever
   "Auto" was last tapped. Polls DOM connectedness rather than requiring an explicit
   teardown call, since this row can disappear via several different paths (back
   navigation, closing the whole sheet) that would otherwise each need their own
   cleanup wired in. */
function startLiveAutoRefresh(el, refresh) {
    const id = setInterval(() => {
        if (!el.isConnected) {
            clearInterval(id);
            return;
        }
        refresh();
    }, 750);
}

/* Shared shell for the three Effects rows below - icon+label (and an optional caption
   under the label) on the left, whatever control(s) belong at a glance (mode buttons or
   a toggle) on the right, matching chrome-menu.js's buildAccordionRow header layout
   minus the chevron/click-to-expand behavior. Returns `rightSide` for the caller to drop
   its control into, `header` for the caller to wire up (see `toggleReachable` below), and
   the row itself (`wrap`) for the caller to append full-width content (e.g. a slider) below
   the header line.

   `header` is a plain, unclickable div unless `toggleReachable` is set - Sharpening
   and Color Boost don't need it: their Auto/On/Off mode buttons (buildModeRow) are real
   `<button>`s already reachable by chrome-menu.js's wireLinearNav. Ambient Lighting has no
   such button, only a bare on/off toggle switch (a div, see makeToggleSwitch - never a
   focus target itself), which left it completely unreachable via D-pad/keyboard - the same
   bug buildAccordionRow's toggle-only rows (Auto-Play/Performance Overlay) had, fixed there
   by making the row's own header a real, wired-up button instead of leaving the switch as
   the only way to flip it. */
function buildEffectRow(list, { icon, label, caption, toggleReachable = false }) {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { borderBottom: "1px solid rgba(255,255,255,0.07)", padding: "14px 16px" });

    const header = document.createElement(toggleReachable ? "button" : "div");
    if (toggleReachable) {
        header.type = "button";
        header.classList.add(PLAYER_FOCUSABLE_CLASS);
    }
    Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        width: "100%",
        textAlign: "left",
        border: "none",
        background: "transparent",
        padding: "0",
        cursor: toggleReachable ? "pointer" : "default",
        fontFamily: '"Roboto", sans-serif',
    });

    const leftSide = document.createElement("span");
    Object.assign(leftSide.style, { display: "flex", alignItems: "center", gap: "12px", minWidth: "0", flex: "1 1 auto" });
    const iconEl = document.createElement("span");
    iconEl.innerHTML = icon;
    Object.assign(iconEl.style, { display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto", width: "20px", height: "20px", color: "rgba(255,255,255,0.75)" });
    leftSide.appendChild(iconEl);

    const labelStack = document.createElement("span");
    Object.assign(labelStack.style, { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" });
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    Object.assign(labelEl.style, { color: "#fff", fontSize: "15px", fontWeight: "600" });
    labelStack.appendChild(labelEl);
    if (caption) {
        const captionEl = document.createElement("span");
        captionEl.textContent = caption;
        Object.assign(captionEl.style, { fontSize: "11px", fontWeight: "400", color: "rgba(255,255,255,0.45)" });
        labelStack.appendChild(captionEl);
    }
    leftSide.appendChild(labelStack);
    header.appendChild(leftSide);

    const rightSide = document.createElement("span");
    Object.assign(rightSide.style, { display: "flex", alignItems: "center", gap: "12px", flex: "0 0 auto" });
    header.appendChild(rightSide);

    wrap.appendChild(header);
    list.appendChild(wrap);
    return { wrap, rightSide, header };
}

/* Reuses fullscreenIconMarkup's expand-corners glyph - a sharpen kernel is, visually, the same
   "stretch the picture outward" idea. No manual Off/Anime4K/Live-Action picker -
   controller._shaderAutoType is decided once per video from its Plex genre tags (see
   detectShaderType) and shown here as read-only info via the caption. The mode row + slider
   are the only remaining controls, and dragging strength to 0% in "on" mode is what a plain
   "Off" used to be.

   This is deliberately always the full mode-row+slider now, with no branching on whether AI
   Upscaling happens to be the thing actually rendering - that branching (via activePresetKey/
   strengthless) is what made this feel like one feature secretly swapping algorithms
   underneath a single toggle. AI Upscaling is its own row below with its own toggle;
   Sharpening's own row no longer needs to know or care what it's doing. */
function buildShaderEffectRow(controller, list) {
    const familyLabel = SHADER_TYPES[controller._shaderAutoType].label;
    const { wrap, rightSide } = buildEffectRow(list, {
        icon: fullscreenIconMarkup(false),
        label: "Sharpening",
        caption: `Detected: ${familyLabel}`,
    });

    const strengthLabel = document.createElement("div");
    Object.assign(strengthLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "10px 0 4px" });

    const strengthInput = document.createElement("input");
    strengthInput.type = "range";
    strengthInput.min = "0";
    strengthInput.max = "100";
    strengthInput.classList.add(PLAYER_FOCUSABLE_CLASS);
    Object.assign(strengthInput.style, { display: "block", width: "100%", accentColor: "#e5a00d", cursor: "pointer", boxSizing: "border-box" });
    strengthInput.addEventListener("input", () => {
        strengthLabel.textContent = `Strength: ${strengthInput.value}%`;
        setShaderStrength(controller, Number(strengthInput.value) / 100);
    });

    const { row: modeRow, refreshIfAuto } = buildModeRow({
        groupId: "shader-mode",
        mode: upscaleModeOf(controller),
        onModeChange: (mode) => setUpscaleMode(controller, mode),
        strips: [{
            strengthInput,
            strengthLabel,
            label: "Strength",
            getAutoValue: () => controller._autoUpscaleStrength,
            getManualValue: () => controller._shaderStrength,
        }],
    });
    rightSide.appendChild(modeRow);
    wrap.appendChild(strengthLabel);
    wrap.appendChild(strengthInput);
    startLiveAutoRefresh(strengthInput, refreshIfAuto);
}

/* The chain that is actually built, not the preset's own `passes` - for the CNN/FSR presets
   that's the same thing (their composition is fixed, deband included), but reading the real
   compiled chain here is what stays correct if that ever stops being true. */
function presetPassCount(controller, preset) {
    for (const [key, chain] of Object.entries(controller._shaderChains ?? {})) {
        if (SHADER_TYPES[key] === preset) return chain.passCount;
    }
    return preset.passes.length;
}

/* Mirrors stats-overlay.js's xboxAiUpscalingStatusLine, worded for the Effects menu rather than
   the debug overlay - reads native's own reported state (AiUpscaleFrameServer's "aiUpscaleStatus"
   event, stashed on controller._xboxAiUpscaleStatus by xbox-bridge.js) instead of the JS GL
   chain checks the web leg relies on, which never exist on Xbox. Only called while the toggle is
   already known to be on (see buildAiUpscalingEffectRow). */
function xboxAiUpscalingCaption(controller, preset) {
    if (controller._session?.isHdr) return "Not supported on HDR titles";
    const status = controller._xboxAiUpscaleStatus;
    if (!status) return "Starting...";
    if (status.error) return `Error: ${status.error}`;
    if (!status.receivedFrame) return "Waiting for video...";
    /* preset is already the resolved UPGRADE entry (e.g. SHADER_TYPES.anime4k_cnn, label
       "Animation (AI CNN)") - status.family is only the bare family key ("anime4k"), whose own
       label ("Animation") says nothing about the real CNN/FSR chain actually running. Real bug
       hit and fixed 2026-08-20: this used to prefer SHADER_TYPES[status.family]?.label, which
       resolves to the plain family label every time (it's never null/undefined) - so this
       caption never actually distinguished "running" from "off" state, and toggling AI
       Upscaling produced no visible caption change at all. */
    if (status.upscaled) return `${preset.label} running`;
    // Native reports "not upscaled" for two different reasons: FSR1 (live-action) isn't ported
    // yet (Stage 2b), or an error mid-chain fell back to plain pass-through this frame.
    if (status.family && status.family !== "anime4k") return `${status.family} not supported here yet`;
    return `${preset.label} idle - pass-through`;
}

/* AI Upscaling (the real Anime4K CNN / FSR 1 chains): a plain on/off toggle, independent of
   Sharpening's own toggle - no strength slider (see `strengthless`, a trained network/analytic
   upscaler has no intensity knob) and no Auto (there's nothing for Auto to compute either). Same
   toggle-reachable header treatment as Ambient Lighting, for the same D-pad reason.

   "Independent" no longer means "mutually exclusive": Sharpening's own kernel always runs as a
   trailing pass on top of AI Upscaling's output now (see shaders.js's buildAnime4kCnn/buildFsr)
   rather than one toggle silently superseding the other - explicit user call. The pass count in
   the caption below already reflects that extra pass when it applies.

   The caption does the same explaining idleUpgradeLabel always did, just covering the "off"
   and "unsupported" states too now that this is its own row rather than one that only existed
   when the upgrade was already the thing rendering. */
function buildAiUpscalingEffectRow(controller, list) {
    const familyKey = controller._shaderAutoType;
    const upgradeKey = SHADER_TYPES[familyKey]?.upgradeTo;
    const preset = upgradeKey ? SHADER_TYPES[upgradeKey] : null;
    const isXbox = controller._xboxIsHdr !== undefined;

    let caption;
    if (!preset) {
        caption = "Not supported on this device";
    } else if (isXbox) {
        /* Xbox has no JS-side GL pass chain at all - native does the work (see
           AiUpscaleFrameServer) - so the _shaderChainErrors/_shaderChains checks below never
           apply here and unconditionally read "Not supported on this device" regardless of
           whether AI Upscaling is actually running. Real bug hit and fixed 2026-08-20: the
           same class of bug stats-overlay.js's xboxAiUpscalingStatusLine already guards
           against, just never applied to this (far more visible) menu caption too. */
        caption = controller._aiUpscalingEnabled ? xboxAiUpscalingCaption(controller, preset) : preset.label;
    } else if (controller._shaderChainErrors?.[upgradeKey]) {
        caption = `${preset.label} failed to compile here`;
    } else if (!controller._shaderChains?.[upgradeKey]) {
        caption = "Not supported on this device";
    } else if (!controller._aiUpscalingEnabled) {
        caption = preset.label;
    } else {
        /* Already fully worded ("... idle - source not upscaled" / "... off - too slow here")
           when there's a reason it isn't currently the one rendering - only the running case
           needs assembling here. */
        caption = idleUpgradeLabel(controller, familyKey) ?? `${preset.label} · ${presetPassCount(controller, preset)} passes`;
    }

    const { rightSide, header } = buildEffectRow(list, {
        icon: aiUpscalingIconMarkup(),
        label: "AI Upscaling",
        caption,
        toggleReachable: true,
    });
    const toggleEl = makeToggleSwitch(!!controller._aiUpscalingEnabled, (checked) => controller._setAiUpscalingEnabled(checked));
    rightSide.appendChild(toggleEl);
    header.addEventListener("click", () => toggleEl.click());
}

/* One sub-control (its own title, its own Auto/On/Off mode row, its own slider) - shared by
   buildColorBoostEffectRow's Saturation and Contrast sections below. Fully independent now:
   each has its own enabled/auto pair and auto-derives from its own signal (avgSaturation for
   Saturation, lumaStdDev for Contrast - see shaders.js's autoColorBoostStrength/
   autoContrastBoostStrength), so unlike the shared-mode-row this replaced, there's nothing left
   to couple the two through. Own groupId per section so focus-nav.js's Left/Right cycling
   between mode buttons stays scoped to one section's own three buttons, not both. */
function buildColorBoostComponentSection(controller, { title, groupId, modeOf, setMode, getManualValue, setStrength, getAutoValue }) {
    const section = document.createElement("div");
    Object.assign(section.style, { marginTop: "10px" });

    const header = document.createElement("div");
    Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" });
    const titleEl = document.createElement("span");
    titleEl.textContent = title;
    Object.assign(titleEl.style, { color: "rgba(255,255,255,0.85)", fontSize: "13px", fontWeight: "600" });
    header.appendChild(titleEl);

    const strengthLabel = document.createElement("div");
    Object.assign(strengthLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "10px 0 4px" });

    const strengthInput = document.createElement("input");
    strengthInput.type = "range";
    strengthInput.min = "0";
    strengthInput.max = "100";
    strengthInput.classList.add(PLAYER_FOCUSABLE_CLASS);
    Object.assign(strengthInput.style, { display: "block", width: "100%", accentColor: "#e5a00d", cursor: "pointer", boxSizing: "border-box" });
    strengthInput.addEventListener("input", () => {
        strengthLabel.textContent = `${title}: ${strengthInput.value}%`;
        setStrength(controller, Number(strengthInput.value) / 100);
    });

    const { row: modeRow, refreshIfAuto } = buildModeRow({
        groupId,
        mode: modeOf(controller),
        onModeChange: (mode) => setMode(controller, mode),
        strips: [{ strengthInput, strengthLabel, label: title, getAutoValue, getManualValue }],
    });
    header.appendChild(modeRow);

    section.appendChild(header);
    section.appendChild(strengthLabel);
    section.appendChild(strengthInput);
    startLiveAutoRefresh(strengthInput, refreshIfAuto);
    return section;
}

/* Two fully independent controls now (Saturation, Contrast - each its own Auto/On/Off mode,
   previously one combined "Strength" knob under one shared mode row) rather than one shared
   Color Boost toggle - a viewer may want one boosted and not the other, or one on Auto while
   manually dialing in the other. Unlike Android's equivalent panel, both apply live on every
   `input` event rather than gating to release: both compiled GL programs stay resident (see
   ensureShaderPipeline), so a strength change here is only a uniform update on the next frame,
   not a program rebuild. */
function buildColorBoostEffectRow(controller, list) {
    const { wrap } = buildEffectRow(list, { icon: colorBoostIconMarkup(), label: "Color Boost" });

    wrap.appendChild(buildColorBoostComponentSection(controller, {
        title: "Saturation",
        groupId: "colorboost-saturation-mode",
        modeOf: colorBoostSaturationModeOf,
        setMode: setColorBoostSaturationMode,
        getManualValue: () => controller._colorBoostSaturationStrength,
        setStrength: setColorBoostSaturationStrength,
        getAutoValue: () => controller._autoColorBoostSaturationStrength,
    }));
    wrap.appendChild(buildColorBoostComponentSection(controller, {
        title: "Contrast",
        groupId: "colorboost-contrast-mode",
        modeOf: colorBoostContrastModeOf,
        setMode: setColorBoostContrastMode,
        getManualValue: () => controller._colorBoostContrastStrength,
        setStrength: setColorBoostContrastStrength,
        getAutoValue: () => controller._autoColorBoostContrastStrength,
    }));
}

/* Same pattern as buildShaderEffectRow above (a continuous slider can't be expressed as
   tappable picker rows) - simpler, since there's no auto-detected type to show as read-
   only info here, just the one opacity control plus the on/off toggle. */
function buildAmbientEffectRow(controller, list) {
    const { wrap, rightSide, header } = buildEffectRow(list, { icon: ambientIconMarkup(), label: "Ambient Lighting", toggleReachable: true });

    const opacityLabel = document.createElement("div");
    opacityLabel.textContent = `Opacity: ${Math.round(controller._ambientOpacity * 100)}%`;
    Object.assign(opacityLabel.style, { color: "rgba(255,255,255,0.7)", fontSize: "12px", padding: "10px 0 4px" });

    const opacityInput = document.createElement("input");
    opacityInput.type = "range";
    opacityInput.min = "0";
    opacityInput.max = "100";
    opacityInput.value = String(Math.round(controller._ambientOpacity * 100));
    opacityInput.classList.add(PLAYER_FOCUSABLE_CLASS);
    Object.assign(opacityInput.style, { display: "block", width: "100%", accentColor: "#e5a00d", boxSizing: "border-box" });
    opacityInput.addEventListener("input", () => {
        opacityLabel.textContent = `Opacity: ${opacityInput.value}%`;
        setAmbientOpacity(controller, Number(opacityInput.value) / 100);
    });

    /* No effect running to tune while the toggle is off, same "disabled unless there's
       something to adjust" reasoning as Shader Upscaling/Color Boost's own strength
       slider (see buildModeRow's applyStrengthDisplay). */
    const applyOpacityEnabled = (enabled) => {
        opacityInput.disabled = !enabled;
        opacityInput.style.opacity = enabled ? "1" : "0.5";
        opacityInput.style.cursor = enabled ? "pointer" : "default";
    };
    applyOpacityEnabled(controller._ambientEnabled);

    const toggleEl = makeToggleSwitch(controller._ambientEnabled, (checked) => {
        controller._setAmbientEnabled(checked);
        applyOpacityEnabled(checked);
    });
    rightSide.appendChild(toggleEl);
    /* Delegates to the switch's own click() rather than duplicating its flip-the-UI-and-call-
       onChange logic here - same pattern and same reasoning as chrome-menu.js's toggle-only
       accordion rows (its own stopPropagation keeps a direct mouse click on the switch from
       looping back through this listener). */
    header.addEventListener("click", () => toggleEl.click());
    wrap.appendChild(opacityLabel);
    wrap.appendChild(opacityInput);
}
