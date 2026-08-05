package com.mpotrykus.streaming;

import android.opengl.GLES20;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.GlProgram;
import androidx.media3.common.util.GlUtil;
import androidx.media3.common.util.Size;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.BaseGlShaderProgram;

/* Two single-pass GLSL shader variants sharing one Java implementation, selected via
   ShaderType.useCas:

   - The Anime4K/RAVU-lite-inspired variant (FRAGMENT_SHADER_ANIME): hardware-bilinear upscale to a
     display-capped target resolution, plus a Sobel-edge-gated unsharp mask so only real line-art
     contours pick up the "AI upscale" crispness boost. Tuned for anime/line-art: it makes a hard
     edge/no-edge decision, which looks great on flat color fields and clean contours but tends to
     ring/halo on live-action's soft photographic gradients and amplify film grain/sensor noise.
   - The CAS-inspired variant (FRAGMENT_SHADER_CAS), better suited to live-action: derives the
     sharpen weight from local *contrast range* instead of a binary edge decision (gentle in flat or
     already-high-contrast regions, stronger in genuine mid-detail), then clamps the result to the
     local neighborhood's own min/max - the anti-ringing guard that's the real difference from the
     Anime4K variant, and the reason CAS doesn't need a separate contrast/saturation boost the way
     the anime shader does (see ShaderType - its live-action tuning leaves those at 1.0). This is our
     own implementation of the published Contrast Adaptive Sharpening idea AMD ships with FSR, not a
     port of AMD's actual shader source.

   Neither is a deep-CNN super-resolution model - see docs/plezy-player-comparison.md's "Deferred
   features" section for why that's out of scope on any of this app's platforms. Intensity is a
   continuous 0f-1f strength, resolved to concrete knob values via ShaderType.tuningAt() - see that
   enum for the 0%/100% endpoints each shader type interpolates between. */
@UnstableApi
final class ShaderUpscaleShaderProgram extends BaseGlShaderProgram {

  private static final String VERTEX_SHADER =
      "attribute vec4 aFramePosition;\n"
          + "varying vec2 vTexSamplingCoord;\n"
          + "void main() {\n"
          + "  gl_Position = aFramePosition;\n"
          + "  vTexSamplingCoord = vec2(aFramePosition.x * 0.5 + 0.5, aFramePosition.y * 0.5 + 0.5);\n"
          + "}\n";

  private static final String FRAGMENT_SHADER_ANIME =
      "precision mediump float;\n"
          + "uniform sampler2D uTexSampler;\n"
          + "uniform vec2 uTexelSize;\n"
          + "uniform float uKernelScale;\n"
          + "uniform float uSharpenStrength;\n"
          + "uniform float uSaturationBoost;\n"
          + "uniform float uContrastBoost;\n"
          + "varying vec2 vTexSamplingCoord;\n"
          + "float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }\n"
          + "void main() {\n"
          + "  vec2 uv = vTexSamplingCoord;\n"
          + "  vec2 off = uTexelSize * uKernelScale;\n"
          + "  vec3 center = texture2D(uTexSampler, uv).rgb;\n"
          + "  vec3 n  = texture2D(uTexSampler, uv + vec2(0.0, -off.y)).rgb;\n"
          + "  vec3 s  = texture2D(uTexSampler, uv + vec2(0.0,  off.y)).rgb;\n"
          + "  vec3 w  = texture2D(uTexSampler, uv + vec2(-off.x, 0.0)).rgb;\n"
          + "  vec3 e  = texture2D(uTexSampler, uv + vec2( off.x, 0.0)).rgb;\n"
          + "  vec3 nw = texture2D(uTexSampler, uv + vec2(-off.x, -off.y)).rgb;\n"
          + "  vec3 ne = texture2D(uTexSampler, uv + vec2( off.x, -off.y)).rgb;\n"
          + "  vec3 sw = texture2D(uTexSampler, uv + vec2(-off.x,  off.y)).rgb;\n"
          + "  vec3 se = texture2D(uTexSampler, uv + vec2( off.x,  off.y)).rgb;\n"
          + "  float lN = luma(n); float lS = luma(s); float lW = luma(w); float lE = luma(e);\n"
          + "  float lNW = luma(nw); float lNE = luma(ne); float lSW = luma(sw); float lSE = luma(se);\n"
          + "  float gx = (lNE + 2.0 * lE + lSE) - (lNW + 2.0 * lW + lSW);\n"
          + "  float gy = (lSW + 2.0 * lS + lSE) - (lNW + 2.0 * lN + lNE);\n"
          + "  float edge = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);\n"
          + "  vec3 blurredNeighborhood = (n + s + w + e) * 0.25;\n"
          + "  vec3 outColor = center + (center - blurredNeighborhood) * uSharpenStrength * edge;\n"
          + "  outColor = clamp(outColor, 0.0, 1.0);\n"
          + "  outColor = (outColor - 0.5) * uContrastBoost + 0.5;\n"
          + "  outColor = mix(vec3(luma(outColor)), outColor, uSaturationBoost);\n"
          + "  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);\n"
          + "}\n";

