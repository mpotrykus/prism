package com.mpotrykus.prism;

import android.content.Context;
import android.util.DisplayMetrics;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.GlEffect;
import androidx.media3.effect.GlShaderProgram;

/* Factory side of AiUpscaleShaderProgram - parallels ShaderUpscaleEffect exactly (see that
   class's own header comment), one level up: this is what PlayerActivity.applyVideoEffects
   installs instead of ShaderUpscaleEffect whenever AI Upscaling's own toggle is on, regardless
   of whether Sharpening is also on - the two are independent toggles now, matching the web
   leg's split (see shaders.js's "AI Upscaling split from Sharpening" note). */
@UnstableApi
final class AiUpscaleEffect implements GlEffect {

    private final Context context;
    private final ShaderType family;
    private final ShaderTuning sharpeningTuning;
    private final ColorBoostTuning colorTuning;
    private final int maxOutputWidth;
    private final int maxOutputHeight;

    AiUpscaleEffect(Context context, ShaderType family, ShaderTuning sharpeningTuning, ColorBoostTuning colorTuning) {
        this.context = context;
        this.family = family;
        this.sharpeningTuning = sharpeningTuning;
        this.colorTuning = colorTuning;
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        this.maxOutputWidth = metrics.widthPixels;
        this.maxOutputHeight = metrics.heightPixels;
    }

    @Override
    public GlShaderProgram toGlShaderProgram(Context unusedEffectContext, boolean useHdr) throws VideoFrameProcessingException {
        // Deliberately uses the Context captured in this effect's own constructor, not the
        // parameter Media3 hands this method - that one is whatever context the video-effects
        // pipeline was set up with, not guaranteed to be the PlayerActivity instance the
        // instanceof check below (and getAssets()) needs.
        AiUpscaleShaderProgram program =
            new AiUpscaleShaderProgram(context, useHdr, family, sharpeningTuning, colorTuning, maxOutputWidth, maxOutputHeight);
        // PlayerActivity also implements Context here (see applyVideoEffects's `new
        // AiUpscaleEffect(this, ...)`) - stashed so the stats overlay can query this instance's
        // live status without a separate listener interface. See PlayerActivity's own comment on
        // activeAiUpscaleProgram for why a briefly-stale read after release() is acceptable.
        if (context instanceof PlayerActivity) {
            ((PlayerActivity) context).activeAiUpscaleProgram = program;
        }
        return program;
    }

    /* Mirrors ShaderUpscaleEffect.isNoOp's reasoning exactly, plus a third condition: this
       effect also isn't a no-op whenever the CNN/FSR upgrade would actually apply, since that
       preset always meaningfully transforms the image once it's a candidate at all (deband +
       a real upscale/reconstruction pass) - "strengthless" the same way the web leg's presets
       are, so there is no all-parameters-zero case to detect for it the way there is for
       Sharpening/Color Boost. wouldUpgradeApply needs no GL context - see its own comment. */
    @Override
    public boolean isNoOp(int inputWidth, int inputHeight) {
        boolean colorNoOp = colorTuning.saturationBoost == 1f && colorTuning.contrastBoost == 1f;
        if (!colorNoOp) return false;
        if (AiUpscaleShaderProgram.wouldUpgradeApply(context, family, maxOutputWidth, maxOutputHeight, inputWidth, inputHeight)) {
            return false;
        }
        boolean upscalingRequested = sharpeningTuning.sharpenStrength > 0f;
        boolean sharpenNoOp = !upscalingRequested || (inputWidth >= maxOutputWidth && inputHeight >= maxOutputHeight);
        return sharpenNoOp;
    }
}
