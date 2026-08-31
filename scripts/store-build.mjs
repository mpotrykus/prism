// Builds the UWP shell for Microsoft Store submission (Partner Center), after `uwp:sync`
// has already refreshed www/ with the latest web build. Run via `npm run store:build`.
//
// Distinct from xbox-build.mjs (`npm run xbox:build`), which sets
// UapAppxPackageBuildMode=SideloadOnly to produce a directly-installable .msixbundle for
// Xbox Dev Mode/local sideload. Partner Center rejects that artifact outright with
// "You cannot submit pre-compiled .NET Native packages. Please upload the Microsoft Store
// appxupload file and try again" - the project has UseDotNetNativeToolchain=true (needed so
// a sideloaded build runs at retail performance without the Store's own compile step), but
// Store ingestion insists on doing its own per-architecture .NET Native compilation from an
// IL-only package rather than accepting one precompiled locally. UapAppxPackageBuildMode=
// StoreUpload is what produces that IL-only upload package instead of a precompiled .msix -
// this is the actual difference, not a signing or manifest issue. With AppxBundle=Always
// the output is a bundle, so MSBuild names it *_bundle.msixupload rather than .appxupload -
// both are valid Store upload formats, Partner Center accepts either.
import { findMsBuild, projectDir, solutionPath } from "./uwp-msbuild.mjs";
import { execFileSync } from "node:child_process";

const msbuild = findMsBuild();
console.log(`store-build: using ${msbuild}`);

const run = (args) =>
  execFileSync(msbuild, args, { cwd: projectDir, stdio: "inherit" });

console.log("store-build: restoring NuGet packages...");
run([solutionPath, "/t:Restore", "/verbosity:minimal"]);

console.log("store-build: building Store upload package (Release|x64)...");
run([
  solutionPath,
  "/t:Build",
  "/p:Configuration=Release",
  "/p:Platform=x64",
  "/p:AppxBundlePlatforms=x64",
  "/p:AppxBundle=Always",
  "/p:UapAppxPackageBuildMode=StoreUpload",
  "/verbosity:minimal",
]);

console.log(
  "store-build: done - upload the .msixupload/.appxupload file under " +
    "uwp/PrismUwp/AppPackages/.../ to Partner Center (not the .msix/.msixbundle - those are " +
    "the sideload-only artifacts)."
);
