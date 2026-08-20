// Debanding pass, ported from src/player/shader/glsl/deband.frag.glsl - see that file's own
// header comment for the technique (randomized-neighborhood reconstruction, written from the
// published approach, not ported from mpv's GPL deband filter). Runs on Xbox between the CNN
// upscale chain and present.hlsl - see shaders.js's buildAnime4kCnn for the real composition
// order (this file's own web-side header comment is stale on that point).
//
// D2DSampleInputAtOffset's offset argument is already in real pixels (see anime4k.hlsl's own
// note), unlike GLSL's texture2D which needed a manual texelSize-scaled UV offset - so unlike
// the GLSL original, this needs no uTexTexelSize uniform at all. D2DGetScenePosition() supplies
// the per-pixel coordinate the GLSL original derived as `vUv * uTexSize`, for the same
// per-pixel/per-frame hash seeding.
#define D2D_INPUT_COUNT 1
#include "d2d1effecthelpers.hlsli"

cbuffer constants : register(b0)
{
    float uFrameSeed;
    float uDebandThreshold;
    float uDebandRange;
    float uDebandGrain;
};

float hash13(float3 p)
{
    p = frac(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return frac((p.x + p.y) * p.z);
}

D2D_PS_ENTRY(main)
{
    float2 scenePos = D2DGetScenePosition().xy;
    float4 center = D2DGetInput(0);
    float3 result = center.rgb;
    float h = hash13(float3(scenePos, uFrameSeed));

    [unroll]
    for (int i = 1; i <= 2; i++)
    {
        float fi = (float)i;
        float dist = h * uDebandRange * fi;
        h = frac(h * 7919.0 + 0.137);
        float angle = h * 6.28318530718;
        h = frac(h * 7919.0 + 0.137);
        float2 o = dist * float2(cos(angle), sin(angle));

        float3 a = D2DSampleInputAtOffset(0, float2( o.x,  o.y)).rgb;
        float3 b = D2DSampleInputAtOffset(0, float2(-o.y,  o.x)).rgb;
        float3 c = D2DSampleInputAtOffset(0, float2(-o.x, -o.y)).rgb;
        float3 d = D2DSampleInputAtOffset(0, float2( o.y, -o.x)).rgb;
        float3 avg = (a + b + c + d) * 0.25;

        float3 diff = abs(result - avg);
        float thresholdVal = uDebandThreshold * fi / 255.0;
        float3 weight = saturate(1.0 - diff / float3(thresholdVal, thresholdVal, thresholdVal));
        result = lerp(result, avg, weight);
    }

    float3 noise = float3(
        hash13(float3(scenePos, uFrameSeed + 11.0)),
        hash13(float3(scenePos, uFrameSeed + 23.0)),
        hash13(float3(scenePos, uFrameSeed + 37.0))
    ) - 0.5;
    result += noise * (uDebandGrain / 255.0);

    return float4(result, center.a);
}
