package com.mpotrykus.prism;

/* Contrast/saturation "look" boost - its own independent toggle (Color Boost, see
   PlayerActivity.setColorBoostEnabled/setColorBoostSaturationStrength/
   setColorBoostContrastStrength and PlayerUiHelper's Color Boost menu row), not tied to
   whichever ShaderType algorithm a title's genre detected. Used to be folded into
   ShaderTuning/ShaderType's own min/max tuning, but a linear contrast stretch pivoted at
   mid-gray ((x-0.5)*contrastBoost+0.5) crushes near-black shades into flat 0 once the
   boost multiplier rides high enough (confirmed: the old Anime4K max of 1.18x crushed
   anything under ~7.6% luma to exact 0 post-clamp) - composing that with the strongest
   shader-upscale tuning made the crush worse than necessary. Splitting it into its own
   toggle with its own strength slider keeps that choice in the user's hands independent
   of sharpening, and the sharpen GLSL (see AiUpscaleShaderProgram's ensurePlainChain, and the
   CNN/FSR chain's own trailing sharpen pass) now also feathers this boost down to 1.0 (no-op)
   as luma approaches black (shadowProtect) regardless of which toggle drives it.

   Saturation and contrast are themselves independent sliders now (see PlayerUiHelper's
   two SeekBars), not one combined "strength" - `at` takes each one's own resolved
   strength (manual or auto-resolved, same single avgSaturation-driven auto signal
   applied to both - see PlayerActivity.applyVideoEffects) and lerps them independently. */
final class ColorBoostTuning {
    private static final float MIN_SATURATION = 1f;
    private static final float MAX_SATURATION = 1.3f;
    private static final float MIN_CONTRAST = 1f;
    private static final float MAX_CONTRAST = 1.15f;

    static final ColorBoostTuning NEUTRAL = new ColorBoostTuning(1f, 1f);

    final float saturationBoost;
    final float contrastBoost;

    private ColorBoostTuning(float saturationBoost, float contrastBoost) {
        this.saturationBoost = saturationBoost;
        this.contrastBoost = contrastBoost;
    }

    static ColorBoostTuning at(float saturationStrength, float contrastStrength) {
        float satT = Math.max(0f, Math.min(1f, saturationStrength));
        float conT = Math.max(0f, Math.min(1f, contrastStrength));
        return new ColorBoostTuning(
            MIN_SATURATION + (MAX_SATURATION - MIN_SATURATION) * satT,
            MIN_CONTRAST + (MAX_CONTRAST - MIN_CONTRAST) * conT);
    }
}
