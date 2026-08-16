// Win2D PixelShaderEffect port of src/player/shader/shaders.js's SHADER_FRAGMENT_CAS
// (Contrast Adaptive Sharpening-inspired variant for live-action footage). See anime4k.hlsl's
// header comment for the shared texelSize/kernelScale/reflection/MaxSamplerOffset notes - all
// apply here too.
#define D2D_INPUT_COUNT 1
#include "d2d1effecthelpers.hlsli"

cbuffer constants : register(b0)
{
    float kernelScale;
    float sharpenStrength;
    float saturationBoost;
    float contrastBoost;
};

float luma(float3 c)
{
    return dot(c, float3(0.299, 0.587, 0.114));
}

D2D_PS_ENTRY(main)
{
    float4 center4 = D2DGetInput(0);
    float3 c = center4.rgb;
    float3 n = D2DSampleInputAtOffset(0, float2(0.0, -kernelScale)).rgb;
    float3 s = D2DSampleInputAtOffset(0, float2(0.0,  kernelScale)).rgb;
    float3 w = D2DSampleInputAtOffset(0, float2(-kernelScale, 0.0)).rgb;
    float3 e = D2DSampleInputAtOffset(0, float2( kernelScale, 0.0)).rgb;

    float lc = luma(c);
    float ln = luma(n);
    float ls = luma(s);
    float lw = luma(w);
    float le = luma(e);
    float minL = min(lc, min(min(ln, ls), min(lw, le)));
    float maxL = max(lc, max(max(ln, ls), max(lw, le)));
    float contrastRange = max(maxL - minL, 0.0001);
    // *10.0 / *0.5 tuned the same way the GLSL original was - see shaders.js's own comment on
    // SHADER_FRAGMENT_CAS for why these constants (not 4.0/0.25) actually make the effect visible
    // on already-compressed streamed video instead of only reacting to hard edges.
    float weight = saturate(contrastRange * 10.0) * sharpenStrength;
    float3 sharpened = c + (4.0 * c - n - s - e - w) * weight * 0.5;
    float3 minRgb = min(c, min(min(n, s), min(w, e)));
    float3 maxRgb = max(c, max(max(n, s), max(w, e)));
    float3 outColor = clamp(sharpened, minRgb, maxRgb);

    float shadowProtect = smoothstep(0.0, 0.22, luma(outColor));
    float contrast = lerp(1.0, contrastBoost, shadowProtect);
    float saturationAmt = lerp(1.0, saturationBoost, shadowProtect);
    outColor = (outColor - 0.5) * contrast + 0.5;
    float l = luma(outColor);
    outColor = lerp(float3(l, l, l), outColor, saturationAmt);
    outColor = saturate(outColor);

    return float4(outColor, center4.a);
}
