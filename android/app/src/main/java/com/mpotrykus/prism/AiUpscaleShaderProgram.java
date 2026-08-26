package com.mpotrykus.prism;

import android.content.Context;
import android.opengl.GLES30;
import android.util.Log;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.Size;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.BaseGlShaderProgram;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/* AI Upscaling's own GlShaderProgram - runs the real Anime4K CNN / FSR 1 chain (see
   AiUpscalingPresets) through GlPassChain, mirroring the web leg's chooseRenderPreset +
   renderShaderFrame (shader-pipeline.js). This is now the ONLY GlShaderProgram
   PlayerActivity.applyVideoEffects ever installs, for the whole life of a player instance -
   AI Upscaling on/off, Sharpening strength, Color Boost, and the Content Type family override
   are all live-mutable via updateState() below rather than requiring a new Effect + a fresh
   player.setVideoEffects() call. That call is what used to header comment) - the old
   ShaderUpscaleEffect/ShaderUpscaleShaderProgram pair (a separate program installed only while
   AI Upscaling was off) is retired entirely; its fallback math is identical to this class's own
   plainChainFor, which already used the same asset-loaded GLSL.

   `family` used to be a fixed constructor param, chosen once at bootstrap and never revisited -
   that was fine when the only thing that could change it was a title switch (which already
   tears down and rebuilds this whole program via a fresh player instance, see
   PlayerActivity.createPlayer). It stopped being fine once Content Type's manual Auto/Animation/
   Live-Action override (PlayerActivity.setShaderFamilyOverride) needed to change which family
   renders MID-TITLE, with no reinstall. It's a volatile field now, updated live by updateState()
   exactly like aiUpscalingEnabled/sharpeningTuning/colorTuning already were - both the CNN
   (anime4k) and FSR1 (live_action) upgrade chains are built lazily and cached per-family (see
   upgradeChainFor/plainChainFor) rather than once, so a live family switch just changes which
   already-(or newly-)built chain drawFrame() picks for the very next frame; no GL program is
   ever rebuilt on the hot path, no setVideoEffects() call happens.

   configure()'s output size is still pinned once (per Media3's own contract - see its own
   comment below) - this stays correct across a live family switch only because BOTH presets
   declare the same 2x scale (AiUpscalingPresets.buildAnimeCnn/buildLiveActionFsr). If a future
   preset ever needed a different scale, a family override picked while the OTHER family's
   scale was what sized this program's fixed output canvas would render at a stale size - not a
   crash, just a suboptimal-resolution upgrade chain, and not addressed here since it doesn't
   occur with either of today's two presets.

   Deband is baked permanently into the upgrade chain's own composition (see
   AiUpscalingPresets) - there is no separate on/off state to track here, matching the web
   leg's explicit design ("deband is exclusively an AI Upscaling thing"). Sharpening's own
   kernel always runs as the chain's trailing pass too (stacks rather than one toggle
   superseding the other) - sharpeningTuning is Sharpening's own resolved tuning, computed by
   the caller exactly the same way it is for the plain chain path, and applies whether or not
   the CNN/FSR chain itself is the one currently rendering.

   Auto-Crop (see AutoCropSampler/PlayerActivity.reinstallVideoEffectsForCrop) is folded in as an
   extra GL step ahead of whichever chain ends up rendering, rather than a new node in the effects
   graph. UNLIKE every other toggle above, this is NOT live-mutable - `cropInsets` is a final
   field, baked in at CONSTRUCTION time, not updated after the fact. That's deliberate, not an
   oversight - see the real-device finding below for why.

   Real-device finding (2026-08-26): this pass's output Size is pinned once by configure(), and
   Media3 never calls it again just because this program would prefer a different size later (see
   configure()'s own comment). Two earlier attempts at applying Auto-Crop as a LIVE update into an
   already-pinned, raw-AR buffer both failed on a real device: a View-transform zoom on the outer
   AspectRatioFrameLayout had no visible effect at all (Android's SurfaceView presents its video
   through an independent compositor layer that does not respect ancestor View transforms) while
   the resized box re-letterboxed the still-raw buffer a SECOND time (a visible residual black
   band, confirmed via direct pixel sampling); a GL remap that stretched or fit-and-letterboxed the
   crop sub-rect into that same fixed raw-AR canvas avoided the double-letterbox but either
   distorted the picture or left its own residual black gap, since the buffer's own shape could
   never actually change to match the true cropped content.

   The fix implemented here: cropInsets is passed in at construction (PlayerActivity's
   reinstallVideoEffectsForCrop, called once - see that method's own header comment for the real,
   accepted trade-off of doing this: a mid-playback player.setVideoEffects() reinstall carries a
   documented wedge/stall risk on this codebase, previously hit and fixed for every OTHER toggle
   by going live-mutable instead. Auto-Crop can't use that same fix because its insets genuinely
   aren't known until several real seconds into playback - AutoCropSampler needs multiple decoded
   frames to confirm a border isn't a dark scene or a fade, see that class's own header comment -
   so there is no way to have configure() see the true cropped dimensions from the very first
   call). configure() computes the OUTPUT size from the CROPPED effective input dimensions when
   cropInsets is non-null, so the crop GL pass renders a real crop+resize (no padding, no
   distortion, no residual bars - source and destination share the same true aspect ratio by
   construction) instead of a remap into a mismatched fixed canvas. contentFrame's own aspect
   ratio (see PlayerActivity.layoutGlow) is sized off the SAME cropped-or-raw AR this program is
   actually outputting, so the outer box and the buffer always agree - the double-letterbox bug
   above structurally cannot recur, because there is no longer a size mismatch between them to
   begin with. SDR-only - see this class's own drawFrame/applyVideoEffects: HDR content never
   gets this GL pipeline installed at all, so there is nothing for Auto-Crop to hook into on an
   HDR title either. */
