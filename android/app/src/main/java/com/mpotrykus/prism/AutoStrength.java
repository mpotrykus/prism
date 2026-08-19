package com.mpotrykus.prism;

/* Auto-strength math for Shader Upscaling/Color Boost Saturation/Color Boost Contrast -
   Java port of shaders.js's autoUpscaleStrength/autoColorBoostStrength/
   autoContrastBoostStrength on the web leg, kept as the exact same formula/constants on
   both platforms rather than each guessing its own calibration. See that file's own
   comments for the reasoning behind each constant; not repeated here to avoid the two
   copies drifting out of sync in wording while the numbers stay in sync (or, worse, vice
   versa). */
final class AutoStrength {
    private static final float UPSCALE_MIN_STRENGTH = 0.15f;
    private static final float UPSCALE_RATIO_LOW = 1.0f;
    private static final float UPSCALE_RATIO_HIGH = 3.0f;
    private static final float UPSCALE_DETAIL_DAMPEN_MAX = 0.4f;

    private static final float COLOR_BOOST_SAT_LOW = 0.04f;
    private static final float COLOR_BOOST_SAT_HIGH = 0.2f;

    /* Auto-strength thresholds for Contrast - mirrors shaders.js's
       COLOR_BOOST_AUTO_CONTRAST_LOW/HIGH exactly (see that file's own comment: unlike
       COLOR_BOOST_SAT_LOW/HIGH above, tuned and confirmed against real playback, these two
       are a first estimate against lumaStdDev, not yet confirmed against real reference
       footage). */
    private static final float COLOR_BOOST_CONTRAST_LOW = 0.1f;
    private static final float COLOR_BOOST_CONTRAST_HIGH = 0.28f;

    private AutoStrength() {}

    static float upscale(float scaleFactor, float edgeEnergy) {
        float ratioNeed = clamp((scaleFactor - UPSCALE_RATIO_LOW) / (UPSCALE_RATIO_HIGH - UPSCALE_RATIO_LOW), 0f, 1f);
        float base = UPSCALE_MIN_STRENGTH + ratioNeed * (1f - UPSCALE_MIN_STRENGTH);
        float dampen = clamp(edgeEnergy, 0f, 1f) * UPSCALE_DETAIL_DAMPEN_MAX;
        return clamp(base * (1f - dampen), 0f, 1f);
    }

    static float colorBoost(float avgSaturation) {
        return clamp((COLOR_BOOST_SAT_HIGH - avgSaturation) / (COLOR_BOOST_SAT_HIGH - COLOR_BOOST_SAT_LOW), 0f, 1f);
    }

    /* Contrast can't reuse colorBoost's avgSaturation signal - a desaturated frame isn't
       necessarily a flat/low-contrast one - so it derives from lumaStdDev instead (see
       ContentAnalysisSampler.averageLumaStdDev). Same inverted-lerp shape as colorBoost
       above: a low stdDev (flat, washed-out image) boosts more, a high stdDev (already
       spans a wide tonal range) boosts little to none. */
    static float colorBoostContrast(float lumaStdDev) {
        return clamp((COLOR_BOOST_CONTRAST_HIGH - lumaStdDev) / (COLOR_BOOST_CONTRAST_HIGH - COLOR_BOOST_CONTRAST_LOW), 0f, 1f);
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