  private static final String FRAGMENT_SHADER_CAS =
      "precision mediump float;\n"
          + "uniform sampler2D uTexSampler;\n"
          + "uniform vec2 uTexelSize;\n"
          + "uniform float uKernelScale;\n"
          + "uniform float uSharpenStrength;\n"
          + "varying vec2 vTexSamplingCoord;\n"
          + "float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }\n"
          + "void main() {\n"
          + "  vec2 uv = vTexSamplingCoord;\n"
          + "  vec2 off = uTexelSize * uKernelScale;\n"
          + "  vec3 c = texture2D(uTexSampler, uv).rgb;\n"
          + "  vec3 n = texture2D(uTexSampler, uv + vec2(0.0, -off.y)).rgb;\n"
          + "  vec3 s = texture2D(uTexSampler, uv + vec2(0.0,  off.y)).rgb;\n"
          + "  vec3 w = texture2D(uTexSampler, uv + vec2(-off.x, 0.0)).rgb;\n"
          + "  vec3 e = texture2D(uTexSampler, uv + vec2( off.x, 0.0)).rgb;\n"
          + "  float lc = luma(c); float ln = luma(n); float ls = luma(s); float lw = luma(w); float le = luma(e);\n"
          + "  float minL = min(lc, min(min(ln, ls), min(lw, le)));\n"
          + "  float maxL = max(lc, max(max(ln, ls), max(lw, le)));\n"
          + "  float contrastRange = max(maxL - minL, 0.0001);\n"
          + "  float weight = clamp(contrastRange * 4.0, 0.0, 1.0) * uSharpenStrength;\n"
          + "  vec3 sharpened = c + (4.0 * c - n - s - e - w) * weight * 0.25;\n"
          + "  vec3 minRgb = min(c, min(min(n, s), min(w, e)));\n"
          + "  vec3 maxRgb = max(c, max(max(n, s), max(w, e)));\n"
          + "  gl_FragColor = vec4(clamp(sharpened, minRgb, maxRgb), 1.0);\n"
          + "}\n";

  private final GlProgram glProgram;
  private final float scaleFactor;
  private final int maxOutputWidth;
  private final int maxOutputHeight;

  ShaderUpscaleShaderProgram(boolean useHdr, ShaderType shaderType, float strength,
      int maxOutputWidth, int maxOutputHeight) throws VideoFrameProcessingException {
    super(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1);
    ShaderTuning tuning = shaderType.tuningAt(strength);
    this.scaleFactor = tuning.scaleFactor;
    this.maxOutputWidth = maxOutputWidth;
    this.maxOutputHeight = maxOutputHeight;
    try {
      glProgram = new GlProgram(VERTEX_SHADER, shaderType.useCas ? FRAGMENT_SHADER_CAS : FRAGMENT_SHADER_ANIME);
    } catch (GlUtil.GlException e) {
      throw new VideoFrameProcessingException(e);
    }
    glProgram.setFloatUniform("uKernelScale", tuning.kernelScale);
    glProgram.setFloatUniform("uSharpenStrength", tuning.sharpenStrength);
    if (!shaderType.useCas) {
      glProgram.setFloatUniform("uSaturationBoost", tuning.saturationBoost);
      glProgram.setFloatUniform("uContrastBoost", tuning.contrastBoost);
    }
    glProgram.setBufferAttribute(
        "aFramePosition",
        GlUtil.getNormalizedCoordinateBounds(),
        GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE);
  }

  @Override
  public Size configure(int inputWidth, int inputHeight) {
    glProgram.setFloatsUniform("uTexelSize", new float[] {1f / inputWidth, 1f / inputHeight});
    /* One scale factor applied to both axes - clamping width/height independently against the
       device's display bounds would scale them by different amounts whenever the screen's aspect
       ratio doesn't match the video's (the common case), distorting the frame so PlayerView's
       aspect-ratio layout then stretches it to fill the screen instead of upscaling in place. */
    float scale = Math.min(scaleFactor,
        Math.min((float) maxOutputWidth / inputWidth, (float) maxOutputHeight / inputHeight));
    scale = Math.max(scale, 1f);
    return new Size(Math.round(inputWidth * scale), Math.round(inputHeight * scale));
  }

  @Override
  public void drawFrame(int inputTexId, long presentationTimeUs)
      throws VideoFrameProcessingException {
    try {
      glProgram.use();
      glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, /* texUnitIndex= */ 0);
      glProgram.bindAttributesAndUniforms();
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4);
    } catch (GlUtil.GlException e) {
      throw new VideoFrameProcessingException(e, presentationTimeUs);
    }
  }

  @Override
  public void release() throws VideoFrameProcessingException {
    super.release();
    try {
      glProgram.delete();
    } catch (GlUtil.GlException e) {
      throw new VideoFrameProcessingException(e);
    }
  }
}
