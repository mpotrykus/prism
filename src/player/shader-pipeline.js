import { shaderTuningAt, SHADER_VERTEX_SRC, SHADER_FRAGMENT_ANIME, SHADER_FRAGMENT_CAS } from "./shader/shaders.js";

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
   slider's position is remembered independently of whether the toggle is currently on. */
export function setShaderStrength(controller, strength) {
    controller._shaderStrength = strength;
    controller._shaderType = controller._shaderEnabled && strength > 0 ? controller._shaderAutoType : "off";
    updateShaderPipeline(controller);
}

/* The "more" menu's inline toggle (see chrome.js's openHamburgerMenu) - flips whether the
   shader runs at all without touching _shaderStrength, so switching back on restores
   whatever strength the slider was already at instead of resetting it. */
export function setShaderEnabled(controller, enabled) {
    controller._shaderEnabled = enabled;
    controller._shaderType = enabled && controller._shaderStrength > 0 ? controller._shaderAutoType : "off";
    updateShaderPipeline(controller);
}

/* Off by default - same reasoning as the Android leg (ShaderUpscaleEffect): this spends
   an extra GPU pass every frame, only worth it on already-low-resolution sources.
   Unlike Android, there's no per-drag rebuild hazard here (see PlayerActivity's
   showShaderUpscaleDialog gotcha) - both compiled programs stay resident, so re-running
   this on every drag tick (setShaderStrength above) is cheap: ensureShaderPipeline
   no-ops once already built, and start/stop only takes effect when the 0%/>0% boundary
   is actually crossed. */
export function updateShaderPipeline(controller) {
    if (controller._shaderType === "off") {
        stopShaderLoop(controller);
        if (controller._shaderCanvas) controller._shaderCanvas.style.display = "none";
        if (controller._videoEl) controller._videoEl.style.opacity = "1";
        return;
    }
    if (!ensureShaderPipeline(controller)) {
        controller._shaderType = "off";
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
        background: "#000",
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
    const tuning = shaderTuningAt(controller._shaderType, controller._shaderStrength);
    const scale = Math.max(1, Math.min(tuning.scale, Math.min(displayW / video.videoWidth, displayH / video.videoHeight)));
    const outW = Math.round(video.videoWidth * scale);
    const outH = Math.round(video.videoHeight * scale);
    const canvas = controller._shaderCanvas;
    if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
    }
    gl.viewport(0, 0, outW, outH);

    const { program, uniforms, aPosition } = controller._shaderPrograms[controller._shaderType];
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
    gl.uniform1f(uniforms.uKernelScale, tuning.kernel);
    gl.uniform1f(uniforms.uSharpenStrength, tuning.sharpen);
    if (uniforms.uSaturationBoost) {
        gl.uniform1f(uniforms.uSaturationBoost, tuning.saturation);
        gl.uniform1f(uniforms.uContrastBoost, tuning.contrast);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
