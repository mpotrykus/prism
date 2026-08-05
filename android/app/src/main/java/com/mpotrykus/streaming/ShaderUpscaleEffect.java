package com.mpotrykus.streaming;

import android.content.Context;
import android.util.DisplayMetrics;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.GlEffect;
import androidx.media3.effect.GlShaderProgram;

/* Factory side of ShaderUpscaleShaderProgram - see that class for the actual shaders, and
   ShaderType for what shaderType/strength resolve to. Caps the upscale target at the device's own
   display resolution (this activity is locked to sensorLandscape, see AndroidManifest.xml, so
   DisplayMetrics read once here stays valid for the activity's lifetime) and skips the pass
   entirely once the source is already at or above that, via isNoOp - no point spending a GPU pass
   upscaling a stream the display can't show any larger. */
@UnstableApi
final class ShaderUpscaleEffect implements GlEffect {

  private final ShaderType shaderType;
  private final float strength;
  private final int maxOutputWidth;
  private final int maxOutputHeight;

  ShaderUpscaleEffect(Context context, ShaderType shaderType, float strength) {
    this.shaderType = shaderType;
    this.strength = strength;
    DisplayMetrics metrics = context.getResources().getDisplayMetrics();
    this.maxOutputWidth = metrics.widthPixels;
    this.maxOutputHeight = metrics.heightPixels;
  }

  @Override
  public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
      throws VideoFrameProcessingException {
    return new ShaderUpscaleShaderProgram(useHdr, shaderType, strength, maxOutputWidth, maxOutputHeight);
  }

  @Override
  public boolean isNoOp(int inputWidth, int inputHeight) {
    return inputWidth >= maxOutputWidth || inputHeight >= maxOutputHeight;
  }
}
