// Shared vertex shader for every raw-D3D11 pass in the AI Upscaling pipeline (see
// AiUpscalePixelEffect.cs). Generates a single fullscreen triangle purely from SV_VertexID - no
// vertex/index buffer needed, just Draw(3, 0). Standard, well-known D3D11 pattern; the triangle
// overshoots the actual viewport at the edges, which the rasterizer clips away, and uv still
// interpolates correctly to [0,1] across the visible region.
struct VSOutput
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

VSOutput main(uint id : SV_VertexID)
{
    VSOutput o;
    o.uv = float2((id << 1) & 2, id & 2);
    o.position = float4(o.uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
    return o;
}
