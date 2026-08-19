package com.mpotrykus.prism;

import android.content.Context;
import android.opengl.GLES30;
import android.util.Log;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.Size;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.BaseGlShaderProgram;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/* AI Upscaling's own GlShaderProgram - runs the real Anime4K CNN / FSR 1 chain (see
   AiUpscalingPresets) through GlPassChain, mirroring the web leg's chooseRenderPreset +
   renderShaderFrame (shader-pipeline.js). Only ever constructed while AI Upscaling's own
   toggle is on (see PlayerActivity.applyVideoEffects) - the existing ShaderUpscaleEffect/
   ShaderUpscaleShaderProgram path is untouched and still used whenever AI Upscaling is off,
   so this class carries all of the new feature's risk without touching the already-shipped,
   hardware-confirmed plain-Sharpening path.

   Deband is baked permanently into the upgrade chain's own composition (see
   AiUpscalingPresets) - there is no separate on/off state to track here, matching the web
   leg's explicit design ("deband is exclusively an AI Upscaling thing"). Sharpening's own
   kernel always runs as the chain's trailing pass too (stacks rather than one toggle
   superseding the other) - sharpeningTuning is Sharpening's own resolved tuning, computed by
   the caller exactly the same way it is for the plain ShaderUpscaleEffect path, and applies
   whether or not the CNN/FSR chain itself is the one currently rendering. */
@UnstableApi
final class AiUpscaleShaderProgram extends BaseGlShaderProgram {

    private static final String TAG = "PrismAiUpscale";

    // Matches shaders.js's DEBAND_TUNING - see that constant's own comment for how these
    // numbers (8-bit LSBs for threshold/grain, source pixels for range) were landed on.
    private static final float DEBAND_THRESHOLD = 6.0f;
    private static final float DEBAND_RANGE = 2.0f;
    private static final float DEBAND_GRAIN = 0.0f;

    private final Context context;
    private final ShaderType family;
    private final ShaderTuning sharpeningTuning;
    private final ColorBoostTuning colorTuning;
    private final int maxOutputWidth;
    private final int maxOutputHeight;
    private final AiUpscalingPresets.Preset preset; // nullable - no upgrade for this family/device

    private GlPassChain plainChain; // lazy - single-pass Sharpening fallback, same math as ShaderUpscaleShaderProgram
    private GlPassChain upgradeChain; // lazy - the CNN/FSR chain
    private boolean upgradeChainFailed;

    // volatile: read from the UI thread by PlayerUiHelper's stats overlay, written from the GL
    // thread's configure() - a simple flag needs no stronger synchronization than visibility.
    private volatile boolean usingUpgrade;
    private int lastInputWidth;
    private int lastInputHeight;
    private int activeOutW;
    private int activeOutH;
    private int frameSeed;

    /** What this preset/device pair would resolve to, without needing a GL context - see
     * AiUpscaleEffect.isNoOp, which has to answer this before any GlShaderProgram exists. */
    static boolean wouldUpgradeApply(Context context, ShaderType family, int maxOutputWidth, int maxOutputHeight,
        int inputWidth, int inputHeight) {
        AiUpscalingPresets.Preset preset = AiUpscalingPresets.forFamily(context.getAssets(), family);
        if (preset == null) return false;
        int[] outSize = scaledOutputSize(preset.scale, maxOutputWidth, maxOutputHeight, inputWidth, inputHeight);
        return preset.when == null || preset.when.test(inputWidth, inputHeight, outSize[0], outSize[1]);
    }

    private static int[] scaledOutputSize(float presetScale, int maxOutputWidth, int maxOutputHeight, int inputWidth, int inputHeight) {
        float scale = Math.min(presetScale, Math.min((float) maxOutputWidth / inputWidth, (float) maxOutputHeight / inputHeight));
        scale = Math.max(scale, 1f);
        return new int[] {Math.round(inputWidth * scale), Math.round(inputHeight * scale)};
    }

    AiUpscaleShaderProgram(Context context, boolean useHdr, ShaderType family, ShaderTuning sharpeningTuning,
        ColorBoostTuning colorTuning, int maxOutputWidth, int maxOutputHeight) {
        super(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1);
        this.context = context;
        this.family = family;
        this.sharpeningTuning = sharpeningTuning;
        this.colorTuning = colorTuning;
        this.maxOutputWidth = maxOutputWidth;
        this.maxOutputHeight = maxOutputHeight;
        this.preset = AiUpscalingPresets.forFamily(context.getAssets(), family);
    }

