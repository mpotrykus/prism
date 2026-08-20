using System;
using System.Numerics;
using System.Reflection;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Effects;
using Vortice.Direct3D11;
using Windows.Foundation;

namespace PrismXboxEffects
{
    /// <summary>
    /// Real AI Upscaling for Xbox: the Anime4K CNN chain (restore + upscale, fixed 2x scale),
    /// ported from the same vendored, upstream-verbatim source the web/Android legs use
    /// (src/player/shader/glsl/vendor/anime4k-{restore,upscale}-cnn-*.glsl, bloc97/Anime4K, MIT).
    /// FSR1 (live-action) is not ported yet - Stage 2b - so <see cref="Render"/> only produces a
    /// real result for the "anime4k" family; anything else returns null and the caller
    /// (AiUpscaleFrameServer) falls back to plain pass-through.
    ///
    /// Two kinds of pass, split for a real reason, not style: every same-resolution, single- or
    /// dual-input pass (the 7 CNN convolutions, deband, present) is a Win2D
    /// <see cref="PixelShaderEffect"/> - the exact mechanism already proven on this hardware for
    /// Sharpening/Color Boost (ShaderVideoEffect.cs). The one pass that both changes resolution
    /// (2x) AND reads two differently-purposed textures at once - depth-to-space - is raw D3D11
    /// via Vortice instead: Win2D's <c>PixelShaderEffect</c> is a D2D "simple input" effect
    /// (same-size in/out by contract), and forcing a resolution change through it would need a
    /// full custom D2D effect with its own <c>ID2D1DrawTransform</c> - real COM authoring, more
    /// complex than just issuing the draw call directly. Raw D3D11 sidesteps that uncertainty
    /// entirely: an ordinary vertex+pixel shader draw against a manually-sized render target,
    /// obtained via <see cref="CanvasRenderTarget"/>'s existing D3D11 interop (see
    /// D3D11Interop.cs). This mirrors FSR1's later EASU/luma-merge passes (Stage 2b), which need
    /// the same raw-D3D11 treatment for the same reason.
    /// </summary>
    // Public (unlike this assembly's other internal helper classes) because AiUpscaleFrameServer,
    // in the PrismXbox project (a different assembly), needs to call it directly - same "only
    // mark public what's genuinely needed cross-assembly" rule EffectSettings.cs's own header
    // comment documents. CanvasDevice/CanvasRenderTarget (Win2D's own WinRT types) and plain
    // primitives are all this class's public surface ever uses, so it's WinRT-projectable
    // without hitting the array-struct-field/open-generic-delegate rules that forced
    // EffectSettings.Snapshot/AmbientZoneColors to stay internal instead.
    public sealed class AiUpscalePixelEffect : IDisposable
    {
        private readonly CanvasDevice canvasDevice;
        private readonly ID3D11Device d3dDevice;
        private readonly ID3D11VertexShader fullscreenVertexShader;

        private PixelShaderEffect restoreConv0;
        private PixelShaderEffect restoreConv1;
        private PixelShaderEffect restoreConv2;
        private PixelShaderEffect restoreConv3;
        private PixelShaderEffect upscaleConv0;
        private PixelShaderEffect upscaleConv1;
        private PixelShaderEffect upscaleConv2;
        private PixelShaderEffect upscaleConv3;
        private PixelShaderEffect debandEffect;
        private PixelShaderEffect presentEffect;
        private PixelShaderEffect trailingSharpenEffect;
        private RawD3D11Pass depthToSpacePass;

        private CanvasRenderTarget restoreConv0Target;
        private CanvasRenderTarget restoreConv1Target;
        private CanvasRenderTarget restoreConv2Target;
        private CanvasRenderTarget restoreOutputTarget;
        private CanvasRenderTarget upscaleConv0Target;
        private CanvasRenderTarget upscaleConv1Target;
        private CanvasRenderTarget upscaleConv2Target;
        private CanvasRenderTarget upscaleConv3Target;
        private CanvasRenderTarget upscaleOutputTarget;
        private CanvasRenderTarget debandTarget;
        private CanvasRenderTarget presentTarget;
        private CanvasRenderTarget finalTarget;

        private int builtWidth;
        private int builtHeight;
        private float frameSeed;

