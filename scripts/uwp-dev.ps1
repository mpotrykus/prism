# Builds the current web + UWP shell under a throwaway identity (Prism.DevDemo, "Prism (Demo)")
# and registers it loose, so it installs next to the Store build without touching it.
# Usage: pwsh scripts/uwp-dev.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$dev = Join-Path $repo ".uwp-dev"
$ms = "C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe"
if (-not (Test-Path $ms)) { $ms = Get-ChildItem "C:\Program Files\Microsoft Visual Studio" -Recurse -Filter MSBuild.exe | Where-Object FullName -notmatch "amd64" | Select-Object -First 1 -ExpandProperty FullName }

Push-Location $repo; npm run uwp:sync; if ($LASTEXITCODE) { throw "uwp:sync failed" }; Pop-Location

foreach ($d in "PrismUwp", "PrismUwpEffects") {
  robocopy "$repo\uwp\$d" "$dev\uwp\$d" /MIR /XD bin obj AppPackages BundleArtifacts .vs /NFL /NDL /NJH /NJS | Out-Null
}
$manifest = "$dev\uwp\PrismUwp\Package.appxmanifest"
(Get-Content $manifest -Raw) -replace 'Name="Anlagen.PrismStreaming"', 'Name="Prism.DevDemo"' -replace 'DisplayName="Prism"', 'DisplayName="Prism (Demo)"' | Set-Content $manifest -NoNewline

$sln = "$dev\uwp\PrismUwp\PrismUwp.sln"
& $ms $sln /t:Restore /verbosity:minimal
Remove-Item "$dev\uwp\PrismUwp\AppPackages" -Recurse -Force -ErrorAction SilentlyContinue
& $ms $sln /t:Build /p:Configuration=Debug /p:Platform=x64 /p:AppxBundle=Never /verbosity:minimal
if ($LASTEXITCODE) { throw "build failed" }

$mk = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter makeappx.exe | Where-Object FullName -match "x64" | Sort-Object FullName | Select-Object -Last 1
$msix = Get-ChildItem "$dev\uwp\PrismUwp\AppPackages" -Recurse -Filter *.msix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$layout = "$dev\layout"
Remove-Item $layout -Recurse -Force -ErrorAction SilentlyContinue
& $mk.FullName unpack /p $msix.FullName /d $layout /l | Out-Null
Get-Process PrismUwp -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
Add-AppxPackage -Register "$layout\AppxManifest.xml" -ForceUpdateFromAnyVersion
Start-Process "shell:AppsFolder\$((Get-AppxPackage Prism.DevDemo).PackageFamilyName)!App"
