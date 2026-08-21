// AMD FidelityFX Super Resolution 1.0.2 - RCAS (robust contrast-adaptive sharpen), part of the
// FSR1 chain (Stage 2b). Runs INSIDE the AI-upscaling pipeline, between deband and luma-merge -
// distinct from anime4k.hlsl/live_action.hlsl's own trailing Sharpening pass, which still runs
// afterward on top of this chain's final output (see shaders.js's buildFsr for why RCAS can't
// substitute for that pass: it operates on the luma plane pre-merge, not the final RGB image).
// Transcribed from src/player/shader/glsl/vendor/fsr1-easu-rcas.glsl's RCAS hook() (AMD, MIT).
// SHARPNESS is a vendored compile-time #define (0.2), not a uniform - see shaders.js's own
// comment on why `strengthless` presets never expose it as a slider.
#define D2D_INPUT_COUNT 1
#include "d2d1effecthelpers.hlsli"

#define SHARPNESS 0.2
#define FSR_RCAS_LIMIT (0.25 - (1.0 / 16.0))

float APrxMedRcpF1(float a)
{
    float b = asfloat(0x7ef19fffu - asuint(a));
    return b * (-b * a + 2.0);
}

float AMax3F1(float x, float y, float z) { return max(x, max(y, z)); }
float AMin3F1(float x, float y, float z) { return min(x, min(y, z)); }

D2D_PS_ENTRY(main)
{
    // Algorithm uses a minimal 3x3-cross neighborhood:
    //    b
    //  d e f
    //    h
    float b = D2DSampleInputAtOffset(0, float2( 0.0, -1.0)).r;
    float d = D2DSampleInputAtOffset(0, float2(-1.0,  0.0)).r;
    float e = D2DGetInput(0).r;
    float f = D2DSampleInputAtOffset(0, float2( 1.0,  0.0)).r;
    float h = D2DSampleInputAtOffset(0, float2( 0.0,  1.0)).r;

    float mn1 = min(AMin3F1(b, d, f), h);
    float mx1 = max(AMax3F1(b, d, f), h);

    // peakC = (1.0, -4.0) in the vendored source; folded directly into the two expressions below.
    float hitMin = min(mn1, e) / (4.0 * mx1);
    float hitMax = (1.0 - max(mx1, e)) / (4.0 * mn1 - 4.0);
    float lobeL = max(-hitMin, hitMax);
    float lobe = max(-FSR_RCAS_LIMIT, min(lobeL, 0.0)) * exp2(-clamp(SHARPNESS, 0.0, 2.0));

    // Noise removal (FSR_RCAS_DENOISE == 1 in the vendored source, upstream's default).
    float nz = 0.25 * b + 0.25 * d + 0.25 * f + 0.25 * h - e;
    nz = saturate(abs(nz) * APrxMedRcpF1(AMax3F1(AMax3F1(b, d, e), f, h) - AMin3F1(AMin3F1(b, d, e), f, h)));
    nz = -0.5 * nz + 1.0;
    lobe *= nz;

    float rcpL = APrxMedRcpF1(4.0 * lobe + 1.0);
    float result = (lobe * b + lobe * d + lobe * h + lobe * f + e) * rcpL;

    return float4(result, result, result, 1.0);
}
