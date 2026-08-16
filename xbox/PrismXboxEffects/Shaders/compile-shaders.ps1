# Precompiles the .hlsl sources in this folder into .cso pixel-shader bytecode consumed by
# Win2D's PixelShaderEffect (see ShaderVideoEffect.cs). Re-run this after editing either .hlsl -
# nothing in the PrismXboxEffects.csproj build recompiles them automatically, matching this
# project's other Xbox sub-project (moonlight-xbox's Assets\Shader\build_hlsl.bat), since a
# classic C# UWP csproj has no HLSL build-item support the way a .vcxproj does.
#
# /T ps_4_0, NOT ps_5_0: confirmed the hard way, via the actual runtime error Win2D's
# PixelShaderEffect throws for a ps_5_0-compiled shader - "ArgumentException: The parameter is
# incorrect. Unable to load the specified shader. This should be a Direct3D pixel shader compiled
# for shader model 4." - on a real console, silently reducing every frame to the exception
# fallback's plain passthrough draw. Trust that message over any doc/assumption if this ever needs
# revisiting.
#
# Deliberately does NOT pass /Qstrip_reflect: Win2D's PixelShaderEffect.Properties["name"]
# indexer discovers each shader's cbuffer field names via D3D shader reflection at runtime, so
# stripping that data would silently break every effect.Properties[...] assignment in
# ShaderVideoEffect.cs.
$ErrorActionPreference = "Stop"

$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10"
$sdkVersion = "10.0.26100.0"
$fxc = Join-Path $sdkRoot "bin\$sdkVersion\x64\fxc.exe"
$includeDir = Join-Path $sdkRoot "Include\$sdkVersion\um"

if (-not (Test-Path $fxc)) {
    throw "fxc.exe not found at $fxc - install the Windows 10 SDK ($sdkVersion) or edit `$sdkVersion above to match an installed one."
}
if (-not (Test-Path (Join-Path $includeDir "d2d1effecthelpers.hlsli"))) {
    throw "d2d1effecthelpers.hlsli not found under $includeDir"
}

$shaders = @("anime4k", "live_action")
foreach ($name in $shaders) {
    $src = Join-Path $PSScriptRoot "$name.hlsl"
    $out = Join-Path $PSScriptRoot "$name.cso"
    Write-Host "Compiling $name.hlsl -> $name.cso"
    & $fxc /nologo /T ps_4_0 /E main /D D2D_ENTRY=main /I "$includeDir" /Fo "$out" "$src"
    if ($LASTEXITCODE -ne 0) {
        throw "fxc failed compiling $name.hlsl (exit $LASTEXITCODE)"
    }
}

Write-Host "Done. Re-add the .cso files as EmbeddedResource in PrismXboxEffects.csproj if this is their first build."