        public AiUpscalePixelEffect(CanvasDevice canvasDevice)
        {
            this.canvasDevice = canvasDevice;
            d3dDevice = D3D11Interop.GetD3D11Device(canvasDevice);
            fullscreenVertexShader = d3dDevice.CreateVertexShader(LoadShaderBytes("fullscreen_quad_vs.cso"));

            restoreConv0 = CreateOffsetEffect("anime4k_restore_conv0.cso");
            restoreConv1 = CreateOffsetEffect("anime4k_restore_conv1.cso");
            restoreConv2 = CreateOffsetEffect("anime4k_restore_conv2.cso");
            restoreConv3 = CreateOffsetEffect("anime4k_restore_conv3.cso");
            upscaleConv0 = CreateOffsetEffect("anime4k_upscale_conv0.cso");
            upscaleConv1 = CreateOffsetEffect("anime4k_upscale_conv1.cso");
            upscaleConv2 = CreateOffsetEffect("anime4k_upscale_conv2.cso");
            upscaleConv3 = CreateOffsetEffect("anime4k_upscale_conv3.cso");
            depthToSpacePass = new RawD3D11Pass(d3dDevice, fullscreenVertexShader, LoadShaderBytes("anime4k_depth_to_space.cso"));

            // uDebandThreshold/Range/Grain are fixed constants (DEBAND_TUNING in shaders.js -
            // {6.0, 2.0, 0.0}), set once here; only uFrameSeed changes per frame (see Render).
            debandEffect = CreateOffsetEffect("deband.cso");
            debandEffect.Properties["uDebandThreshold"] = 6.0f;
            debandEffect.Properties["uDebandRange"] = 2.0f;
            debandEffect.Properties["uDebandGrain"] = 0.0f;
            // Largest offset deband ever requests: uDebandRange(2.0) * fi(max 2), plus margin.
            debandEffect.MaxSamplerOffset = 8;

            presentEffect = new PixelShaderEffect(LoadShaderBytes("present.cso"));

            // Reuses the exact same compiled shader ShaderVideoEffect uses for Sharpening/Color
            // Boost - Sharpening and AI Upscaling stack (same design as web/Android), so this
            // trailing pass is what actually applies both, on top of the CNN chain's own output.
            // NOT CreateOffsetEffect: this pass's kernelScale is compensated *2 at render time
            // (its input is already 2x-upscaled, see Render), so MaxSamplerOffset must cover the
            // doubled range, not the plain conv passes' fixed 1-pixel taps.
            trailingSharpenEffect = new PixelShaderEffect(LoadShaderBytes("anime4k.cso"));
            trailingSharpenEffect.Source1Mapping = SamplerCoordinateMapping.Offset;
            trailingSharpenEffect.MaxSamplerOffset = (int)Math.Ceiling(2 * ShaderTuning.MaxKernelScale);
        }

        private PixelShaderEffect CreateOffsetEffect(string resourceName)
        {
            var effect = new PixelShaderEffect(LoadShaderBytes(resourceName));
            // Every conv pass samples a 3x3 neighborhood (offsets of exactly 1 pixel) - see each
            // .hlsl file's own go0/go1 helpers.
            effect.Source1Mapping = SamplerCoordinateMapping.Offset;
            effect.MaxSamplerOffset = 2;
            return effect;
        }

        /// <summary>
        /// Runs the Anime4K CNN chain against <paramref name="source"/> (the native-resolution
        /// decoded frame) and returns the result at exactly 2x resolution, clamped and dithered -
        /// ready for the caller's own trailing Sharpening pass. Returns null for any family other
        /// than "anime4k" (FSR1/live-action is Stage 2b, not built yet).
        /// </summary>
        public CanvasRenderTarget Render(CanvasRenderTarget source, string family, int nativeWidth, int nativeHeight)
        {
            if (family != "anime4k") return null;

            EnsureTargets(nativeWidth, nativeHeight);
            frameSeed += 0.6180339887f; // irrational increment - decorrelates the hash across frames without needing a real clock/RNG
            debandEffect.Properties["uFrameSeed"] = frameSeed;
            presentEffect.Properties["uFrameSeed"] = frameSeed;

            DrawOneInput(restoreConv0, restoreConv0Target, source);
            DrawOneInput(restoreConv1, restoreConv1Target, restoreConv0Target);
            DrawOneInput(restoreConv2, restoreConv2Target, restoreConv1Target);
            DrawTwoInput(restoreConv3, restoreOutputTarget, restoreConv2Target, source);

            DrawOneInput(upscaleConv0, upscaleConv0Target, restoreOutputTarget);
            DrawOneInput(upscaleConv1, upscaleConv1Target, upscaleConv0Target);
            DrawOneInput(upscaleConv2, upscaleConv2Target, upscaleConv1Target);
            DrawOneInput(upscaleConv3, upscaleConv3Target, upscaleConv2Target);
            depthToSpacePass.Draw(upscaleOutputTarget, upscaleConv3Target, restoreOutputTarget);

            DrawOneInput(debandEffect, debandTarget, upscaleOutputTarget);
            DrawOneInput(presentEffect, presentTarget, debandTarget);

            return ApplyTrailingSharpen(presentTarget);
        }