@UnstableApi
final class AiUpscaleShaderProgram extends BaseGlShaderProgram {

    private static final String TAG = "PrismAiUpscale";

    // Matches shaders.js's DEBAND_TUNING - see that constant's own comment for how these
    // numbers (8-bit LSBs for threshold/grain, source pixels for range) were landed on.
    private static final float DEBAND_THRESHOLD = 6.0f;
    private static final float DEBAND_RANGE = 2.0f;
    private static final float DEBAND_GRAIN = 0.0f;

    private final Context context;
    private final int maxOutputWidth;
    private final int maxOutputHeight;
    // Baked in at construction, never mutated after - see this class's own header comment for
    // why Auto-Crop is the one piece of state here that isn't live-updatable via updateState().
    // Null means "no crop for this player instance" (the bootstrap-installed, common case).
    private final AutoCropSampler.Insets cropInsets;
    // "fit"/"cover"/"stretch" - see PlayerActivity.applyAspectMode. Baked in at construction like
    // cropInsets above and for the same reason: configure()'s output Size is pinned once, so a
    // live aspectMode change (PlayerActivity.applyAspectMode) needs its own reinstall
    // (PlayerActivity.reinstallVideoEffectsForCrop, reused for this too - see its own comment)
    // exactly like a newly-confirmed crop does, not a live updateState() field.
    private final String aspectMode;
    // cropInsets, widened with extra cover-only cropping when aspectMode is "cover" (see
    // configure()'s own comment) so the crop pass's sub-rect already matches the target AR by
    // construction - null means "no crop pass needed at all" (renderCropPass's own gate).
    private AutoCropSampler.Insets effectiveCropInsets;

    /* Live-mutable, updated in place from PlayerActivity's toggle setters via updateState() -
       volatile rather than synchronized: each is swapped as a whole new immutable instance, so a
       torn read can only ever see one fully-formed value or the other, never a mix of two. This
       is what lets every Effects-panel setter skip both player.setVideoEffects() and the old
       same-position seekTo nudge entirely. */
    private volatile boolean aiUpscalingEnabled;
    private volatile ShaderTuning sharpeningTuning;
    private volatile ColorBoostTuning colorTuning;
    private volatile ShaderType family;

