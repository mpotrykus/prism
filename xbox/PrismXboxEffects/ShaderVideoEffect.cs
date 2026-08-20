using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Effects;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Media.Effects;
using Windows.Media.MediaProperties;
using Windows.UI;

namespace PrismXboxEffects
{
    /// <summary>
    /// The one native video effect added via <c>MediaPlayer.AddVideoEffect(typeof(ShaderVideoEffect)
    /// .FullName, true, new PropertySet())</c> from <c>NativePlayerHost</c>. Must live in this
    /// separate Windows Runtime Component project, not PrismXbox itself - confirmed against
    /// Microsoft's "Custom video effects - UWP applications" doc, which is explicit that an
    /// IBasicVideoEffect "can't be included directly in your app's project."
    ///
    /// Bakes Shader Upscaling/Color Boost directly into the decoded frame via a Win2D
    /// PixelShaderEffect (see Shaders\anime4k.hlsl/live_action.hlsl), and - piggybacking on the one
    /// GPU frame this already has in hand - downsamples the same frame for
    /// ContentAnalysisSampler (auto-strength) and AmbientColorSampler (ambient lighting), pushed
    /// back out through EffectSettings' events. See EffectSettings' own header comment for why
    /// settings flow in through a shared static object rather than IPropertySet: MediaPlayer.
    /// AddVideoEffect returns void, so there is no live handle to call SetProperties on again
    /// after the initial add.
    /// </summary>
    public sealed class ShaderVideoEffect : IBasicVideoEffect
    {
        private const int SampleW = 32;
        private const int SampleH = 18;
        private const double ContentIntervalMs = 750;
        /* NOT ambient-pipeline.js's own 42ms - that number is tuned for a cheap 2D canvas
           getImageData() call in a browser, not CanvasRenderTarget.GetPixelColors() here, which
           forces a synchronous GPU pipeline stall (a full staging-texture copy + CPU map) every
           time it's called. First hardware test (500ms/2Hz, then thought to be the fix for
           "enabling Ambient Lighting cuts the video out") turned out to have been dominated by a
           different bug instead - a shader-model mismatch (fxc /T ps_5_0 vs the ps_4_0 Win2D's
           PixelShaderEffect actually requires) was making GetOrCreateEffect's cache never populate,
           so a real GPU shader *load* was retried every single frame, not just this readback. With
           that fixed, 2Hz read as too slow/laggy on real hardware - raised to 150ms (~6.7Hz), a
           middle ground: still ~3.3x less GetPixelColors pressure than the original 42ms/24Hz that
           preceded both bugs, but noticeably more responsive than 500ms. Adjust from here based on
           further hardware feedback, not by returning to either previous extreme. */
        private const double AmbientIntervalMs = 42;
        /* Throttle for the diagnostic log line in ProcessFrame - NOT tied to Content/AmbientIntervalMs,
           since that log should fire regardless of whether either sampler is active (it's the only
           way to confirm from the console's own screen whether the shader path is even resolving
           non-off/non-zero values at all). */
        private const double DiagLogIntervalMs = 2000;

        private CanvasDevice _canvasDevice;
        private PixelShaderEffect _anime4kEffect;
        private PixelShaderEffect _liveActionEffect;
        private CanvasRenderTarget _sampleTarget;
        private readonly Stopwatch _contentStopwatch = Stopwatch.StartNew();
        private readonly Stopwatch _ambientStopwatch = Stopwatch.StartNew();
        private readonly Stopwatch _diagStopwatch = Stopwatch.StartNew();

        public bool IsReadOnly => false;

        public IReadOnlyList<VideoEncodingProperties> SupportedEncodingProperties
        {
            get
            {
                var props = new VideoEncodingProperties { Subtype = "ARGB32" };
                return new List<VideoEncodingProperties> { props };
            }
        }

        public MediaMemoryTypes SupportedMemoryTypes => MediaMemoryTypes.Gpu;

        public bool TimeIndependent => true;

        public void SetEncodingProperties(VideoEncodingProperties encodingProperties, IDirect3DDevice device)
        {
            _canvasDevice = CanvasDevice.CreateFromDirect3D11Device(device);
        }

        // Configuration flows through EffectSettings (a shared static, same process) rather than
        // this IPropertySet - see this class's own header comment. The parameter still has to be
        // accepted to satisfy IMediaExtension, it is simply unused.
        public void SetProperties(IPropertySet configuration)
        {
        }

        public void DiscardQueuedFrames()
        {
            _contentStopwatch.Restart();
            _ambientStopwatch.Restart();
        }

        public void Close(MediaEffectClosedReason reason)
        {
            _anime4kEffect?.Dispose();
            _anime4kEffect = null;
            _liveActionEffect?.Dispose();
            _liveActionEffect = null;
            _sampleTarget?.Dispose();
            _sampleTarget = null;
            _canvasDevice?.Dispose();
            _canvasDevice = null;
        }

