package com.mpotrykus.streaming;

/* Which GLSL algorithm ShaderUpscaleShaderProgram compiles - see that class's header comment for
   why Anime4K's edge-gated shader and the CAS-inspired live-action shader are genuinely different
   algorithms, not just different intensity numbers on one shader.

   Each non-OFF type carries a minTuning/maxTuning pair - the 0% and 100% ends of the "Strength"
   slider in PlayerActivity's shader upscaling dialog. These were the old discrete preset tiers
   (Subtle/Medium/Bold for Anime4K, Subtle/Bold for live-action) before the dialog replaced picking
   a fixed tier with a continuous slider; tuningAt() linearly interpolates every knob between them,
   so any strength in between is a blend rather than a name. */
enum ShaderType {
    OFF("Off", false, null, null, 1f),
    ANIME4K("Anime4K", false,
        new ShaderTuning(/* scaleFactor= */ 1.8f, /* sharpenStrength= */ 1.8f,
            /* kernelScale= */ 1.5f, /* saturationBoost= */ 1.1f, /* contrastBoost= */ 1.05f),
        new ShaderTuning(/* scaleFactor= */ 2.4f, /* sharpenStrength= */ 3.8f,
            /* kernelScale= */ 2.8f, /* saturationBoost= */ 1.35f, /* contrastBoost= */ 1.18f),
        1f),
    /* useCas=true - saturationBoost/contrastBoost here are a small compensating boost, not the
       anime tuning's exaggeration (see ShaderUpscaleShaderProgram's header comment): CAS's
       anti-ringing clamp slightly flattens contrast/saturation as a side effect of guarding
       against ringing, and this nudges both back up rather than leaving the picture duller than
       the source.
       rampToMaxAt=0.15 - CAS ramps to its max tuning by 15% strength instead of 100%: the old
       full 0-100% range made the slider's first ~2/3 barely perceptible (see
       ShaderUpscaleShaderProgram's weight-gate fix), so the previous "100%" tuning now arrives
       at "Light" instead of only at "Strong". Strength above 0.15 just stays at max, same as
       reaching 100% used to. */
    LIVE_ACTION("Live-Action (CAS)", true,
        new ShaderTuning(/* scaleFactor= */ 1.3f, /* sharpenStrength= */ 1.0f,
            /* kernelScale= */ 1.2f, /* saturationBoost= */ 1f, /* contrastBoost= */ 1f),
        new ShaderTuning(/* scaleFactor= */ 1.6f, /* sharpenStrength= */ 2.2f,
            /* kernelScale= */ 1.8f, /* saturationBoost= */ 1.12f, /* contrastBoost= */ 1.06f),
        0.15f);

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
            lerp(minTuning.kernelScale, maxTuning.kernelScale, t),
            lerp(minTuning.saturationBoost, maxTuning.saturationBoost, t),
            lerp(minTuning.contrastBoost, maxTuning.contrastBoost, t));
    }

    private static float lerp(float a, float b, float t) {
        return a + (b - a) * t;
    }
}
