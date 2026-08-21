using System;
using System.Runtime.InteropServices;
using Microsoft.Graphics.Canvas;
using Vortice.Direct3D11;
using Windows.Graphics.DirectX.Direct3D11;

namespace PrismUwpEffects
{
    /// <summary>
    /// Bridges Win2D's WinRT Direct3D wrappers (<see cref="CanvasDevice"/>,
    /// <see cref="IDirect3DSurface"/> - what <see cref="CanvasRenderTarget"/> implements) into
    /// Vortice's real C# D3D11 bindings, so the AI Upscaling pass graph's raw-draw passes
    /// (<c>AiUpscalePixelEffect.cs</c>) can bind the exact same textures Win2D's
    /// <c>PixelShaderEffect</c>-based passes already render into/from.
    ///
    /// <see cref="IDirect3DSurface"/>'s underlying support for this is already proven on real
    /// hardware, not assumed: <c>AiUpscaleFrameServer.cs</c> already passes a
    /// <c>CanvasRenderTarget</c> directly to <c>MediaPlayer.CopyFrameToVideoSurface</c>, a WinRT
    /// API that requires a real <c>IDirect3DSurface</c> - confirmed working (Stage 1's hardware
    /// checkpoint). This class relies on the same underlying interop surface, just reached
    /// through <c>IDirect3DDxgiInterfaceAccess</c> instead of a WinRT API that already accepts it.
    /// </summary>
    internal static class D3D11Interop
    {
        // Fixed, documented COM interface (windows.graphics.directx.direct3d11.interop.h) that
        // every WinRT Direct3D11 wrapper object (IDirect3DDevice, IDirect3DSurface) implements,
        // used to retrieve the real underlying D3D11 COM pointer. GUID is fixed by that header,
        // not invented here. Deliberately hand-declared rather than pulled from a package: it is
        // a single method with a fixed GUID, unlike the full ID3D11Device/DeviceContext surface
        // Vortice provides - see PrismUwpEffects.csproj's own comment on this split.
        [ComImport]
        [Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IDirect3DDxgiInterfaceAccess
        {
            IntPtr GetInterface(ref Guid iid);
        }

        internal static ID3D11Device GetD3D11Device(CanvasDevice device)
        {
            var access = (IDirect3DDxgiInterfaceAccess)(object)device;
            Guid iid = typeof(ID3D11Device).GUID;
            IntPtr ptr = access.GetInterface(ref iid);
            return new ID3D11Device(ptr);
        }

        internal static ID3D11Texture2D GetD3D11Texture(IDirect3DSurface surface)
        {
            var access = (IDirect3DDxgiInterfaceAccess)(object)surface;
            Guid iid = typeof(ID3D11Texture2D).GUID;
            IntPtr ptr = access.GetInterface(ref iid);
            return new ID3D11Texture2D(ptr);
        }
    }
}
