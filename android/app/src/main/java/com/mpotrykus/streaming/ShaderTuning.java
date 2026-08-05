package com.mpotrykus.streaming;

/* Immutable set of ShaderUpscaleShaderProgram's tunable knobs - see ShaderType for the endpoint
   values a strength slider interpolates between. */
final class ShaderTuning {
    final float scaleFactor;
    final float sharpenStrength;
    final float kernelScale;
    final float saturationBoost;
    final float contrastBoost;

    ShaderTuning(float scaleFactor, float sharpenStrength, float kernelScale,
            float saturationBoost, float contrastBoost) {
        this.scaleFactor = scaleFactor;
        this.sharpenStrength = sharpenStrength;
        this.kernelScale = kernelScale;
        this.saturationBoost = saturationBoost;
        this.contrastBoost = contrastBoost;
    }
}