        public void ProcessFrame(ProcessVideoFrameContext context)
        {
            EffectSettings.Snapshot settings = EffectSettings.Current;

            try
            {
                using (CanvasBitmap inputBitmap = CanvasBitmap.CreateFromDirect3D11Surface(_canvasDevice, context.InputFrame.Direct3DSurface))
                using (CanvasRenderTarget renderTarget = CanvasRenderTarget.CreateFromDirect3D11Surface(_canvasDevice, context.OutputFrame.Direct3DSurface))
                {
                    // Mirrors shader-pipeline.js's resolveShaderType/renderShaderFrame exactly: a
                    // manual strength of 0 with Auto off means "off" even if the enabled toggle is on,
                    // but Auto mode stays resolved to a real type regardless of the live auto value so
                    // the sampler keeps running (see that file's own comment for why).
                    bool hasStrength = settings.ShaderAuto || settings.ShaderStrength > 0;
                    string resolvedShaderType = settings.ShaderEnabled && hasStrength ? settings.ShaderType : "off";
                    // Saturation and Contrast are fully independent controls now - either alone
                    // (or both) keeps the visual pass alive, same as before this split.
                    bool colorBoostOn = settings.ColorBoostSaturationEnabled || settings.ColorBoostContrastEnabled;
                    bool visualOn = resolvedShaderType != "off" || colorBoostOn;
                    ShaderTuning.SharpenTuning sharpen = new ShaderTuning.SharpenTuning { Scale = 1, Sharpen = 0, Kernel = 1 };
                    ShaderTuning.ColorTuning color = new ShaderTuning.ColorTuning { Saturation = 1, Contrast = 1 };
                    string programType = settings.ShaderType;

                    using (CanvasDrawingSession ds = renderTarget.CreateDrawingSession())
                    {
                        if (visualOn)
                        {
                            // Color Boost alone (shader off) reuses whichever type this title
                            // auto-detected, with sharpen forced to 0 - same fallback
                            // renderShaderFrame's own `programType` uses on web.
                            programType = resolvedShaderType != "off" ? resolvedShaderType : settings.ShaderType;
                            double upscaleStrength = resolvedShaderType != "off" ? settings.ShaderStrength : 0;

                            sharpen = upscaleStrength > 0
                                ? ShaderTuning.ShaderTuningAt(programType, upscaleStrength)
                                : new ShaderTuning.SharpenTuning { Scale = 1, Sharpen = 0, Kernel = 1 };
                            // Real bug hit and fixed 2026-08-20: ColorBoostAt was given BOTH raw
                            // strengths whenever EITHER was enabled, so turning e.g. Contrast off
                            // while Saturation stayed on kept applying Contrast's own last
                            // remembered strength - "off" only disabled that slider's UI, not the
                            // actual boost. Each strength must independently zero out (-> neutral
                            // 1.0 via ColorBoostAt) when its OWN enabled flag is false.
                            color = ShaderTuning.ColorBoostAt(
                                settings.ColorBoostSaturationEnabled ? settings.ColorBoostSaturationStrength : 0,
                                settings.ColorBoostContrastEnabled ? settings.ColorBoostContrastStrength : 0);

                            PixelShaderEffect effect = GetOrCreateEffect(programType);
                            effect.Source1 = inputBitmap;
                            effect.Properties["kernelScale"] = (float)sharpen.Kernel;
                            effect.Properties["sharpenStrength"] = (float)sharpen.Sharpen;
                            effect.Properties["saturationBoost"] = (float)color.Saturation;
                            effect.Properties["contrastBoost"] = (float)color.Contrast;

                            ds.DrawImage(effect);
                        }
                        else
                        {
                            // IsReadOnly is false, so something must be written every frame regardless
                            // of whether a visual effect is active (e.g. Ambient Lighting alone).
                            ds.DrawImage(inputBitmap);
                        }
                    }

                    if (_diagStopwatch.Elapsed.TotalMilliseconds >= DiagLogIntervalMs)
                    {
                        _diagStopwatch.Restart();
                        EffectSettings.RaiseLog(
                            $"visualOn={visualOn} type={programType} kernel={sharpen.Kernel:F2} " +
                            $"sharpen={sharpen.Sharpen:F2} sat={color.Saturation:F2} con={color.Contrast:F2}");
                    }

                    // Isolated from the draw above on purpose: a sampling failure (e.g. a
                    // GetPixelColors stall/error) must not undo a draw that already succeeded.
                    try
                    {
                        MaybeSampleFrame(settings, inputBitmap);
                    }
                    catch (Exception ex)
                    {
                        EffectSettings.RaiseLog($"sample error: {ex.GetType().Name}: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                EffectSettings.RaiseLog($"ProcessFrame error: {ex.GetType().Name}: {ex.Message}");
                // IsReadOnly is false, so the output frame's contents are otherwise undefined after
                // an exception here - fall back to an untouched copy rather than risk a garbage or
                // black frame reaching the screen.
                try
                {
                    using (CanvasBitmap fallbackInput = CanvasBitmap.CreateFromDirect3D11Surface(_canvasDevice, context.InputFrame.Direct3DSurface))
                    using (CanvasRenderTarget fallbackTarget = CanvasRenderTarget.CreateFromDirect3D11Surface(_canvasDevice, context.OutputFrame.Direct3DSurface))
                    using (CanvasDrawingSession fallbackDs = fallbackTarget.CreateDrawingSession())
                    {
                        fallbackDs.DrawImage(fallbackInput);
                    }
                }
                catch (Exception fallbackEx)
                {
                    // Truly nothing left to try - swallow rather than let a second exception
                    // propagate out of ProcessFrame, across the WinRT ABI boundary, into whatever
                    // the media pipeline does with an effect that throws from frame processing
                    // (undefined by this project - not worth discovering by accident).
                    EffectSettings.RaiseLog($"fallback draw also failed: {fallbackEx.GetType().Name}: {fallbackEx.Message}");
                }
            }
        }

        private PixelShaderEffect GetOrCreateEffect(string shaderType)
        {
            if (shaderType == "anime4k")
            {
                return _anime4kEffect ?? (_anime4kEffect = CreateEffect("anime4k.cso"));
            }
            return _liveActionEffect ?? (_liveActionEffect = CreateEffect("live_action.cso"));
        }

        private PixelShaderEffect CreateEffect(string resourceName)
        {
            var effect = new PixelShaderEffect(LoadShaderBytes(resourceName));
            // Anime4K/CAS both need their 3x3 neighbor taps (see the .hlsl sources' own comments) -
            // Offset mapping + MaxSamplerOffset is what tells D2D how far those taps reach so it
            // feeds the shader real border pixels instead of an arbitrarily-clipped tile. Sized to
            // the larger of the two shader types' max Kernel value (ShaderTuning.MaxKernelScale)
            // since either can be selected at runtime without recreating this effect.
            effect.Source1Mapping = SamplerCoordinateMapping.Offset;
            effect.MaxSamplerOffset = (int)Math.Ceiling(ShaderTuning.MaxKernelScale);
            return effect;
        }

        private static byte[] LoadShaderBytes(string resourceName)
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException($"Embedded shader resource '{resourceName}' not found.");
                }
                var buffer = new byte[stream.Length];
                int offset = 0;
                while (offset < buffer.Length)
                {
                    int read = stream.Read(buffer, offset, buffer.Length - offset);
                    if (read <= 0) break;
                    offset += read;
                }
                return buffer;
            }
        }

