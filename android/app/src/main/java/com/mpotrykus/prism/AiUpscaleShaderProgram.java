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
   renderShaderFrame (shader-pipeline.js). This is now the ONLY GlShaderProgram
   PlayerActivity.applyVideoEffects ever installs, for the whole life of a player instance -
   AI Upscaling on/off, Sharpening strength, and Color Boost are all live-mutable via
   updateState() below rather than requiring a new Effect + a fresh player.setVideoEffects()
   call. That call is what used to wedge/stall the renderer when issued mid-playback (see
   PlayerActivity.applyVideoEffects's own header comment) - the old ShaderUpscaleEffect/
   ShaderUpscaleShaderProgram pair (a separate program installed only while AI Upscaling was
   off) is retired entirely; its fallback math is identical to this class's own
   ensurePlainChain, which already used the same asset-loaded GLSL.

   Deband is baked permanently into the upgrade chain's own composition (see
   AiUpscalingPresets) - there is no separate on/off state to track here, matching the web
   leg's explicit design ("deband is exclusively an AI Upscaling thing"). Sharpening's own
   kernel always runs as the chain's trailing pass too (stacks rather than one toggle
   superseding the other) - sharpeningTuning is Sharpening's own resolved tuning, computed by
   the caller exactly the same way it is for the plain ensurePlainChain path, and applies
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
    private final int maxOutputWidth;
    private final int maxOutputHeight;
    private final AiUpscalingPresets.Preset preset; // nullable - no upgrade for this family/device

    /* Live-mutable, updated in place from PlayerActivity's toggle setters via updateState() -
       volatile rather than synchronized: each is swapped as a whole new immutable instance, so
       a torn read can only ever see one fully-formed value or the other, never a mix of two.
       This is what lets every Effects-panel setter skip both player.setVideoEffects() and the
       old same-position seekTo nudge entirely. */
    private volatile boolean aiUpscalingEnabled;
    private volatile ShaderTuning sharpeningTuning;
    private volatile ColorBoostTuning colorTuning;

    private GlPassChain plainChain; // lazy - single-pass Sharpening fallback
    private GlPassChain upgradeChain; // lazy - the CNN/FSR chain
    private boolean upgradeChainFailed;
    private boolean upgradeGateOk; // resolved once in configure(), independent of aiUpscalingEnabled

    // volatile: read from the UI thread by PlayerUiHelper's stats overlay, written from the GL
    // thread's drawFrame() - a simple flag needs no stronger synchronization than visibility.
    private volatile boolean usingUpgrade;
    private int lastInputWidth;
    private int lastInputHeight;
    private int activeOutW;
    private int activeOutH;
    private int frameSeed;

    /** Live-updates the tuning/toggle state this program renders with on the very next frame -
     * called directly from PlayerActivity.applyVideoEffects, never through a new Effect/
     * player.setVideoEffects() round-trip. Deliberately no GL work here: drawFrame() picks up
     * these fields fresh every frame on the GL thread, so this can be called from whatever
     * thread a UI toggle fires on (see the fields' own volatile comment). */
    void updateState(boolean aiUpscalingEnabled, ShaderTuning sharpeningTuning, ColorBoostTuning colorTuning) {
        this.aiUpscalingEnabled = aiUpscalingEnabled;
        this.sharpeningTuning = sharpeningTuning;
        this.colorTuning = colorTuning;
    }

    private static int[] scaledOutputSize(float presetScale, int maxOutputWidth, int maxOutputHeight, int inputWidth, int inputHeight) {
        float scale = Math.min(presetScale, Math.min((float) maxOutputWidth / inputWidth, (float) maxOutputHeight / inputHeight));
        scale = Math.max(scale, 1f);
        return new int[] {Math.round(inputWidth * scale), Math.round(inputHeight * scale)};
    }

    AiUpscaleShaderProgram(Context context, boolean useHdr, ShaderType family, ShaderTuning sharpeningTuning,
        ColorBoostTuning colorTuning, boolean aiUpscalingEnabled, int maxOutputWidth, int maxOutputHeight) {
        super(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1);
        this.context = context;
        this.family = family;
        this.sharpeningTuning = sharpeningTuning;
        this.colorTuning = colorTuning;
        this.aiUpscalingEnabled = aiUpscalingEnabled;
        this.maxOutputWidth = maxOutputWidth;
        this.maxOutputHeight = maxOutputHeight;
        this.preset = AiUpscalingPresets.forFamily(context.getAssets(), family);
    }

    /* The size declared here has to stay valid across every future toggle/strength change for
       as long as the input resolution doesn't change - Media3's BaseGlShaderProgram only calls
       configure() again when the INPUT texture's dimensions differ from last time (see
       queueInputFrame), never because this program itself would prefer a different output size.
       So the size is pinned up front, once, regardless of aiUpscalingEnabled or the live
       strength - toggling later only changes which pass chain fills that fixed canvas (see
       drawFrame), never the canvas size itself.

       Whenever a preset exists, its own scale is the ONLY ceiling used - not
       family.maxScaleFactor() too. The CNN/FSR chain's last pass ("present"/"luma-merge")
       explicitly resizes to whatever final size this method returns, so feeding it anything
       other than the preset's own designed ratio (2x for both Anime4K and FSR1 here) adds an
       extra bilinear stretch on top of the network's real output and visibly dilutes it - a real
       regression caught after this fix shipped, animation-only (Anime4K's preset.scale (2.0) is
       below ShaderType.ANIME4K's own maxTuning.scaleFactor (2.4); FSR1's ties with LIVE_ACTION's
       (1.6) either way so it was never affected). family.maxScaleFactor() is only the right
       ceiling for the OTHER axis this method has to handle: a family/device with no AI Upscaling
       preset at all, where the plain Sharpening chain alone still needs a fixed canvas big
       enough for its own strength slider's max. */
    @Override
    public Size configure(int inputWidth, int inputHeight) {
        lastInputWidth = inputWidth;
        lastInputHeight = inputHeight;

        float maxScale = preset != null ? preset.scale : family.maxScaleFactor();
        int[] outSize = scaledOutputSize(maxScale, maxOutputWidth, maxOutputHeight, inputWidth, inputHeight);
        activeOutW = outSize[0];
        activeOutH = outSize[1];

        upgradeGateOk = preset != null
            && (preset.when == null || preset.when.test(inputWidth, inputHeight, activeOutW, activeOutH));
        if (upgradeGateOk && upgradeChain == null && !upgradeChainFailed) {
            try {
                upgradeChain = new GlPassChain(context.getAssets(), preset.passes);
            } catch (RuntimeException e) {
                Log.e(TAG, "AI Upscaling chain build failed, falling back to Sharpening only - " + e.getMessage());
                upgradeChainFailed = true;
            }
        }
        return new Size(activeOutW, activeOutH);
    }

    @Override
    public void drawFrame(int inputTexId, long presentationTimeUs) throws VideoFrameProcessingException {
        try {
            int[] prevFbo = new int[1];
            GLES30.glGetIntegerv(GLES30.GL_FRAMEBUFFER_BINDING, prevFbo, 0);

            usingUpgrade = aiUpscalingEnabled && upgradeGateOk && !upgradeChainFailed;

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
