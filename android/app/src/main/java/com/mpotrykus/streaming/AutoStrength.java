package com.mpotrykus.streaming;

/* Auto-strength math for Shader Upscaling/Color Boost - Java port of shaders.js's
   autoUpscaleStrength/autoColorBoostStrength on the web leg, kept as the exact same
   formula/constants on both platforms rather than each guessing its own calibration.
   See that file's own comments for the reasoning behind each constant; not repeated
   here to avoid the two copies drifting out of sync in wording while the numbers stay
   in sync (or, worse, vice versa). */
final class AutoStrength {
    private static final float UPSCALE_MIN_STRENGTH = 0.15f;
    private static final float UPSCALE_RATIO_LOW = 1.0f;
    private static final float UPSCALE_RATIO_HIGH = 3.0f;
    private static final float UPSCALE_DETAIL_DAMPEN_MAX = 0.4f;

    private static final float COLOR_BOOST_SAT_LOW = 0.04f;
    private static final float COLOR_BOOST_SAT_HIGH = 0.2f;

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

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
