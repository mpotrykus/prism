import { SHADER_TYPES } from "../shader/shaders.js";
import { setShaderStrength, setColorBoostStrength, upscaleModeOf, setUpscaleMode, colorBoostModeOf, setColorBoostMode, activePresetKey, idleUpgradeLabel } from "../shader-pipeline.js";
import { setAmbientOpacity } from "../ambient-pipeline.js";
import { fullscreenIconMarkup, colorBoostIconMarkup, ambientIconMarkup, debandIconMarkup, PLAYER_FOCUSABLE_CLASS } from "./shared.js";
/* Circular with chrome-menu.js (which imports renderEffectsList from this file for its
   "Effects" row) - safe here because both sides only reference the other module's
   export from inside a function body (makeBackRow/makeToggleSwitch are only called once
   renderEffectsList itself actually runs, well after both modules have finished
   loading), never at top-level module-evaluation time. */
import { makeBackRow, makeToggleSwitch } from "./chrome-menu.js";

/* The hamburger "More" sheet's Effects sub-screen: Shader Upscaling/Color Boost/Ambient
   Lighting, each a plain always-visible row (not an accordion section, see
   renderEffectsList) landing on a slider. */

/* "Effects" navigates to a whole separate list (see chrome-menu.js's buildAccordionRow
   `nav` case) rather than expanding in place - Shader Upscaling/Color Boost/Ambient
   Lighting read better as their own dedicated screen than squeezed inline under a fourth
   row. Clears and rebuilds `list` in place (same element, new contents) rather than
   swapping in a second list element, so the sheet's own scroll position/height logic
   doesn't need to know which screen is currently showing. Unlike the main list's rows,
   these three are plain always-visible rows (see buildEffectRow) rather than accordion
   sections - with only three of them and every one landing on a slider, tap-to-expand
   just added a step between opening "Effects" and reaching the control someone came here
   for. */
export function renderEffectsList(controller, list, onBack) {
    list.innerHTML = "";
    list.appendChild(makeBackRow(onBack));
    buildShaderEffectRow(controller, list);
    buildDebandEffectRow(controller, list);
    buildColorBoostEffectRow(controller, list);
    buildAmbientEffectRow(controller, list);
}

const MODE_OPTIONS = [
    { key: "auto", label: "Auto" },
    { key: "on", label: "On" },
    { key: "off", label: "Off" },
];

/* A trained CNN preset has no intensity knob, so there is nothing for Auto to compute and
   nothing for the slider to set - see SHADER_TYPES.anime4k_cnn's `strengthless`. Offering
   either would be a control that visibly does nothing. */
const ON_OFF_OPTIONS = MODE_OPTIONS.filter((opt) => opt.key !== "auto");

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
   at, not watched. */
