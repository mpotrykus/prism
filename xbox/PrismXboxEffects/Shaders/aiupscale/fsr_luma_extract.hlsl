// FSR1 luma sub-pipeline, pass 1 of 3 (Stage 2b). Ported from
// src/player/shader/glsl/luma-extract.frag.glsl - see that file's own header comment for why
// pulling a single-channel luma plane out of RGB is required (FSR's vendored EASU/RCAS source
// hooks LUMA and reads/writes only .r) rather than an optimization.
#define D2D_INPUT_COUNT 1
#include "d2d1effecthelpers.hlsli"

D2D_PS_ENTRY(main)
{
    float3 rgb = D2DGetInput(0).rgb;
    // BT.709 - must match fsr_luma_merge.hlsl's own copy exactly, see that file's note.
    float y = dot(rgb, float3(0.2126, 0.7152, 0.0722));
    return float4(y, y, y, 1.0);
}
