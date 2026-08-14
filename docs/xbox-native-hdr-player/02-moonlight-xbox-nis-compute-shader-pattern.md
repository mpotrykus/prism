# moonlight-xbox PR #267 (NVIDIA Image Scaling / Video Super Resolution) — Compute Shader Integration Pattern

**Not a feature to port** — Prism doesn't need upscaling. This is documented purely as a worked example of "how to wire a DX11 compute shader into moonlight-xbox's exact render pipeline," in case a future compute-shader-based HDR tone-mapping pass needs the same mechanics (resource binding, hazard tracking, dispatch sizing).

**Important correction**: PR #267 is **not merged** into moonlight-xbox. `gh pr view 267` shows `state: CLOSED`, `mergedAt: null`. It exists only on a fork (`linckosz/moonlight-xbox`, branch `master`) and was fetched directly from GitHub to produce this report — none of these files exist in the local `moonlight-xbox` checkout. The maintainer's objection was product-level (Xbox streams are usually already native-res over stable LAN; upscaling mainly helps bandwidth-constrained cases) — not a technical defect, so the pattern below is still sound as a reference.

## 1. Files touched

- **Added**: `Streaming/VideoUpscaler.cpp` (188 lines), `Streaming/VideoUpscaler.h` (56 lines), `Assets/Shader/build_nis.bat`, four precompiled shader blobs `Assets/Shader/nis_{sdr,hdr}_{fp16,fp32}.cso`, submodule pointer `third_party/NVIDIAImageScaling` (→ `https://github.com/NVIDIAGameWorks/NVIDIAImageScaling.git`)
- **Modified**: `Streaming/VideoRenderer.cpp`/`.h` (main integration), `.gitmodules`, `moonlight-xbox-dx.vcxproj`/`.filters`, `State/MoonlightHost.h`, `State/StreamConfiguration.h`, `State/ApplicationState.cpp` (persist `video_super_resolution` setting), `State/Stats.cpp`/`.h`, `Streaming/StatsRenderer.cpp` (scale-ratio overlay), `Pages/AppPage.xaml.cpp`, `Pages/HostSettingsPage.xaml` (checkbox UI)

9 commits by `linckosz`/Bruno Martin (2026-04-22–23): the bulk add, then fixups guarding null configs, removing an unused method, **precompiling shaders to `.cso`**, fixing the build script's working directory, and releasing VSR resources on device teardown.

## 2. Compute shader setup mechanics

**Precompiled `.cso`, not runtime `D3DCompile`.** `Assets/Shader/build_nis.bat` runs `fxc /T cs_5_0 /E main /O3` offline against `third_party/NVIDIAImageScaling/NIS/NIS_Main.hlsl`, producing 4 variants via preprocessor defines:
```
fxc /T cs_5_0 /E main /O3 /D NIS_SCALER=1 /D NIS_HDR_MODE=0 /D NIS_BLOCK_WIDTH=32 /D NIS_BLOCK_HEIGHT=32 /D NIS_THREAD_GROUP_SIZE=128 /D NIS_USE_HALF_PRECISION=1 /Fo "nis_sdr_fp16.cso" "%HLSL%"
```
(HDR variant uses `NIS_HDR_MODE=2`; fp32 variants use `NIS_BLOCK_HEIGHT=24` and `NIS_USE_HALF_PRECISION=0`.) At runtime, `VideoUpscaler::Initialize` loads the matching blob with `DX::ReadData(shaderPath.c_str())` and calls `device->CreateComputeShader(shaderBlob.data(), shaderBlob.size(), nullptr, m_nisShader.ReleaseAndGetAddressOf())`.

**FP16 capability check** drives which variant loads:
```cpp
D3D11_FEATURE_DATA_SHADER_MIN_PRECISION_SUPPORT featureSupport = {};
device->CheckFeatureSupport(D3D11_FEATURE_SHADER_MIN_PRECISION_SUPPORT, &featureSupport, sizeof(featureSupport));
bool supportsFP16 = (featureSupport.AllOtherShaderStagesMinPrecision & D3D11_SHADER_MIN_PRECISION_16_BIT) != 0;
```

**UAV/SRV creation**: output texture created once with both bind flags — `D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS` — then a SRV and UAV are each created against the same `ID3D11Texture2D`.

**Dispatch sizing** (`VideoUpscaler::Initialize`, tail):
```cpp
m_dispatchX = static_cast<UINT>(std::ceil(m_outWidth / float(blockWidth)));
m_dispatchY = static_cast<UINT>(std::ceil(m_outHeight / float(blockHeight)));
```
where `blockWidth = 32` always, and `blockHeight = supportsFP16 ? 32 : 24` — matching the `.hlsl` block dims baked into the chosen `.cso` variant. Call site: `ctx->Dispatch(m_dispatchX, m_dispatchY, 1)` in `ProcessFrame`, `Streaming/VideoUpscaler.cpp`.

## 3. Resource handoff

Three-stage pipeline inside `VideoRenderer::Render`:

