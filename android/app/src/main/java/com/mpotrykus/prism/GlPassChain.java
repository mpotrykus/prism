package com.mpotrykus.prism;

import android.content.res.AssetManager;
import android.opengl.GLES30;
import android.util.Log;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/* Java port of src/player/shader/pass-chain.js - the multi-pass FBO runtime the CNN (Anime4K)
   and FSR1 presets need. See that file's own header comment for the design: passes execute in
   declared order and may only read SOURCE or an *earlier* pass by name (no cycles, no general
   render graph), and the last pass always renders into whatever framebuffer the caller hands
   render() - the "default framebuffer" equivalent, which on Android is the output FBO Media3's
   BaseGlShaderProgram already bound before calling drawFrame().

   Uses GLES30 throughout rather than GLES20, even for the two legacy ES-1.00-style sharpen
   shaders this chain can also run - a real ES3 context (confirmed via GlCapabilities on this
   device) is required to be backward-compatible with ES-1.00-style shading language, and mixing
   GLES20/GLES30 call surfaces for what is one GL context buys nothing. Float (RGBA16F)
   intermediates are required, not merely preferred, by every mpv-loaded pass (CNN activations,
   luma) - GlCapabilities.detect() is checked once here rather than assumed, mirroring the web
   leg's own resolveFloatSupport/needsFloat guard in pass-chain.js. */
final class GlPassChain {

    static final String SOURCE = "SOURCE";
    private static final String TAG = "PrismPassChain";

    // ---- pass descriptor ----

    static final class PassSpec {
        final String name;
        final String frag;
        final List<Input> inputs;
        final SizeFn size; // nullable - falls back to `scale` relative to SOURCE
        final float scale;
        final boolean floatRequired;

        PassSpec(String name, String frag, List<Input> inputs, SizeFn size, float scale, boolean floatRequired) {
            this.name = name;
            this.frag = frag;
            this.inputs = inputs;
            this.size = size;
            this.scale = scale;
            this.floatRequired = floatRequired;
        }

        PassSpec(String name, String frag, List<Input> inputs, float scale, boolean floatRequired) {
            this(name, frag, inputs, null, scale, floatRequired);
        }

        static final class Input {
            final String uniform;
            final String from;
            Input(String uniform, String from) {
                this.uniform = uniform;
                this.from = from;
            }
        }

        interface SizeFn {
            int[] size(SizeCtx ctx);
        }
    }

    interface SizeCtx {
        int outW();
        int outH();
        int[] sizeOf(String name);
    }

    // ---- compiled state ----

    private static final class UniformInfo {
        final int location;
        final int type;
        UniformInfo(int location, int type) {
            this.location = location;
            this.type = type;
        }
    }

    private static final class CompiledPass {
        final PassSpec spec;
        final int program;
        final Map<String, UniformInfo> uniforms;
        final int aPositionLoc;
        CompiledPass(PassSpec spec, int program, Map<String, UniformInfo> uniforms, int aPositionLoc) {
            this.spec = spec;
            this.program = program;
            this.uniforms = uniforms;
            this.aPositionLoc = aPositionLoc;
        }
    }

    private static final class Target {
        final int texture;
        final int framebuffer;
        final int width;
        final int height;
        Target(int texture, int framebuffer, int width, int height) {
            this.texture = texture;
            this.framebuffer = framebuffer;
            this.width = width;
            this.height = height;
        }
    }

    private final List<CompiledPass> compiled = new ArrayList<>();
    private final Map<String, Target> targets = new HashMap<>();
    private final int quadVbo;
    private int lastSourceW = -1, lastSourceH = -1, lastOutW = -1, lastOutH = -1;

    GlPassChain(AssetManager assets, List<PassSpec> passes) {
        boolean anyFloatRequired = false;
        for (PassSpec p : passes) if (p.floatRequired) anyFloatRequired = true;
        if (anyFloatRequired && !GlCapabilities.detect().floatRenderTargetWorks) {
            throw new IllegalStateException("float render targets unavailable on this GL context");
        }

        String vert100 = GlAssetLoader.read(assets, "quad.vert.glsl");
        String vert300 = GlAssetLoader.read(assets, "quad300.vert.glsl");

        float[] quad = {-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f};
        FloatBuffer quadBuf = ByteBuffer.allocateDirect(quad.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        quadBuf.put(quad).position(0);
        int[] vboHolder = new int[1];
        GLES30.glGenBuffers(1, vboHolder, 0);
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vboHolder[0]);
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, quad.length * 4, quadBuf, GLES30.GL_STATIC_DRAW);
        quadVbo = vboHolder[0];

