using System;
using System.Runtime.InteropServices.WindowsRuntime;

namespace PrismUwpEffects
{
    /// <summary>
    /// (avgSaturation, edgeEnergy, lumaStdDev) - a plain <c>Action&lt;double,double,double&gt;</c>
    /// is not usable here: this assembly compiles as a Windows Runtime Component
    /// (<c>OutputType=winmdobj</c>), and every public member is projected into Windows Metadata,
    /// which does not support open generic delegates like <c>System.Action&lt;T&gt;</c> - only a
    /// real (non-generic) delegate type. lumaStdDev backs Auto Contrast (see
    /// ContentAnalysisSampler.AverageLumaStdDev) - added alongside avgSaturation/edgeEnergy once
    /// Saturation and Contrast became independently auto-able rather than sharing one signal.
    /// </summary>
    public delegate void ContentAnalysisHandler(double avgSaturation, double edgeEnergy, double lumaStdDev);

    /// <summary>
    /// Four raw per-zone RGB-average arrays (top/bottom/left/right, 24 doubles each - 8 zones * 3
    /// channels), passed as separate array parameters rather than one struct: WinRT structs may
    /// only contain primitives/other structs, never arrays (see AmbientColorSampler's own
    /// AmbientZoneColors, which stays internal for exactly this reason - it cannot be exported).
    /// Plain array parameters are fine for WinRT delegates/methods; only STRUCT FIELDS disallow
    /// them. Each still needs an explicit [ReadOnlyArray]/[WriteOnlyArray] direction (WME1106) -
    /// WinRT has no notion of a plain "in" array otherwise, since arrays marshal by reference.
    /// </summary>
    public delegate void AmbientColorsHandler(
        [ReadOnlyArray] double[] top,
        [ReadOnlyArray] double[] bottom,
        [ReadOnlyArray] double[] left,
        [ReadOnlyArray] double[] right);

    /// <summary>A single string is already a WinRT-primitive type, so this needs no custom
    /// marshaling attributes the way AmbientColorsHandler's arrays did.</summary>
    public delegate void EffectLogHandler(string message);

    /// <summary>Windowed fps + average per-frame processing time from ShaderVideoEffect's own
    /// Sharpening/Color Boost/Ambient pipeline - see that class's RecordFrameLoad. Two plain
    /// doubles need no custom marshaling, same as ContentAnalysisHandler's three.</summary>
    public delegate void FrameLoadHandler(double fps, double avgFrameMs);

    /// <summary>
    /// Shared state between <see cref="PrismUwp.Player.NativePlayerHost"/> (UI thread, a
    /// different assembly - PrismUwp.csproj references this project) and
    /// <see cref="ShaderVideoEffect"/> (a Media Foundation work thread, activated in-process by
    /// <c>MediaPlayer.AddVideoEffect</c> with no handle returned to the caller - see that
    /// method's own signature, which is <c>void</c>).
    ///
    /// Because there is no returned handle, there is no way to call a live "update properties"
    /// method on the running effect instance. The two documented alternatives are (a) relying on
    /// the <c>PropertySet</c> passed to <c>AddVideoEffect</c> being observed live via
    /// <c>IObservableMap</c>, which is not confirmed to actually be wired up by the media
    /// pipeline's wrapper around <see cref="Windows.Media.Effects.IBasicVideoEffect"/>, or (b) a
    /// plain shared, same-process settings object. This project uses (b) - it does not depend on
    /// unconfirmed platform behavior, and there is only ever one <c>MediaPlayer</c>/one effect
    /// instance per app session, so a static singleton is the actual lifetime this needs, not an
    /// approximation of it.
    ///
    /// Only the members PrismUwp's NativePlayerHost actually calls across the assembly boundary
    /// are public (SetShaderEffect/SetColorBoost/SetAmbientLighting/ShouldAttach/the two events,
    /// all WinRT-primitive-typed already) - Current/Snapshot are read only by ShaderVideoEffect in
    /// this same assembly, so they stay internal rather than fighting WinRT's export rules for no
    /// reason (a nested public struct can't be exported at all - WME1025 - and every member of a
    /// public winmdobj type is checked for WinRT-compatibility whether or not anything outside this
    /// assembly actually needs it).
    ///
    /// All reads/writes go through the lock: ProcessFrame runs on a background thread while
    /// NativePlayerHost's SetShaderEffect/SetColorBoost/SetAmbientLighting run on the UI thread,
    /// and a snapshot must be internally consistent (e.g. ShaderType must match ShaderStrength
    /// from the same call, not a torn mix of two different SetShaderEffect calls).
    /// </summary>
    public static class EffectSettings
    {
        private static readonly object Gate = new object();

