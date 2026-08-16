using System;
using Windows.UI;

namespace PrismXboxEffects
{
    /// <summary>
    /// Native port of src/player/content-analysis.js's averageSaturation/averageEdgeEnergy - the
    /// pixel-access half only. The math that turns these two numbers into an actual strength
    /// value (shaders.js's autoUpscaleStrength/autoColorBoostStrength, plus the EMA smoothing in
    /// content-analysis.js's smooth()) deliberately stays in JS: it already knows
    /// scaleFactor (video/display dimensions, via the media facade) and there is no reason to
    /// duplicate tuning logic natively when JS can compute the final strength from two plain
    /// numbers over the bridge.
    /// </summary>
    internal static class ContentAnalysisSampler
    {
        internal static double AverageSaturation(Color[] pixels)
        {
            if (pixels.Length == 0) return 0;
            double total = 0;
            foreach (Color p in pixels)
            {
                int max = Math.Max(p.R, Math.Max(p.G, p.B));
                int min = Math.Min(p.R, Math.Min(p.G, p.B));
                total += (max - min) / 255.0;
            }
            return total / pixels.Length;
        }

        /// <summary>Mean Sobel-style gradient magnitude - same gx/gy math as
        /// SHADER_FRAGMENT_ANIME's edge detection and content-analysis.js's averageEdgeEnergy,
        /// run once over this tiny downsampled grid rather than per-pixel over the full frame.</summary>
        internal static double AverageEdgeEnergy(Color[] pixels, int w, int h)
        {
            if (w < 3 || h < 3) return 0;
            double total = 0;
            int count = 0;
            for (int y = 1; y < h - 1; y++)
            {
                for (int x = 1; x < w - 1; x++)
                {
                    double lN = Luma(pixels[(y - 1) * w + x]);
                    double lS = Luma(pixels[(y + 1) * w + x]);
                    double lW = Luma(pixels[y * w + (x - 1)]);
                    double lE = Luma(pixels[y * w + (x + 1)]);
                    double gx = lE - lW;
                    double gy = lS - lN;
                    total += Math.Sqrt(gx * gx + gy * gy) / 255.0;
                    count++;
                }
            }
            if (count == 0) return 0;
            return Math.Min(1, (total / count) * 4);
        }

        private static double Luma(Color c) => 0.299 * c.R + 0.587 * c.G + 0.114 * c.B;
    }
}