        for (PassSpec spec : passes) {
            boolean wants300 = spec.frag.startsWith("#version 300 es");
            String vertexSrc = wants300 ? vert300 : vert100;
            int vs = compileShader(GLES30.GL_VERTEX_SHADER, vertexSrc, spec.name + " vertex");
            int fs = compileShader(GLES30.GL_FRAGMENT_SHADER, spec.frag, spec.name + " fragment");
            int program = linkProgram(vs, fs, spec.name);
            GLES30.glDeleteShader(vs);
            GLES30.glDeleteShader(fs);
            Map<String, UniformInfo> uniforms = reflectUniforms(program);
            int aPos = GLES30.glGetAttribLocation(program, "aPosition");
            compiled.add(new CompiledPass(spec, program, uniforms, aPos));
        }
    }

    int passCount() {
        return compiled.size();
    }

    private static int compileShader(int type, String src, String label) {
        int shader = GLES30.glCreateShader(type);
        GLES30.glShaderSource(shader, src);
        GLES30.glCompileShader(shader);
        int[] status = new int[1];
        GLES30.glGetShaderiv(shader, GLES30.GL_COMPILE_STATUS, status, 0);
        if (status[0] != GLES30.GL_TRUE) {
            String info = GLES30.glGetShaderInfoLog(shader);
            GLES30.glDeleteShader(shader);
            throw new RuntimeException(label + ": " + info);
        }
        return shader;
    }

    private static int linkProgram(int vs, int fs, String label) {
        int program = GLES30.glCreateProgram();
        GLES30.glAttachShader(program, vs);
        GLES30.glAttachShader(program, fs);
        GLES30.glLinkProgram(program);
        int[] status = new int[1];
        GLES30.glGetProgramiv(program, GLES30.GL_LINK_STATUS, status, 0);
        if (status[0] != GLES30.GL_TRUE) {
            String info = GLES30.glGetProgramInfoLog(program);
            GLES30.glDeleteProgram(program);
            throw new RuntimeException(label + " link: " + info);
        }
        return program;
    }

    private static Map<String, UniformInfo> reflectUniforms(int program) {
        Map<String, UniformInfo> uniforms = new HashMap<>();
        int[] count = new int[1];
        GLES30.glGetProgramiv(program, GLES30.GL_ACTIVE_UNIFORMS, count, 0);
        int[] size = new int[1];
        int[] type = new int[1];
        for (int i = 0; i < count[0]; i++) {
            String rawName = GLES30.glGetActiveUniform(program, i, size, 0, type, 0);
            if (rawName == null) continue;
            String name = rawName.endsWith("[0]") ? rawName.substring(0, rawName.length() - 3) : rawName;
            int location = GLES30.glGetUniformLocation(program, rawName);
            uniforms.put(name, new UniformInfo(location, type[0]));
        }
        return uniforms;
    }

    private Target createTarget(int width, int height, boolean wantFloat) {
        int[] texHolder = new int[1];
        GLES30.glGenTextures(1, texHolder, 0);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texHolder[0]);
        if (wantFloat) {
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA16F, width, height, 0, GLES30.GL_RGBA, GLES30.GL_HALF_FLOAT, null);
        } else {
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, width, height, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
        }
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE);

        int[] fboHolder = new int[1];
        GLES30.glGenFramebuffers(1, fboHolder, 0);
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fboHolder[0]);
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, texHolder[0], 0);
        boolean complete = GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) == GLES30.GL_FRAMEBUFFER_COMPLETE;
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        if (!complete) {
            GLES30.glDeleteFramebuffers(1, fboHolder, 0);
            GLES30.glDeleteTextures(1, texHolder, 0);
            return null;
        }
        return new Target(texHolder[0], fboHolder[0], width, height);
    }

    private void releaseTargets() {
        for (Target t : targets.values()) {
            int[] fb = {t.framebuffer};
            GLES30.glDeleteFramebuffers(1, fb, 0);
            int[] tex = {t.texture};
            GLES30.glDeleteTextures(1, tex, 0);
        }
        targets.clear();
    }

    private boolean ensureTargets(int sourceW, int sourceH, int outW, int outH) {
        if (sourceW == lastSourceW && sourceH == lastSourceH && outW == lastOutW && outH == lastOutH) return true;
        releaseTargets();
        lastSourceW = sourceW;
        lastSourceH = sourceH;
        lastOutW = outW;
        lastOutH = outH;

        Map<String, int[]> known = new HashMap<>();
        known.put(SOURCE, new int[] {sourceW, sourceH});
        SizeCtx ctx = new SizeCtx() {
            @Override public int outW() { return outW; }
            @Override public int outH() { return outH; }
            @Override public int[] sizeOf(String name) {
                int[] size = known.get(name);
                if (size == null) throw new IllegalStateException("pass size references \"" + name + "\" before it is allocated");
                return size;
            }
        };
        try {
            for (int i = 0; i < compiled.size() - 1; i++) {
                PassSpec spec = compiled.get(i).spec;
                int w, h;
                if (spec.size != null) {
                    int[] wh = spec.size.size(ctx);
                    w = wh[0];
                    h = wh[1];
                } else {
                    w = Math.round(sourceW * spec.scale);
                    h = Math.round(sourceH * spec.scale);
                }
                w = Math.max(1, w);
                h = Math.max(1, h);
                Target target = createTarget(w, h, spec.floatRequired);
                if (target == null) throw new IllegalStateException("could not allocate a " + w + "x" + h + " target for \"" + spec.name + "\"");
                targets.put(spec.name, target);
                known.put(spec.name, new int[] {w, h});
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "shader pass sizing failed - " + e.getMessage());
            releaseTargets();
            return false;
        }
        return true;
    }

    private int textureOf(String from, int sourceTex) {
        if (from.equals(SOURCE)) return sourceTex;
        return targets.get(from).texture;
    }

    private int[] sizeOf(String from, int sourceW, int sourceH) {
        if (from.equals(SOURCE)) return new int[] {sourceW, sourceH};
        Target t = targets.get(from);
        if (t == null) throw new IllegalStateException("pass input \"" + from + "\" has no target - is it declared after the pass reading it?");
        return new int[] {t.width, t.height};
    }

    private void bindInputs(CompiledPass entry, int sourceTex, int sourceW, int sourceH) {
        List<PassSpec.Input> inputs = entry.spec.inputs;
        for (int unit = 0; unit < inputs.size(); unit++) {
            PassSpec.Input input = inputs.get(unit);
            GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + unit);
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, textureOf(input.from, sourceTex));
            UniformInfo sampler = entry.uniforms.get(input.uniform);
            if (sampler != null) GLES30.glUniform1i(sampler.location, unit);

            int[] wh = sizeOf(input.from, sourceW, sourceH);
            UniformInfo sizeEntry = entry.uniforms.get(input.uniform + "Size");
            if (sizeEntry != null) GLES30.glUniform2f(sizeEntry.location, wh[0], wh[1]);
            UniformInfo texelEntry = entry.uniforms.get(input.uniform + "TexelSize");
            if (texelEntry != null) GLES30.glUniform2f(texelEntry.location, 1f / wh[0], 1f / wh[1]);
            if (unit == 0) {
                UniformInfo legacy = entry.uniforms.get("uTexelSize");
                if (legacy != null) GLES30.glUniform2f(legacy.location, 1f / wh[0], 1f / wh[1]);
            }
        }
    }

    private static void uploadUniform(UniformInfo entry, Object value) {
        if (entry.location < 0) return;
        if (entry.type == GLES30.GL_FLOAT) {
            GLES30.glUniform1f(entry.location, ((Number) value).floatValue());
        } else if (entry.type == GLES30.GL_FLOAT_VEC2) {
            float[] v = (float[]) value;
            GLES30.glUniform2f(entry.location, v[0], v[1]);
        } else if (entry.type == GLES30.GL_INT || entry.type == GLES30.GL_BOOL) {
            GLES30.glUniform1i(entry.location, ((Number) value).intValue());
        }
        // Samplers are bound by bindInputs, never through this bag - see pass-chain.js's own
        // uploadUniform for why falling through silently here is deliberate.
    }

    /** One frame through the whole chain. Returns false if intermediate allocation failed. */
    boolean render(int sourceTex, int sourceW, int sourceH, int outW, int outH, Map<String, Object> uniformsBag, int outputFramebuffer) {
        if (!ensureTargets(sourceW, sourceH, outW, outH)) return false;

        for (int i = 0; i < compiled.size(); i++) {
            CompiledPass entry = compiled.get(i);
            boolean isFinal = i == compiled.size() - 1;
            Target target = isFinal ? null : targets.get(entry.spec.name);
            int w = isFinal ? outW : target.width;
            int h = isFinal ? outH : target.height;

            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, isFinal ? outputFramebuffer : target.framebuffer);
            GLES30.glViewport(0, 0, w, h);
            GLES30.glUseProgram(entry.program);

            bindInputs(entry, sourceTex, sourceW, sourceH);

            UniformInfo outSize = entry.uniforms.get("uOutputSize");
            if (outSize != null) GLES30.glUniform2f(outSize.location, w, h);
            UniformInfo outTexel = entry.uniforms.get("uOutputTexelSize");
            if (outTexel != null) GLES30.glUniform2f(outTexel.location, 1f / w, 1f / h);

            for (Map.Entry<String, Object> u : uniformsBag.entrySet()) {
                UniformInfo info = entry.uniforms.get(u.getKey());
                if (info != null) uploadUniform(info, u.getValue());
            }

            GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, quadVbo);
            GLES30.glEnableVertexAttribArray(entry.aPositionLoc);
            GLES30.glVertexAttribPointer(entry.aPositionLoc, 2, GLES30.GL_FLOAT, false, 0, 0);
            GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4);
        }
        return true;
    }

    void release() {
        releaseTargets();
        for (CompiledPass p : compiled) GLES30.glDeleteProgram(p.program);
        int[] vbo = {quadVbo};
        GLES30.glDeleteBuffers(1, vbo, 0);
    }
}