        /// <summary>
        /// Sharpening and Color Boost stack on top of AI Upscaling rather than one superseding
        /// the other (same explicit design as the web/Android legs) - mirrors
        /// ShaderVideoEffect.ProcessFrame's own resolution of EffectSettings.Current exactly, so
        /// the two paths behave identically whenever either is active. Skips the extra pass
        /// entirely when neither is contributing, same as that method's own "off" fast path.
        /// </summary>
        private CanvasRenderTarget ApplyTrailingSharpen(CanvasRenderTarget input)
        {
            EffectSettings.Snapshot settings = EffectSettings.Current;
            bool hasStrength = settings.ShaderAuto || settings.ShaderStrength > 0;
            string resolvedShaderType = settings.ShaderEnabled && hasStrength ? settings.ShaderType : "off";
            bool colorBoostOn = settings.ColorBoostSaturationEnabled || settings.ColorBoostContrastEnabled;
            bool visualOn = resolvedShaderType != "off" || colorBoostOn;
            if (!visualOn) return input;

            string programType = resolvedShaderType != "off" ? resolvedShaderType : settings.ShaderType;
            double upscaleStrength = resolvedShaderType != "off" ? settings.ShaderStrength : 0;
            ShaderTuning.SharpenTuning sharpen = upscaleStrength > 0
                ? ShaderTuning.ShaderTuningAt(programType, upscaleStrength)
                : new ShaderTuning.SharpenTuning { Scale = 1, Sharpen = 0, Kernel = 1 };
            // Real bug hit and fixed 2026-08-20 (same duplicated bug as ShaderVideoEffect.cs's
            // own copy of this same math): ColorBoostAt was given BOTH raw strengths whenever
            // EITHER was enabled, so turning e.g. Contrast off while Saturation stayed on kept
            // applying Contrast's own last remembered strength - "off" only disabled that
            // slider's UI, not the actual boost. Each strength must independently zero out
            // (-> neutral 1.0 via ColorBoostAt) when its OWN enabled flag is false.
            ShaderTuning.ColorTuning color = ShaderTuning.ColorBoostAt(
                settings.ColorBoostSaturationEnabled ? settings.ColorBoostSaturationStrength : 0,
                settings.ColorBoostContrastEnabled ? settings.ColorBoostContrastStrength : 0);

            // The kernel's tap offsets are in real pixels of THIS pass's own input - which is now
            // the 2x-upscaled image, not the source resolution ShaderTuning's own curve assumes.
            // Doubling keeps the sharpen kernel's real-world reach pinned to source pixels either
            // way, same compensation the web leg applies for its own trailing-sharpen-after-an-
            // upgrade-chain case.
            trailingSharpenEffect.Source1 = input;
            trailingSharpenEffect.Properties["kernelScale"] = (float)(sharpen.Kernel * 2.0);
            trailingSharpenEffect.Properties["sharpenStrength"] = (float)sharpen.Sharpen;
            trailingSharpenEffect.Properties["saturationBoost"] = (float)color.Saturation;
            trailingSharpenEffect.Properties["contrastBoost"] = (float)color.Contrast;

            using (CanvasDrawingSession ds = finalTarget.CreateDrawingSession())
            {
                ds.DrawImage(trailingSharpenEffect);
            }
            return finalTarget;
        }