        /// <summary>
        /// Shared downsample for ContentAnalysisSampler + AmbientColorSampler - one GPU->CPU
        /// readback (GetPixelColors is a blocking stall, per Win2D's own docs) serves both, each
        /// gated to its own cadence (ContentIntervalMs/AmbientIntervalMs above - deliberately NOT
        /// the same numbers as their JS namesakes, see AmbientIntervalMs's own comment) rather than
        /// running every decoded frame.
        /// </summary>
        private void MaybeSampleFrame(EffectSettings.Snapshot settings, CanvasBitmap inputBitmap)
        {
            bool wantsContent = settings.ShaderAuto || settings.ColorBoostSaturationAuto || settings.ColorBoostContrastAuto;
            bool wantsAmbient = settings.AmbientEnabled;
            if (!wantsContent && !wantsAmbient) return;

            bool contentDue = wantsContent && _contentStopwatch.Elapsed.TotalMilliseconds >= ContentIntervalMs;
            bool ambientDue = wantsAmbient && _ambientStopwatch.Elapsed.TotalMilliseconds >= AmbientIntervalMs;
            if (!contentDue && !ambientDue) return;

            if (_sampleTarget == null)
            {
                _sampleTarget = new CanvasRenderTarget(_canvasDevice, SampleW, SampleH, 96);
            }
            using (CanvasDrawingSession sampleDs = _sampleTarget.CreateDrawingSession())
            {
                sampleDs.Clear(Colors.Transparent);
                sampleDs.DrawImage(inputBitmap, new Rect(0, 0, SampleW, SampleH));
            }
            Color[] pixels = _sampleTarget.GetPixelColors();

            if (contentDue)
            {
                _contentStopwatch.Restart();
                double avgSaturation = ContentAnalysisSampler.AverageSaturation(pixels);
                double edgeEnergy = ContentAnalysisSampler.AverageEdgeEnergy(pixels, SampleW, SampleH);
                double lumaStdDev = ContentAnalysisSampler.AverageLumaStdDev(pixels);
                EffectSettings.RaiseContentAnalysis(avgSaturation, edgeEnergy, lumaStdDev);
            }
            if (ambientDue)
            {
                _ambientStopwatch.Restart();
                AmbientZoneColors colors = AmbientColorSampler.Compute(pixels, SampleW, SampleH);
                EffectSettings.RaiseAmbientColors(colors);
            }
        }
    }
}
