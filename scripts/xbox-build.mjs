// Restores and builds the Xbox UWP shell into a sideloadable .msix, after `uwp:sync` has
// already refreshed www/ with the latest web build. Run via `npm run xbox:build` (which
// chains uwp:sync first) rather than directly.
//
// Locates MSBuild via vswhere instead of a hardcoded Visual Studio path/edition/version,
// since that varies per machine. A plain `msbuild PrismUwp.csproj` build resolves
// System.Runtime/WinMD references but fails XAML compilation with a cryptic
// "Type universe cannot resolve assembly" error unless NuGet packages are restored first
// (classic UWP + PackageReference quirk - MSBuild doesn't auto-restore like `dotnet build`
// does for SDK-style projects) - hence the separate Restore pass before Build.
//
// Builds Release, not Debug: confirmed empirically that a Debug build's framework
// dependencies (Microsoft.NET.CoreFramework.Debug.2.2, Microsoft.VCLibs...Debug.14.00) are
// SDK-only debug redistributables that Visual Studio's own "Remote Machine" deploy
// provisions automatically but a manual Device Portal sideload cannot - it fails with
// "depends on a framework that could not be found" even though the .appx is sitting right
// there in AppPackages/.../Dependencies/. Release (with UseDotNetNativeToolchain, already
// set in the csproj) depends only on the standard retail Microsoft.NET.Native.*/
// Microsoft.VCLibs.*.14.00 framework packages instead, which sideload cleanly.
import { execFileSync } from "node:child_process";
import { findMsBuild, projectDir, solutionPath } from "./uwp-msbuild.mjs";

const msbuild = findMsBuild();
console.log(`xbox-build: using ${msbuild}`);

const run = (args) =>
  execFileSync(msbuild, args, { cwd: projectDir, stdio: "inherit" });

console.log("xbox-build: restoring NuGet packages...");
run([solutionPath, "/t:Restore", "/verbosity:minimal"]);

console.log("xbox-build: building .msix (Release|x64, sideload)...");
run([
  solutionPath,
  "/t:Build",
  "/p:Configuration=Release",
  "/p:Platform=x64",
  "/p:AppxBundlePlatforms=x64",
  "/p:AppxBundle=Always",
  "/p:UapAppxPackageBuildMode=SideloadOnly",
  "/verbosity:minimal",
]);

console.log(
  "xbox-build: done - in uwp/PrismUwp/AppPackages/.../, sideload the .msixbundle together with every " +
    ".appx under Dependencies/x64/ (Device Portal's app-install page accepts multiple files in one upload) " +
    "- a sideload install does not auto-provision framework dependencies the way Visual Studio's Remote " +
    "Machine deploy does."
);
