package com.mpotrykus.prism;

/* Sharpen/upscale knobs only - no saturation/contrast here anymore, see ColorBoostTuning
   for where those moved (their own independent toggle, not tied to whichever
   shader-upscale algorithm a title's genre detected - see ShaderType's own header
   comment for why they were split out). See ShaderType for the endpoint values a
   strength slider interpolates between. */
final class ShaderTuning {
    final float scaleFactor;
    final float sharpenStrength;
    final float kernelScale;

    ShaderTuning(float scaleFactor, float sharpenStrength, float kernelScale) {
        this.scaleFactor = scaleFactor;
        this.sharpenStrength = sharpenStrength;
        this.kernelScale = kernelScale;
    }
}
