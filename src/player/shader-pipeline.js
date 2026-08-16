import { shaderTuningAt, colorBoostAt, SHADER_VERTEX_SRC, SHADER_FRAGMENT_ANIME, SHADER_FRAGMENT_CAS } from "./shader/shaders.js";
import {
    UPSCALE_ENABLED_STORAGE_KEY,
    UPSCALE_STRENGTH_STORAGE_KEY,
    UPSCALE_AUTO_STORAGE_KEY,
    COLOR_BOOST_STORAGE_KEY,
    COLOR_BOOST_STRENGTH_STORAGE_KEY,
    COLOR_BOOST_AUTO_STORAGE_KEY,
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
    const hasStrength = controller._upscaleAuto || controller._shaderStrength > 0;
    return controller._shaderEnabled && hasStrength ? controller._shaderAutoType : "off";
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
    if (controller._shaderType === "off" && !controller._colorBoostEnabled) {
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
    controller._applyZoomTransform();
    startShaderLoop(controller);
}

/* Lazily builds the WebGL pipeline on first use rather than in playWeb - most sessions
   never touch this menu, and compiling two shader programs upfront on every playback
   would be wasted work. Both ShaderType programs are compiled once here and kept
   resident; switching type is just swapping which compiled program renders with, not a
   recompile (see updateShaderPipeline's comment for why that matters). */
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
    const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: false })
        || canvas.getContext("experimental-webgl");
    if (!gl) {
        console.error("StreamingPlayer: WebGL unavailable, shader upscaling disabled");
        return false;
    }

    let programs;
    try {
        programs = {
            anime4k: compileShaderProgram(gl, SHADER_FRAGMENT_ANIME),
            live_action: compileShaderProgram(gl, SHADER_FRAGMENT_CAS),
        };
    } catch (e) {
        console.error("StreamingPlayer: shader compile failed -", e.message);
        return false;
    }

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const texture = gl.createTexture();
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
    controller._shaderPrograms = programs;
    controller._shaderQuadBuffer = quadBuffer;
    controller._shaderTexture = texture;
    document.body.appendChild(canvas);
    return true;
}

export function compileShaderProgram(gl, fragmentSrc) {
    const compile = (type, src) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(info);
        }
        return shader;
    };
    const vertexShader = compile(gl.VERTEX_SHADER, SHADER_VERTEX_SRC);
    const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSrc);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(info);
    }
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    const uniforms = {
        uTex: gl.getUniformLocation(program, "uTex"),
        uTexelSize: gl.getUniformLocation(program, "uTexelSize"),
        uKernelScale: gl.getUniformLocation(program, "uKernelScale"),
        uSharpenStrength: gl.getUniformLocation(program, "uSharpenStrength"),
        uSaturationBoost: gl.getUniformLocation(program, "uSaturationBoost"),
        uContrastBoost: gl.getUniformLocation(program, "uContrastBoost"),
    };
    const aPosition = gl.getAttribLocation(program, "aPosition");
    return { program, uniforms, aPosition };
}

export function startShaderLoop(controller) {
    if (controller._shaderRafId) return;
    const step = () => {
        renderShaderFrame(controller);
        controller._shaderRafId = requestAnimationFrame(step);
    };
    controller._shaderRafId = requestAnimationFrame(step);
}

export function stopShaderLoop(controller) {
    if (controller._shaderRafId) {
        cancelAnimationFrame(controller._shaderRafId);
        controller._shaderRafId = null;
    }
}

/* Mirrors ShaderUpscaleShaderProgram.configure()'s single-scale-factor-bounded-by-both-
   axes approach - scaling width/height independently would distort the aspect ratio
   whenever the screen and video don't match (the common case). Recomputed every frame
   (cheap - a handful of multiplications) rather than cached, since the window can
   resize mid-playback. */
export function renderShaderFrame(controller) {
    const gl = controller._shaderGl;
    const video = controller._videoEl;
    if (!gl || !video || !video.videoWidth || video.readyState < video.HAVE_CURRENT_DATA) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.round((window.innerWidth || document.documentElement.clientWidth) * dpr);
    const displayH = Math.round((window.innerHeight || document.documentElement.clientHeight) * dpr);
    /* Shader Upscaling and Color Boost are independent toggles sharing this one GL pass.
       When only Color Boost is on, there's no compiled "plain" program to fall back to -
       reuse whichever algorithm this title's genre auto-detected (_shaderAutoType) with
       sharpen forced to 0, which both fragment shaders already reduce to an exact
       passthrough for (see SHADER_FRAGMENT_ANIME/_CAS - zero sharpen strength leaves the
       sharpen stage a no-op either way). */
    const programType = controller._shaderType !== "off" ? controller._shaderType : controller._shaderAutoType;
    /* Auto strength (see content-analysis.js) writes straight to _autoUpscaleStrength/
       _autoColorBoostStrength rather than through setShaderStrength/setColorBoostStrength
       - those persist to localStorage, which would clobber the remembered manual slider
       position on every sample tick. Resolved here instead, same shape as _shaderAutoType
       being resolved into programType just above. */
    const upscaleStrength = controller._upscaleAuto ? (controller._autoUpscaleStrength ?? 0) : controller._shaderStrength;
    const boostStrength = controller._colorBoostAuto ? (controller._autoColorBoostStrength ?? 0) : controller._colorBoostStrength;
    /* _shaderType alone isn't enough to gate this - resolveShaderType keeps it resolved
       to a real type throughout Auto mode regardless of the live auto strength (it has
       to, so the content-analysis sampler keeps running and the GL pass stays alive for
       whenever a nonzero value does arrive - see that function's own comment). But
       shaderTuningAt(type, 0) returns that type's own MIN tuning, not a true no-op (e.g.
       live_action's min already carries sharpen:1.0) - the same "0 strength" that means
       fully off in manual mode (there, _shaderType itself already becomes "off" at
       exactly 0) would otherwise render as still-visibly-sharpened once auto legitimately
       computes 0 (source doesn't need upscaling). Checking upscaleStrength > 0 here too
       is what actually makes a live 0 look like off, regardless of which mode produced it. */
    const sharpenTuning = controller._shaderType !== "off" && upscaleStrength > 0
        ? shaderTuningAt(controller._shaderType, upscaleStrength)
        : { scale: 1, sharpen: 0, kernel: 1 };
    const colorTuning = controller._colorBoostEnabled
        ? colorBoostAt(boostStrength)
        : { saturation: 1, contrast: 1 };
    const scale = Math.max(1, Math.min(sharpenTuning.scale, Math.min(displayW / video.videoWidth, displayH / video.videoHeight)));
    const outW = Math.round(video.videoWidth * scale);
    const outH = Math.round(video.videoHeight * scale);
    const canvas = controller._shaderCanvas;
    if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
    }
    gl.viewport(0, 0, outW, outH);

    const { program, uniforms, aPosition } = controller._shaderPrograms[programType];
    gl.useProgram(program);
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

    gl.bindBuffer(gl.ARRAY_BUFFER, controller._shaderQuadBuffer);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(uniforms.uTex, 0);
    gl.uniform2f(uniforms.uTexelSize, 1 / video.videoWidth, 1 / video.videoHeight);
    gl.uniform1f(uniforms.uKernelScale, sharpenTuning.kernel);
    gl.uniform1f(uniforms.uSharpenStrength, sharpenTuning.sharpen);
    if (uniforms.uSaturationBoost) {
        gl.uniform1f(uniforms.uSaturationBoost, colorTuning.saturation);
        gl.uniform1f(uniforms.uContrastBoost, colorTuning.contrast);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