1. **Decode texture → intermediate RGB texture**: when `configuration->videoSuperResolution` is set, on format/size change the renderer allocates `m_intermediateTex`/`m_intermediateRTV`/`m_intermediateSRV` sized to the *native stream resolution* (`D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE`). The existing YUV→RGB pixel-shader pass is redirected to render into `m_intermediateRTV` instead of the backbuffer (viewport also resized to stream dims), and the vertex output rect is forced to full NDC (`-1,-1,2,2`) rather than the on-screen aspect-fit rect.
2. **Intermediate SRV → compute shader → UAV output**: the render target is explicitly unbound before invoking the compute pass — `ctx->OMSetRenderTargets(1, nullRTV, nullptr)` — with a comment explaining this is needed "so we can use its SRV in the Compute Shader without D3D11 Hazard Tracking forcing it to NULL". Then `VideoUpscaler::ProcessFrame(m_intermediateSRV.Get())` binds `{ inputSRV, m_coefScaleSRV, m_coefUsmSRV }` to `t0..t2` via `CSSetShaderResources(0, 3, srvs)`, binds `m_finalOutputUAV` to `u0`, dispatches, then explicitly nulls both the UAV and the 3 SRVs afterward — mandatory, since a bound UAV blocks that same resource from later being read as SRV, and the D3D11 debug layer will warn on leaked CS bindings across draw calls.
3. **UAV output SRV → backbuffer**: rather than a further pixel-shader blit, the code retrieves the underlying `ID3D11Texture2D` from the returned SRV (`finalSRV->GetResource(...)` + `As<ID3D11Texture2D>()`) and does a **direct GPU copy**: `ctx->CopySubresourceRegion(backBufferRes.Get(), 0, fsrDst.x, fsrDst.y, 0, upscaledTex.Get(), 0, nullptr)`, where `fsrDst` is the aspect-ratio-preserving destination rect (computed via the existing `scaleSourceToDestinationSurface` helper) — this both scales-to-fit and letterboxes/pillarboxes by offsetting the copy destination.

## 4. Constant buffer setup

**Per-resize, not per-frame.** The NIS constant buffer (`m_nisCB`) is built once inside `Initialize` (called only from the `hasFrameFormatChanged` branch, i.e. on resolution/format change, not every frame):
```cpp
NISConfig config = {};
float sharpness = 0.25f;
NISHDRMode hdrMode = isHDR ? NISHDRMode::PQ : NISHDRMode::None;
NVScalerUpdateConfig(config, sharpness, 0, 0, inWidth, inHeight, inWidth, inHeight,
                      0, 0, outWidth, outHeight, outWidth, outHeight, hdrMode);
CreateConstantBuffer(&config, sizeof(config), m_nisCB.ReleaseAndGetAddressOf());
```
`NVScalerUpdateConfig`/`NISConfig`/`NISHDRMode` come from NVIDIA's own `NIS_Config.h` (in the `third_party/NVIDIAImageScaling` submodule) and fill in the input/output rects, sharpness (hardcoded `0.25f`, not user-exposed), and HDR mode enum.

`CreateConstantBuffer` uses **`D3D11_USAGE_IMMUTABLE`** with initial data supplied at creation (`D3D11_SUBRESOURCE_DATA`), not `Map`/`Unmap` or `UpdateSubresource` — because the buffer's contents never change between `Initialize` calls, only get fully recreated (`Cleanup()` + re-`Initialize()`) on resize. Byte width is 16-byte aligned: `desc.ByteWidth = (size + 15) & ~15`. The two coefficient LUT textures (`m_coefScaleTex`/`m_coefUsmTex`, NIS's precomputed scale/sharpen filter kernels) are likewise created once via `CreateCoefTexture` with `D3D11_USAGE_DEFAULT` and static `pSysMem` data, not updated per frame.

## 5. Lessons / gotchas noted in the PR

- **Thread-group/block-size alignment must match between compile-time HLSL defines and CPU-side dispatch math**: `build_nis.bat`'s `NIS_BLOCK_WIDTH/HEIGHT` per `.cso` variant (32×32 for fp16, 32×24 for fp32) must exactly match `VideoUpscaler::Initialize`'s `blockWidth`/`blockHeight` used to compute `m_dispatchX`/`m_dispatchY` — get this out of sync and dispatch under/overshoots the output texture.
- **FP16 capability gating**: `D3D11_FEATURE_SHADER_MIN_PRECISION_SUPPORT` must be queried per-device before picking a `.cso` variant; the two precision paths use different coefficient texture formats too (`DXGI_FORMAT_R16G16B16A16_FLOAT` vs `DXGI_FORMAT_R32G32B32A32_FLOAT`), so a format mismatch between the chosen shader and coefficient textures is a real failure mode the code guards against explicitly.
- **UAV/SRV hazard tracking**: the explicit `OMSetRenderTargets(1, nullRTV, ...)` before dispatch, and explicit null-binding of UAV/SRVs after dispatch, are called out in code comments as required to avoid D3D11 silently forcing resources to NULL when the same resource is bound as both an active render target and a shader-visible resource.
- **Resource creation failure handling** was hardened across 2 separate fixup commits — every `CreateTexture2D`/`CreateShaderResourceView`/`CreateUnorderedAccessView`/`CreateComputeShader` call has its `HRESULT` checked, and on any failure `m_upscaler.reset()` disables the whole feature gracefully rather than crashing.
- **Precompiling shaders was a deliberate late change** ("Precompile the NIS shader to .cso files") — implies an earlier iteration compiled at runtime/build-time differently before settling on shipping `.cso` blobs directly as project assets.
- **Product-level gotcha (not technical)**: the maintainer's core objection was that Xbox streams are usually already native-resolution over a stable LAN, so VSR's main value is bandwidth-constrained scenarios — worth keeping in mind if reusing this pattern for HDR tone-mapping, since that pass would run unconditionally on every HDR frame rather than being an optional toggle.

**Key reference files for future integration work**: `Streaming/VideoUpscaler.h`/`.cpp` (self-contained compute pipeline class, cleanly separable), `Streaming/VideoRenderer.cpp` (render-loop integration diff), `Assets/Shader/build_nis.bat` (offline `fxc` compile pattern). Fetch from `linckosz/moonlight-xbox` at commit `0e563de4101bcc453013f4c6aec88a1ae3212141` if the actual diff is needed rather than this summary.
