import QUAD_VERT_100 from "./glsl/quad.vert.glsl?raw";
import QUAD_VERT_300 from "./glsl/quad300.vert.glsl?raw";

/* Multi-pass GPU runtime for the player's shader presets. The original pipeline was a
   single fragment shader rendering the <video> texture straight to the canvas's default
   framebuffer - fine for a sharpen pass, but the real published upscalers (Anime4K's CNN
   chain, ArtCNN, FSR's EASU+RCAS split, NVScaler) are all multi-pass and several of them
   need a pass to read *both* the original source and an earlier pass's output. This owns
   the FBO/texture allocation and input wiring that requires.

   Deliberately not a general-purpose render graph: passes are declared in execution order
   and may only read SOURCE or an *earlier* pass by name, so scheduling is just "run the
   list". A cycle isn't expressible, which is why there's no cycle detection here.

   The last pass always renders to the default framebuffer (the canvas) - it never gets an
   intermediate target - so a 1-pass chain is byte-identical to what the old
   renderShaderFrame did directly, which is what makes the single-pass sharpen presets a
   no-op port onto this runtime rather than a behavior change. */

export const SOURCE = "SOURCE";

/* Uniforms the runtime fills in itself when a shader declares them, so no pass has to be
   handed geometry it can derive. `uTexelSize` is the odd one out - it's 1/size of input 0
   specifically, kept because both original sharpen shaders already use exactly that name
   and meaning, and renaming them would have made this port a rewrite. */
function autoUniformNames(inputUniform) {
    return {
        size: `${inputUniform}Size`,
        texelSize: `${inputUniform}TexelSize`,
    };
}

function compile(gl, type, src, label) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`${label}: ${info}`);
    }
    return shader;
}

/* Reflects the uniform list off the linked program instead of taking a hardcoded name
   list. The old compileShaderProgram looked up a fixed six-entry set, which meant every
   new pass with a different uniform signature needed that list edited - and a typo'd
   uniform name silently became a null location that uploads to nothing. Reflection makes
   the shader source the single declaration of what it takes. */
function reflectUniforms(gl, program) {
    const uniforms = new Map();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (!info) continue;
        /* Array uniforms come back as "name[0]" - store under the bare name so callers can
           pass `{ weights: [...] }` without knowing GL's spelling. */
        const name = info.name.replace(/\[0\]$/, "");
        uniforms.set(name, { location: gl.getUniformLocation(program, info.name), type: info.type, size: info.size });
    }
    return uniforms;
}

function uploadUniform(gl, entry, value) {
    const { location, type } = entry;
    if (location === null) return;
    switch (type) {
        case gl.FLOAT:
            if (Array.isArray(value) || value instanceof Float32Array) gl.uniform1fv(location, value);
            else gl.uniform1f(location, value);
            break;
        case gl.FLOAT_VEC2:
            gl.uniform2fv(location, value);
            break;
        case gl.FLOAT_VEC3:
            gl.uniform3fv(location, value);
            break;
        case gl.FLOAT_VEC4:
            gl.uniform4fv(location, value);
            break;
        case gl.FLOAT_MAT4:
            gl.uniformMatrix4fv(location, false, value);
            break;
        case gl.INT:
        case gl.BOOL:
            gl.uniform1i(location, value ? Number(value) : 0);
            break;
        default:
            /* Samplers are bound by the runtime itself (see bindInputs), never through the
               caller's uniform bag - falling through to a silent no-op here is deliberate
               so a stray sampler name in `uniforms` can't clobber a real binding. */
            break;
    }
}

/* Half-float intermediates matter for the CNN presets specifically: their hidden layers
   carry signed activations well outside 0..1, which an RGBA8 target clamps and quantizes
   into visible blocking. RGBA8 is still the fallback rather than a hard failure - a
   clamped CNN looks worse than float but far better than no upscaler at all, and this
   keeps one code path for GL1 devices too. */
function resolveFloatSupport(gl, isWebGl2) {
    if (!isWebGl2) return false;
    return !!(gl.getExtension("EXT_color_buffer_half_float") || gl.getExtension("EXT_color_buffer_float"));
}

