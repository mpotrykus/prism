// AMD FidelityFX Super Resolution 1.0.2 - EASU (edge-adaptive spatial upscale), the one FSR1
// pass that changes resolution (Stage 2b) - raw D3D11 for the same reason
// anime4k_depth_to_space.hlsl is (see AiUpscalePixelEffect.cs's header comment). Transcribed
// from src/player/shader/glsl/vendor/fsr1-easu-rcas.glsl's EASU hook() (AMD, MIT), with mpv's
// HOOKED_pos/HOOKED_size/HOOKED_gather machinery replaced by direct Texture2D sampling driven by
// this pass's own fullscreen-quad uv - the same substitution anime4k_depth_to_space.hlsl already
// made for its own mpv-shaped source. Upstream's own defaults are baked in throughout:
// FSR_EASU_SIMPLE_ANALYSIS=0, FSR_EASU_QUIT_EARLY=0, FSR_EASU_DERING=1, FSR_PQ=0 (so
// FSR_EASU_DIR_THRESHOLD is fixed at 32768.0) - matching every other platform's port.
Texture2D lumaTex : register(t0); // native-resolution luma plane, from fsr_luma_extract.hlsl
SamplerState linearSampler : register(s0);

float APrxLoRcpF1(float a) { return asfloat(0x7ef07ebbu - asuint(a)); }
float APrxLoRsqF1(float a) { return asfloat(0x5f347d74u - (asuint(a) >> 1)); }
float AMin3F1(float x, float y, float z) { return min(x, min(y, z)); }
float AMax3F1(float x, float y, float z) { return max(x, max(y, z)); }

// Filtering for a given tap for the scalar (luma-only) case.
void FsrEasuTap(inout float aC, inout float aW, float2 off, float2 dir, float2 len, float lob, float clp, float c)
{
    float2 v;
    v.x = (off.x * dir.x) + (off.y * dir.y);
    v.y = (off.x * -dir.y) + (off.y * dir.x);
    v *= len;
    float d2 = min(v.x * v.x + v.y * v.y, clp);
    float wB = (2.0 / 5.0) * d2 - 1.0;
    float wA = lob * d2 - 1.0;
    wB *= wB;
    wA *= wA;
    wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
    float w = wB * wA;
    aC += c * w;
    aW += w;
}

// Accumulate direction and length - FSR_EASU_SIMPLE_ANALYSIS == 0 branch of the vendored source
// (each call passes exactly one of biS/biT/biU/biV true, matching the four call sites in main()).
void FsrEasuSet(inout float2 dir, inout float len, float2 pp, bool biS, bool biT, bool biU, bool biV,
                float lA, float lB, float lC, float lD, float lE)
{
    float w = 0.0;
    if (biS) w = (1.0 - pp.x) * (1.0 - pp.y);
    if (biT) w =        pp.x  * (1.0 - pp.y);
    if (biU) w = (1.0 - pp.x) *        pp.y;
    if (biV) w =        pp.x  *        pp.y;

    float dc = lD - lC;
    float cb = lC - lB;
    float lenX = max(abs(dc), abs(cb));
    lenX = APrxLoRcpF1(lenX);
    float dirX = lD - lB;
    lenX = saturate(abs(dirX) * lenX);
    lenX *= lenX;

    float ec = lE - lC;
    float ca = lC - lA;
    float lenY = max(abs(ec), abs(ca));
    lenY = APrxLoRcpF1(lenY);
    float dirY = lE - lA;
    lenY = saturate(abs(dirY) * lenY);
    lenY *= lenY;

    dir += float2(dirX, dirY) * w;
    len += dot(float2(w, w), float2(lenX, lenY));
}

