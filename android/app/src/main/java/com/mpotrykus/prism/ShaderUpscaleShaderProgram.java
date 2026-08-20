package com.mpotrykus.prism;

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
     Anime4K variant. That clamp has its own side effect though: pulling sharpened pixels back
     toward the neighborhood's min/max also slightly flattens contrast/saturation, which is why CAS
     applies the same saturation/contrast boost the anime shader does, just at a much smaller
     magnitude (see ShaderType.LIVE_ACTION's tuning) - compensating for the clamp rather than
     exaggerating the picture the way the anime shader's boost does. This is our own implementation
     of the published Contrast Adaptive Sharpening idea AMD ships with FSR, not a port of AMD's
     actual shader source.

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
          // Clamp to the local 4-neighbor min/max before the [0,1] clamp - same anti-halo
          // technique FRAGMENT_SHADER_CAS below uses. Without this, the unsharp-mask term
          // above overshoots past the neighborhood's actual value range right at
          // high-contrast edges (exactly what anime lineart is), producing a bright/dark
          // halo fringe next to every line instead of a clean sharpened edge.
          + "  vec3 minRgb = min(center, min(min(n, s), min(w, e)));\n"
          + "  vec3 maxRgb = max(center, max(max(n, s), max(w, e)));\n"
          + "  outColor = clamp(outColor, minRgb, maxRgb);\n"
          + "  outColor = clamp(outColor, 0.0, 1.0);\n"
          // Shadow protection - (x-0.5)*contrastBoost+0.5 is a linear stretch pivoted at
          // mid-gray, and for any contrastBoost > 1 that pushes near-black values negative,
          // which the final clamp(0,1) then flattens to exact 0 - different near-black
          // shades collapsing into the same crushed black. Feathering both boosts down to
          // 1.0 (no-op) as luma approaches 0 keeps shadow detail intact while
          // midtones/highlights still get the full lift.
          + "  float shadowProtect = smoothstep(0.0, 0.22, luma(outColor));\n"
          + "  float contrast = mix(1.0, uContrastBoost, shadowProtect);\n"
          + "  float saturation = mix(1.0, uSaturationBoost, shadowProtect);\n"
          // Saturation and Contrast are independent controls - each must be a true no-op on
          // the other. Real bug fixed 2026-08-20, second (deeper) round: a first attempt
          // just reordered contrast/saturation, but a per-channel stretch
          // (x-0.5)*contrast+0.5 multiplies EVERY channel value by contrast, including the
          // differences BETWEEN channels - which is exactly what chroma/saturation is - so
          // contrast still visibly scaled saturation regardless of order. Fix: apply
          // contrast to LUMA ONLY via an additive delta to R/G/B (preserves every channel
          // difference, i.e. chroma, exactly - same trick this codebase's luma-merge
          // shader already uses), then lerp saturation toward that contrast-adjusted luma.
          + "  float l0 = luma(outColor);\n"
          + "  float lc = (l0 - 0.5) * contrast + 0.5;\n"
          + "  vec3 contrastedColor = outColor + (lc - l0);\n"
          + "  outColor = mix(vec3(lc), contrastedColor, saturation);\n"
          + "  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);\n"
          + "}\n";

  private static final String FRAGMENT_SHADER_CAS =
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
          + "  vec3 c = texture2D(uTexSampler, uv).rgb;\n"
          + "  vec3 n = texture2D(uTexSampler, uv + vec2(0.0, -off.y)).rgb;\n"
          + "  vec3 s = texture2D(uTexSampler, uv + vec2(0.0,  off.y)).rgb;\n"
          + "  vec3 w = texture2D(uTexSampler, uv + vec2(-off.x, 0.0)).rgb;\n"
          + "  vec3 e = texture2D(uTexSampler, uv + vec2( off.x, 0.0)).rgb;\n"
          + "  float lc = luma(c); float ln = luma(n); float ls = luma(s); float lw = luma(w); float le = luma(e);\n"
          + "  float minL = min(lc, min(min(ln, ls), min(lw, le)));\n"
          + "  float maxL = max(lc, max(max(ln, ls), max(lw, le)));\n"
          + "  float contrastRange = max(maxL - minL, 0.0001);\n"
          // *10.0 (was *4.0)/*0.5 (was *0.25) - see plex-player.js's SHADER_FRAGMENT_CAS,
          // same shared algorithm on both platforms: the old constants only ever reached
          // full sharpen weight on very high-contrast edges, so most already-compressed
          // streamed video saw almost no visible effect.
          + "  float weight = clamp(contrastRange * 10.0, 0.0, 1.0) * uSharpenStrength;\n"
          + "  vec3 sharpened = c + (4.0 * c - n - s - e - w) * weight * 0.5;\n"
          + "  vec3 minRgb = min(c, min(min(n, s), min(w, e)));\n"
          + "  vec3 maxRgb = max(c, max(max(n, s), max(w, e)));\n"
          + "  vec3 outColor = clamp(sharpened, minRgb, maxRgb);\n"
          // Same shadow-protection reasoning as FRAGMENT_SHADER_ANIME above - feather the
          // contrast/saturation boost down to 1.0 (no-op) as luma approaches 0, so a linear
          // mid-gray-pivoted contrast stretch can't crush near-black shades into flat 0.
          + "  float shadowProtect = smoothstep(0.0, 0.22, luma(outColor));\n"
          + "  float contrast = mix(1.0, uContrastBoost, shadowProtect);\n"
          + "  float saturation = mix(1.0, uSaturationBoost, shadowProtect);\n"
          // Saturation and Contrast are independent controls - see FRAGMENT_SHADER_ANIME's
          // own comment on this fix (2026-08-20).
          + "  float l0 = luma(outColor);\n"
          + "  float lc = (l0 - 0.5) * contrast + 0.5;\n"
          + "  vec3 contrastedColor = outColor + (lc - l0);\n"
          + "  outColor = mix(vec3(lc), contrastedColor, saturation);\n"
          + "  gl_FragColor = vec4(clamp(outColor, 0.0, 1.0), 1.0);\n"
          + "}\n";

  private final GlProgram glProgram;
  private final float scaleFactor;
  private final int maxOutputWidth;
  private final int maxOutputHeight;

  /* programType picks which GLSL variant compiles (Anime4K vs. CAS) - always a real
     algorithm, never OFF, even when sharpenTuning is ShaderType.NEUTRAL (see
     ShaderUpscaleEffect's own header comment for why a program is always needed to
     render through whenever either Shader Upscaling or Color Boost is on).
     sharpenTuning/colorTuning are resolved separately by the caller now (PlayerActivity's
     applyVideoEffects) rather than both coming from one shaderType.tuningAt(strength)
     call - see ShaderTuning/ColorBoostTuning's own header comments for why those two
     concerns were split. */
  ShaderUpscaleShaderProgram(boolean useHdr, ShaderType programType, ShaderTuning sharpenTuning,
      ColorBoostTuning colorTuning, int maxOutputWidth, int maxOutputHeight) throws VideoFrameProcessingException {
    super(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1);
    this.scaleFactor = sharpenTuning.scaleFactor;
    this.maxOutputWidth = maxOutputWidth;
    this.maxOutputHeight = maxOutputHeight;
    try {
      glProgram = new GlProgram(VERTEX_SHADER, programType.useCas ? FRAGMENT_SHADER_CAS : FRAGMENT_SHADER_ANIME);
    } catch (GlUtil.GlException e) {
      throw new VideoFrameProcessingException(e);
    }
    glProgram.setFloatUniform("uKernelScale", sharpenTuning.kernelScale);
    glProgram.setFloatUniform("uSharpenStrength", sharpenTuning.sharpenStrength);
    glProgram.setFloatUniform("uSaturationBoost", colorTuning.saturationBoost);
    glProgram.setFloatUniform("uContrastBoost", colorTuning.contrastBoost);
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