        private static bool _shaderEnabled;
        private static string _shaderType = "live_action";
        private static double _shaderStrength;
        private static bool _shaderAuto;
        /* Saturation and Contrast are fully independent controls now - each its own
           enabled/auto pair, each auto-deriving from its own signal (avgSaturation for
           Saturation, lumaStdDev for Contrast - see ContentAnalysisSampler) - not one
           shared _colorBoostEnabled/_colorBoostAuto pair. */
        private static bool _colorBoostSaturationEnabled;
        private static bool _colorBoostContrastEnabled;
        private static double _colorBoostSaturationStrength;
        private static double _colorBoostContrastStrength;
        private static bool _colorBoostSaturationAuto;
        private static bool _colorBoostContrastAuto;
        private static bool _ambientEnabled;
        // Set by NativePlayerHost right after hdr.EnableAsync()/RestoreAsync() settles (the real,
        // re-read display state, not the raw request) - lets ShaderVideoEffect skip its SDR-tuned
        // Sharpening/Color Boost draw on HDR titles (see ProcessFrame) without touching
        // ShouldAttach, which Ambient Lighting's own frame sampling also depends on and has
        // nothing to do with this.
        private static bool _isHdrActive;
        // Set by NativePlayerHost's SetAiUpscalePathActive alongside player.IsVideoFrameServerEnabled.
        // AiUpscalePixelEffect's own trailing-sharpen step (see that class) already reapplies
        // Sharpening/Color Boost on the frame-server surface that's actually shown once this is
        // true, so ShaderVideoEffect's own visual draw here would be pure duplicate GPU work on a
        // surface nobody sees (Element.Visibility is Collapsed at that point) - lets ProcessFrame
        // skip it the same way IsHdrActive does, again without touching ShouldAttach/sampling.
        private static bool _isAiUpscaleActive;

        internal struct Snapshot
        {
            public bool ShaderEnabled;
            public string ShaderType;
            public double ShaderStrength;
            public bool ShaderAuto;
            public bool ColorBoostSaturationEnabled;
            public bool ColorBoostContrastEnabled;
            public double ColorBoostSaturationStrength;
            public double ColorBoostContrastStrength;
            public bool ColorBoostSaturationAuto;
            public bool ColorBoostContrastAuto;
            public bool AmbientEnabled;
            public bool IsHdrActive;
            public bool IsAiUpscaleActive;
        }

        /// <summary>True whenever the video-effect pass needs to be attached to the MediaPlayer at
        /// all - either something visual is on, or something needs frame samples (auto-strength or
        /// ambient lighting). Mirrors shader-pipeline.js's updateShaderPipeline gate
        /// ("_shaderType === 'off' && !_colorBoostSaturationEnabled && !_colorBoostContrastEnabled"
        /// => stop), extended with the two sampling cases web/Android never needed a native
        /// equivalent of.</summary>
        public static bool ShouldAttach
        {
            get
            {
                lock (Gate)
                {
                    return _shaderEnabled || _colorBoostSaturationEnabled || _colorBoostContrastEnabled || _ambientEnabled;
                }
            }
        }

