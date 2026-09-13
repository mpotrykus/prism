package com.mpotrykus.prism;

/* Black point/white point/gamma "levels" adjustment (Levels, see PlayerActivity.
   setLevelsBlackEnabled/setLevelsBlack/setLevelsWhiteEnabled/setLevelsWhite/
   setLevelsGammaEnabled/setLevelsGamma and PlayerUiHelper's Levels menu row), sharing
   AiUpscaleShaderProgram's one GL pass with ColorBoostTuning above rather than a second
   full-frame pass. Black Level/White Level get ColorBoostTuning's own per-component Auto|On|Off
   shape (each independently auto-able - see AutoStrength.levelsBlack/levelsWhite, which reads
   MAX_BLACK/MID_WHITE/MAX_WHITE below directly rather than duplicating them); Gamma has no auto,
   just a plain enabled toggle.

   Mirrors shaders.js's LEVELS_TUNING/levelsAt exactly (kept in numeric lockstep - if these
   ranges ever change, mirror the change there too) and the UWP leg's own ShaderTuning.LevelsAt.

   Each knob is bidirectional and centered on 0 (MID, that knob's true no-op: black point 0,
   white point 1, gamma 1), not a one-directional 0-1 strength - PlayerUiHelper's SeekBars run
   -100..100 (see makeCenteredStrengthSeekBar), not 0..100. MID is not necessarily the arithmetic
   midpoint of MIN/MAX (gamma's isn't), so `at` lerps each side of 0 separately rather than a
   single min-to-max lerp. Black/white are symmetric around their own neutral point (negative
   lifts blacks/dims whites - lower contrast; positive crushes blacks/clips whites - higher
   contrast); gamma is the familiar brighten/darken direction (negative darkens, positive
   brightens midtones). */
final class LevelsTuning {
    private static final float MIN_BLACK = -0.3f;
    private static final float MID_BLACK = 0f;
    // Package-visible (not private) - AutoStrength.levelsBlack reads this directly rather than
    // duplicating the literal, since Auto Black Level resolves a black point exactly at the
    // frame's own darkest sampled luma, in the same units this tuning table's own black.max is.
    static final float MAX_BLACK = 0.3f;
    private static final float MIN_WHITE = 1.3f;
    // Package-visible for the same reason as MAX_BLACK above - AutoStrength.levelsWhite reads
    // both directly.
    static final float MID_WHITE = 1f;
    static final float MAX_WHITE = 0.7f;
    private static final float MIN_GAMMA = 0.5f;
    private static final float MID_GAMMA = 1f;
    private static final float MAX_GAMMA = 1.8f;

    static final LevelsTuning NEUTRAL = new LevelsTuning(MID_BLACK, MID_WHITE, MID_GAMMA);

    final float black;
    final float white;
    final float gamma;

    private LevelsTuning(float black, float white, float gamma) {
        this.black = black;
        this.white = white;
        this.gamma = gamma;
    }

    private static float lerpAround(float min, float mid, float max, float strength) {
        float t = Math.max(-1f, Math.min(1f, strength));
        return t >= 0f ? mid + (max - mid) * t : mid + (mid - min) * t;
    }

    static LevelsTuning at(float blackStrength, float whiteStrength, float gammaStrength) {
        return new LevelsTuning(
            lerpAround(MIN_BLACK, MID_BLACK, MAX_BLACK, blackStrength),
            lerpAround(MIN_WHITE, MID_WHITE, MAX_WHITE, whiteStrength),
            lerpAround(MIN_GAMMA, MID_GAMMA, MAX_GAMMA, gammaStrength));
    }
}
