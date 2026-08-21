package com.mpotrykus.prism;

import android.content.Context;
import android.util.DisplayMetrics;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.GlEffect;
import androidx.media3.effect.GlShaderProgram;

/* Factory side of AiUpscaleShaderProgram - this is the ONLY GlEffect PlayerActivity.
   applyVideoEffects ever installs now (see that method and AiUpscaleShaderProgram's own header
   comment for why): it's installed once per player instance and then left alone for the rest
   of that instance's life, with every later Sharpening/Color Boost/AI Upscaling toggle pushed
   straight into the already-built AiUpscaleShaderProgram via updateState() instead of a new
   Effect + a fresh player.setVideoEffects() call. */
@UnstableApi
final class AiUpscaleEffect implements GlEffect {

    private final Context context;
    private final ShaderType family;
    private final ShaderTuning sharpeningTuning;
    private final ColorBoostTuning colorTuning;
    private final boolean aiUpscalingEnabled;
    private final int maxOutputWidth;
    private final int maxOutputHeight;

    AiUpscaleEffect(Context context, ShaderType family, ShaderTuning sharpeningTuning, ColorBoostTuning colorTuning,
        boolean aiUpscalingEnabled) {
        this.context = context;
        this.family = family;
        this.sharpeningTuning = sharpeningTuning;
        this.colorTuning = colorTuning;
        this.aiUpscalingEnabled = aiUpscalingEnabled;
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
        AiUpscaleShaderProgram program = new AiUpscaleShaderProgram(
            context, useHdr, family, sharpeningTuning, colorTuning, aiUpscalingEnabled, maxOutputWidth, maxOutputHeight);
        // PlayerActivity also implements Context here (see applyVideoEffects's `new
        // AiUpscaleEffect(this, ...)`) - stashed so the stats overlay AND applyVideoEffects's own
        // later toggle calls can reach this instance without a separate listener interface. See
        // PlayerActivity's own comment on activeAiUpscaleProgram for why a briefly-stale read
        // right after install/release is acceptable.
        if (context instanceof PlayerActivity) {
            ((PlayerActivity) context).activeAiUpscaleProgram = program;
        }
        return program;
    }

    /* Always kept live (never a no-op) so that every later toggle has an already-installed
       GlShaderProgram to update in place - see AiUpscaleShaderProgram.updateState and
       PlayerActivity.applyVideoEffects's header comment for why eliding this node the way the
       old ShaderUpscaleEffect/plain-off case used to would leave nothing for a later toggle to
       talk to without a fresh (wedge-risky) player.setVideoEffects() call. The trade is one
       always-on GL pass even when every toggle is currently off - cheap next to a full 10-pass
       CNN chain, which real-device testing already showed running with zero dropped frames.
       HDR content still skips this effect's installation entirely (see applyVideoEffects), so
       this only applies to SDR playback. */
    @Override
    public boolean isNoOp(int inputWidth, int inputHeight) {
        return false;
    }
}