        private void EnsureTargets(int width, int height)
        {
            if (builtWidth == width && builtHeight == height) return;

            DisposeTargets();

            restoreConv0Target = NewTarget(width, height);
            restoreConv1Target = NewTarget(width, height);
            restoreConv2Target = NewTarget(width, height);
            restoreOutputTarget = NewTarget(width, height);
            upscaleConv0Target = NewTarget(width, height);
            upscaleConv1Target = NewTarget(width, height);
            upscaleConv2Target = NewTarget(width, height);
            upscaleConv3Target = NewTarget(width, height);
            upscaleOutputTarget = NewTarget(width * 2, height * 2);
            debandTarget = NewTarget(width * 2, height * 2);
            presentTarget = NewTarget(width * 2, height * 2);
            // Default (8-bit) format, unlike the intermediates above - this is the true final
            // image handed to the caller for presentation, not a stage another pass reads back.
            finalTarget = new CanvasRenderTarget(canvasDevice, width * 2, height * 2, 96);

            builtWidth = width;
            builtHeight = height;
        }

        // CNN activations are signed and exceed [0,1] mid-chain (same reason the web/Android legs
        // use half-float intermediates for these passes, see shader-pipeline.js's pass-chain
        // header comment) - DirectXPixelFormat.R16G16B16A16Float, not the render target's default
        // 8-bit format, or every conv pass would clamp its own signed output before the next pass
        // ever reads it.
        private CanvasRenderTarget NewTarget(int width, int height) =>
            new CanvasRenderTarget(canvasDevice, width, height, 96,
                Windows.Graphics.DirectX.DirectXPixelFormat.R16G16B16A16Float,
                CanvasAlphaMode.Premultiplied);

        private static void DrawOneInput(PixelShaderEffect effect, CanvasRenderTarget target, ICanvasImage input)
        {
            effect.Source1 = input;
            DrawFull(effect, target);
        }

        private static void DrawTwoInput(PixelShaderEffect effect, CanvasRenderTarget target, ICanvasImage input0, ICanvasImage input1)
        {
            effect.Source1 = input0;
            effect.Source2 = input1;
            DrawFull(effect, target);
        }

        // These CNN passes repurpose RGBA as 4 independent learned feature channels, not real
        // color+alpha - each conv shader's own bias term (see e.g. anime4k_restore_conv0.hlsl)
        // puts an arbitrary weight in the alpha slot, never pinned near 1.0. The default
        // DrawImage(effect) overload composites via SourceOver using that (meaningless-as-
        // opacity) alpha, blending each frame's result into whatever was already sitting in the
        // target's PERSISTENT, frame-to-frame-reused CanvasRenderTarget instead of fully
        // replacing it - real bug hit and fixed 2026-08-20: looked fine for the first frame, then
        // visibly accumulated into pure static within about a second as the blend residue
        // compounded, worse the more passes were chained (confirmed via the DebugStopAfterStage
        // bisection below - stage 1 clean, stage 2 mild jitter, stage 3 heavy static).
        // CanvasComposite.Copy makes every pass an unconditional full overwrite regardless of
        // the shader's own alpha output. The one pass NOT using this helper - depthToSpacePass,
        // raw D3D11 - was never
        // at risk: D3D11's output-merger has blending disabled by default, so it already
        // overwrites unconditionally.
        private static void DrawFull(ICanvasImage image, CanvasRenderTarget target)
        {
            var bounds = new Rect(0, 0, target.SizeInPixels.Width, target.SizeInPixels.Height);
            using (CanvasDrawingSession ds = target.CreateDrawingSession())
            {
                ds.DrawImage(image, Vector2.Zero, bounds, 1.0f, CanvasImageInterpolation.Linear, CanvasComposite.Copy);
            }
        }

        private void DisposeTargets()
        {
            restoreConv0Target?.Dispose();
            restoreConv1Target?.Dispose();
            restoreConv2Target?.Dispose();
            restoreOutputTarget?.Dispose();
            upscaleConv0Target?.Dispose();
            upscaleConv1Target?.Dispose();
            upscaleConv2Target?.Dispose();
            upscaleConv3Target?.Dispose();
            upscaleOutputTarget?.Dispose();
            debandTarget?.Dispose();
            presentTarget?.Dispose();
            finalTarget?.Dispose();
        }

        // Same pattern as ShaderVideoEffect.LoadShaderBytes - duplicated rather than shared,
        // consistent with this project's existing convention of small per-file utilities over a
        // shared-helpers module (see e.g. deband.frag.glsl's own hash13 duplication note).
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

        public void Dispose()
        {
            DisposeTargets();
            depthToSpacePass?.Dispose();
            fullscreenVertexShader?.Dispose();
            d3dDevice?.Dispose();
        }
    }
}
