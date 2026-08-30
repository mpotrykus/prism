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
        /// not one combined "strength" - each gets its own strength/range lerped independently.</summary>
        internal static ColorTuning ColorBoostAt(double saturationStrength, double contrastStrength)
        {
            double satT = Clamp(saturationStrength, 0, 1);
            double conT = Clamp(contrastStrength, 0, 1);
            return new ColorTuning
            {
                Saturation = Lerp(1.0, 1.3, satT),
                Contrast = Lerp(1.0, 1.15, conT),
            };
        }

        private static double Lerp(double a, double b, double t) => a + (b - a) * t;

        private static double Clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);
    }
}