float4 main(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target
{
    uint texW, texH;
    lumaTex.GetDimensions(texW, texH);
    float2 size = float2(texW, texH);
    float2 pt = 1.0 / size;

    // Position of 'F' (see the vendored source's own ASCII-art diagram of the 12-tap kernel).
    float2 pp = uv * size - 0.5;
    float2 fp = floor(pp);
    pp -= fp;

    // Exact texel-center sampling via a linear sampler - same trick anime4k_depth_to_space.hlsl
    // already relies on (see that file's own note): the computed UV lands exactly on a texel
    // center, so linear filtering degenerates to a point sample.
    float b = lumaTex.Sample(linearSampler, (fp + float2( 0.5, -0.5)) * pt).r;
    float c = lumaTex.Sample(linearSampler, (fp + float2( 1.5, -0.5)) * pt).r;
    float e = lumaTex.Sample(linearSampler, (fp + float2(-0.5,  0.5)) * pt).r;
    float f = lumaTex.Sample(linearSampler, (fp + float2( 0.5,  0.5)) * pt).r;
    float g = lumaTex.Sample(linearSampler, (fp + float2( 1.5,  0.5)) * pt).r;
    float h = lumaTex.Sample(linearSampler, (fp + float2( 2.5,  0.5)) * pt).r;
    float i = lumaTex.Sample(linearSampler, (fp + float2(-0.5,  1.5)) * pt).r;
    float j = lumaTex.Sample(linearSampler, (fp + float2( 0.5,  1.5)) * pt).r;
    float k = lumaTex.Sample(linearSampler, (fp + float2( 1.5,  1.5)) * pt).r;
    float l = lumaTex.Sample(linearSampler, (fp + float2( 2.5,  1.5)) * pt).r;
    float n = lumaTex.Sample(linearSampler, (fp + float2( 0.5,  2.5)) * pt).r;
    float o = lumaTex.Sample(linearSampler, (fp + float2( 1.5,  2.5)) * pt).r;

    float2 dir = float2(0.0, 0.0);
    float len = 0.0;
    FsrEasuSet(dir, len, pp, true,  false, false, false, b, e, f, g, j);
    FsrEasuSet(dir, len, pp, false, true,  false, false, c, f, g, h, k);
    FsrEasuSet(dir, len, pp, false, false, true,  false, f, i, j, k, n);
    FsrEasuSet(dir, len, pp, false, false, false, true,  g, j, k, l, o);

    float2 dir2 = dir * dir;
    float dirR = dir2.x + dir2.y;
    bool zro = dirR < (1.0 / 32768.0);
    dirR = APrxLoRsqF1(dirR);
    dirR = zro ? 1.0 : dirR;
    dir.x = zro ? 1.0 : dir.x;
    dir *= dirR;

    len = len * 0.5;
    len *= len;
    float stretch = (dir.x * dir.x + dir.y * dir.y) * APrxLoRcpF1(max(abs(dir.x), abs(dir.y)));
    float2 len2 = float2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
    float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
    float clp = APrxLoRcpF1(lob);

    float aC = 0.0;
    float aW = 0.0;
    FsrEasuTap(aC, aW, float2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);
    FsrEasuTap(aC, aW, float2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);
    FsrEasuTap(aC, aW, float2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);
    FsrEasuTap(aC, aW, float2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);
    FsrEasuTap(aC, aW, float2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);
    FsrEasuTap(aC, aW, float2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);
    FsrEasuTap(aC, aW, float2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);
    FsrEasuTap(aC, aW, float2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);
    FsrEasuTap(aC, aW, float2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);
    FsrEasuTap(aC, aW, float2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);
    FsrEasuTap(aC, aW, float2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);
    FsrEasuTap(aC, aW, float2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);

    float result = aC / aW;
    // Dering (FSR_EASU_DERING == 1 in the vendored source, upstream's default).
    float min1 = min(AMin3F1(f, g, j), k);
    float max1 = max(AMax3F1(f, g, j), k);
    result = clamp(result, min1, max1);
    result = saturate(result);

    return float4(result, result, result, 1.0);
}
