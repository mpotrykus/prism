using System;
using System.Numerics;
using System.Reflection;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Effects;
using Vortice.Direct3D11;
using Windows.Foundation;

namespace PrismUwpEffects
{
    /// <summary>
    /// Real AI Upscaling for Xbox: the Anime4K CNN chain (restore + upscale, fixed 2x scale) for
    /// the "anime4k" family, and the AMD FSR1 EASU+RCAS chain for the "live_action" family - both
    /// ported from the same vendored, upstream-verbatim sources the web/Android legs use
    /// (src/player/shader/glsl/vendor/{anime4k-{restore,upscale}-cnn-*,fsr1-easu-rcas}.glsl,
    /// bloc97/Anime4K + AMD, both MIT). <see cref="Render"/> returns null for any other family,
    /// and the caller (AiUpscaleFrameServer) falls back to plain pass-through.
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
    // in the PrismUwp project (a different assembly), needs to call it directly - same "only
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
        private PixelShaderEffect trailingSharpenLiveActionEffect;
        private RawD3D11Pass depthToSpacePass;

        // FSR1 (live_action family, Stage 2b) - luma-extract and RCAS are same-size Win2D
        // passes; EASU and the final luma-merge both change resolution and/or read two
        // differently-sized inputs at once, so they're raw D3D11 like depthToSpacePass above.
        // deband is shared with the Anime4K chain (see debandEffect/debandTarget) - it's a
        // generic same-size 1-input pass with fixed tuning, and only one family is ever active
        // per playback session, so there's no cross-frame conflict from reusing it.
        private PixelShaderEffect lumaExtractEffect;
        private PixelShaderEffect rcasEffect;
        private RawD3D11Pass fsrEasuPass;
        private RawD3D11Pass lumaMergePass;

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
        private CanvasRenderTarget lumaExtractTarget;
        private CanvasRenderTarget fsrEasuTarget;
        private CanvasRenderTarget rcasTarget;
        private CanvasRenderTarget lumaMergeTarget;
        private CanvasRenderTarget finalTarget;
        private CanvasRenderTarget nativeFinalTarget;

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

            // FSR1's own trailing sharpen needs live_action.cso, not anime4k.cso - same
            // per-family split ShaderVideoEffect.GetOrCreateEffect already makes for the plain
            // (non-AI-Upscaling) Sharpening path.
            trailingSharpenLiveActionEffect = new PixelShaderEffect(LoadShaderBytes("live_action.cso"));
            trailingSharpenLiveActionEffect.Source1Mapping = SamplerCoordinateMapping.Offset;
            trailingSharpenLiveActionEffect.MaxSamplerOffset = (int)Math.Ceiling(2 * ShaderTuning.MaxKernelScale);

            // No offset sampling (plain D2DGetInput(0) read) - same reason presentEffect above
            // needs no Source1Mapping/MaxSamplerOffset either.
            lumaExtractEffect = new PixelShaderEffect(LoadShaderBytes("fsr_luma_extract.cso"));
            fsrEasuPass = new RawD3D11Pass(d3dDevice, fullscreenVertexShader, LoadShaderBytes("fsr_easu.cso"));
            // RCAS taps a 4-neighbor cross at exactly 1 pixel each - same offset magnitude as the
            // CNN conv passes, so CreateOffsetEffect's MaxSamplerOffset=2 already covers it.
            rcasEffect = CreateOffsetEffect("fsr_rcas.cso");
            // One float (uFrameSeed) rounded up to a full 16-byte constant buffer by RawD3D11Pass.
            lumaMergePass = new RawD3D11Pass(d3dDevice, fullscreenVertexShader, LoadShaderBytes("fsr_luma_merge.cso"), constantFloatCount: 1);
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
        /// Runs the real AI-upscaling chain for <paramref name="family"/> against
        /// <paramref name="source"/> (the native-resolution decoded frame) and returns the result
        /// at exactly 2x resolution, ready for the caller's own trailing Sharpening pass. For any
        /// other family (AI Upscaling off, or a title the chain doesn't support), no chain runs,
        /// but Sharpening/Color Boost still have to be applied here at native resolution - the
        /// frame-server path this feeds is active for every non-HDR title regardless of whether
        /// AI Upscaling itself is on (see NativePlayerHost.SetAiUpscalePathActive), and
        /// ShaderVideoEffect deliberately skips its own draw whenever that path is active, on the
        /// assumption that this method is the one place still drawing that pass. <paramref
        /// name="chainRan"/> reports only whether a real CNN/FSR chain executed - the stats
        /// overlay's "upscaled" label needs that, distinct from whether anything was drawn at all.
        /// </summary>
        public CanvasRenderTarget Render(CanvasRenderTarget source, string family, int nativeWidth, int nativeHeight, out bool chainRan)
        {
            chainRan = family == "anime4k" || family == "live_action";

            EnsureTargets(nativeWidth, nativeHeight);
            frameSeed += 0.6180339887f; // irrational increment - decorrelates the hash across frames without needing a real clock/RNG
            debandEffect.Properties["uFrameSeed"] = frameSeed;
            presentEffect.Properties["uFrameSeed"] = frameSeed;

            if (!chainRan) return ApplyTrailingSharpen(source, nativeFinalTarget, 1.0);

            if (family == "live_action") return RenderLiveActionFsr(source);

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

            return ApplyTrailingSharpen(presentTarget, finalTarget, 2.0);
        }

