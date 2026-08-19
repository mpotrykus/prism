import { shaderTuningAt, colorBoostAt, SHADER_TYPES, DEBAND_TUNING } from "./shader/shaders.js";
import { createPassChain } from "./shader/pass-chain.js";
import { createPerfWatchdog } from "./shader/perf-watchdog.js";
import {
    UPSCALE_ENABLED_STORAGE_KEY,
    UPSCALE_STRENGTH_STORAGE_KEY,
    UPSCALE_AUTO_STORAGE_KEY,
    COLOR_BOOST_STORAGE_KEY,
    COLOR_BOOST_STRENGTH_STORAGE_KEY,
    COLOR_BOOST_AUTO_STORAGE_KEY,
    DEBAND_STORAGE_KEY,
} from "./ui/shared.js";
import { updateContentAnalysis } from "./content-analysis.js";
import { hasNativePlayer, platformTag } from "./core/platform.js";
/* Circular with xbox-bridge.js (which imports postXboxShaderSettings/postXboxColorBoostSettings
   from content-analysis.js, which itself imports them from this file) - safe for the same reason
   the other cycles in src/player/ui/ are: postShaderEffect/postColorBoost are only referenced
   inside function bodies below (updateShaderPipeline, postXboxShaderSettings), never at
   top-level module-evaluation time. */
import { postShaderEffect, postColorBoost } from "./xbox-bridge.js";

function isXbox() {
    return hasNativePlayer() && platformTag() === "xbox";
}

/* Xbox has no real <video> element for ensureShaderPipeline's canvas/WebGL pass to read from -
   ShaderVideoEffect (xbox/PrismXboxEffects) bakes Shader Upscaling/Color Boost directly into the
   decoded frame instead, so this side only ever has to relay settings across the bridge. Exported
   so content-analysis.js's own Xbox branch can reuse the exact same payload-building logic rather
   than re-deriving it - native's "auto" flag lives in this same message, and content-analysis.js's
   updateContentAnalysis is what setUpscaleAuto/setColorBoostAuto below actually call. */
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

