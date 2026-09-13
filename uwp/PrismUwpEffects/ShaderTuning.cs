namespace PrismUwpEffects
{
    /// <summary>
    /// Native port of src/player/shader/shaders.js's SHADER_TYPES/shaderTuningAt/COLOR_BOOST_TUNING/
    /// colorBoostAt - pure math, kept in exact numeric lockstep with the web/Android tuning curves
    /// (see that file's own comments for why these specific constants, e.g. CAS ramping to max by
    /// 15% strength) rather than re-derived here. If those tables ever change, mirror the change
    /// here too - there is no way to share the literal JS module with this native project.
    /// </summary>
    internal static class ShaderTuning
    {
        internal struct SharpenTuning
        {
            public double Scale;
            public double Sharpen;
            public double Kernel;
        }

        internal struct ColorTuning
        {
            public double Saturation;
            public double Contrast;
        }

        internal struct LevelsTuning
        {
            public double Black;
            public double White;
            public double Gamma;
        }

        /* min.Sharpen/Kernel are deliberately near-zero, not "the lightest visible tier" - both
           used to sit at an already-visible sharpen (1.8/1.5 and 1.0/1.2) because LiveAction also
           compressed the whole 0-100% slider into its first 15% via LiveActionRampToMaxAt, to
           make "Strong" reachable without most of the slider feeling unchanged. That combination
           meant even 1% strength landed almost exactly at that already-strong min, producing
           visible jaggies right at the bottom of the slider - reported 2026-08-30. Fix: drop min
           to near-zero for both families and use a plain linear ramp across the full 0-100%
           range - 1% now lands close to min, genuinely subtle, climbing smoothly to the
           unchanged max at 100%. */
        private static readonly SharpenTuning Anime4KMin = new SharpenTuning { Scale = 1.8, Sharpen = 0.15, Kernel = 1.0 };
        private static readonly SharpenTuning Anime4KMax = new SharpenTuning { Scale = 2.4, Sharpen = 3.8, Kernel = 2.8 };
        private static readonly SharpenTuning LiveActionMin = new SharpenTuning { Scale = 1.3, Sharpen = 0.1, Kernel = 1.0 };
        private static readonly SharpenTuning LiveActionMax = new SharpenTuning { Scale = 1.6, Sharpen = 2.2, Kernel = 1.8 };

        internal static SharpenTuning ShaderTuningAt(string shaderType, double strength)
        {
            bool isLiveAction = shaderType == "live_action";
            SharpenTuning min = isLiveAction ? LiveActionMin : Anime4KMin;
            SharpenTuning max = isLiveAction ? LiveActionMax : Anime4KMax;
            double t = Clamp(strength, 0, 1);
            return new SharpenTuning
            {
                Scale = Lerp(min.Scale, max.Scale, t),
                Sharpen = Lerp(min.Sharpen, max.Sharpen, t),
                Kernel = Lerp(min.Kernel, max.Kernel, t),
            };
        }

        /// <summary>Largest Kernel value either shader type can ever produce - the value
        /// ShaderVideoEffect must configure MaxSamplerOffset with, since it has to cover the worst
        /// case regardless of which type/strength is active at any given moment.</summary>
        internal const double MaxKernelScale = 2.8;

        /// <summary>Saturation and contrast are independent sliders (see EffectSettings'
        /// ColorBoostSaturationStrength/ColorBoostContrastStrength) sharing one Auto/On/Off mode,
        /// not one combined "strength" - each gets its own strength/range lerped independently.
        ///
        /// Each is bidirectional and centered on 0 (true neutral - a 1.0 multiplier), not a
        /// one-directional 0..1 strength - the JS chrome's two sliders (chrome-menu-effects.js's
        /// buildCenteredStrengthSlider) run -100%..100%, and this native leg is fed that same
        /// -1..1 range over the bridge. The "reduce" endpoint is 0 for both - saturation:0 is the
        /// trailing sharpen shader's own full-grayscale mix factor, contrast:0 is its own
        /// flat-mid-gray point - so -100% actually reaches "no color"/"no contrast", matching what
        /// the displayed percentage implies (an earlier version mirrored each knob's own boost
        /// delta instead - 0.7/0.85 - which left -100% too mild a reduction to read as "fully
        /// removed"). The boost endpoint (1.3/1.15) is unchanged, so that half of the range (and
        /// the stored default strength, 0.5) behaves exactly as it did before this became
        /// bidirectional. Mirrors shaders.js's COLOR_BOOST_TUNING/colorBoostAt exactly.</summary>
        internal static ColorTuning ColorBoostAt(double saturationStrength, double contrastStrength)
        {
            return new ColorTuning
            {
                Saturation = LerpAround(0.0, 1.0, 1.3, saturationStrength),
                Contrast = LerpAround(0.0, 1.0, 1.15, contrastStrength),
            };
        }

        /// <summary>Native port of shaders.js's LEVELS_TUNING/levelsAt. Black Level and White
        /// Level get ColorBoostAt's own per-component Auto/On/Off shape (see EffectSettings'
        /// LevelsBlackEnabled/LevelsWhiteEnabled); Gamma has no Auto, just a plain enabled flag
        /// (LevelsGammaEnabled). Each disabled component's strength is forced to 0 by the caller.
        ///
        /// Each knob is bidirectional and centered on 0 (mid, that knob's true no-op: black
        /// point 0, white point 1, gamma 1), not a one-directional 0..1 strength - the JS chrome's
        /// three sliders (chrome-menu-effects.js's buildCenteredStrengthSlider) run -100%..100%,
        /// not 0..100%, and this native leg is fed that same -1..1 range over the bridge (see
        /// xbox-bridge.js's postLevels). mid is not necessarily the arithmetic midpoint of
        /// min/max (gamma's isn't), so LerpAround lerps each side of 0 separately rather than a
        /// single min-to-max lerp. Black/white are symmetric around their own neutral point
        /// (negative lifts blacks/dims whites - lower contrast; positive crushes blacks/clips
        /// whites - higher contrast); gamma is the familiar brighten/darken direction (negative
        /// darkens, positive brightens midtones).</summary>
        internal static LevelsTuning LevelsAt(double blackStrength, double whiteStrength, double gammaStrength)
        {
            return new LevelsTuning
            {
                Black = LerpAround(-0.3, 0.0, 0.3, blackStrength),
                White = LerpAround(1.3, 1.0, 0.7, whiteStrength),
                Gamma = LerpAround(0.5, 1.0, 1.8, gammaStrength),
            };
        }

        private static double Lerp(double a, double b, double t) => a + (b - a) * t;

        private static double LerpAround(double min, double mid, double max, double strength)
        {
            double t = Clamp(strength, -1, 1);
            return t >= 0 ? mid + (max - mid) * t : mid + (mid - min) * t;
        }

        private static double Clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);
    }
}