        /// <summary>
        /// AMD FSR1: luma-extract (Win2D) -> EASU (raw D3D11, the 2x resize) -> deband (Win2D,
        /// shared with the Anime4K chain) -> RCAS (Win2D) -> luma-merge (raw D3D11, folds the
        /// reconstructed luma back into <paramref name="source"/>'s RGB at 2x). Mirrors the
        /// composition in src/player/shader/shaders.js's buildFsr exactly, minus the trailing
        /// sharpen pass (added by the shared <see cref="ApplyTrailingSharpen"/> afterward, same
        /// as the Anime4K chain).
        /// </summary>
        private CanvasRenderTarget RenderLiveActionFsr(CanvasRenderTarget source)
        {
            DrawOneInput(lumaExtractEffect, lumaExtractTarget, source);
            fsrEasuPass.Draw(fsrEasuTarget, lumaExtractTarget);
            DrawOneInput(debandEffect, debandTarget, fsrEasuTarget);
            DrawOneInput(rcasEffect, rcasTarget, debandTarget);
            lumaMergePass.Draw(lumaMergeTarget, new[] { frameSeed }, source, rcasTarget);

            return ApplyTrailingSharpen(lumaMergeTarget, finalTarget, 2.0);
        }

        /// <summary>
        /// Sharpening and Color Boost stack on top of AI Upscaling rather than one superseding
        /// the other (same explicit design as the web/Android legs) - mirrors
        /// ShaderVideoEffect.ProcessFrame's own resolution of EffectSettings.Current exactly, so
        /// the two paths behave identically whenever either is active. Skips the extra pass
        /// entirely when neither is contributing, same as that method's own "off" fast path.
        /// Also the plain (no-chain) pass-through path's only place to apply either, called with
        /// <paramref name="outputTarget"/> sized to <paramref name="input"/>'s own resolution and
        /// <paramref name="kernelScaleMultiplier"/> of 1.0 rather than the chain paths' 2.0 - see
        /// Render's own comment.
        /// </summary>
        private CanvasRenderTarget ApplyTrailingSharpen(CanvasRenderTarget input, CanvasRenderTarget outputTarget, double kernelScaleMultiplier)
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

            // The kernel's tap offsets are in real pixels of THIS pass's own input - for the
            // chain paths that's the 2x-upscaled image, not the source resolution ShaderTuning's
            // own curve assumes, hence kernelScaleMultiplier=2.0 there; the plain pass-through
            // path's input is already native resolution, so it passes 1.0 (no compensation
            // needed), same as ShaderVideoEffect's own untouched kernelScale.
            // programType is the Sharpening algorithm to run, independent of which AI-upscaling
            // chain produced `input` (both are keyed off the same family, but this is the
            // user-facing Sharpening type, not a re-check of the AI-upscaling family) - same
            // anime4k.cso/live_action.cso split ShaderVideoEffect.GetOrCreateEffect makes.
            PixelShaderEffect sharpenEffect = programType == "anime4k" ? trailingSharpenEffect : trailingSharpenLiveActionEffect;
            sharpenEffect.Source1 = input;
            sharpenEffect.Properties["kernelScale"] = (float)(sharpen.Kernel * kernelScaleMultiplier);
            sharpenEffect.Properties["sharpenStrength"] = (float)sharpen.Sharpen;
            sharpenEffect.Properties["saturationBoost"] = (float)color.Saturation;
            sharpenEffect.Properties["contrastBoost"] = (float)color.Contrast;

            using (CanvasDrawingSession ds = outputTarget.CreateDrawingSession())
            {
                ds.DrawImage(sharpenEffect);
            }
            return outputTarget;
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
            lumaExtractTarget = NewTarget(width, height);
            fsrEasuTarget = NewTarget(width * 2, height * 2);
            rcasTarget = NewTarget(width * 2, height * 2);
            lumaMergeTarget = NewTarget(width * 2, height * 2);
            // Default (8-bit) format, unlike the intermediates above - this is the true final
            // image handed to the caller for presentation, not a stage another pass reads back.
            finalTarget = new CanvasRenderTarget(canvasDevice, width * 2, height * 2, 96);
            // Same, but at native resolution - the trailing sharpen pass's output target when no
            // chain ran (AI Upscaling off), since finalTarget above is sized for the 2x chain
            // output and would only fill the top-left quadrant of a native-resolution draw.
            nativeFinalTarget = new CanvasRenderTarget(canvasDevice, width, height, 96);

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
            lumaExtractTarget?.Dispose();
            fsrEasuTarget?.Dispose();
            rcasTarget?.Dispose();
            lumaMergeTarget?.Dispose();
            finalTarget?.Dispose();
            nativeFinalTarget?.Dispose();
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
            fsrEasuPass?.Dispose();
            lumaMergePass?.Dispose();
            fullscreenVertexShader?.Dispose();
            d3dDevice?.Dispose();
        }
    }
}
