// Anime4K v4.0 Restore CNN (S) - Conv 4x3x3x3 (pass 1 of 4 in the restore chain). Weights
// transcribed byte-for-byte (never re-derived) from
// src/player/shader/glsl/vendor/anime4k-restore-cnn-s.glsl (bloc97/Anime4K, MIT).
//
// D2DSampleInputAtOffset's offset argument is already in real pixels, unlike GLSL's texture2D
// which needed a manual texelSize-scaled UV offset - same note as the existing anime4k.hlsl
// Sharpening shader's own header comment. Reads SOURCE (the decoded frame) directly - this is
// the first layer, so unlike every later conv pass there is no prior ReLU split to undo.
#define D2D_INPUT_COUNT 1
#include "d2d1effecthelpers.hlsli"

float4 matMulGlsl(float4x4 m, float4 v)
{
    // GLSL's mat4(c0,c1,c2,c3) constructor fills COLUMNS; HLSL's float4x4(r0,r1,r2,r3)
    // constructor fills ROWS. Indexing the HLSL matrix by row therefore yields the same values
    // as GLSL's column indexing, so this reproduces GLSL's `mat4 * vec4` (a column-weighted sum)
    // exactly, with the 16 literals passed in the identical order they appear in the source -
    // deliberately not using HLSL's mul() intrinsic, whose own row/column convention would need
    // re-deriving instead of directly copying the source's literal order.
    return m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3] * v.w;
}

float4 go0(float x_off, float y_off)
{
    return D2DSampleInputAtOffset(0, float2(x_off, y_off));
}

D2D_PS_ENTRY(main)
{
    float4 result = matMulGlsl(float4x4(-0.19288683, -0.21397883, 0.111997396, -0.04791413, -0.26682988, -0.06144587, -0.03601853, -0.16693151, 0.038494494, -0.16651472, 0.147657, -0.083003886, 0.0, 0.0, 0.0, 0.0), go0(-1.0, -1.0));
    result += matMulGlsl(float4x4(-0.14286195, 0.08746566, -0.40107322, 0.12390977, -0.33392772, -0.18703035, -0.21326795, 0.04780781, -0.15155545, -0.0010025925, -0.1554875, -0.10676251, 0.0, 0.0, 0.0, 0.0), go0(-1.0, 0.0));
    result += matMulGlsl(float4x4(0.28095165, 0.022872915, -0.21342312, -0.29982176, 0.025937587, -0.055012174, -0.33779636, 0.0015666655, 0.076416336, 0.06656033, -0.1557806, 0.1078894, 0.0, 0.0, 0.0, 0.0), go0(-1.0, 1.0));
    result += matMulGlsl(float4x4(-0.31584853, 0.07527119, 0.30713862, -0.34014285, -0.50103146, -0.07217874, 0.512807, -0.09597398, -0.32097813, -0.051580857, -0.022466356, 0.01148551, 0.0, 0.0, 0.0, 0.0), go0(0.0, -1.0));
    result += matMulGlsl(float4x4(-0.026032459, -0.04193211, 0.37703893, -0.031916667, -0.27421117, 1.0906446, -0.049654085, -0.19814016, 0.07819544, 0.06003738, 0.1405805, -0.0064135445, 0.0, 0.0, 0.0, 0.0), go0(0.0, 0.0));
    result += matMulGlsl(float4x4(0.041450135, 0.11319654, -0.23237701, 0.08443178, 0.53344345, 0.30857387, -0.057264958, -0.1575803, 0.2325609, -0.027797326, -0.04544767, -0.18720597, 0.0, 0.0, 0.0, 0.0), go0(0.0, 1.0));
    result += matMulGlsl(float4x4(0.2531829, -0.074966915, -0.27800754, -0.3146097, 0.20126024, -0.5380133, -0.15082566, -0.19021043, 0.29951036, 0.17123336, -0.01681872, -0.12574998, 0.0, 0.0, 0.0, 0.0), go0(1.0, -1.0));
    result += matMulGlsl(float4x4(0.25203633, 0.19882993, 0.14906439, 0.13593598, 0.40712556, 0.084902965, 0.42969635, 0.2961132, -0.057267334, -0.030388135, 8.8084314e-05, 0.0210724, 0.0, 0.0, 0.0, 0.0), go0(1.0, 0.0));
    result += matMulGlsl(float4x4(-0.13459359, -0.12199573, 0.12591946, 0.24736497, 0.2033463, -0.09388599, -0.094370656, 0.1071285, -0.18479438, -0.066625565, 0.08279283, 0.20130983, 0.0, 0.0, 0.0, 0.0), go0(1.0, 1.0));
    result += float4(-0.011108127, -0.07481861, 0.07640154, 0.4964964);
    return result;
}
