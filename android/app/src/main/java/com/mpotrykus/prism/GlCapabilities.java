package com.mpotrykus.prism;

import android.opengl.GLES20;
import android.opengl.GLES30;
import android.util.Log;

/* One-time-per-process probe of what the *current* GL context can actually do, run lazily the
   first time anything asks - not assumed from GLES30.glGetString(GL_VERSION) alone, since that
   string reports the driver's ceiling, not what the EGL context Media3's video-effects pipeline
   handed us was created with. GLSL ES 3.00 ("#version 300 es", the format every mpv-user-shader
   vendored file requires) only compiles under a real ES3 context; a GLES2 context rejects it at
   compile time regardless of what the Java GLES30 class can technically call. Same story for
   RGBA16F float render targets - core in ES3, an extension-only maybe on ES2. Both are load-
   bearing for the CNN/FSR chains (GlPassChain), so this is checked once, empirically, before
   either preset is offered rather than assumed and left to fail deep inside a chain build. */
final class GlCapabilities {

    static final class Result {
        final boolean gles3ShaderCompiles;
        final boolean floatRenderTargetWorks;

        Result(boolean gles3ShaderCompiles, boolean floatRenderTargetWorks) {
            this.gles3ShaderCompiles = gles3ShaderCompiles;
            this.floatRenderTargetWorks = floatRenderTargetWorks;
        }

        boolean cnnFsrChainsSupported() {
            return gles3ShaderCompiles && floatRenderTargetWorks;
        }
    }

    private static final String TAG = "PrismGlCaps";
    private static Result cached;

    private GlCapabilities() {}

    /* Must be called with a GL context current (i.e. from inside a GlShaderProgram callback -
       configure()/drawFrame() are both fine, they're invoked on the video-effects GL thread). */
    static Result detect() {
        if (cached != null) return cached;
        boolean shaderOk = probeGles3ShaderCompile();
        boolean floatOk = probeFloatRenderTarget();
        cached = new Result(shaderOk, floatOk);
        Log.i(TAG, "detect: gles3ShaderCompiles=" + shaderOk + " floatRenderTargetWorks=" + floatOk
            + " glVersion=" + GLES20.glGetString(GLES20.GL_VERSION));
        return cached;
    }

    private static boolean probeGles3ShaderCompile() {
        String vertexSrc = "#version 300 es\n"
            + "in vec4 aPos;\n"
            + "void main() { gl_Position = aPos; }\n";
        String fragmentSrc = "#version 300 es\n"
            + "precision mediump float;\n"
            + "out vec4 oColor;\n"
            + "void main() { oColor = vec4(1.0); }\n";
        int vs = GLES30.glCreateShader(GLES30.GL_VERTEX_SHADER);
        int fs = GLES30.glCreateShader(GLES30.GL_FRAGMENT_SHADER);
        int program = 0;
        try {
            if (vs == 0 || fs == 0) return false;
            if (!compile(vs, vertexSrc) || !compile(fs, fragmentSrc)) return false;
            program = GLES30.glCreateProgram();
            if (program == 0) return false;
            GLES30.glAttachShader(program, vs);
            GLES30.glAttachShader(program, fs);
            GLES30.glLinkProgram(program);
            int[] status = new int[1];
            GLES30.glGetProgramiv(program, GLES30.GL_LINK_STATUS, status, 0);
            if (status[0] != GLES30.GL_TRUE) {
                Log.w(TAG, "probeGles3ShaderCompile: link failed - " + GLES30.glGetProgramInfoLog(program));
                return false;
            }
            return true;
        } finally {
            GLES30.glDeleteShader(vs);
            GLES30.glDeleteShader(fs);
            if (program != 0) GLES30.glDeleteProgram(program);
        }
    }

    private static boolean compile(int shader, String src) {
        GLES30.glShaderSource(shader, src);
        GLES30.glCompileShader(shader);
        int[] status = new int[1];
        GLES30.glGetShaderiv(shader, GLES30.GL_COMPILE_STATUS, status, 0);
        if (status[0] != GLES30.GL_TRUE) {
            Log.w(TAG, "probeGles3ShaderCompile: compile failed - " + GLES30.glGetShaderInfoLog(shader));
            return false;
        }
        return true;
    }

    private static boolean probeFloatRenderTarget() {
        int[] tex = new int[1];
        int[] fbo = new int[1];
        int[] prevFbo = new int[1];
        GLES30.glGetIntegerv(GLES30.GL_FRAMEBUFFER_BINDING, prevFbo, 0);
        try {
            GLES30.glGenTextures(1, tex, 0);
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tex[0]);
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA16F, 64, 64, 0,
                GLES30.GL_RGBA, GLES30.GL_HALF_FLOAT, null);
            int glErr = GLES30.glGetError();
            if (glErr != GLES30.GL_NO_ERROR) {
                Log.w(TAG, "probeFloatRenderTarget: glTexImage2D(RGBA16F) failed, error=0x" + Integer.toHexString(glErr));
                return false;
            }
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE);
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE);

            GLES30.glGenFramebuffers(1, fbo, 0);
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo[0]);
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                GLES30.GL_TEXTURE_2D, tex[0], 0);
            int status = GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER);
            if (status != GLES30.GL_FRAMEBUFFER_COMPLETE) {
                Log.w(TAG, "probeFloatRenderTarget: framebuffer incomplete, status=0x" + Integer.toHexString(status));
                return false;
            }
            return true;
        } finally {
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, prevFbo[0]);
            if (fbo[0] != 0) GLES30.glDeleteFramebuffers(1, fbo, 0);
            if (tex[0] != 0) GLES30.glDeleteTextures(1, tex, 0);
        }
    }
}
