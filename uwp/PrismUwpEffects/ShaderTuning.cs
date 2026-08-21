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

        private static readonly SharpenTuning Anime4KMin = new SharpenTuning { Scale = 1.8, Sharpen = 1.8, Kernel = 1.5 };
        private static readonly SharpenTuning Anime4KMax = new SharpenTuning { Scale = 2.4, Sharpen = 3.8, Kernel = 2.8 };
        private static readonly SharpenTuning LiveActionMin = new SharpenTuning { Scale = 1.3, Sharpen = 1.0, Kernel = 1.2 };
        private static readonly SharpenTuning LiveActionMax = new SharpenTuning { Scale = 1.6, Sharpen = 2.2, Kernel = 1.8 };
        private const double LiveActionRampToMaxAt = 0.15;

        internal static SharpenTuning ShaderTuningAt(string shaderType, double strength)
        {
            bool isLiveAction = shaderType == "live_action";
            SharpenTuning min = isLiveAction ? LiveActionMin : Anime4KMin;
            SharpenTuning max = isLiveAction ? LiveActionMax : Anime4KMax;
            double rampToMaxAt = isLiveAction ? LiveActionRampToMaxAt : 1.0;
            double t = Clamp(strength / rampToMaxAt, 0, 1);
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
