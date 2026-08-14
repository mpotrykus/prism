# Moonlight-Xbox DX11/HDR Architecture — Research Report

Repo: `C:\Users\mpotr\source\repos\moonlight-xbox` (UWP, C++/CX, game-streaming client for Xbox)

## 1. D3D11 Device & Swapchain Setup

**Device creation**: `Common\DeviceResources.cpp`, `CreateDeviceResources()` (lines 93–196).
- `D3D11CreateDevice` with `D3D_DRIVER_TYPE_HARDWARE`, flag `D3D11_CREATE_DEVICE_BGRA_SUPPORT` (+ `D3D11_CREATE_DEVICE_DEBUG` in debug builds) — line 152.
- Feature levels requested 12_1 down to 9_1 (lines 135–146), falls back to `D3D_DRIVER_TYPE_WARP` on failure (lines 172–186).
- Device/context stored as `ID3D11Device3`/`ID3D11DeviceContext3` via `.As<>()` (lines 189–195). Header (`DeviceResources.h` lines 57–58, 81–83) also holds `IDXGISwapChain4` and `IDXGIOutput`.

**Swapchain**: created in `CreateWindowSizeDependentResources()` (lines 199–347).
- Built as `DXGI_SWAP_CHAIN_DESC1` via `IDXGIFactory4::CreateSwapChainForComposition` → returns `IDXGISwapChain1`, immediately QI'd up to `IDXGISwapChain4` (`swapChain.As<IDXGISwapChain4>(&m_swapChain)`, line 296) — this is a composition swapchain (XAML `SwapChainPanel` interop via `ISwapChainPanelNative::SetSwapChain`, lines 300–312), not a classic HWND swapchain.
- `SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD`, `BufferCount = 5` (comment cites moonlight-qt's `d3d11va.cpp` for the buffer-count rationale, line 255–256), `AlphaMode = DXGI_ALPHA_MODE_IGNORE`, `Scaling = DXGI_SCALING_STRETCH`, `Flags = 0`.
- **Pixel format**: single format used for both SDR and HDR — `DXGI_FORMAT_R10G10B10A2_UNORM`, set as `m_backBufferFormat` in the constructor initializer list with comment `// 10-bit for HDR` (`DeviceResources.cpp` line 62). **There is no separate HDR vs SDR swapchain/format path** — the swapchain is always created 10-bit; HDR vs SDR is switched purely via `IDXGISwapChain4::SetColorSpace1` (see §2) plus a display-mode change, not by recreating the swapchain with a different buffer format.
- Render target view created via `CreateRenderTargetView1` on an `ID3D11Texture2D1` backbuffer (lines 325–336); accessor type is `ID3D11RenderTargetView1`.

## 2. HDR10 Output Setup

Two independent layers: (a) telling the **Xbox console's HDMI output** to switch to HDR, and (b) telling **DXGI** to tag the swapchain's color space to match.

**(a) Display-level HDR switch** — `State\MoonlightClient.cpp`, `MoonlightClient::SetDisplayHDR()` (lines 62–173). Uses UWP's `Windows.Graphics.Display.Core.HdmiDisplayInformation` API, not `IDXGIOutput6`/`CheckColorSpaceSupport`/`DXGI_OUTPUT_DESC1` (none of these DXGI display-capability APIs appear anywhere in the render/HDR code — capability is entirely queried through the UWP Xbox-console API instead).
- `HdmiDisplayInformation::GetForCurrentView()->GetCurrentDisplayMode()` → `HdmiDisplayMode` has `IsSmpte2084Supported` (bool) used as the HDR-capability/HDR-active flag (lines 69, 72, 89, 118, 161, 184).
- Enumerates `hdmi->GetSupportedDisplayModes()` to find a mode matching the current resolution/refresh rate but with the opposite `IsSmpte2084Supported` value (lines 116–126) — i.e., HDR toggling on Xbox is implemented as picking a *different supported display mode*, not just flipping a flag.
- Builds a `HdmiDisplayHdr2086Metadata` struct (lines 95–107) from Moonlight/Sunshine's own `SS_HDR_METADATA` (fields: `RedPrimaryX/Y`, `GreenPrimaryX/Y`, `BluePrimaryX/Y`, `WhitePointX/Y`, `MaxMasteringLuminance`, `MinMasteringLuminance`, `MaxContentLightLevel`, `MaxFrameAverageLightLevel`) — pulled via `LiGetHdrMetadata()` in `VideoRenderer::SetHDR()` (`Streaming\VideoRenderer.cpp` lines 666–683).
- Applies the mode change asynchronously: `hdmi->RequestSetCurrentDisplayModeAsync(newMode, hdrOption, hdrMetadata)` where `hdrOption` is `HdmiDisplayHdrOption::Eotf2084` (HDR on) or `::None` (SDR) — lines 139–152.
- Verifies the actual resulting mode afterward since the API can "lie" about success (comment at line 157: `// XXX sometimes this lies and the TV is in another mode :(`).
- Also checks `ResolutionWidthInRawPixels < 3840` and warns HDR may be unavailable off native 4K (lines 88–92, commented-out early return).
- `MoonlightClient::MoonlightClient()` constructor (lines 177–192) initializes `m_isHDR`/`m_isRGBFull` by reading the current mode at startup, noting `HdmiDisplayColorSpace::RgbFull` corresponds to Xbox's "PC RGB" SDR video-fidelity setting.
- Entry point: `VideoRenderer::SetHDR(bool enabled)` (h: `VideoRenderer.h` line 47) is invoked from `moonlight_xbox_dxMain`'s `client->SetHDR` lambda (`moonlight_xbox_dxMain.cpp` lines 150–158), gated on waiting for the renderer to finish loading first.

**(b) DXGI color-space tagging** — `Streaming\VideoRenderer.cpp`, inside `VideoRenderer::Render()` (lines 161–182), triggered per-frame whenever the decoded frame's `AVColorTransferCharacteristic` (`frame->color_trc`) changes:
```cpp
if (frame->color_trc == AVCOL_TRC_SMPTE2084) {
    colorspace = DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;  // Rec.2020 PQ / HDR10
} else {
    colorspace = DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709;      // sRGB/Rec.709 SDR
}
UINT colorSpaceSupport = 0;
if (colorspace && SUCCEEDED(m_deviceResources->GetSwapChain()->CheckColorSpaceSupport(colorspace, &colorSpaceSupport))
    && (colorSpaceSupport & DXGI_SWAP_CHAIN_COLOR_SPACE_SUPPORT_FLAG_PRESENT)) {
    DX::ThrowIfFailed(m_deviceResources->GetSwapChain()->SetColorSpace1(colorspace));
}
```
This is the only place `IDXGISwapChain4::CheckColorSpaceSupport`/`SetColorSpace1` are used — it is content-driven (based on the actual stream's transfer characteristic), decoupled from the display-mode switch in (a).

**No tone-mapping shader present.** No pixel shader in the repo does PQ/EOTF tone-mapping or HDR→SDR conversion — the YUV→RGB pixel shader (`d3d11_yuv420_pixel.hlsl`, see §5) does color-space (YUV) conversion only, not luminance/tone-mapping; HDR pass-through relies entirely on the display accepting Rec.2020 PQ content directly (host encodes HDR10, decoder passes P010, DXGI/display present it untouched).

`DXGI_HDR_METADATA_HDR10` appears as a stored/declared type (`VideoRenderer.h` line 77, `m_lastHdr10`) but is zero-initialized in the constructor (`VideoRenderer.cpp` line 62) and not otherwise populated/used in the reviewed code — no call to `IDXGISwapChain4::SetHDRMetaData` was found anywhere in the repo (grep for `SetHDRMetaData` returned no hits in first-party code). HDR metadata delivery to the display goes exclusively through the UWP `HdmiDisplayHdr2086Metadata`/`RequestSetCurrentDisplayModeAsync` path in (a), not through DXGI's own HDR-metadata API.

## 3. Video Decode → Texture Pipeline

**Decoder**: `Streaming\FFmpegDecoder.cpp` (`FFMpegDecoder` class), FFmpeg/libavcodec with D3D11VA hardware acceleration — not raw DXVA2/Media Foundation.
- `FFMpegDecoder::Init()` (lines 95–179): picks `AV_CODEC_ID_H264` or `AV_CODEC_ID_HEVC` based on `VIDEO_FORMAT_MASK_H264`/`_H265` (lines 115–122).
- Allocates a D3D11VA hw device context bound to the app's own `ID3D11Device`/`ID3D11DeviceContext` (lines 136–143): `av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA)`, `AVD3D11VADeviceContext::device`/`device_context` set to `m_deviceResources->GetD3DDevice()`/`GetD3DDeviceContext()`, with `lock`/`unlock` callbacks (`lock_context`/`unlock_context`, lines 62–70) so ffmpeg and the render thread share the same D3D context safely.
- `decoder_ctx->pix_fmt = AV_PIX_FMT_D3D11` (hardware-surface output) and `decoder_ctx->sw_pix_fmt` is `AV_PIX_FMT_P010` for 10-bit/HDR streams or `AV_PIX_FMT_NV12` for 8-bit (line 154) — this is the NV12/P010 shared-texture path.
- **Decode**: `FFMpegDecoder::SubmitDecodeUnit()` (lines 218–323) receives Moonlight RTP decode units, copies them into a growable buffer, wraps in an `AVPacket`, calls `avcodec_send_packet`/`avcodec_receive_frame` in a loop (lines 264–304). Decoded frames are handed to `Pacer::instance().submitFrame(frame)` (line 300) rather than rendered directly — decode and present are decoupled via a frame queue (see §4).
- **Frame → GPU texture**: In `VideoRenderer::Render()` (`Streaming\VideoRenderer.cpp` lines 95–185), `frame->data[0]` is reinterpreted directly as `ID3D11Texture2D*` (the D3D11VA hw surface) and `frame->data[1]` (cast to int) is the array-slice index — no CPU copy of pixel data. The frame's array-slice subresource is copied into the renderer's own single-subresource `m_VideoTexture` via `ID3D11DeviceContext3::CopySubresourceRegion1(..., D3D11_COPY_DISCARD)` (lines 128–130) — this normalizes format/reuses one texture regardless of which array slice in ffmpeg's texture pool the frame landed on.
- `setupVideoTexture()` (lines 333–376) creates the destination `ID3D11Texture2D` (bind flag `D3D11_BIND_SHADER_RESOURCE` only) matching the frame's format (NV12 or P010), and creates two `ID3D11ShaderResourceView`s per plane: for P010 → `DXGI_FORMAT_R16_UNORM` (luma) + `DXGI_FORMAT_R16G16_UNORM` (chroma); for 8-bit NV12 → `DXGI_FORMAT_R8_UNORM` + `DXGI_FORMAT_R8G8_UNORM` (`getVideoTextureSRVFormats()`, lines 83–91).
- **YUV→RGB conversion is a pixel shader**, not a `VideoProcessor`/`IDXGIOutput`/software `swscale` conversion — see `bindColorConversion()` (lines 617–664), which builds a per-format `CSC_CONST_BUF` constant buffer (Rec.601/709/2020 matrices premultiplied by range scale, chroma-siting offsets, chroma UV clamp) and `d3d11_yuv420_pixel.hlsl` samples both SRVs and does the matrix multiply on the GPU (§5).

## 4. Present/Render Loop Structure

**Threads** (documented in `Streaming\Pacer.cpp` header comment, lines 15–33):
1. **Decoder thread** (driven by moonlight-common-c via `CAPABILITY_DIRECT_SUBMIT`) — calls `FFMpegDecoder::SubmitDecodeUnit` → `Pacer::submitFrame()` → enqueues into `FrameQueue` (high-water mark 3, `FRAME_QUEUE_HIGH`, `Pacer.cpp` line 36/103).
2. **vsyncHardware thread** (`Pacer::vsyncHardware()`, lines 121–138) — background thread that calls `IDXGIOutput::WaitForVBlank()` in a loop and calls `updateFrameStats()`, which reads `IDXGISwapChain4::GetFrameStatistics()` (`DXGI_FRAME_STATISTICS`) to derive a precise vsync interval/drift via an EWMA (lines 141–215).
3. **Main render thread** — `moonlight_xbox_dxMain::StartRenderLoop()` (`Streaming\moonlight_xbox_dxMain.cpp` lines 235–349), run via `ThreadPool::RunAsync(..., WorkItemPriority::High, WorkItemOptions::TimeSliced)`, thread priority raised to `THREAD_PRIORITY_ABOVE_NORMAL` (line 243).
   - Per iteration: `Pacer::instance().getNextVBlankQpc(&t0)` computes the present deadline (handles Xbox 120 Hz needing half-vblank presents when stream is 120fps, `Pacer.cpp` lines 413–421); `Pacer::waitForFrame(maxWaitMs)` blocks on the frame queue; `Update()` ticks the scene; `Pacer::renderOnMainThread(sceneRenderer)` dequeues/renders (`Pacer.cpp` lines 228–340, two modes: `renderModeImmediate` vs `renderModeDisplayLocked`, selectable via `m_FramePacingImmediate`); `Pacer::waitBeforePresent(deadline)` sleeps until the vblank target; then `m_deviceResources->Present()` is called under the same lock (`FFMpegDecoder::Lock()`) used by the decoder, since ffmpeg and rendering share one D3D11 context (`moonlight_xbox_dxMain.cpp` lines 271–294).
   - A **separate input thread** polls gamepad state at 500 Hz (lines 353–376).
4. **Actual render call**: `VideoRenderer::Render(AVFrame*)` (§3) does the draw (`ctx->DrawIndexed(6, 0, 0)`, a single textured quad) plus the color-space check/`SetColorSpace1` call (§2b). `moonlight_xbox_dxMain::Render()` (lines 710–744) wraps this with ImGui overlay rendering and returns whether a new frame was presented.
5. **Present call**: `DX::DeviceResources::Present()` (`Common\DeviceResources.cpp` lines 527–551) — `m_swapChain->Present(0, 0)` (sync interval **0**, i.e. the app does its own vblank-aligned pacing via `Pacer` rather than relying on DXGI's built-in sync-interval throttling; `DXGI_ERROR_DEVICE_REMOVED`/`_RESET`/`_INVALID_CALL` trigger `HandleDeviceLost()`).

## 5. Shaders

Only two first-party HLSL files (pre-PR#267; see the NIS doc for the never-merged upscaling addition):
- `Assets\Shader\d3d11_vertex.hlsl` — trivial passthrough vertex shader; takes `POSITION`/`TEXCOORD0`, outputs `SV_POSITION`/`TEXCOORD0` unmodified (full-screen/quad transform is pre-baked into vertex data by `VideoRenderer::setupVertexBuffer`, not done in the shader).
- `Assets\Shader\d3d11_yuv420_pixel.hlsl` — NV12/P010 → RGB color-space-conversion pixel shader. Samples `Texture2D<min16float> luminancePlane : t0` and `Texture2D<min16float2> chrominancePlane : t1`, applies chroma-offset/clamp, subtracts range `offsets`, and multiplies by a `min16float3x3 cscMatrix` constant buffer (`CSC_CONST_BUF` at `b0`) built per-frame in `VideoRenderer::bindColorConversion()`. This is the sole color-conversion shader; it performs Rec.601/709/2020 YUV→RGB conversion but does **not** do PQ tone-mapping — HDR PQ content is passed through as-is (linear YUV→RGB matrix only), relying on the display/DXGI color-space tag for correct PQ interpretation.

Compiled shader bytecode is loaded from `Assets\Shader\d3d11_vertex.fxc` / `d3d11_yuv420_pixel.fxc` (`VideoRenderer::CreateDeviceDependentResources()`, lines 192–231).

## Findings relevant beyond the numbered sections

Confirmed **not present** anywhere in first-party moonlight-xbox code (checked explicitly, not just unmentioned): `IDXGIOutput6`, `DXGI_OUTPUT_DESC1`, `GetDesc1` on outputs, `SetHDRMetaData`, and Media Foundation/DXVA2 APIs (`IMFDXGIDeviceManager`, `MFCreateDXGIDeviceManager`) — decode uses ffmpeg/D3D11VA exclusively, and HDR display-capability detection uses the UWP `HdmiDisplayInformation` API rather than DXGI's own output/color-space capability surface. Worth confirming whether Prism's native Xbox player should follow this same "ffmpeg + D3D11VA" decode strategy or use Media Foundation instead — this reference only demonstrates the ffmpeg path.
