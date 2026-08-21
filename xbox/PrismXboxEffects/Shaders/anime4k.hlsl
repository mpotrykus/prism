// Win2D PixelShaderEffect port of src/player/shader/shaders.js's SHADER_FRAGMENT_ANIME
// (Anime4K-inspired Sobel-edge-gated unsharp mask). Ported algorithm, not the exact GLSL -
// texelSize is folded away because D2DSampleInputAtOffset's offset argument is already in real
// pixels (see d2d1effecthelpers.hlsli), unlike GLSL's texture2D which needed a manual
// texelSize-scaled UV offset. kernelScale plays the same role uKernelScale did on web/Android:
// how many pixels away each tap samples.
//
// Compiled offline via fxc.exe (see compile-shaders.ps1), NOT at MSBuild time - this is a
// classic C# UWP project tree with no HLSL build-item support. Reflection metadata is
// deliberately NOT stripped (no /Qstrip_reflect) so Win2D's PixelShaderEffect can discover
// the four cbuffer fields below by name via effect.Properties["kernelScale"] etc.
//
// D2D_INPUT0 defaults to "complex" (offset-sampling) mode per d2d1effecthelpers.hlsli - do not
// add a D2D_INPUT0_SIMPLE define, that would make D2DSampleInputAtOffset read a single static
// sample regardless of offset. The C# side must pair this with
// Source1Mapping = SamplerCoordinateMapping.Offset and MaxSamplerOffset >= the largest
// kernelScale this shader will ever be given (SHADER_TYPES.anime4k.max.kernel in shaders.js) -
// too small a MaxSamplerOffset silently produces wrong samples at the tile edges D2D chooses
// for this effect, not an error.
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
    float3 center = center4.rgb;
    float3 n  = D2DSampleInputAtOffset(0, float2(0.0, -kernelScale)).rgb;
    float3 s  = D2DSampleInputAtOffset(0, float2(0.0,  kernelScale)).rgb;
    float3 w  = D2DSampleInputAtOffset(0, float2(-kernelScale, 0.0)).rgb;
    float3 e  = D2DSampleInputAtOffset(0, float2( kernelScale, 0.0)).rgb;
    float3 nw = D2DSampleInputAtOffset(0, float2(-kernelScale, -kernelScale)).rgb;
    float3 ne = D2DSampleInputAtOffset(0, float2( kernelScale, -kernelScale)).rgb;
    float3 sw = D2DSampleInputAtOffset(0, float2(-kernelScale,  kernelScale)).rgb;
    float3 se = D2DSampleInputAtOffset(0, float2( kernelScale,  kernelScale)).rgb;

    float lN = luma(n);
    float lS = luma(s);
    float lW = luma(w);
    float lE = luma(e);
    float lNW = luma(nw);
    float lNE = luma(ne);
    float lSW = luma(sw);
    float lSE = luma(se);
    float gx = (lNE + 2.0 * lE + lSE) - (lNW + 2.0 * lW + lSW);
    float gy = (lSW + 2.0 * lS + lSE) - (lNW + 2.0 * lN + lNE);
    float edge = saturate(sqrt(gx * gx + gy * gy));

    float3 blurredNeighborhood = (n + s + w + e) * 0.25;
    float3 outColor = center + (center - blurredNeighborhood) * sharpenStrength * edge;

    // Clamp to the local 4-neighbor min/max before the final saturate() - same anti-halo
    // technique live_action.hlsl's CAS variant uses. Without this, the unsharp-mask term
    // above overshoots past the neighborhood's actual value range right at high-contrast
    // edges (exactly what anime lineart is), producing a bright/dark halo fringe next to
    // every line instead of a clean sharpened edge.
    float3 minRgb = min(center, min(min(n, s), min(w, e)));
    float3 maxRgb = max(center, max(max(n, s), max(w, e)));
    outColor = clamp(outColor, minRgb, maxRgb);
    outColor = saturate(outColor);

    // Shadow protection: feathers contrast/saturation down to a no-op as luma approaches
    // black, same reasoning as the GLSL original - a linear mid-gray-pivoted contrast stretch
    // otherwise crushes near-black shades to flat 0.
    float shadowProtect = smoothstep(0.0, 0.22, luma(outColor));
    float contrast = lerp(1.0, contrastBoost, shadowProtect);
    float saturationAmt = lerp(1.0, saturationBoost, shadowProtect);
    // Saturation and Contrast are independent controls - each must be a true no-op on the
    // other. Real bug fixed 2026-08-20 (duplicated across all 3 platform copies of this
    // shader - see sharpen-anime.frag.glsl's own comment), second (deeper) round: a first
    // attempt just reordered contrast/saturation, but a per-channel stretch
    // (x-0.5)*contrast+0.5 multiplies EVERY channel value by contrast, including the
    // differences BETWEEN channels - which is exactly what chroma/saturation is - so
    // contrast still visibly scaled saturation regardless of order. Fix: apply contrast to
    // LUMA ONLY via an additive delta to R/G/B (preserves every channel difference, i.e.
    // chroma, exactly - same trick this codebase's luma-merge.frag.glsl already uses), then
    // lerp saturation toward that contrast-adjusted luma.
    float l0 = luma(outColor);
    float lc = (l0 - 0.5) * contrast + 0.5;
    float3 contrastedColor = outColor + (lc - l0);
    outColor = lerp(float3(lc, lc, lc), contrastedColor, saturationAmt);
    outColor = saturate(outColor);

    return float4(outColor, center4.a);
}
