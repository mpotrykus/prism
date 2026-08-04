// Restores and builds the Xbox UWP shell into a sideloadable .msix, after `xbox:sync` has
// already refreshed www/ with the latest web build. Run via `npm run xbox:build` (which
// chains xbox:sync first) rather than directly.
//
// Locates MSBuild via vswhere instead of a hardcoded Visual Studio path/edition/version,
// since that varies per machine. A plain `msbuild PrismXbox.csproj` build resolves
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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("../xbox/PrismXbox/", import.meta.url));
const solutionPath = new URL("../xbox/PrismXbox/PrismXbox.sln", import.meta.url);

function findMsBuild() {
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (!existsSync(vswhere)) {
    throw new Error(`vswhere.exe not found at ${vswhere} - is Visual Studio installed?`);
  }
  const path = execFileSync(vswhere, [
    "-latest",
    "-prerelease",
    "-requires", "Microsoft.Component.MSBuild",
    "-find", "MSBuild\\**\\Bin\\MSBuild.exe",
  ])
    .toString()
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  if (!path) throw new Error("vswhere found Visual Studio but no MSBuild.exe under it.");
  return path.trim();
}

const msbuild = findMsBuild();
console.log(`xbox-build: using ${msbuild}`);

const run = (args) =>
  execFileSync(msbuild, args, { cwd: projectDir, stdio: "inherit" });

console.log("xbox-build: restoring NuGet packages...");
run([fileURLToPath(solutionPath), "/t:Restore", "/verbosity:minimal"]);

console.log("xbox-build: building .msix (Release|x64, sideload)...");
run([
  fileURLToPath(solutionPath),
  "/t:Build",
  "/p:Configuration=Release",
  "/p:Platform=x64",
  "/p:AppxBundlePlatforms=x64",
  "/p:AppxBundle=Always",
  "/p:UapAppxPackageBuildMode=SideloadOnly",
  "/verbosity:minimal",
]);

console.log(
  "xbox-build: done - in xbox/PrismXbox/AppPackages/.../, sideload the .msixbundle together with every " +
    ".appx under Dependencies/x64/ (Device Portal's app-install page accepts multiple files in one upload) " +
    "- a sideload install does not auto-provision framework dependencies the way Visual Studio's Remote " +
    "Machine deploy does."
);