function buildModeRow({ groupId, mode, onModeChange, getAutoValue, getManualValue, strengthInput, strengthLabel, options = MODE_OPTIONS }) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", padding: "0 0 10px" });

    let currentMode = mode;
    /* strengthInput/strengthLabel are omitted entirely by a strengthless preset's row, so
       every touch of them is guarded rather than the caller being made to pass a dummy. */
    const applyStrengthDisplay = (m) => {
        if (!strengthInput) return;
        const auto = m === "auto";
        /* Only "on" leaves the slider interactive - "auto" because the value isn't
           user-driven, and "off" because there's no effect running for it to tune, same
           reasoning "off" already gets a dimmed/disabled mode button of its own. */
        const enabled = m === "on";
        strengthInput.disabled = !enabled;
        strengthInput.style.opacity = enabled ? "1" : "0.5";
        strengthInput.style.cursor = enabled ? "pointer" : "default";
        const value = auto ? (getAutoValue() ?? 0) : getManualValue();
        strengthInput.value = String(Math.round(value * 100));
        strengthLabel.textContent = `Strength: ${Math.round(value * 100)}%${auto ? " (auto)" : ""}`;
    };

    const buttons = options.map((opt) => {
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

   `header` is a plain, unclickable div unless `toggleReachable` is set - Shader Upscaling
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

/* Reuses fullscreenIconMarkup's expand-corners glyph - upscaling is, visually, the same
   "stretch the picture outward" idea. No manual Off/Anime4K/Live-Action picker -
   controller._shaderAutoType is decided once per video from its Plex genre tags (see
   detectShaderType) and shown here as read-only info via the caption. The mode row +
   slider are the only remaining controls, and dragging strength to 0% in "on" mode is
   what a plain "Off" used to be. */
function buildShaderEffectRow(controller, list) {
    /* What is really rendering, gate and perf downgrade included - not merely what could. A
       CNN/FSR preset that built but isn't currently chosen must NOT take over this row, or the
       strength slider disappears while the strength-driven sharpen chain is the one actually
       applying. See shader-pipeline.js's activePresetKey. */
    const activeKey = activePresetKey(controller, controller._shaderAutoType);
    const activePreset = SHADER_TYPES[activeKey];
    if (activePreset?.strengthless) {
        buildStrengthlessShaderRow(controller, list, activePreset);
        return;
    }

    /* Names the better preset that exists but is sitting out, and why. Without this the row
       reads as "Live-Action" with no hint that FSR was ever involved, which is indistinguishable
       from the feature being broken - a real round trip was spent on exactly that confusion. */
    const idle = idleUpgradeLabel(controller, controller._shaderAutoType);
    const familyLabel = SHADER_TYPES[controller._shaderAutoType].label;
    const { wrap, rightSide } = buildEffectRow(list, {
        icon: fullscreenIconMarkup(false),
        label: "Shader Upscaling",
        caption: idle ? `${familyLabel} · ${idle}` : `Detected: ${familyLabel}`,
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
        getAutoValue: () => controller._autoUpscaleStrength,
        getManualValue: () => controller._shaderStrength,
        strengthInput,
        strengthLabel,
    });
    rightSide.appendChild(modeRow);
    wrap.appendChild(strengthLabel);
    wrap.appendChild(strengthInput);
    startLiveAutoRefresh(strengthInput, refreshIfAuto);
}

/* The chain that is actually built, not the preset's default composition - with Deband on, every
   chain carries one extra pass, and reporting the static count would understate the cost the
   viewer just opted into. */
function presetPassCount(controller, preset) {
    for (const [key, chain] of Object.entries(controller._shaderChains ?? {})) {
        if (SHADER_TYPES[key] === preset) return chain.passCount;
    }
    return preset.passes.length;
}

/* Deband: repairs banded gradients in the source, independent of any upscaler. A plain on/off
   toggle rather than a mode row - there is no auto signal for it (content-analysis.js measures
   saturation and edge energy, neither of which detects banding) and no strength that means
   anything, since the threshold is pinned at the ~1 LSB that defines banding in the first place.
   Same toggle-reachable header treatment as Ambient Lighting, for the same D-pad reason. */
function buildDebandEffectRow(controller, list) {
    const { rightSide, header } = buildEffectRow(list, {
        icon: debandIconMarkup(),
        label: "Deband",
        caption: "Smooths banded gradients in low-bitrate sources",
        toggleReachable: true,
    });
    const toggleEl = makeToggleSwitch(!!controller._debandEnabled, (checked) => controller._setDebandEnabled(checked));
    rightSide.appendChild(toggleEl);
    header.addEventListener("click", () => toggleEl.click());
}

/* The Shader Upscaling row for a strengthless (trained-CNN) preset: On/Off only, no
   strength slider, and the caption reports the algorithm and its pass count so the cost is
   at least visible. Kept as a separate builder rather than a pile of conditionals inside
   buildShaderEffectRow - the two rows share only the mode buttons, and the shared piece
   (buildModeRow) is already factored out. */
function buildStrengthlessShaderRow(controller, list, preset) {
    const { rightSide } = buildEffectRow(list, {
        icon: fullscreenIconMarkup(false),
        label: "Shader Upscaling",
        caption: `${preset.label} · ${presetPassCount(controller, preset)} passes`,
    });

    const rawMode = upscaleModeOf(controller);
    const { row: modeRow } = buildModeRow({
        groupId: "shader-mode",
        /* A persisted Auto from a title that *did* have a strength knob is shown as On here
           rather than being written back to On - the flag is untouched, and it will apply
           again as soon as a strength-driven preset renders. Mutating it from a render of
           this row would silently change a setting the viewer never touched. */
        mode: rawMode === "auto" ? "on" : rawMode,
        onModeChange: (mode) => setUpscaleMode(controller, mode),
        options: ON_OFF_OPTIONS,
    });
    rightSide.appendChild(modeRow);
}

/* Same pattern as buildShaderEffectRow above, simpler since there's no auto-detected
   type to show as read-only info here - just the one strength control. Unlike
   Android's equivalent panel, this applies live on every `input` event rather than
   gating to release: both compiled GL programs stay resident (see
   ensureShaderPipeline), so a strength change here is only a uniform update on the next
   frame, not a program rebuild. */
function buildColorBoostEffectRow(controller, list) {
    const { wrap, rightSide } = buildEffectRow(list, { icon: colorBoostIconMarkup(), label: "Color Boost" });

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
        setColorBoostStrength(controller, Number(strengthInput.value) / 100);
    });

    const { row: modeRow, refreshIfAuto } = buildModeRow({
        groupId: "colorboost-mode",
        mode: colorBoostModeOf(controller),
        onModeChange: (mode) => setColorBoostMode(controller, mode),
        getAutoValue: () => controller._autoColorBoostStrength,
        getManualValue: () => controller._colorBoostStrength,
        strengthInput,
        strengthLabel,
    });
    rightSide.appendChild(modeRow);
    wrap.appendChild(strengthLabel);
    wrap.appendChild(strengthInput);
    startLiveAutoRefresh(strengthInput, refreshIfAuto);
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
