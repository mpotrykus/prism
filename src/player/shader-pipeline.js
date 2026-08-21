import { shaderTuningAt, colorBoostAt, SHADER_TYPES, DEBAND_TUNING } from "./shader/shaders.js";
import { createPassChain } from "./shader/pass-chain.js";
import { createPerfWatchdog } from "./shader/perf-watchdog.js";
import {
    UPSCALE_ENABLED_STORAGE_KEY,
    UPSCALE_STRENGTH_STORAGE_KEY,
    UPSCALE_AUTO_STORAGE_KEY,
    COLOR_BOOST_SATURATION_ENABLED_STORAGE_KEY,
    COLOR_BOOST_CONTRAST_ENABLED_STORAGE_KEY,
    COLOR_BOOST_SATURATION_STRENGTH_STORAGE_KEY,
    COLOR_BOOST_CONTRAST_STRENGTH_STORAGE_KEY,
    COLOR_BOOST_SATURATION_AUTO_STORAGE_KEY,
    COLOR_BOOST_CONTRAST_AUTO_STORAGE_KEY,
    AI_UPSCALING_STORAGE_KEY,
} from "./ui/shared.js";
import { updateContentAnalysis } from "./content-analysis.js";
import { hasNativePlayer, platformTag } from "./core/platform.js";
/* Circular with xbox-bridge.js (which imports postXboxShaderSettings/postXboxColorBoostSettings
   from content-analysis.js, which itself imports them from this file) - safe for the same reason
   the other cycles in src/player/ui/ are: postShaderEffect/postColorBoost are only referenced
   inside function bodies below (updateShaderPipeline, postXboxShaderSettings), never at
   top-level module-evaluation time. */
import { postShaderEffect, postColorBoost, postAiUpscaling } from "./xbox-bridge.js";

function isXbox() {
    return hasNativePlayer() && platformTag() === "xbox";
}

/* Xbox has no real <video> element for ensureShaderPipeline's canvas/WebGL pass to read from -
   ShaderVideoEffect (xbox/PrismXboxEffects) bakes Shader Upscaling/Color Boost directly into the
   decoded frame instead, so this side only ever has to relay settings across the bridge. Exported
   so content-analysis.js's own Xbox branch can reuse the exact same payload-building logic rather
   than re-deriving it - native's "auto" flags live in this same message, and content-analysis.js's
   updateContentAnalysis is what setUpscaleAuto/setColorBoostSaturationAuto/
   setColorBoostContrastAuto below actually call. */
export function postXboxShaderSettings(controller) {
    postShaderEffect({
        enabled: !!controller._shaderEnabled,
        shaderType: controller._shaderAutoType,
        /* The bug this fixed: native has no concept of "auto" strength resolution of its own - it
           only ever renders whatever strength number this message carries. Sending the raw manual
           slider value here meant Auto mode natively rendered with _shaderStrength (0 unless the
           viewer had also dragged the slider), a no-op, regardless of what applyXboxContentAnalysis
           had actually computed into _autoUpscaleStrength - same resolution renderShaderFrame's web
           path already does per-frame (`controller._upscaleAuto ? controller._autoUpscaleStrength :
           controller._shaderStrength`). */
        strength: controller._upscaleAuto ? (controller._autoUpscaleStrength ?? 0) : controller._shaderStrength,
        auto: !!controller._upscaleAuto,
    });
}

/* Saturation and contrast are independently auto-able now (see setColorBoostSaturationMode/
   setColorBoostContrastMode below) - each resolves from its own enabled/auto pair and its own
   auto-derived value (_autoColorBoostSaturationStrength from avgSaturation,
   _autoColorBoostContrastStrength from lumaStdDev - see content-analysis.js), so there is no
   longer one shared "strength"/"auto" to send, there are two independent ones. */
/* AI Upscaling's native counterpart - see NativePlayerHost.SetAiUpscaling. preset mirrors the
   family key postXboxShaderSettings sends as shaderType (_shaderAutoType: "anime4k"/
   "live_action"), since AI Upscaling has no algorithm choice of its own - it upgrades whichever
   family Sharpening would have used, same as the web leg's upgradeTo. */
export function postXboxAiUpscalingSettings(controller) {
    postAiUpscaling({
        enabled: !!controller._aiUpscalingEnabled,
        preset: controller._shaderAutoType,
    });
}

export function postXboxColorBoostSettings(controller) {
    postColorBoost({
        saturationEnabled: !!controller._colorBoostSaturationEnabled,
        contrastEnabled: !!controller._colorBoostContrastEnabled,
        saturationStrength: controller._colorBoostSaturationAuto
            ? (controller._autoColorBoostSaturationStrength ?? 0)
            : controller._colorBoostSaturationStrength,
        contrastStrength: controller._colorBoostContrastAuto
            ? (controller._autoColorBoostContrastStrength ?? 0)
            : controller._colorBoostContrastStrength,
        saturationAuto: !!controller._colorBoostSaturationAuto,
        contrastAuto: !!controller._colorBoostContrastAuto,
    });
}

/* WebGL upscaling pipeline (Anime4K/CAS) - reads frames from the controller's <video>
   element and renders an upscaled frame into a canvas stacked on top of it. Takes the
   StreamingPlayerController instance as an explicit first argument (same "mixin
   function" pattern as native-bridge.js/web-fallback.js) rather than owning a private
   copy of the video/canvas state - the pipeline's GL resources genuinely are part of
   one playback session's state, not a separable subsystem with its own lifecycle. */

