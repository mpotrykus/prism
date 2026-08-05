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
    OFF("Off", false, null, null),
    ANIME4K("Anime4K", false,
        new ShaderTuning(/* scaleFactor= */ 1.8f, /* sharpenStrength= */ 1.8f,
            /* kernelScale= */ 1.5f, /* saturationBoost= */ 1.15f, /* contrastBoost= */ 1.08f),
        new ShaderTuning(/* scaleFactor= */ 2.4f, /* sharpenStrength= */ 3.8f,
            /* kernelScale= */ 2.8f, /* saturationBoost= */ 1.5f, /* contrastBoost= */ 1.28f)),
    /* useCas=true - saturationBoost/contrastBoost are unused by the CAS shader (kept at 1.0, see
       ShaderUpscaleShaderProgram) since exaggerating global contrast/saturation on already
       color-graded live-action footage looks wrong in a way it doesn't on anime's flat palette. */
    LIVE_ACTION("Live-Action (CAS)", true,
        new ShaderTuning(/* scaleFactor= */ 1.3f, /* sharpenStrength= */ 0.6f,
            /* kernelScale= */ 1f, /* saturationBoost= */ 1f, /* contrastBoost= */ 1f),
        new ShaderTuning(/* scaleFactor= */ 1.6f, /* sharpenStrength= */ 1.1f,
            /* kernelScale= */ 1.3f, /* saturationBoost= */ 1f, /* contrastBoost= */ 1f));

    final String label;
    final boolean useCas;
    private final ShaderTuning minTuning;
    private final ShaderTuning maxTuning;

    ShaderType(String label, boolean useCas, ShaderTuning minTuning, ShaderTuning maxTuning) {
        this.label = label;
        this.useCas = useCas;
        this.minTuning = minTuning;
        this.maxTuning = maxTuning;
    }

    /** @param strength 0f-1f, clamped; meaningless for OFF (never queried since OFF adds no effect). */
    ShaderTuning tuningAt(float strength) {
        float t = Math.max(0f, Math.min(1f, strength));
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
