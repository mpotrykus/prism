package com.mpotrykus.prism;

/* Which GLSL algorithm ShaderUpscaleShaderProgram compiles - see that class's header comment for
   why Anime4K's edge-gated shader and the CAS-inspired live-action shader are genuinely different
   algorithms, not just different intensity numbers on one shader.

   Each non-OFF type carries a minTuning/maxTuning pair - the 0% and 100% ends of the "Strength"
   slider in PlayerActivity's shader upscaling dialog. These were the old discrete preset tiers
   (Subtle/Medium/Bold for Anime4K, Subtle/Bold for live-action) before the dialog replaced picking
   a fixed tier with a continuous slider; tuningAt() linearly interpolates every knob between them,
   so any strength in between is a blend rather than a name.

   Used to also carry saturationBoost/contrastBoost, folded into this same slider - split out into
   ColorBoostTuning/PlayerActivity's separate Color Boost toggle instead (see that class's header
   comment for why: a linear contrast stretch pivoted at mid-gray crushes near-black shades into
   flat 0 once the boost multiplier rides high enough, and composing that with the strongest
   shader-upscale tuning made the crush worse than necessary). */
enum ShaderType {
    OFF("Off", false, null, null, 1f),
    /* min.sharpenStrength/kernelScale are deliberately near-zero, not "the lightest visible
       tier" - see LIVE_ACTION's own comment below (both families tuned together, fixed
       2026-08-30: 1% strength was landing at an already-strong, visibly jaggy sharpen). */
    ANIME4K("Animation", false,
        new ShaderTuning(/* scaleFactor= */ 1.8f, /* sharpenStrength= */ 0.15f, /* kernelScale= */ 1.0f),
        new ShaderTuning(/* scaleFactor= */ 2.4f, /* sharpenStrength= */ 3.8f, /* kernelScale= */ 2.8f),
        1f),
    /* min used to sit at 1.0/1.2 (sharpen/kernel) - a real, already-visible sharpen, not a true
       "barely on" floor - because an earlier fix (see ShaderUpscaleShaderProgram's weight-gate
       fix) also compressed the whole 0-100% slider into just its first 15% via rampToMaxAt, to
       make "Strong" reachable without most of the slider feeling unchanged. That combination
       meant even 1% strength landed almost exactly at that already-strong min, producing
       visible jaggies right at the bottom of the slider - reported 2026-08-30. Fix: drop min to
       near-zero and go back to a plain linear ramp across the full 0-100% range (rampToMaxAt=1,
       same as ANIME4K) - 1% now lands close to 0.1/1.0, genuinely subtle, climbing smoothly to
       the unchanged max (2.2/1.8) at 100%. */
    LIVE_ACTION("Live-Action", true,
        new ShaderTuning(/* scaleFactor= */ 1.3f, /* sharpenStrength= */ 0.1f, /* kernelScale= */ 1.0f),
        new ShaderTuning(/* scaleFactor= */ 1.6f, /* sharpenStrength= */ 2.2f, /* kernelScale= */ 1.8f),
        1f);

    /* Sharpening/upscale fully off - the "a program is needed to render through, but shader
       upscaling itself is disabled" case Color Boost alone hits (see ShaderUpscaleEffect's own
       header comment for why a program is always picked, never truly skipped, whenever either
       toggle is on). Distinct from any type's own minTuning, which is the lightest tier while
       still ON, not "off" - see this enum's own header comment. */
    static final ShaderTuning NEUTRAL = new ShaderTuning(1f, 0f, 1f);

    final String label;
    final boolean useCas;
    private final ShaderTuning minTuning;
    private final ShaderTuning maxTuning;
    private final float rampToMaxAt;

    ShaderType(String label, boolean useCas, ShaderTuning minTuning, ShaderTuning maxTuning, float rampToMaxAt) {
        this.label = label;
        this.useCas = useCas;
        this.minTuning = minTuning;
        this.maxTuning = maxTuning;
        this.rampToMaxAt = rampToMaxAt;
    }

    /** @param strength 0f-1f, clamped; meaningless for OFF (never queried since OFF adds no effect). */
    ShaderTuning tuningAt(float strength) {
        float t = Math.max(0f, Math.min(1f, strength / rampToMaxAt));
        return new ShaderTuning(
            lerp(minTuning.scaleFactor, maxTuning.scaleFactor, t),
            lerp(minTuning.sharpenStrength, maxTuning.sharpenStrength, t),
            lerp(minTuning.kernelScale, maxTuning.kernelScale, t));
    }

    private static float lerp(float a, float b, float t) {
        return a + (b - a) * t;
    }

    /** The scale this type could ever ask for, at 100% strength - see AiUpscaleShaderProgram's
     * own use of this: the output size it declares to Media3 has to stay fixed across a live
     * strength/toggle change (Media3 only reconfigures a GlShaderProgram's output size when the
     * *input* resolution changes, not on request - see BaseGlShaderProgram.queueInputFrame), so
     * the external contract is pinned to this ceiling rather than whatever the live strength
     * would produce. */
    float maxScaleFactor() {
        return maxTuning != null ? maxTuning.scaleFactor : 1f;
    }
}