    // GL-thread-only (configure()/drawFrame()/release() all run on Media3's own single video-
    // effects GL thread) - plain HashMaps, no synchronization needed, same reasoning the single
    // plainChain/upgradeChain fields they replace never needed any either.
    private final Map<ShaderType, GlPassChain> upgradeChains = new HashMap<>();
    private final Set<ShaderType> upgradeChainFailed = new HashSet<>();
    private final Map<ShaderType, GlPassChain> plainChains = new HashMap<>();

    // volatile: read from the UI thread by PlayerUiHelper's stats overlay, written from the GL
    // thread's drawFrame() - a simple flag needs no stronger synchronization than visibility.
    private volatile boolean usingUpgrade;
    private volatile boolean upgradeUnsupported;
    private int lastInputWidth;
    private int lastInputHeight;
    // The dimensions the upgrade/plain chain actually treats as SOURCE - equal to
    // lastInputWidth/lastInputHeight when cropInsets is null, or the cropped-down-from-raw
    // dimensions (see configure()) when it isn't. Everything downstream of the optional crop
    // pass (kernelScale, chain.render's own source-dims args) reasons in these, never the raw
    // lastInputWidth/lastInputHeight directly, since sourceTex itself is at THIS size once a
    // crop is baked in.
    private int effectiveInputWidth;
    private int effectiveInputHeight;
    private int activeOutW;
    private int activeOutH;
    private int frameSeed;

    private GlPassChain cropChain; // lazy, built once on first frame, only when effectiveCropInsets != null
    private int cropTex = -1;
    private int cropFbo = -1;
    private int cropTexW = -1;
    private int cropTexH = -1;

    /** Live-updates the tuning/toggle/family state this program renders with on the very next
     * frame - called directly from PlayerActivity.applyVideoEffects, never through a new Effect/
     * player.setVideoEffects() round-trip. Deliberately no GL work here: drawFrame() picks up
     * these fields fresh every frame on the GL thread, so this can be called from whatever
     * thread a UI toggle fires on (see the fields' own volatile comment). */
    void updateState(ShaderType family, boolean aiUpscalingEnabled, ShaderTuning sharpeningTuning, ColorBoostTuning colorTuning) {
        this.family = family;
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
        ColorBoostTuning colorTuning, boolean aiUpscalingEnabled, int maxOutputWidth, int maxOutputHeight,
        AutoCropSampler.Insets cropInsets, String aspectMode) {
        super(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1);
        this.context = context;
        this.family = family;
        this.sharpeningTuning = sharpeningTuning;
        this.colorTuning = colorTuning;
        this.aiUpscalingEnabled = aiUpscalingEnabled;
        this.maxOutputWidth = maxOutputWidth;
        this.maxOutputHeight = maxOutputHeight;
        this.cropInsets = cropInsets;
        this.aspectMode = aspectMode;
    }

