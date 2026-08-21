using Windows.UI;

namespace PrismUwpEffects
{
    /// <summary>Raw per-zone RGB averages for all four edges, one 8-entry triple per edge -
    /// mirrors ambient-pipeline.js's AMBIENT_ZONES_PER_EDGE. Deliberately raw (0-255 per channel,
    /// no saturation/brightness boost, no temporal smoothing) - see AmbientColorSampler's own
    /// header comment for why those two steps stay in JS.
    ///
    /// internal, not public: a WinRT structure may only contain primitives/other structures, never
    /// an array field (WME1060) - this type only ever crosses methods that are themselves internal
    /// (AmbientColorSampler.Compute, EffectSettings.RaiseAmbientColors), so it never needs to be
    /// WinRT-projectable. The public-facing event (EffectSettings.AmbientColorsHandler) passes the
    /// four arrays as separate parameters instead - see that delegate's own comment.</summary>
    internal struct AmbientZoneColors
    {
        public double[] Top;
        public double[] Bottom;
        public double[] Left;
        public double[] Right;
    }

    /// <summary>
    /// Native port of src/player/ambient-pipeline.js's sampleZones/averageRegion - the raw
    /// pixel-averaging half only. boostColor's saturation/brightness lift and smoothZones' EMA
    /// both stay in JS, reused unchanged from that file, so the tuning constants
    /// (AMBIENT_SATURATION_BOOST/AMBIENT_BRIGHTNESS_BOOST/AMBIENT_SMOOTHING_FACTOR) have exactly
    /// one implementation shared by web and Xbox, not a duplicated native copy.
    /// </summary>
    internal static class AmbientColorSampler
    {
        private const int ZonesPerEdge = 8;
        private const double EdgeFraction = 0.25;

        internal static AmbientZoneColors Compute(Color[] pixels, int sampleW, int sampleH)
        {
            int edgeRows = System.Math.Max(1, RoundAwayFromZero(sampleH * EdgeFraction));
            int edgeCols = System.Math.Max(1, RoundAwayFromZero(sampleW * EdgeFraction));

            return new AmbientZoneColors
            {
                Top = SampleZones(pixels, sampleW, sampleH, sampleW, edgeRows, isHorizontalEdge: true, atStart: true),
                Bottom = SampleZones(pixels, sampleW, sampleH, sampleW, edgeRows, isHorizontalEdge: true, atStart: false),
                Left = SampleZones(pixels, sampleW, sampleH, sampleH, edgeCols, isHorizontalEdge: false, atStart: true),
                Right = SampleZones(pixels, sampleW, sampleH, sampleH, edgeCols, isHorizontalEdge: false, atStart: false),
            };
        }

        /// <summary>Returns ZonesPerEdge*3 doubles ([r,g,b] flattened) - flattened rather than a
        /// jagged array so the bridge event can serialize it as one flat JSON array per edge.</summary>
        private static double[] SampleZones(Color[] pixels, int stride, int sampleH, int axisLen, int thickness, bool isHorizontalEdge, bool atStart)
        {
            double[] result = new double[ZonesPerEdge * 3];
            for (int i = 0; i < ZonesPerEdge; i++)
            {
                int a0 = RoundAwayFromZero((i * (double)axisLen) / ZonesPerEdge);
                int a1 = RoundAwayFromZero(((i + 1) * (double)axisLen) / ZonesPerEdge);
                int len = System.Math.Max(1, a1 - a0);

                double r, g, b;
                if (isHorizontalEdge)
                {
                    int y0 = atStart ? 0 : sampleH - thickness;
                    AverageRegion(pixels, stride, a0, y0, len, thickness, out r, out g, out b);
                }
                else
                {
                    int x0 = atStart ? 0 : stride - thickness;
                    AverageRegion(pixels, stride, x0, a0, thickness, len, out r, out g, out b);
                }
                result[i * 3] = r;
                result[i * 3 + 1] = g;
                result[i * 3 + 2] = b;
            }
            return result;
        }

        private static void AverageRegion(Color[] pixels, int stride, int x0, int y0, int w, int h, out double r, out double g, out double b)
        {
            double sr = 0, sg = 0, sb = 0;
            int count = 0;
            for (int y = y0; y < y0 + h; y++)
            {
                for (int x = x0; x < x0 + w; x++)
                {
                    Color p = pixels[y * stride + x];
                    sr += p.R;
                    sg += p.G;
                    sb += p.B;
                    count++;
                }
            }
            if (count == 0)
            {
                r = g = b = 0;
                return;
            }
            r = sr / count;
            g = sg / count;
            b = sb / count;
        }

        // JS's Math.round always rounds .5 away from zero (toward +Infinity for the non-negative
        // values used here); C#'s Math.Round defaults to banker's rounding (round-to-even), which
        // silently disagrees on exact .5 boundaries (e.g. 4.5 -> 4 in C#, 5 in JS). Every zone
        // boundary here is ported directly from ambient-pipeline.js's own Math.round calls, so
        // this must match that behavior exactly rather than use the .NET default.
        private static int RoundAwayFromZero(double value) =>
            (int)System.Math.Round(value, System.MidpointRounding.AwayFromZero);
    }
}
