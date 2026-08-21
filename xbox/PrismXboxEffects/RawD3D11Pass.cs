using System;
using Microsoft.Graphics.Canvas;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.Mathematics;

namespace PrismXboxEffects
{
    /// <summary>
    /// One raw-D3D11 draw (a fullscreen triangle, 1-2 SRV inputs, 1 RTV output) against Win2D
    /// <see cref="CanvasRenderTarget"/>s shared with the rest of the AI Upscaling pass graph - see
    /// AiUpscalePixelEffect.cs's own header comment for why depth-to-space (and FSR1's later
    /// EASU/luma-merge) need this instead of a Win2D <c>PixelShaderEffect</c>. No vertex/index
    /// buffer: <c>fullscreen_quad_vs.hlsl</c> generates its 3 vertices purely from
    /// <c>SV_VertexID</c>, so this only ever issues <c>Draw(3, 0)</c>.
    /// </summary>
    internal sealed class RawD3D11Pass : IDisposable
    {
        private readonly ID3D11Device device;
        private readonly ID3D11DeviceContext context;
        private readonly ID3D11VertexShader vertexShader;
        private readonly ID3D11PixelShader pixelShader;
        private readonly ID3D11SamplerState sampler;
        private readonly ID3D11Buffer constantBuffer;

        internal RawD3D11Pass(ID3D11Device device, ID3D11VertexShader sharedVertexShader, byte[] pixelShaderBytecode, int constantFloatCount = 0)
        {
            this.device = device;
            context = device.ImmediateContext;
            vertexShader = sharedVertexShader;
            pixelShader = device.CreatePixelShader(pixelShaderBytecode);
            sampler = device.CreateSamplerState(new SamplerDescription
            {
                Filter = Filter.MinMagMipLinear,
                AddressU = TextureAddressMode.Clamp,
                AddressV = TextureAddressMode.Clamp,
                AddressW = TextureAddressMode.Clamp,
                ComparisonFunc = ComparisonFunction.Never,
                MaxLOD = float.MaxValue,
            });
            if (constantFloatCount > 0)
            {
                // Constant buffers must be a multiple of 16 bytes (4 floats) - round up rather
                // than require every caller to pad its own float[] to that boundary. Default
                // usage + UpdateSubresource (not Dynamic + Map) - this only needs updating once
                // per frame, at most a few floats, so the extra ceremony Dynamic buffers exist
                // for buys nothing here.
                int byteWidth = ((constantFloatCount * sizeof(float)) + 15) / 16 * 16;
                constantBuffer = device.CreateBuffer(byteWidth, BindFlags.ConstantBuffer);
            }
        }

        internal void Draw(CanvasRenderTarget output, params CanvasRenderTarget[] inputs) => Draw(output, null, inputs);

        /// <summary>
        /// <paramref name="constants"/>, if non-null, is uploaded to register(b0) - the pass must
        /// have been constructed with a matching <c>constantFloatCount</c> for this to have any
        /// effect. Pass null (the other overload) for a pass with no cbuffer at all.
        /// </summary>
        internal void Draw(CanvasRenderTarget output, float[] constants, params CanvasRenderTarget[] inputs)
        {
            // Classic using-block syntax, not C# 8's using-declaration - this project has no
            // explicit LangVersion set, which defaults to a C# version that predates them (same
            // note NativePlayerHost.cs's own SetStretch already carries for switch expressions).
            using (ID3D11Texture2D outputTexture = D3D11Interop.GetD3D11Texture(output))
            using (ID3D11RenderTargetView rtv = device.CreateRenderTargetView(outputTexture))
            {
                var textures = new ID3D11Texture2D[inputs.Length];
                var srvs = new ID3D11ShaderResourceView[inputs.Length];
                try
                {
                    for (int i = 0; i < inputs.Length; i++)
                    {
                        textures[i] = D3D11Interop.GetD3D11Texture(inputs[i]);
                        srvs[i] = device.CreateShaderResourceView(textures[i]);
                    }

                    if (constantBuffer != null && constants != null)
                    {
                        context.UpdateSubresource(constants, constantBuffer);
                        context.PSSetConstantBuffer(0, constantBuffer);
                    }

                    context.OMSetRenderTargets(rtv);
                    context.RSSetViewport(new Viewport(0, 0, output.SizeInPixels.Width, output.SizeInPixels.Height));
                    context.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
                    context.VSSetShader(vertexShader);
                    context.PSSetShader(pixelShader);
                    context.PSSetShaderResources(0, srvs);
                    context.PSSetSamplers(0, new[] { sampler });
                    context.Draw(3, 0);

                    // Explicit unbind - a resource still bound as an SRV can't later be written to
                    // as an RTV without D3D11 forcing it to null anyway, same "hazard tracking"
                    // note the NIS compute-shader integration doc
                    // (docs/xbox-native-hdr-player/02-*.md) flags for UAV/SRV binding around a
                    // dispatch; the same reasoning applies here.
                    context.PSSetShaderResources(0, new ID3D11ShaderResourceView[inputs.Length]);
                    context.OMSetRenderTargets((ID3D11RenderTargetView)null);
                    if (constantBuffer != null && constants != null)
                    {
                        context.PSUnsetConstantBuffer(0);
                    }
                }
                finally
                {
                    foreach (ID3D11ShaderResourceView srv in srvs) srv?.Dispose();
                    foreach (ID3D11Texture2D tex in textures) tex?.Dispose();
                }
            }
        }

        public void Dispose()
        {
            pixelShader?.Dispose();
            sampler?.Dispose();
            constantBuffer?.Dispose();
        }
    }
}