    /* The size declared here has to stay valid across every future toggle/strength/family change
       for as long as the input resolution doesn't change - Media3's BaseGlShaderProgram only
       calls configure() again when the INPUT texture's dimensions differ from last time (see
       queueInputFrame), never because this program itself would prefer a different output size.
       So the size is pinned up front, using whichever family is in effect right now, and stays
       fixed regardless of aiUpscalingEnabled/strength/a later family override - see this class's
       own header comment for why that's safe (both presets share the same 2x scale).

       When cropInsets is non-null, the scale-up base is the CROPPED effective dimensions, not
       the raw input ones - this is the whole reason Auto-Crop needs a reinstall (a fresh
       construction, hence a fresh configure() call) rather than a live update: this computation
       can only run once, at the top of this program's life, with whatever cropInsets the
       constructor was given. */
    @Override
    public Size configure(int inputWidth, int inputHeight) {
        lastInputWidth = inputWidth;
        lastInputHeight = inputHeight;
        float targetAR = maxOutputHeight > 0 ? (float) maxOutputWidth / maxOutputHeight : 0f;

        // Cover needs the crop pass's OWN sub-rect widened (beyond whatever Auto-Crop already
        // found) until its AR matches the screen's - see combineCoverInsets's own comment. Fit
        // and Stretch both leave cropInsets untouched: Fit doesn't reshape at all, and Stretch
        // reshapes downstream (see the outSize branch below), never by cropping further here -
        // honoring Auto-Crop's own AR as the thing that gets stretched, not cropped again.
        effectiveCropInsets = "cover".equals(aspectMode) && targetAR > 0
            ? combineCoverInsets(cropInsets, inputWidth, inputHeight, targetAR)
            : cropInsets;

        if (effectiveCropInsets != null) {
            float cropW = Math.max(0.001f, 1f - effectiveCropInsets.left - effectiveCropInsets.right);
            float cropH = Math.max(0.001f, 1f - effectiveCropInsets.top - effectiveCropInsets.bottom);
            effectiveInputWidth = Math.max(1, Math.round(inputWidth * cropW));
            effectiveInputHeight = Math.max(1, Math.round(inputHeight * cropH));
        } else {
            effectiveInputWidth = inputWidth;
            effectiveInputHeight = inputHeight;
        }

        ShaderType fam = family;
        AiUpscalingPresets.Preset preset = AiUpscalingPresets.forFamily(context.getAssets(), fam);
        float maxScale = preset != null ? preset.scale : fam.maxScaleFactor();
        /* Stretch is the one mode that reshapes WITHOUT cropping - effectiveInputWidth/Height
           above still carries Auto-Crop's own (uncropped-further) AR, honoring it as the source,
           and the actual non-uniform stretch happens implicitly in chain.render's own resize from
           that source AR to this method's returned Size once it's a different shape - same
           mechanism the upscale chain already uses to go from 1x to preset.scale, just fed a
           differently-shaped target here. The area-preserving reshape below keeps the same pixel
           budget (hence the same upscale quality) Fit would have used, just poured into the
           screen's own AR instead of the content's. */
        int[] outSize;
        if ("stretch".equals(aspectMode) && targetAR > 0) {
            long area = (long) effectiveInputWidth * effectiveInputHeight;
            int virtualH = Math.max(1, Math.round((float) Math.sqrt(area / targetAR)));
            int virtualW = Math.max(1, Math.round(virtualH * targetAR));
            outSize = scaledOutputSize(maxScale, maxOutputWidth, maxOutputHeight, virtualW, virtualH);
        } else {
            outSize = scaledOutputSize(maxScale, maxOutputWidth, maxOutputHeight, effectiveInputWidth, effectiveInputHeight);
        }
        activeOutW = outSize[0];
        activeOutH = outSize[1];
        return new Size(activeOutW, activeOutH);
    }

    /* Widens `base` (Auto-Crop's own confirmed insets, or null) with extra symmetric cropping on
       whichever axis is oversized relative to targetAR, until the remaining sub-rect's AR equals
       targetAR exactly - the same "source and destination share the same AR by construction, so
       this is a plain crop+resample, never a stretch" invariant crop.frag.glsl's own header
       comment already relies on, just with a target AR that's now the screen's instead of always
       being the raw frame's. Builds ON TOP of base rather than replacing it, so a real detected
       border stays honored as the thing Cover crops further from, not discarded. */
    private static AutoCropSampler.Insets combineCoverInsets(AutoCropSampler.Insets base, int inputWidth, int inputHeight, float targetAR) {
        float left = base != null ? base.left : 0f;
        float right = base != null ? base.right : 0f;
        float top = base != null ? base.top : 0f;
        float bottom = base != null ? base.bottom : 0f;
        float croppedW = inputWidth * Math.max(0.001f, 1f - left - right);
        float croppedH = inputHeight * Math.max(0.001f, 1f - top - bottom);
        float subAR = croppedW / croppedH;
        if (subAR > targetAR) {
            float wantedW = croppedH * targetAR;
            float extra = Math.max(0f, (croppedW - wantedW) / inputWidth) / 2f;
            left += extra;
            right += extra;
        } else if (subAR < targetAR) {
            float wantedH = croppedW / targetAR;
            float extra = Math.max(0f, (croppedH - wantedH) / inputHeight) / 2f;
            top += extra;
            bottom += extra;
        }
        AutoCropSampler.Insets combined = new AutoCropSampler.Insets(top, bottom, left, right);
        return combined.isZero() ? null : combined;
    }