    @Override
    public Size configure(int inputWidth, int inputHeight) {
        lastInputWidth = inputWidth;
        lastInputHeight = inputHeight;

        if (preset != null && !upgradeChainFailed) {
            int[] outSize = scaledOutputSize(preset.scale, maxOutputWidth, maxOutputHeight, inputWidth, inputHeight);
            boolean gateOk = preset.when == null || preset.when.test(inputWidth, inputHeight, outSize[0], outSize[1]);
            if (gateOk) {
                try {
                    if (upgradeChain == null) upgradeChain = new GlPassChain(context.getAssets(), preset.passes);
                    usingUpgrade = true;
                    activeOutW = outSize[0];
                    activeOutH = outSize[1];
                    return new Size(activeOutW, activeOutH);
                } catch (RuntimeException e) {
                    Log.e(TAG, "AI Upscaling chain build failed, falling back to Sharpening only - " + e.getMessage());
                    upgradeChainFailed = true;
                }
            }
        }

        usingUpgrade = false;
        int[] outSize = scaledOutputSize(sharpeningTuning.scaleFactor, maxOutputWidth, maxOutputHeight, inputWidth, inputHeight);
        activeOutW = outSize[0];
        activeOutH = outSize[1];
        return new Size(activeOutW, activeOutH);
    }

    @Override
    public void drawFrame(int inputTexId, long presentationTimeUs) throws VideoFrameProcessingException {
        try {
            int[] prevFbo = new int[1];
            GLES30.glGetIntegerv(GLES30.GL_FRAMEBUFFER_BINDING, prevFbo, 0);

            Map<String, Object> uniforms = new HashMap<>();
            // The trailing sharpen pass in the upgrade chain samples an already-output-resolution
            // image (present's/luma-merge's result), not SOURCE directly the way the plain chain
            // does - its tap offsets need the real output/source ratio folded in, or the kernel's
            // reach silently shrinks relative to source pixels. See shader-pipeline.js's identical
            // uKernelScale comment for the same fix on the web leg.
            float kernelScale = usingUpgrade
                ? sharpeningTuning.kernelScale * (activeOutW / (float) lastInputWidth)
                : sharpeningTuning.kernelScale;
            uniforms.put("uKernelScale", kernelScale);
            uniforms.put("uSharpenStrength", sharpeningTuning.sharpenStrength);
            uniforms.put("uSaturationBoost", colorTuning.saturationBoost);
            uniforms.put("uContrastBoost", colorTuning.contrastBoost);
            uniforms.put("uDebandThreshold", DEBAND_THRESHOLD);
            uniforms.put("uDebandRange", DEBAND_RANGE);
            uniforms.put("uDebandGrain", DEBAND_GRAIN);
            frameSeed = (frameSeed + 1) % 4096;
            uniforms.put("uFrameSeed", (float) frameSeed);

            GlPassChain chain = usingUpgrade ? upgradeChain : ensurePlainChain();
            boolean ok = chain.render(inputTexId, lastInputWidth, lastInputHeight, activeOutW, activeOutH, uniforms, prevFbo[0]);
            if (!ok) {
                Log.e(TAG, "AI Upscaling chain render failed (intermediate target allocation) for this frame");
            }
        } catch (RuntimeException e) {
            throw new VideoFrameProcessingException(e, presentationTimeUs);
        }
    }

    private GlPassChain ensurePlainChain() {
        if (plainChain == null) {
            String frag = GlAssetLoader.read(context.getAssets(), family.useCas ? "sharpen-cas.frag.glsl" : "sharpen-anime.frag.glsl");
            List<GlPassChain.PassSpec> passes = List.of(new GlPassChain.PassSpec(
                "sharpen", frag, List.of(new GlPassChain.PassSpec.Input("uTex", GlPassChain.SOURCE)), 1f, /* floatRequired= */ false));
            plainChain = new GlPassChain(context.getAssets(), passes);
        }
        return plainChain;
    }

    @Override
    public void release() throws VideoFrameProcessingException {
        super.release();
        if (plainChain != null) plainChain.release();
        if (upgradeChain != null) upgradeChain.release();
    }

    /* Read by PlayerUiHelper's Performance Overlay - see updateStatsOverlay's "AI Upscaling"
       line. Distinguishes the same three otherwise-identical silences shader-pipeline.js's
       idleUpgradeLabel does on the web leg: unsupported on this device/GPU, idle because the
       upscale gate declined (source doesn't need it), and actually rendering. */
    String statusLabel() {
        if (preset == null || upgradeChainFailed) return "unsupported here";
        if (!usingUpgrade) return "idle - source not upscaled";
        return family == ShaderType.ANIME4K ? "Animation (AI CNN)" : "Live-Action (FSR 1)";
    }
}