        public static void SetShaderEffect(bool enabled, string shaderType, double strength, bool auto)
        {
            lock (Gate)
            {
                _shaderEnabled = enabled;
                if (!string.IsNullOrEmpty(shaderType)) _shaderType = shaderType;
                _shaderStrength = strength;
                _shaderAuto = auto;
            }
        }

        public static void SetColorBoost(
            bool saturationEnabled, bool contrastEnabled,
            double saturationStrength, double contrastStrength,
            bool saturationAuto, bool contrastAuto)
        {
            lock (Gate)
            {
                _colorBoostSaturationEnabled = saturationEnabled;
                _colorBoostContrastEnabled = contrastEnabled;
                _colorBoostSaturationStrength = saturationStrength;
                _colorBoostContrastStrength = contrastStrength;
                _colorBoostSaturationAuto = saturationAuto;
                _colorBoostContrastAuto = contrastAuto;
            }
        }

        public static void SetAmbientLighting(bool enabled)
        {
            lock (Gate)
            {
                _ambientEnabled = enabled;
            }
        }

        public static void SetHdrActive(bool isHdrActive)
        {
            lock (Gate)
            {
                _isHdrActive = isHdrActive;
            }
        }

        public static void SetAiUpscaleActive(bool isAiUpscaleActive)
        {
            lock (Gate)
            {
                _isAiUpscaleActive = isAiUpscaleActive;
            }
        }

        internal static Snapshot Current
        {
            get
            {
                lock (Gate)
                {
                    return new Snapshot
                    {
                        ShaderEnabled = _shaderEnabled,
                        ShaderType = _shaderType,
                        ShaderStrength = _shaderStrength,
                        ShaderAuto = _shaderAuto,
                        ColorBoostSaturationEnabled = _colorBoostSaturationEnabled,
                        ColorBoostContrastEnabled = _colorBoostContrastEnabled,
                        ColorBoostSaturationStrength = _colorBoostSaturationStrength,
                        ColorBoostContrastStrength = _colorBoostContrastStrength,
                        ColorBoostSaturationAuto = _colorBoostSaturationAuto,
                        ColorBoostContrastAuto = _colorBoostContrastAuto,
                        AmbientEnabled = _ambientEnabled,
                        IsHdrActive = _isHdrActive,
                        IsAiUpscaleActive = _isAiUpscaleActive,
                    };
                }
            }
        }

        /// <summary>Raised off ShaderVideoEffect's ProcessFrame thread (NOT the UI thread) - a
        /// subscriber must marshal to the UI thread itself before touching WebView2, same
        /// requirement NativePlayerHost's own `emit` delegate already documents for
        /// MediaPlaybackSession's events.</summary>
        public static event ContentAnalysisHandler ContentAnalysis;

        public static event AmbientColorsHandler AmbientColors;

        internal static void RaiseContentAnalysis(double avgSaturation, double edgeEnergy, double lumaStdDev)
        {
            ContentAnalysis?.Invoke(avgSaturation, edgeEnergy, lumaStdDev);
        }

        internal static void RaiseAmbientColors(AmbientZoneColors colors)
        {
            AmbientColors?.Invoke(colors.Top, colors.Bottom, colors.Left, colors.Right);
        }

        /// <summary>Lets ShaderVideoEffect (no reference back to NativePlayerHost, and no console-
        /// visible output of its own otherwise) surface errors and throttled diagnostics through
        /// the same on-screen log MainPage.xaml.cs's Log() already writes to, added specifically to
        /// debug the "no visual difference"/"video cuts out" first-hardware-test failures rather
        /// than guess blind a second time.</summary>
        public static event EffectLogHandler EffectLog;

        internal static void RaiseLog(string message)
        {
            EffectLog?.Invoke(message);
        }

        public static event FrameLoadHandler FrameLoad;

        internal static void RaiseFrameLoad(double fps, double avgFrameMs)
        {
            FrameLoad?.Invoke(fps, avgFrameMs);
        }
    }
}
