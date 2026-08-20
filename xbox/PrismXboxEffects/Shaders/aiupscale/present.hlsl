// Ported from src/player/shader/glsl/present.frag.glsl - clamps the CNN chain's half-float
// output (signed activations can legitimately land slightly outside 0..1) and applies
// triangular-PDF dither ahead of the trailing sharpen pass. See that file's own header comment
// for why the clamp/dither split from deband's own grain matters (distinct concerns: masking
// banding already in the source vs. masking this pipeline's own float->8bit quantization).
#define D2D_INPUT_COUNT 1
#include "d2d1effecthelpers.hlsli"

cbuffer constants : register(b0)
{
    float uFrameSeed;
};

float hash13(float3 p)
{
    p = frac(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return frac((p.x + p.y) * p.z);
}

float3 ditherOut(float3 c, float2 scenePos, float seed)
{
    float a = hash13(float3(scenePos, seed));
    float b = hash13(float3(scenePos, seed + 53.0));
    return c + ((a + b) - 1.0) * (0.5 / 255.0);
}

D2D_PS_ENTRY(main)
{
    float2 scenePos = D2DGetScenePosition().xy;
    float3 outColor = saturate(D2DGetInput(0).rgb);
    return float4(saturate(ditherOut(outColor, scenePos, uFrameSeed)), 1.0);
}
