// Anime4K v3.2 Upscale CNN x2 (S) - Depth-to-Space (final pass of the upscale chain, the 2x
// resolution change). Transcribed from
// src/player/shader/glsl/vendor/anime4k-upscale-cnn-x2-s.glsl (bloc97/Anime4K, MIT):
//
//   vec2 f0 = fract(conv2d_last_tf_pos * conv2d_last_tf_size);
//   ivec2 i0 = ivec2(f0 * vec2(2.0));
//   float c0 = conv2d_last_tf_tex((vec2(0.5) - f0) * conv2d_last_tf_pt + conv2d_last_tf_pos)[i0.y * 2 + i0.x];
//   return vec4(c0, c0, c0, c0) + MAIN_tex(MAIN_pos);
//
// mpv's "_pos" is always the CURRENT fragment's normalized position within the shader's own
// declared output (2x here) regardless of which texture it's read against - this pass's own
// vertex shader (fullscreen_quad_vs.hlsl) supplies exactly that as `uv`. This is a raw D3D11
// pass, not a Win2D PixelShaderEffect, because it both changes resolution (declared output is
// 2x the conv2d_last_tf/MAIN input resolution) and reads two textures at that different
// resolution at once - the combination Win2D's PixelShaderEffect can't cleanly express (see
// AiUpscalePixelEffect.cs's header comment).
Texture2D convLastTex : register(t0); // conv2d_last_tf - anime4k_upscale_conv3.hlsl's output
Texture2D mainTex : register(t1);     // MAIN (upscale chain) - the restore chain's own output
SamplerState linearSampler : register(s0);

float4 main(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    uint texW, texH;
    convLastTex.GetDimensions(texW, texH);
    float2 size = float2(texW, texH);
    float2 pt = 1.0 / size;

    float2 f0 = frac(uv * size);
    int2 i0 = int2(f0 * 2.0);
    float2 samplePos = (float2(0.5, 0.5) - f0) * pt + uv;
    float4 texel = convLastTex.Sample(linearSampler, samplePos);
    // Explicit branch chain, not texel[i0.y * 2 + i0.x] - fxc compiles a fully dynamic vector
    // component index without complaint, but that is only a DXBC-level validity check, not a
    // guarantee every D3D11 driver/GPU actually executes it correctly; this branch form is
    // unambiguous on any conformant hardware.
    int idx = i0.y * 2 + i0.x;
    float c0 = (idx == 0) ? texel.x : (idx == 1) ? texel.y : (idx == 2) ? texel.z : texel.w;

    float4 mainSample = mainTex.Sample(linearSampler, uv);
    return float4(c0, c0, c0, c0) + mainSample;
}