/* controller._shaderType only ever tracks "off" vs. whichever type detectShaderType
   picked for this video, never a user-chosen algorithm. Gated on _shaderEnabled as well
   as strength>0 now that on/off is its own toggle (see setShaderEnabled below) rather
   than dragging the strength slider to 0 being the only way to turn this off - the
   slider's position is remembered independently of whether the toggle is currently on.
   Same "toggle IS the persisted setting" immediate-persistence model as Color Boost
   below (see storedShaderStrength) - whatever this is last set to is what every
   subsequent video starts from, not a Settings-modal default. */
export function setShaderStrength(controller, strength) {
    controller._shaderStrength = strength;
    controller._shaderType = resolveShaderType(controller);
    localStorage.setItem(UPSCALE_STRENGTH_STORAGE_KEY, String(strength));
    updateShaderPipeline(controller);
}

/* Whether the shader actually renders as "off" can't just check _shaderStrength > 0 -
   in Auto mode the manual slider's position is irrelevant (it isn't applied at all, see
   renderShaderFrame), so a manual strength of exactly 0 must not force "off" while
   _upscaleAuto is on. Shared by every place that can change either _shaderEnabled,
   _shaderStrength, or _upscaleAuto, so none of them can resolve this stale relative to
   the other two.

   Purely about Sharpening now - AI Upscaling (the CNN/FSR chains) used to be coupled in
   here (a strengthless upgrade meant a remembered 0 strength couldn't read as "off"), but
   splitting it into its own independent toggle (setAiUpscalingEnabled below) removed that
   coupling entirely: this function no longer needs to know upgradeTo/strengthless exist at
   all, which is what it looked like before either upgrade was ever added. */
function resolveShaderType(controller) {
    if (!controller._shaderEnabled) return "off";
    const hasStrength = controller._upscaleAuto || controller._shaderStrength > 0;
    return hasStrength ? controller._shaderAutoType : "off";
}

/* AI Upscaling (the real Anime4K CNN / FSR 1 chains) - split out from Sharpening into its
   own independent on/off toggle. Confirmed wrong to leave coupled: "Shader Upscaling" running
   the CNN/FSR chain only when Sharpening also happened to be on and the source needed it isn't
   upscaling semantics the viewer can reason about as one control - they're different
   algorithms (a trained network / an analytic edge-directed upscaler vs. a hand-written
   sharpen kernel) with different costs, and deserve independent on/off state. No strength/
   auto here - see `strengthless` - there is nothing for either to drive. */
export function setAiUpscalingEnabled(controller, enabled) {
    controller._aiUpscalingEnabled = enabled;
    localStorage.setItem(AI_UPSCALING_STORAGE_KEY, enabled ? "1" : "0");
    updateShaderPipeline(controller);
    /* Xbox only: postXboxAiUpscalingSettings (called by updateShaderPipeline above) just relays
       the new flag to native - it does NOT make AI Upscaling actually switch mid-playback.
       NativePlayerHost.SetAiUpscaling only updates its own fields; the real work (flipping
       IsVideoFrameServerEnabled, swapping which visual element is shown, aiUpscale.SetActive)
       lives in SetAiUpscalePathActive, which only runs from Play/SwitchTitle. Real bug hit and
       fixed 2026-08-20: without this, toggling the switch while a title was already playing had
       no visible effect at all until the viewer happened to switch/restart a title - reported as
       "zero difference when toggling AI Upscaling". _reloadSource (the same in-place restart
       Quality Cap/Version/audio-track changes and every Xbox seek already use, since a Plex
       progressive stream can't be repositioned in place) re-runs SwitchTitle at the current
       position with no other overrides, which re-evaluates SetAiUpscalePathActive with the now-
       current enabled/preset state. Already safe to call before any title has loaded -
       reloadXboxSource itself no-ops when controller._session isn't set yet. */
    if (isXbox()) controller._reloadSource({});
}

/* The "more" menu's inline toggle (see chrome.js's openHamburgerMenu) - flips whether the
   shader runs at all without touching _shaderStrength, so switching back on restores
   whatever strength the slider was already at instead of resetting it. Same immediate-
   persistence model as setShaderStrength above. */
