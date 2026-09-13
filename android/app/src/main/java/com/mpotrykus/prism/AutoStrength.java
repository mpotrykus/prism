package com.mpotrykus.prism;

/* Auto-strength math for Sharpening/Color Boost Saturation/Color Boost Contrast -
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

    /* Auto-strength math for Levels' Black Level/White Level. Deliberately NOT lumaStdDev-based
       (an earlier version reused colorBoostContrast's signal directly) - lumaStdDev measures how
       spread out the frame's tones are, which has no relationship to where the frame's actual
       black/white points already sit, so it could push the black/white point past real image
       data and clip/crush detail that was never actually redundant. Confirmed in practice: far
       too aggressive, clipping a lot.

       The correct "never clip" behavior is a true levels stretch: read the frame's own darkest/
       brightest sampled luma (minLuma/maxLuma, both 0..1 - see
       ContentAnalysisSampler.averageMinMaxLuma) and move the black/white point to EXACTLY that
       value, never past it. Every pixel already at or above minLuma (resp. at or below maxLuma)
       keeps a distinct, non-clipped value - by construction, nothing in the frame is darker than
       minLuma or brighter than maxLuma, so nothing gets crushed/clipped that wasn't already at
       the new endpoint. A frame that already reaches true black/white (minLuma near 0/maxLuma
       near 1) resolves to ~0 strength - a correct no-op, not a floor. Solved by inverting
       LevelsTuning.at's own lerp for the knob's MAX tier (its most extreme still-defined tuning
       point) and clamping to 0..1 - reads LevelsTuning.MAX_BLACK/MID_WHITE/MAX_WHITE directly
       rather than duplicating those literals. Mirrors shaders.js's
       autoLevelsBlackStrength/autoLevelsWhiteStrength exactly. */
    static float levelsBlack(float minLuma) {
        return clamp(minLuma / LevelsTuning.MAX_BLACK, 0f, 1f);
    }

    static float levelsWhite(float maxLuma) {
        return clamp((LevelsTuning.MID_WHITE - maxLuma) / (LevelsTuning.MID_WHITE - LevelsTuning.MAX_WHITE), 0f, 1f);
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