    @Override
    public void drawFrame(int inputTexId, long presentationTimeUs) throws VideoFrameProcessingException {
        try {
            int[] prevFbo = new int[1];
            GLES30.glGetIntegerv(GLES30.GL_FRAMEBUFFER_BINDING, prevFbo, 0);

            ShaderType fam = family;
            AiUpscalingPresets.Preset preset = AiUpscalingPresets.forFamily(context.getAssets(), fam);
            boolean gateOk = preset != null
                && (preset.when == null || preset.when.test(effectiveInputWidth, effectiveInputHeight, activeOutW, activeOutH));
            GlPassChain upgrade = gateOk ? upgradeChainFor(fam, preset) : null;
            usingUpgrade = aiUpscalingEnabled && upgrade != null;
            upgradeUnsupported = preset == null || upgradeChainFailed.contains(fam);

            int sourceTex = effectiveCropInsets != null ? renderCropPass(inputTexId) : inputTexId;

            Map<String, Object> uniforms = new HashMap<>();
            // The trailing sharpen pass in the upgrade chain samples an already-output-resolution
            // image (present's/luma-merge's result), not SOURCE directly the way the plain chain
            // does - its tap offsets need the real output/source ratio folded in, or the kernel's
            // reach silently shrinks relative to source pixels. See shader-pipeline.js's identical
            // uKernelScale comment for the same fix on the web leg.
            float kernelScale = usingUpgrade
                ? sharpeningTuning.kernelScale * (activeOutW / (float) effectiveInputWidth)
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

            GlPassChain chain = usingUpgrade ? upgrade : plainChainFor(fam);
            boolean ok = chain.render(sourceTex, effectiveInputWidth, effectiveInputHeight, activeOutW, activeOutH, uniforms, prevFbo[0]);
            if (!ok) {
                Log.e(TAG, "AI Upscaling chain render failed (intermediate target allocation) for this frame");
            }
        } catch (RuntimeException e) {
            throw new VideoFrameProcessingException(e, presentationTimeUs);
        }
    }

    /* Renders the crop-only pass into this program's own small intermediate texture/FBO, sized to
       effectiveInputWidth/Height (the TRUE cropped resolution, not the raw input - see this
       class's own header comment for why that's now possible: configure() already committed to
       that size up front). Because source (the crop sub-rect) and destination (this target) now
       share the exact same aspect ratio by construction, this is a plain crop+resample - no
       fit/cover/letterbox math needed, see crop.frag.glsl's own header comment. Returns the input
       texture unchanged if the intermediate target can't be allocated, rather than rendering
       nothing this frame - same "skip the feature, don't blank the picture" reasoning
       GlPassChain.render's own false return gets everywhere else in this class. */
    private int renderCropPass(int inputTexId) {
        if (!ensureCropTarget(effectiveInputWidth, effectiveInputHeight)) return inputTexId;
        if (cropChain == null) {
            String frag = GlAssetLoader.read(context.getAssets(), "crop.frag.glsl");
            List<GlPassChain.PassSpec> passes = List.of(new GlPassChain.PassSpec(
                "crop", frag, List.of(new GlPassChain.PassSpec.Input("uTex", GlPassChain.SOURCE)), 1f, /* floatRequired= */ false));
            cropChain = new GlPassChain(context.getAssets(), passes);
        }
        Map<String, Object> uniforms = new HashMap<>();
        uniforms.put("uInsetLeft", effectiveCropInsets.left);
        uniforms.put("uInsetTop", effectiveCropInsets.top);
        uniforms.put("uInsetRight", effectiveCropInsets.right);
        uniforms.put("uInsetBottom", effectiveCropInsets.bottom);
        boolean ok = cropChain.render(inputTexId, lastInputWidth, lastInputHeight, cropTexW, cropTexH, uniforms, cropFbo);
        if (!ok) {
            Log.e(TAG, "Auto-Crop pass render failed (intermediate target allocation) for this frame");
            return inputTexId;
        }
        return cropTex;
    }