function createTarget(gl, width, height, wantFloat, isWebGl2, floatSupported) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const useFloat = wantFloat && floatSupported;
    if (useFloat && isWebGl2) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        return null;
    }
    return { texture, framebuffer, width, height, float: useFloat };
}

/* `passes` is an ordered array of:
     { name, frag, inputs: [{ uniform, from }], scale?, size?, float? }
   Intermediate target geometry comes from `size(ctx)` when present (mpv's WIDTH/HEIGHT
   expressions need to reference OUTPUT and earlier passes by name, which a bare multiplier
   can't express) or from `scale` relative to SOURCE otherwise. The final pass renders at
   whatever outW/outH render() is given, since that's the canvas the caller already sized to
   the display.

   `float: "required"` means an RGBA8 fallback would be wrong rather than merely worse - CNN
   passes carry signed activations an 8-bit target clamps to 0 - so the whole chain fails to
   build on a context without float render targets, and the caller drops that preset. */
export function createPassChain(gl, passes, { isWebGl2 = false } = {}) {
    const floatSupported = resolveFloatSupport(gl, isWebGl2);
    const needsFloat = passes.some((pass) => pass.float === "required");
    if (needsFloat && !floatSupported) throw new Error("float render targets unavailable (EXT_color_buffer_half_float)");

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const compiled = passes.map((pass) => {
        const wants300 = pass.frag.startsWith("#version 300 es");
        if (wants300 && !isWebGl2) throw new Error(`${pass.name}: GLSL ES 3.00 pass needs a WebGL2 context`);
        const vertexSrc = wants300 ? QUAD_VERT_300 : QUAD_VERT_100;
        const vertexShader = compile(gl, gl.VERTEX_SHADER, vertexSrc, `${pass.name} vertex`);
        const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, pass.frag, `${pass.name} fragment`);
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`${pass.name} link: ${info}`);
        }
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return {
            spec: pass,
            program,
            uniforms: reflectUniforms(gl, program),
            aPosition: gl.getAttribLocation(program, "aPosition"),
        };
    });

    /* Intermediate targets, keyed by pass name. Allocated lazily on the first render and
       thrown away wholesale whenever the source or output geometry changes - a window
       resize or a mid-playback resolution switch (Auto Quality restarts the transcode at a
       different rendition, see core/abr.js) both land here. */
    let targets = new Map();
    let lastSourceW = 0;
    let lastSourceH = 0;
    let lastOutW = 0;
    let lastOutH = 0;

    function releaseTargets() {
        for (const target of targets.values()) {
            gl.deleteFramebuffer(target.framebuffer);
            gl.deleteTexture(target.texture);
        }
        targets = new Map();
    }

    function ensureTargets(sourceW, sourceH, outW, outH) {
        if (sourceW === lastSourceW && sourceH === lastSourceH && outW === lastOutW && outH === lastOutH) return true;
        releaseTargets();
        lastSourceW = sourceW;
        lastSourceH = sourceH;
        lastOutW = outW;
        lastOutH = outH;
        /* Sizes resolve strictly left to right, so a pass's own size expression can only
           reference SOURCE, OUTPUT, or a pass already allocated - the same ordering
           guarantee that makes input wiring acyclic. */
        const known = new Map([[SOURCE, [sourceW, sourceH]]]);
        const sizeCtx = {
            sourceW,
            sourceH,
            outW,
            outH,
            sizeOf: (name) => {
                const size = known.get(name);
                if (!size) throw new Error(`pass size references "${name}" before it is allocated`);
                return size;
            },
        };
        try {
            allocateIntermediates(sizeCtx, known);
        } catch (e) {
            /* A malformed size expression is a load-time authoring bug, but it only surfaces
               once real geometry exists - surfaced here rather than thrown into the rAF loop
               so the caller fails the feature closed the same way it does for a compile
               error. */
            console.error("StreamingPlayer: shader pass sizing failed -", e.message);
            releaseTargets();
            return false;
        }
        return true;
    }

    function allocateIntermediates(sizeCtx, known) {
        const { sourceW, sourceH } = sizeCtx;
        for (let i = 0; i < compiled.length - 1; i++) {
            const { spec } = compiled[i];
            let w;
            let h;
            if (typeof spec.size === "function") {
                [w, h] = spec.size(sizeCtx);
            } else {
                const scale = spec.scale ?? 1;
                w = Math.round(sourceW * scale);
                h = Math.round(sourceH * scale);
            }
            w = Math.max(1, w);
            h = Math.max(1, h);
            const target = createTarget(gl, w, h, !!spec.float, isWebGl2, floatSupported);
            if (!target) throw new Error(`could not allocate a ${w}x${h} target for "${spec.name}"`);
            targets.set(spec.name, target);
            known.set(spec.name, [w, h]);
        }
    }

    function sizeOf(from, sourceW, sourceH) {
        if (from === SOURCE) return [sourceW, sourceH];
        const target = targets.get(from);
        if (!target) throw new Error(`pass input "${from}" has no target - is it declared after the pass reading it?`);
        return [target.width, target.height];
    }

    function textureOf(from, sourceTex) {
        if (from === SOURCE) return sourceTex;
        return targets.get(from).texture;
    }

    function bindInputs(entry, sourceTex, sourceW, sourceH) {
        const inputs = entry.spec.inputs;
        inputs.forEach((input, unit) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, textureOf(input.from, sourceTex));
            const sampler = entry.uniforms.get(input.uniform);
            if (sampler) gl.uniform1i(sampler.location, unit);

            const [w, h] = sizeOf(input.from, sourceW, sourceH);
            const names = autoUniformNames(input.uniform);
            const sizeEntry = entry.uniforms.get(names.size);
            if (sizeEntry) gl.uniform2f(sizeEntry.location, w, h);
            const texelEntry = entry.uniforms.get(names.texelSize);
            if (texelEntry) gl.uniform2f(texelEntry.location, 1 / w, 1 / h);
            /* Back-compat: the two original sharpen shaders take a bare `uTexelSize`
               meaning "1/size of the texture I sample", which is input 0 here. */
            if (unit === 0) {
                const legacy = entry.uniforms.get("uTexelSize");
                if (legacy) gl.uniform2f(legacy.location, 1 / w, 1 / h);
            }
        });
    }

    return {
        get floatTargetsAvailable() {
            return floatSupported;
        },
        get passCount() {
            return compiled.length;
        },

        /* One frame through the whole chain. `uniforms` is a flat bag applied to every pass
           that declares a matching name - passes ignore what they don't declare, so callers
           hand over one tuning object rather than tracking which knob belongs to which
           pass. Returns false if intermediate allocation failed, so the caller can fail the
           feature closed the same way a compile error already does. */
        render({ sourceTex, sourceW, sourceH, outW, outH, uniforms = {} }) {
            if (!ensureTargets(sourceW, sourceH, outW, outH)) return false;

            for (let i = 0; i < compiled.length; i++) {
                const entry = compiled[i];
                const isFinal = i === compiled.length - 1;
                const target = isFinal ? null : targets.get(entry.spec.name);
                const w = isFinal ? outW : target.width;
                const h = isFinal ? outH : target.height;

                gl.bindFramebuffer(gl.FRAMEBUFFER, isFinal ? null : target.framebuffer);
                gl.viewport(0, 0, w, h);
                gl.useProgram(entry.program);

                bindInputs(entry, sourceTex, sourceW, sourceH);

                const outSize = entry.uniforms.get("uOutputSize");
                if (outSize) gl.uniform2f(outSize.location, w, h);
                const outTexel = entry.uniforms.get("uOutputTexelSize");
                if (outTexel) gl.uniform2f(outTexel.location, 1 / w, 1 / h);

                for (const [name, value] of Object.entries(uniforms)) {
                    const uniformEntry = entry.uniforms.get(name);
                    if (uniformEntry) uploadUniform(gl, uniformEntry, value);
                }

                gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
                gl.enableVertexAttribArray(entry.aPosition);
                gl.vertexAttribPointer(entry.aPosition, 2, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            /* Leave the FBO binding clean - ambient lighting and the content-analysis
               sampler share this GL context's canvas only indirectly, but a left-bound
               framebuffer would silently redirect any later draw in this context. */
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            return true;
        },

        dispose() {
            releaseTargets();
            for (const entry of compiled) gl.deleteProgram(entry.program);
            gl.deleteBuffer(quadBuffer);
        },
    };
}
