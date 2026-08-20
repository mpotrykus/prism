// FSR1 luma sub-pipeline, last pass (Stage 2b). Ported from
// src/player/shader/glsl/luma-merge.frag.glsl - see that file's own header comment for the
// additive-luma-delta trick (exact, not an approximation - adding the same delta to R/G/B shifts
// luma by exactly that amount while leaving chroma untouched) and for why dither belongs here
// rather than in a separate present-style pass. Raw D3D11, not Win2D, because it reads two
// DIFFERENTLY-SIZED textures at once (uSource at native resolution, uLuma at the already-
// upscaled 2x resolution) while itself outputting at 2x - the same combination
// anime4k_depth_to_space.hlsl needs raw D3D11 for (see AiUpscalePixelEffect.cs's header comment).
Texture2D sourceTex : register(t0); // native-resolution decoded frame (RGB)
Texture2D lumaTex : register(t1);   // 2x-resolution reconstructed luma (fsr_rcas.hlsl's output, via deband)
SamplerState linearSampler : register(s0);

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

// Triangular-PDF dither at +/-0.5 LSB - see luma-merge.frag.glsl's own comment on why triangular
// rather than uniform noise. pos (SV_Position) is already real pixel coordinates in this pass's
// own 2x output, the same role vUv*uOutputSize plays in the GLSL original.
float3 ditherOut(float3 c, float2 pos, float seed)
{
    float a = hash13(float3(pos, seed));
    float b = hash13(float3(pos, seed + 53.0));
    return c + ((a + b) - 1.0) * (0.5 / 255.0);
}

float4 main(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    float3 rgb = sourceTex.Sample(linearSampler, uv).rgb;
    // BT.709 - must match fsr_luma_extract.hlsl's own copy exactly, see that file's note.
    float yOld = dot(rgb, float3(0.2126, 0.7152, 0.0722));
    float yNew = lumaTex.Sample(linearSampler, uv).r;
    float3 outColor = saturate(rgb + (yNew - yOld));
    outColor = ditherOut(outColor, pos.xy, uFrameSeed);
    return float4(saturate(outColor), 1.0);
}