    private boolean ensureCropTarget(int w, int h) {
        if (cropTex != -1 && cropTexW == w && cropTexH == h) return true;
        releaseCropTarget();

        int[] texHolder = new int[1];
        GLES30.glGenTextures(1, texHolder, 0);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texHolder[0]);
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, w, h, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE);
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE);

        int[] fboHolder = new int[1];
        GLES30.glGenFramebuffers(1, fboHolder, 0);
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fboHolder[0]);
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, texHolder[0], 0);
        boolean complete = GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) == GLES30.GL_FRAMEBUFFER_COMPLETE;
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        if (!complete) {
            GLES30.glDeleteFramebuffers(1, fboHolder, 0);
            GLES30.glDeleteTextures(1, texHolder, 0);
            return false;
        }
        cropTex = texHolder[0];
        cropFbo = fboHolder[0];
        cropTexW = w;
        cropTexH = h;
        return true;
    }

    private void releaseCropTarget() {
        if (cropFbo != -1) {
            GLES30.glDeleteFramebuffers(1, new int[] {cropFbo}, 0);
            cropFbo = -1;
        }
        if (cropTex != -1) {
            GLES30.glDeleteTextures(1, new int[] {cropTex}, 0);
            cropTex = -1;
        }
        cropTexW = -1;
        cropTexH = -1;
    }

    private GlPassChain upgradeChainFor(ShaderType fam, AiUpscalingPresets.Preset preset) {
        if (upgradeChainFailed.contains(fam)) return null;
        GlPassChain existing = upgradeChains.get(fam);
        if (existing != null) return existing;
        try {
            GlPassChain built = new GlPassChain(context.getAssets(), preset.passes);
            upgradeChains.put(fam, built);
            return built;
        } catch (RuntimeException e) {
            Log.e(TAG, "AI Upscaling chain build failed for " + fam + ", falling back to Sharpening only - " + e.getMessage());
            upgradeChainFailed.add(fam);
            return null;
        }
    }

    private GlPassChain plainChainFor(ShaderType fam) {
        GlPassChain existing = plainChains.get(fam);
        if (existing != null) return existing;
        String frag = GlAssetLoader.read(context.getAssets(), fam.useCas ? "sharpen-cas.frag.glsl" : "sharpen-anime.frag.glsl");
        List<GlPassChain.PassSpec> passes = List.of(new GlPassChain.PassSpec(
            "sharpen", frag, List.of(new GlPassChain.PassSpec.Input("uTex", GlPassChain.SOURCE)), 1f, /* floatRequired= */ false));
        GlPassChain built = new GlPassChain(context.getAssets(), passes);
        plainChains.put(fam, built);
        return built;
    }

    @Override
    public void release() throws VideoFrameProcessingException {
        super.release();
        for (GlPassChain chain : plainChains.values()) chain.release();
        for (GlPassChain chain : upgradeChains.values()) chain.release();
        if (cropChain != null) cropChain.release();
        releaseCropTarget();
    }

    /* Read by PlayerUiHelper's Performance Overlay - see updateStatsOverlay's "AI Upscaling"
       line. Distinguishes the same three otherwise-identical silences shader-pipeline.js's
       idleUpgradeLabel does on the web leg: unsupported on this device/GPU, idle because the
       upscale gate declined (source doesn't need it), and actually rendering. Reads `family`
       fresh (not whatever it was at construction) so a live Content Type override is reflected
       here too. */
    String statusLabel() {
        if (upgradeUnsupported) return "unsupported here";
        if (!usingUpgrade) return "idle - source not upscaled";
        return family == ShaderType.ANIME4K ? "Animation (AI CNN)" : "Live-Action (FSR 1)";
    }
}
