package com.mpotrykus.prism;

import android.content.Context;
import android.util.DisplayMetrics;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.GlEffect;
import androidx.media3.effect.GlShaderProgram;

/* Factory side of ShaderUpscaleShaderProgram - see that class for the actual shaders, and
   ShaderType for what programType resolves to. Caps the upscale target at the device's own
   display resolution (this activity is locked to sensorLandscape, see AndroidManifest.xml, so
   DisplayMetrics read once here stays valid for the activity's lifetime).

   Constructed whenever either Shader Upscaling or Color Boost is on (see PlayerActivity's
   applyVideoEffects) - programType always picks a real GLSL algorithm (Anime4K or CAS), even when
   sharpenTuning is ShaderType.NEUTRAL (Color Boost alone, sharpening off): both fragment shaders
   reduce to an exact passthrough for their sharpen stage at sharpenStrength=0 (CAS's anti-ringing
   clamp bounds already include the center pixel itself, so clamp(c, min, max) = c; Anime4K's
   unsharp-mask term is multiplied straight through by sharpenStrength), so reusing whichever
   algorithm this title's genre auto-detected costs nothing extra to render a color-only pass
   through - no separate "plain" program needed, mirroring the web leg's renderShaderFrame. */
@UnstableApi
final class ShaderUpscaleEffect implements GlEffect {

  private final ShaderType programType;
  private final ShaderTuning sharpenTuning;
  private final ColorBoostTuning colorTuning;
  private final int maxOutputWidth;
  private final int maxOutputHeight;

  ShaderUpscaleEffect(Context context, ShaderType programType, ShaderTuning sharpenTuning, ColorBoostTuning colorTuning) {
    this.programType = programType;
    this.sharpenTuning = sharpenTuning;
    this.colorTuning = colorTuning;
    DisplayMetrics metrics = context.getResources().getDisplayMetrics();
    this.maxOutputWidth = metrics.widthPixels;
    this.maxOutputHeight = metrics.heightPixels;
  }

  @Override
  public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
      throws VideoFrameProcessingException {
    return new ShaderUpscaleShaderProgram(useHdr, programType, sharpenTuning, colorTuning, maxOutputWidth, maxOutputHeight);
  }

  /* No point spending a GPU pass upscaling/sharpening a stream the display can't show any
     larger - but that resolution gate only applies to the sharpen/upscale stage
     (upscalingRequested), never to Color Boost, which has nothing to do with resolution.
     Skips entirely only when both stages have nothing to contribute. */
  @Override
  public boolean isNoOp(int inputWidth, int inputHeight) {
    boolean upscalingRequested = sharpenTuning.sharpenStrength > 0f;
    boolean sharpenNoOp = !upscalingRequested || (inputWidth >= maxOutputWidth && inputHeight >= maxOutputHeight);
    boolean colorNoOp = colorTuning.saturationBoost == 1f && colorTuning.contrastBoost == 1f;
    return sharpenNoOp && colorNoOp;
  }
}