export function postXboxColorBoostSettings(controller) {
    postColorBoost({
        enabled: !!controller._colorBoostEnabled,
        strength: controller._colorBoostAuto ? (controller._autoColorBoostStrength ?? 0) : controller._colorBoostStrength,
        auto: !!controller._colorBoostAuto,
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
   the other two. */
function resolveShaderType(controller) {
    if (!controller._shaderEnabled) return "off";
    /* A trained CNN or FSR has no intensity knob - the strength slider isn't applied to it at
       all (see `strengthless`) - so a remembered manual strength of 0 must not read as "off"
       the way it does for the sharpen presets, where 0 genuinely is no effect.

       Asked of the REGISTRY, not of the built chains. Using upgradedPresetKey here was a
       genuine dead end, confirmed on device: chains are only built once updateShaderPipeline
       decides the shader should be on, and that decision is this function's own return value.
       So with a persisted strength of 0 and Auto off, tapping "On" asked whether the upgrade
       was strengthless, found no chains built yet, fell through to `strength > 0`, resolved
       back to "off", and the toggle could never be turned on at all. Registration already
       implies the preset's shader source loaded, which is all this question needs.

       Consequence worth knowing: where an upgrade preset is registered, dragging strength to 0
       no longer doubles as "off". That is fine - the mode row has had an explicit Off button
       since it replaced the old enabled-toggle + Auto-checkbox pair. */
    const upgrade = SHADER_TYPES[controller._shaderAutoType]?.upgradeTo;
    if (SHADER_TYPES[upgrade]?.strengthless) return controller._shaderAutoType;
    const hasStrength = controller._upscaleAuto || controller._shaderStrength > 0;
    return hasStrength ? controller._shaderAutoType : "off";
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
   renderShaderFrame below) rather than spending a second full-frame GPU pass. Same
   "toggle IS the persisted setting" immediate-persistence model as ambient lighting
   (ambient-pipeline.js's setAmbientEnabled) - no per-video/genre concern to reconcile
   here either. */
export function setColorBoostEnabled(controller, enabled) {
    controller._colorBoostEnabled = enabled;
    localStorage.setItem(COLOR_BOOST_STORAGE_KEY, enabled ? "1" : "0");
    updateShaderPipeline(controller);
}

export function setColorBoostStrength(controller, strength) {
    controller._colorBoostStrength = strength;
    localStorage.setItem(COLOR_BOOST_STRENGTH_STORAGE_KEY, String(strength));
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

/* Same immediate-persistence model as setColorBoostEnabled/setUpscaleAuto above. Only
   this on/off flag is written through, never the live-computed strength itself (see
   content-analysis.js's sampleContentFrame) - unchecking always falls back to whatever
   _colorBoostStrength the slider was last left at. */
export function setColorBoostAuto(controller, enabled) {
    controller._colorBoostAuto = enabled;
    localStorage.setItem(COLOR_BOOST_AUTO_STORAGE_KEY, enabled ? "1" : "0");
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

/* Same collapsing reasoning as upscaleModeOf/setUpscaleMode above. */
export function colorBoostModeOf(controller) {
    if (!controller._colorBoostEnabled) return "off";
    return controller._colorBoostAuto ? "auto" : "on";
}

export function setColorBoostMode(controller, mode) {
    setColorBoostEnabled(controller, mode !== "off");
    setColorBoostAuto(controller, mode === "auto");
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
        return;
    }
    /* Either toggle keeps this GL pass alive - Color Boost alone still needs the canvas
       rendering (with sharpenStrength forced to 0 in renderShaderFrame below), same as
       shader upscaling alone. */
    if (controller._shaderType === "off" && !controller._colorBoostEnabled && !controller._debandEnabled) {
        stopShaderLoop(controller);
        if (controller._shaderCanvas) controller._shaderCanvas.style.display = "none";
        if (controller._videoEl) controller._videoEl.style.opacity = "1";
        return;
    }
    if (!ensureShaderPipeline(controller)) {
        controller._shaderType = "off";
        controller._colorBoostEnabled = false;
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
        /* Re-resolve rather than only flipping the flag: the family preset is strength-driven
           where the CNN was not, so _shaderType's "is 0 strength off?" answer genuinely changes
           at this moment. */
        controller._shaderType = resolveShaderType(controller);
        updateShaderPipeline(controller);
    };
}

/* Composes and compiles every preset's chain for the *current* optional-pass settings, and
   hangs the result on the controller. Split out of ensureShaderPipeline because the composition
   is no longer fixed for the session: flipping Deband changes what every chain consists of.

   Why the failure is recorded rather than only logged: a preset whose chain doesn't build simply
   isn't in `chains`, which is indistinguishable from a device that never had that preset - so the
   Effects row said nothing at all, and "the upgrade is broken here" looked identical to "there is
   no upgrade here". Diagnosing that cost three rounds of probing a phone. idleUpgradeLabel
   reports these. */
function buildShaderChains(controller, gl, isWebGl2) {
    const options = { deband: !!controller._debandEnabled };
    const chains = {};
    const chainErrors = {};
    for (const [key, preset] of Object.entries(SHADER_TYPES)) {
        try {
            chains[key] = createPassChain(gl, preset.buildPasses(options), { isWebGl2 });
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

/* Deband (restore banded gradients before anything amplifies them) - its own toggle, independent
   of which upscaler is running, because it addresses damage in the source rather than resolution.

   Recomposing every chain is the cost of it being an optional *pass* rather than a uniform. That
   means disposing and recompiling, which is why this is a menu action rather than a slider - and
   why the watchdog is replaced rather than reset: it is now measuring materially different work,
   so a downgrade latched against the old composition no longer describes anything real. */
export function setDebandEnabled(controller, enabled) {
    controller._debandEnabled = enabled;
    localStorage.setItem(DEBAND_STORAGE_KEY, enabled ? "1" : "0");
    if (controller._shaderGl) {
        for (const chain of Object.values(controller._shaderChains ?? {})) chain.dispose();
        buildShaderChains(controller, controller._shaderGl, controller._shaderIsWebGl2);
        controller._shaderWatchdog = createPerfWatchdog({ onDowngrade: makeDowngradeHandler(controller) });
    }
    updateShaderPipeline(controller);
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
    /* A perf downgrade has to be visible from here, not just inside chooseRenderPreset -
       resolveShaderType asks this question too, and if the two disagreed then a strength of 0
       would mean "off" to one and "irrelevant, the CNN ignores it" to the other. */
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
   preset then, and describing what *would* run is the useful answer for a menu. */
export function activePresetKey(controller, familyKey) {
    if (controller._shaderType === "off") return upgradedPresetKey(controller, familyKey);
    const active = controller._shaderActivePreset;
    if (active && controller._shaderChains?.[active]) return active;
    return upgradedPresetKey(controller, familyKey);
}

/* Explains, for the Effects row, why a better preset exists but isn't the one running - the
   question that otherwise costs a round trip to answer. Two distinct reasons, and they call for
   different wording: the upscale gate declined (nothing to upscale, which is correct behavior
   and not a problem), or the perf watchdog stepped it down (a real capability limit). Returns
   null when the upgrade is running, or when there is no upgrade on this device at all. */
export function idleUpgradeLabel(controller, familyKey) {
    const upgrade = SHADER_TYPES[familyKey]?.upgradeTo;
    if (!upgrade || !SHADER_TYPES[upgrade]) return null;
    const label = SHADER_TYPES[upgrade].label;
    /* Chain failed to compile on this GPU - say so, rather than leaving the row silent. This is
       the case that reads as "the feature does nothing" when it is really "this device's shader
       compiler rejected it", and the two need very different follow-up. */
    if (controller._shaderChainErrors?.[upgrade]) return `${label} failed to compile here`;
    if (!controller._shaderChains?.[upgrade]) return null;
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
    /* Color-Boost-only mode (_shaderType "off") must not silently pull in a ten-pass CNN
       just because the title is animated - the whole point of that mode is one cheap pass
       with sharpen forced to 0. */
    if (controller._shaderType !== "off") {
        const upgrade = upgradedPresetKey(controller, familyKey);
        if (upgrade !== familyKey) candidates.push(upgrade);
    }
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
           it - except for a strengthless preset, where strength was never applied at all. */
        const applies = controller._shaderType !== "off" && (preset.strengthless || upscaleStrength > 0);
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
    /* Shader Upscaling and Color Boost are independent toggles sharing this one GL pass.
       When only Color Boost is on, there's no compiled "plain" program to fall back to -
       reuse whichever algorithm this title's genre auto-detected (_shaderAutoType) with
       sharpen forced to 0, which both sharpen shaders reduce to an exact passthrough for
       (see glsl/sharpen-anime.frag.glsl / sharpen-cas.frag.glsl - zero sharpen strength
       leaves the sharpen stage a no-op either way). chooseRenderPreset deliberately skips
       the CNN upgrade in this mode for the same reason. */
    const programType = controller._shaderType !== "off" ? controller._shaderType : controller._shaderAutoType;
    /* Auto strength (see content-analysis.js) writes straight to _autoUpscaleStrength/
       _autoColorBoostStrength rather than through setShaderStrength/setColorBoostStrength
       - those persist to localStorage, which would clobber the remembered manual slider
       position on every sample tick. Resolved here instead, same shape as _shaderAutoType
       being resolved into programType just above. */
    const upscaleStrength = controller._upscaleAuto ? (controller._autoUpscaleStrength ?? 0) : controller._shaderStrength;
    const boostStrength = controller._colorBoostAuto ? (controller._autoColorBoostStrength ?? 0) : controller._colorBoostStrength;
    const colorTuning = controller._colorBoostEnabled
        ? colorBoostAt(boostStrength)
        : { saturation: 1, contrast: 1 };

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
           which pass wants which knob. */
        uniforms: {
            uKernelScale: sharpenTuning.kernel,
            uSharpenStrength: sharpenTuning.sharpen,
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
        updateShaderPipeline(controller);
    }
}
