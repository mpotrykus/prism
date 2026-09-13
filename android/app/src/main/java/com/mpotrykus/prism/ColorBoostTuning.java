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
   applied to both - see PlayerActivity.applyVideoEffects) and lerps them independently.

   Each is bidirectional and centered on 0 (MID, true neutral - a 1.0 multiplier), not a
   one-directional 0-1 strength - PlayerUiHelper's two SeekBars run -100..100 (see
   makeCenteredStrengthSeekBar), not 0..100. MIN is the "reduce" endpoint: 0 for both -
   saturation:0 is the trailing sharpen shader's own full-grayscale mix factor
   (`mix(gray, color, saturationBoost)`), contrast:0 is its own flat-mid-gray point
   (`(luma-0.5)*contrastBoost+0.5` with contrastBoost=0 collapses every pixel's luma to exactly
   0.5) - so -100% actually reaches "no color"/"no contrast", matching what the displayed
   percentage implies (an earlier version mirrored each knob's own +0.3/+0.15 boost delta
   instead - 0.7/0.85 - which left -100% too mild a reduction to read as "fully removed").
   MAX itself is unchanged, so the boost half of the range (and the stored default strength,
   0.5 - "medium boost") behaves exactly as it did before this became bidirectional. Mirrors
   shaders.js's COLOR_BOOST_TUNING/colorBoostAt exactly. */
final class ColorBoostTuning {
    private static final float MIN_SATURATION = 0f;
    private static final float MID_SATURATION = 1f;
    private static final float MAX_SATURATION = 1.3f;
    private static final float MIN_CONTRAST = 0f;
    private static final float MID_CONTRAST = 1f;
    private static final float MAX_CONTRAST = 1.15f;

    static final ColorBoostTuning NEUTRAL = new ColorBoostTuning(MID_SATURATION, MID_CONTRAST);

    final float saturationBoost;
    final float contrastBoost;

    private ColorBoostTuning(float saturationBoost, float contrastBoost) {
        this.saturationBoost = saturationBoost;
        this.contrastBoost = contrastBoost;
    }

    private static float lerpAround(float min, float mid, float max, float strength) {
        float t = Math.max(-1f, Math.min(1f, strength));
        return t >= 0f ? mid + (max - mid) * t : mid + (mid - min) * t;
    }

    static ColorBoostTuning at(float saturationStrength, float contrastStrength) {
        return new ColorBoostTuning(
            lerpAround(MIN_SATURATION, MID_SATURATION, MAX_SATURATION, saturationStrength),
            lerpAround(MIN_CONTRAST, MID_CONTRAST, MAX_CONTRAST, contrastStrength));
    }
}