export function setShaderEnabled(controller, enabled) {
    controller._shaderEnabled = enabled;
    controller._shaderType = resolveShaderType(controller);
    localStorage.setItem(UPSCALE_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    updateShaderPipeline(controller);
}

/* Color Boost (contrast/saturation "look" lift) - independent of shader upscaling's
   on/off state, but shares the same GL pass/canvas (see updateShaderPipeline/
   renderShaderFrame below) rather than spending a second full-frame GPU pass. Saturation
   and Contrast are fully independent controls now - each its own enabled/auto pair, each
   its own Auto|On|Off mode (see colorBoostSaturationModeOf/colorBoostContrastModeOf
   below) - rather than one shared "Color Boost" enabled flag, since a viewer may want one
   boosted and not the other. Same "toggle IS the persisted setting" immediate-persistence
   model as ambient lighting (ambient-pipeline.js's setAmbientEnabled) - no per-video/genre
   concern to reconcile here either. */
export function setColorBoostSaturationEnabled(controller, enabled) {
    controller._colorBoostSaturationEnabled = enabled;
    localStorage.setItem(COLOR_BOOST_SATURATION_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    updateShaderPipeline(controller);
}

export function setColorBoostContrastEnabled(controller, enabled) {
    controller._colorBoostContrastEnabled = enabled;
    localStorage.setItem(COLOR_BOOST_CONTRAST_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    updateShaderPipeline(controller);
}

export function setColorBoostSaturationStrength(controller, strength) {
    controller._colorBoostSaturationStrength = strength;
    localStorage.setItem(COLOR_BOOST_SATURATION_STRENGTH_STORAGE_KEY, String(strength));
    updateShaderPipeline(controller);
}

export function setColorBoostContrastStrength(controller, strength) {
    controller._colorBoostContrastStrength = strength;
    localStorage.setItem(COLOR_BOOST_CONTRAST_STRENGTH_STORAGE_KEY, String(strength));
    updateShaderPipeline(controller);
}

/* Same immediate-persistence model as setShaderStrength/setShaderEnabled above - only
   this on/off flag is written through, never the live-computed strength itself (see
   content-analysis.js's sampleContentFrame). Switching auto off falls back to whatever
   _shaderStrength the slider was last left at, same "toggle overrides, doesn't erase"
   model setShaderEnabled already uses for the shader on/off toggle above. */
export function setUpscaleAuto(controller, enabled) {
    controller._upscaleAuto = enabled;
    controller._shaderType = resolveShaderType(controller);
    localStorage.setItem(UPSCALE_AUTO_STORAGE_KEY, enabled ? "1" : "0");
    updateContentAnalysis(controller);
}

/* Same immediate-persistence model as setColorBoostSaturationEnabled/setUpscaleAuto above.
   Only this on/off flag is written through, never the live-computed strength itself (see
   content-analysis.js's sampleContentFrame) - unchecking always falls back to whatever
   _colorBoostSaturationStrength the slider was last left at. Independent of
   setColorBoostContrastAuto below - each auto-derives from its own signal (avgSaturation vs
   lumaStdDev, see content-analysis.js/shaders.js), so there's no shared auto state left to
   couple them through. */
export function setColorBoostSaturationAuto(controller, enabled) {
    controller._colorBoostSaturationAuto = enabled;
    localStorage.setItem(COLOR_BOOST_SATURATION_AUTO_STORAGE_KEY, enabled ? "1" : "0");
    updateContentAnalysis(controller);
}

/* Same reasoning as setColorBoostSaturationAuto above, mirrored for Contrast. */
export function setColorBoostContrastAuto(controller, enabled) {
    controller._colorBoostContrastAuto = enabled;
    localStorage.setItem(COLOR_BOOST_CONTRAST_AUTO_STORAGE_KEY, enabled ? "1" : "0");
    updateContentAnalysis(controller);
}

/* "auto"/"on"/"off" - the three-way state chrome.js's mode control presents in place of
   the old separate enabled-toggle + Auto-checkbox pair. Collapses _shaderEnabled/
   _upscaleAuto (still the two flags everything else here - renderShaderFrame,
   persistence, Android's mirrored fields - actually keys off) into one value for the UI
   layer, rather than threading a third piece of state through the rendering/persistence
   code that already works correctly off the pair. */
export function upscaleModeOf(controller) {
    if (!controller._shaderEnabled) return "off";
    return controller._upscaleAuto ? "auto" : "on";
}

/* Drives both flags from one selection - "off" and "on" both set _upscaleAuto false so
   a later switch straight to "on" (skipping "auto") doesn't inherit a stale auto flag
   from a previous session. */
export function setUpscaleMode(controller, mode) {
    setShaderEnabled(controller, mode !== "off");
    setUpscaleAuto(controller, mode === "auto");
}

/* Same collapsing reasoning as upscaleModeOf/setUpscaleMode above, one independent triple
   per component now instead of one shared Color Boost mode. */
export function colorBoostSaturationModeOf(controller) {
    if (!controller._colorBoostSaturationEnabled) return "off";
    return controller._colorBoostSaturationAuto ? "auto" : "on";
}

export function setColorBoostSaturationMode(controller, mode) {
    setColorBoostSaturationEnabled(controller, mode !== "off");
    setColorBoostSaturationAuto(controller, mode === "auto");
}

export function colorBoostContrastModeOf(controller) {
    if (!controller._colorBoostContrastEnabled) return "off";
    return controller._colorBoostContrastAuto ? "auto" : "on";
}

export function setColorBoostContrastMode(controller, mode) {
    setColorBoostContrastEnabled(controller, mode !== "off");
    setColorBoostContrastAuto(controller, mode === "auto");
}

/* Off by default - same reasoning as the Android leg (ShaderUpscaleEffect): this spends
   an extra GPU pass every frame, only worth it on already-low-resolution sources.
   Unlike Android, there's no per-drag rebuild hazard here (see PlayerActivity's
   showShaderUpscaleDialog gotcha) - both compiled programs stay resident, so re-running
   this on every drag tick (setShaderStrength above) is cheap: ensureShaderPipeline
   no-ops once already built, and start/stop only takes effect when the 0%/>0% boundary
   is actually crossed. */
export function updateShaderPipeline(controller) {
    /* Xbox: no canvas/WebGL pass at all - ShaderVideoEffect is what actually renders this, and it
       reads its settings from EffectSettings (a shared static on the native side), not a
       per-frame bridge message. Relaying the current settings here is enough; native re-attaches/
       detaches itself from EffectSettings.ShouldAttach. */
    if (isXbox()) {
        postXboxShaderSettings(controller);
        postXboxColorBoostSettings(controller);
        postXboxAiUpscalingSettings(controller);
        return;
    }
    /* Any of these keeps this GL pass alive - Color Boost's Saturation/Contrast alone (either
       or both) still needs the canvas rendering (with sharpenStrength forced to 0 in
       renderShaderFrame below), same as Sharpening or AI Upscaling alone. */
    if (
        controller._shaderType === "off" &&
        !controller._aiUpscalingEnabled &&
        !controller._colorBoostSaturationEnabled &&
        !controller._colorBoostContrastEnabled
    ) {
        stopShaderLoop(controller);
        if (controller._shaderCanvas) controller._shaderCanvas.style.display = "none";
        if (controller._videoEl) controller._videoEl.style.opacity = "1";
        return;
    }
    if (!ensureShaderPipeline(controller)) {
        controller._shaderType = "off";
        controller._aiUpscalingEnabled = false;
        controller._colorBoostSaturationEnabled = false;
        controller._colorBoostContrastEnabled = false;
        return;
    }
    controller._shaderCanvas.style.display = "block";
    controller._videoEl.style.opacity = "0";
    controller._applyFitMode();
    startShaderLoop(controller);
    /* The loop only draws when a decoded frame arrives, so without this a settings change
       made while paused wouldn't show until playback resumed. */
    renderShaderOnce(controller);
}

function makeDowngradeHandler(controller) {
    return ({ meanMs, ratio }) => {
        console.warn(
            `StreamingPlayer: shader chain averaging ${meanMs.toFixed(1)}ms/frame (${ratio.toFixed(2)}x real time), dropping to the single-pass preset`
        );
        /* Nothing to re-resolve on _shaderType itself any more - AI Upscaling's own toggle is
           independent of Sharpening now, so a downgrade only affects what upgradedPresetKey
           answers (it checks controller._shaderWatchdog.downgraded directly), not Sharpening's
           own on/off/strength resolution. This just re-syncs deband/canvas state. */
        updateShaderPipeline(controller);
    };
}

/* Compiles every preset's chain once and hangs the result on the controller. Each preset's
   `buildPasses` returns a fixed composition now - deband is either permanently part of it
   (the CNN/FSR chains) or never part of it (the sharpen presets), see shaders.js's debandPass
   comment - so unlike the session this briefly grew a deband on/off toggle, there is no longer
   any setting that changes what a chain consists of after this runs once.

   Why the failure is recorded rather than only logged: a preset whose chain doesn't build simply
   isn't in `chains`, which is indistinguishable from a device that never had that preset - so the
   Effects row said nothing at all, and "the upgrade is broken here" looked identical to "there is
   no upgrade here". Diagnosing that cost three rounds of probing a phone. idleUpgradeLabel
   reports these. */
function buildShaderChains(controller, gl, isWebGl2) {
    const chains = {};
    const chainErrors = {};
    for (const [key, preset] of Object.entries(SHADER_TYPES)) {
        try {
            chains[key] = createPassChain(gl, preset.buildPasses(), { isWebGl2 });
        } catch (e) {
            chainErrors[key] = e.message;
            console.warn(`StreamingPlayer: shader preset "${key}" unavailable -`, e.message);
        }
    }
    if (!Object.keys(chains).length) {
        console.error("StreamingPlayer: no shader preset compiled, shader upscaling disabled");
        return false;
    }
    controller._shaderChains = chains;
    controller._shaderChainErrors = chainErrors;
    return true;
}

/* Lazily builds the WebGL pipeline on first use rather than in playWeb - most sessions
   never touch this menu, and compiling every preset's pass chain upfront on every playback
   would be wasted work. Every ShaderType's chain is built once here and kept resident;
   switching type is just swapping which chain renders, not a recompile (see
   updateShaderPipeline's comment for why that matters). */
export function ensureShaderPipeline(controller) {
    if (controller._shaderGl) return true;
    const video = controller._videoEl;
    if (!video) return false;
    const canvas = document.createElement("canvas");
    canvas.className = "streaming-player-shader-canvas";
    Object.assign(canvas.style, {
        position: "fixed",
        inset: "0",
        width: "100%",
        height: "100%",
        /* _renderShaderFrame sizes the canvas's backing buffer (outW/outH) to match the
           video's own aspect ratio, but a canvas is a replaced element like <img> -
           without this, the default object-fit:fill still stretches that correctly-
           proportioned bitmap to fill the 100%/100% box above, undoing the aspect-ratio
           math entirely whenever the window's own aspect ratio doesn't match the
           video's. */
        objectFit: "contain",
        /* Transparent, not "#000", if ambient lighting is already on - this canvas
           visually replaces the (opacity:0'd) video whenever shader upscaling is
           active, so it needs the same "let the letterbox gap show the ambient glow
           behind it" treatment ambient-pipeline.js's updateAmbientPipeline gives the
           video element itself. Only relevant here because that toggle only touches
           whichever shader canvas already exists at the moment ambient is flipped on -
           this covers the case where shader upscaling gets enabled afterward, when no
           canvas existed yet for it to reach. */
        background: controller._ambientEnabled ? "transparent" : "#000",
        zIndex: "10000",
        pointerEvents: "none",
    });
    /* WebGL2 first, WebGL1 as the fallback. The multi-pass CNN presets need GLSL ES 3.00
       (integer texel addressing and half-float render targets); the two original sharpen
       shaders are ES 1.00, which a WebGL2 context still compiles unchanged, so this isn't a
       fork in the shader sources - only in which presets are offered. A GL1-only device
       keeps exactly the behavior it had before. */
    const glAttrs = { antialias: false, preserveDrawingBuffer: false };
    const gl2 = canvas.getContext("webgl2", glAttrs);
    const gl = gl2 || canvas.getContext("webgl", glAttrs) || canvas.getContext("experimental-webgl");
    if (!gl) {
        console.error("StreamingPlayer: WebGL unavailable, shader upscaling disabled");
        return false;
    }
    const isWebGl2 = !!gl2;

    /* Presets whose chain won't build on this context are dropped rather than fatal - a
       WebGL1 device shouldn't lose the sharpen presets just because a CNN preset couldn't
       compile. resolveAvailablePreset below is what keeps _shaderAutoType from pointing at
       one of the dropped keys. */
    if (!buildShaderChains(controller, gl, isWebGl2)) return false;

    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    /* Flips the video's top-left-origin rows to WebGL's bottom-left-origin texture
       space - without this the upscaled output renders upside down. */
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    controller._shaderCanvas = canvas;
    controller._shaderGl = gl;
    controller._shaderIsWebGl2 = isWebGl2;
    controller._shaderTexture = texture;
    /* The frame-driven loop draws nothing while paused, so a resize then would leave the
       canvas at its old size and letterbox against the wrong rect. */
    controller._shaderResizeHandler = () => renderShaderOnce(controller);
    window.addEventListener("resize", controller._shaderResizeHandler);
    controller._shaderWatchdog = createPerfWatchdog({ onDowngrade: makeDowngradeHandler(controller) });
    document.body.appendChild(canvas);
    return true;
}

/* The family key (anime4k/live_action) that detectShaderType returns is what _shaderType
   and _shaderAutoType hold, what the Android/Xbox bridge sends, and what the two native legs
   understand. The *rendered* preset can be a better one: this returns the family's declared
   `upgradeTo` when that chain actually built on this context, so a WebGL2 device with float
   render targets gets the real Anime4K CNN while everything else keeps the hand-written
   sharpen - without either the bridge contract or the persisted settings ever learning a
   third key. */
export function upgradedPresetKey(controller, familyKey) {
    /* AI Upscaling is its own independent toggle now - the upgrade is never the answer while
       it's off, regardless of what the registry/chains/watchdog would otherwise say. */
    if (!controller._aiUpscalingEnabled) return familyKey;
    if (controller._shaderWatchdog?.downgraded) return familyKey;
    const chains = controller._shaderChains;
    const upgrade = SHADER_TYPES[familyKey]?.upgradeTo;
    if (upgrade && chains?.[upgrade]) return upgrade;
    return familyKey;
}

/* What is *actually* rendering, as opposed to what upgradedPresetKey says could render.

   The difference matters because a preset can be built and still not be chosen: both CNN and
   FSR carry an upscale gate, and neither runs when the picture is being downscaled to fit the
   window. upgradedPresetKey knows nothing about geometry, so asking it alone made the Effects
   row claim FSR was the preset and hide the strength slider - while the sharpen chain was the
   one really running, leaving its strength unadjustable. _shaderActivePreset is what
   chooseRenderPreset settled on last frame, so it accounts for the gate and the perf downgrade
   both.

   Falls back to upgradedPresetKey when the shader isn't rendering at all: there is no "active"
   preset then, and describing what *would* run is the useful answer for a menu. No longer
   special-cases "Sharpening is off" as "nothing could be active" - now that AI Upscaling is
   independently toggleable, it can be the only thing rendering while Sharpening sits off, and
   _shaderActivePreset already reflects that correctly every frame it runs. */
export function activePresetKey(controller, familyKey) {
    const active = controller._shaderActivePreset;
    if (active && controller._shaderChains?.[active]) return active;
    return upgradedPresetKey(controller, familyKey);
}

/* Whether AI Upscaling's own upgrade preset would actually run right now, purely from current
   geometry - the same `when` gate chooseRenderPreset checks every frame (e.g. Anime4K CNN's own
   "display must be at least 1.2x the video in both axes"), evaluated up front so the Effects row
   can grey out a toggle that would otherwise be a no-op (source resolution already fills the
   display, so there's nothing to upscale). Optimistic (true) whenever it can't yet be answered -
   no video loaded, no `when` gate at all - so a still-loading title never flashes "disabled"
   incorrectly; buildAiUpscalingEffectRow only calls this once the chain is already confirmed
   built. */
export function sourceWillUpscale(controller, familyKey) {
    const upgradeKey = SHADER_TYPES[familyKey]?.upgradeTo;
    const preset = upgradeKey ? SHADER_TYPES[upgradeKey] : null;
    if (!preset?.when) return true;
    const video = controller._videoEl;
    if (!video || !video.videoWidth || !video.videoHeight) return true;
    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.round((window.innerWidth || document.documentElement.clientWidth) * dpr);
    const displayH = Math.round((window.innerHeight || document.documentElement.clientHeight) * dpr);
    const tuning = shaderTuningAt(upgradeKey, 1);
    const [outW, outH] = outputSizeFor(video, displayW, displayH, tuning.scale);
    return preset.when({ sourceW: video.videoWidth, sourceH: video.videoHeight, outW, outH });
}

/* Explains, for the AI Upscaling row, why it's enabled but isn't the one actually rendering -
   the question that otherwise costs a round trip to answer. Three distinct reasons, and they
   call for different wording: the upscale gate declined (nothing to upscale, which is correct
   behavior and not a problem), the perf watchdog stepped it down (a real capability limit), or
   the toggle itself is off. Returns null when the upgrade is running, or when there is no
   upgrade on this device at all. */
export function idleUpgradeLabel(controller, familyKey) {
    const upgrade = SHADER_TYPES[familyKey]?.upgradeTo;
    if (!upgrade || !SHADER_TYPES[upgrade]) return null;
    const label = SHADER_TYPES[upgrade].label;
    /* Chain failed to compile on this GPU - say so, rather than leaving the row silent. This is
       the case that reads as "the feature does nothing" when it is really "this device's shader
       compiler rejected it", and the two need very different follow-up. Checked even when the
       toggle is off, since "unsupported here" is worth knowing regardless of the toggle state. */
    if (controller._shaderChainErrors?.[upgrade]) return `${label} failed to compile here`;
    if (!controller._shaderChains?.[upgrade]) return null;
    if (!controller._aiUpscalingEnabled) return null;
    if (activePresetKey(controller, familyKey) === upgrade) return null;
    if (controller._shaderWatchdog?.downgraded) return `${label} off - too slow here`;
    return `${label} idle - source not upscaled`;
}

/* Releases this session's GL/canvas/DOM resources. Previously inlined into
   web-fallback.js's teardownWeb, which meant every field this module added had to be
   remembered in a second file - the pass chains own GPU objects (FBOs, intermediate
   textures, programs) that a field-nulling block in teardownWeb can't reach at all. */
export function teardownShaderPipeline(controller) {
    stopShaderLoop(controller);
    if (controller._shaderResizeHandler) {
        window.removeEventListener("resize", controller._shaderResizeHandler);
        controller._shaderResizeHandler = null;
    }
    const gl = controller._shaderGl;
    if (controller._shaderChains) {
        for (const chain of Object.values(controller._shaderChains)) chain.dispose();
    }
    if (gl && controller._shaderTexture) gl.deleteTexture(controller._shaderTexture);
    if (controller._shaderCanvas) {
        controller._shaderCanvas.remove();
        controller._shaderCanvas = null;
    }
    controller._shaderGl = null;
    controller._shaderIsWebGl2 = false;
    controller._shaderChains = null;
    controller._shaderChainErrors = null;
    controller._shaderTexture = null;
    controller._shaderWatchdog = null;
    controller._shaderActivePreset = null;
}

/* Driven by decoded video frames (requestVideoFrameCallback), not display refresh.
   requestAnimationFrame fires at the panel's rate, so on a 24fps source at 60Hz the old loop
   re-ran the entire chain 2-3 times per decoded frame and threw away identical output - free
   at one sharpen pass, but 2.5x wasted GPU work at ten CNN passes, which is what made the
   difference between the Anime4K chain fitting the budget on a phone and not. rVFC also hands
   us metadata.mediaTime, which is what perf-watchdog.js measures against.

   rAF remains the fallback for browsers without rVFC. Both paths render only while frames
   arrive, so a paused player draws nothing - see renderShaderOnce for the cases that then need
   an explicit repaint. */
export function startShaderLoop(controller) {
    if (controller._shaderLoopActive) return;
    controller._shaderLoopActive = true;
    const video = controller._videoEl;

    if (typeof video?.requestVideoFrameCallback === "function") {
        const step = (wallMs, metadata) => {
            if (!controller._shaderLoopActive) return;
            renderShaderFrame(controller, wallMs, metadata?.mediaTime);
            const el = controller._videoEl;
            if (el && controller._shaderLoopActive) controller._shaderVfcId = el.requestVideoFrameCallback(step);
        };
        controller._shaderVfcId = video.requestVideoFrameCallback(step);
        return;
    }

    const step = (wallMs) => {
        if (!controller._shaderLoopActive) return;
        renderShaderFrame(controller, wallMs);
        controller._shaderRafId = requestAnimationFrame(step);
    };
    controller._shaderRafId = requestAnimationFrame(step);
}

export function stopShaderLoop(controller) {
    controller._shaderLoopActive = false;
    if (controller._shaderRafId) {
        cancelAnimationFrame(controller._shaderRafId);
        controller._shaderRafId = null;
    }
    if (controller._shaderVfcId && typeof controller._videoEl?.cancelVideoFrameCallback === "function") {
        controller._videoEl.cancelVideoFrameCallback(controller._shaderVfcId);
    }
    controller._shaderVfcId = null;
}

/* One-shot repaint for the cases a frame-driven loop can't cover: the canvas replaces the
   video element while this pipeline is on, so anything that changes what should be on screen
   without a new decoded frame arriving needs an explicit draw. Two real cases - a settings
   change while paused (the strength slider used to apply visibly because rAF was redrawing
   regardless), and a window resize while paused (the canvas would otherwise keep the previous
   size and letterbox wrongly). */
export function renderShaderOnce(controller) {
    if (!controller._shaderGl || !controller._videoEl) return;
    renderShaderFrame(controller, performance.now());
}

/* Mirrors ShaderUpscaleShaderProgram.configure()'s single-scale-factor-bounded-by-both-
   axes approach - scaling width/height independently would distort the aspect ratio
   whenever the screen and video don't match (the common case). Recomputed every frame
   (cheap - a handful of multiplications) rather than cached, since the window can
   resize mid-playback. */
function outputSizeFor(video, displayW, displayH, maxScale) {
    const scale = Math.max(1, Math.min(maxScale, Math.min(displayW / video.videoWidth, displayH / video.videoHeight)));
    return [Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale)];
}

/* Picks which preset actually renders this frame, in preference order: the family's CNN
   upgrade first, then the family's own sharpen chain.

   The output size and the upscale gate are mutually dependent - a preset's `when` clause
   asks "is the output meaningfully larger than the source", but the output size comes from
   that same preset's own scale - so each candidate is sized on its own terms and then
   tested, rather than sizing once up front and testing afterwards. When the CNN's 1.2x gate
   fails (a native-resolution source on a matching display), the sharpen chain renders
   instead: still worth its one pass, without paying for ten that aren't upscaling. */
function chooseRenderPreset(controller, video, familyKey, displayW, displayH, upscaleStrength) {
    const chains = controller._shaderChains;
    if (!chains) return null;

    const candidates = [];
    /* upgradedPresetKey already encodes every reason the upgrade might not apply (AI Upscaling's
       own toggle, a perf downgrade, the chain not existing on this device) - Sharpening's own
       on/off state plays no part in it any more, now that the two are independent toggles. */
    const upgrade = upgradedPresetKey(controller, familyKey);
    if (upgrade !== familyKey) candidates.push(upgrade);
    candidates.push(familyKey);

    for (const key of candidates) {
        const preset = SHADER_TYPES[key];
        const chain = chains[key];
        if (!preset || !chain) continue;

        /* _shaderType alone isn't enough to gate this - resolveShaderType keeps it resolved
           to a real type throughout Auto mode regardless of the live auto strength (it has
           to, so the content-analysis sampler keeps running and the GL pass stays alive for
           whenever a nonzero value does arrive - see that function's own comment). But
           shaderTuningAt(type, 0) returns that type's own MIN tuning, not a true no-op (e.g.
           live_action's min already carries sharpen:1.0) - the same "0 strength" that means
           fully off in manual mode (there, _shaderType itself already becomes "off" at
           exactly 0) would otherwise render as still-visibly-sharpened once auto legitimately
           computes 0 (source doesn't need upscaling). Checking upscaleStrength > 0 here too
           is what actually makes a live 0 look like off, regardless of which mode produced
           it - except for a strengthless preset (AI Upscaling), which always applies once it's
           a candidate at all: being a candidate already means upgradedPresetKey found its own
           toggle on, undowngraded, and built - Sharpening's on/off state is irrelevant to it. */
        const applies = preset.strengthless || (controller._shaderType !== "off" && upscaleStrength > 0);
        const tuning = applies ? shaderTuningAt(key, upscaleStrength) : { scale: 1, sharpen: 0, kernel: 1 };
        const [outW, outH] = outputSizeFor(video, displayW, displayH, tuning.scale);

        if (applies && preset.when && !preset.when({ sourceW: video.videoWidth, sourceH: video.videoHeight, outW, outH })) continue;
        return { key, preset, chain, tuning, outW, outH };
    }
    return null;
}

export function renderShaderFrame(controller, timestamp = 0, mediaTimeSec = null) {
    const gl = controller._shaderGl;
    const video = controller._videoEl;
    if (!gl || !video || !video.videoWidth || video.readyState < video.HAVE_CURRENT_DATA) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.round((window.innerWidth || document.documentElement.clientWidth) * dpr);
    const displayH = Math.round((window.innerHeight || document.documentElement.clientHeight) * dpr);
    /* Sharpening, AI Upscaling, and Color Boost are three independent toggles sharing this one
       GL pass. When Sharpening is off (whether or not AI Upscaling or Color Boost is on),
       there's still no compiled "plain" program to fall back to for the family-key argument
       chooseRenderPreset needs - reuse whichever algorithm this title's genre auto-detected
       (_shaderAutoType) with sharpen forced to 0, which both sharpen shaders reduce to an exact
       passthrough for (see glsl/sharpen-anime.frag.glsl / sharpen-cas.frag.glsl - zero sharpen
       strength leaves the sharpen stage a no-op either way). Whether the AI Upscaling upgrade
       itself is tried at all is now entirely upgradedPresetKey's own call (controller._aiUpscalingEnabled),
       not gated on this. */
    const programType = controller._shaderType !== "off" ? controller._shaderType : controller._shaderAutoType;
    /* Auto strength (see content-analysis.js) writes straight to _autoUpscaleStrength/
       _autoColorBoostSaturationStrength/_autoColorBoostContrastStrength rather than through
       setShaderStrength/setColorBoostSaturationStrength/setColorBoostContrastStrength - those
       persist to localStorage, which would clobber the remembered manual slider position on
       every sample tick. Resolved here instead, same shape as _shaderAutoType being resolved
       into programType just above. */
    const upscaleStrength = controller._upscaleAuto ? (controller._autoUpscaleStrength ?? 0) : controller._shaderStrength;
    /* Sharpening's own kernel/strength, computed independently of whichever preset
       chooseRenderPreset ends up rendering. Needed for two different consumers now: the plain
       family candidate (as before), and - since the two toggles stack rather than one
       superseding the other - AI Upscaling's own trailing sharpen pass, which must apply
       Sharpening's real tuning, not the upgrade preset's own fixed, strength-less placeholder
       scale/sharpen/kernel. Same "0 strength must mean off, not the type's own MIN tuning"
       gating chooseRenderPreset's family candidate already uses - see its own comment for why
       upscaleStrength > 0 is what makes a live 0 actually read as off. */
    const sharpeningActive = controller._shaderType !== "off" && upscaleStrength > 0;
    const sharpeningTuning = sharpeningActive ? shaderTuningAt(programType, upscaleStrength) : { scale: 1, sharpen: 0, kernel: 1 };
    /* Saturation and Contrast each have their own independent Auto|On|Off mode now (see
       colorBoostSaturationModeOf/colorBoostContrastModeOf) and their own auto-derived value
       (_autoColorBoostSaturationStrength from avgSaturation, _autoColorBoostContrastStrength
       from lumaStdDev - see content-analysis.js/shaders.js's autoContrastBoostStrength) -
       there's no shared strength or auto state left to resolve together. A component whose
       mode is "off" resolves to strength 0, which colorBoostAt's own min-lerp already turns
       into an exact 1.0 (no-op) for that component - no separate enabled-gate branch needed
       around the colorBoostAt call itself. */
    const boostSaturationStrength = controller._colorBoostSaturationEnabled
        ? (controller._colorBoostSaturationAuto ? (controller._autoColorBoostSaturationStrength ?? 0) : controller._colorBoostSaturationStrength)
        : 0;
    const boostContrastStrength = controller._colorBoostContrastEnabled
        ? (controller._colorBoostContrastAuto ? (controller._autoColorBoostContrastStrength ?? 0) : controller._colorBoostContrastStrength)
        : 0;
    const colorTuning = colorBoostAt(boostSaturationStrength, boostContrastStrength);

    const chosen = chooseRenderPreset(controller, video, programType, displayW, displayH, upscaleStrength);
    if (!chosen) return;
    const { chain, tuning: sharpenTuning, outW, outH } = chosen;
    /* Recorded for the Performance Overlay: _shaderType only ever holds the family key, so
       without this there'd be no way to tell from on screen whether the real CNN chain or
       the sharpen fallback is actually running - which is exactly what needs checking on a
       device whose float-target support is in question. */
    controller._shaderActivePreset = chosen.key;

    const canvas = controller._shaderCanvas;
    if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
        /* New geometry means every intermediate target is about to be reallocated, so the
           in-flight timing window describes work that no longer exists. */
        controller._shaderWatchdog?.resetWindow();
    }

    /* Explicit unit 0 before the upload: a multi-pass chain leaves the active unit wherever
       its last input was bound, so without this the video frame would be written over
       whichever unit that happened to be - silently corrupting the next frame's inputs
       rather than failing outright. */
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, controller._shaderTexture);
    try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
        /* Tainted-canvas SecurityError - the crossOrigin/CORS invariant playWeb relies
           on didn't hold for this server. Fail by turning the shader back off instead of
           throwing on every animation frame. */
        console.error("StreamingPlayer: shader upscaling disabled - video frame is cross-origin tainted", e);
        controller._shaderEnabled = false;
        controller._shaderType = "off";
        controller._aiUpscalingEnabled = false;
        updateShaderPipeline(controller);
        return;
    }

    const rendered = chain.render({
        sourceTex: controller._shaderTexture,
        sourceW: video.videoWidth,
        sourceH: video.videoHeight,
        outW,
        outH,
        /* One flat bag for the whole chain - each pass picks up only the names its own
           shader declares (see createPassChain's render), so this doesn't need to know
           which pass wants which knob.

           uKernelScale/uSharpenStrength: chosen.tuning (sharpenTuning) is right when the plain
           family itself is what's rendering - it's already Sharpening's own gated tuning in
           that case. It is NOT right when AI Upscaling is rendering (chosen.preset.strengthless):
           there, sharpenTuning is the upgrade's own fixed, strength-less placeholder, and the
           trailing sharpen pass's actual tap offsets need sharpeningTuning instead - scaled by
           the real output/source ratio, since that pass now samples an already-output-resolution
           image (present's/luma-merge's result) rather than SOURCE directly the way the
           standalone family preset does, which would otherwise silently change what the tuned
           kernel/sharpen values look like. */
        uniforms: {
            uKernelScale: chosen.preset.strengthless ? sharpeningTuning.kernel * (outW / video.videoWidth) : sharpenTuning.kernel,
            uSharpenStrength: chosen.preset.strengthless ? sharpeningTuning.sharpen : sharpenTuning.sharpen,
            uSaturationBoost: colorTuning.saturation,
            uContrastBoost: colorTuning.contrast,
            uDebandThreshold: DEBAND_TUNING.threshold,
            uDebandRange: DEBAND_TUNING.range,
            uDebandGrain: DEBAND_TUNING.grain,
            /* Both deband's sample pattern and the final dither key off this. A fixed value turns
               either into visible fixed-pattern texture instead of noise, so it has to move every
               frame; the modulo keeps it small enough for a mediump-safe hash. */
            uFrameSeed: (controller._shaderFrameSeed = ((controller._shaderFrameSeed ?? 0) + 1) % 4096),
        },
    });
    /* Only the multi-pass presets are measured. Timing the single-pass fallback would be
       pointless - there is nothing cheaper to fall back to, and it is the same one pass this
       player shipped with before any of this existed. Media time comes from rVFC's metadata
       when the loop has it and video.currentTime otherwise; the watchdog compares it against
       wall time, which is what makes the measurement independent of refresh rate. */
    if (chosen.preset.passes.length > 1) {
        /* Frame counts are report-only (see the watchdog's dropRate) - they catch the case the
           wall-vs-media ratio is blind to, where a dropped frame skips both clocks equally. */
        const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
        controller._shaderWatchdog?.frame({
            wallMs: timestamp,
            mediaMs: (mediaTimeSec ?? video.currentTime) * 1000,
            playbackRate: video.playbackRate,
            droppedFrames: quality ? quality.droppedVideoFrames : null,
            totalFrames: quality ? quality.totalVideoFrames : null,
        });
    }

    if (!rendered) {
        /* Intermediate render-target allocation failed (out of VRAM at this output size,
           realistically) - fail the feature closed rather than leaving a blank canvas
           covering the video every frame. */
        console.error("StreamingPlayer: shader pass targets unavailable, shader upscaling disabled");
        controller._shaderEnabled = false;
        controller._shaderType = "off";
        controller._aiUpscalingEnabled = false;
        updateShaderPipeline(controller);
    }
}
