// Shared MSBuild location/path helpers for the UWP shell, used by both xbox-build.mjs
// and xbox-deploy.mjs. Locates MSBuild via vswhere instead of a hardcoded Visual Studio
// path/edition/version, since that varies per machine. Not Xbox-specific itself - just the
// shared plumbing those two Xbox-sideload-specific scripts both need.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const projectDir = fileURLToPath(new URL("../uwp/PrismUwp/", import.meta.url));
export const solutionPath = fileURLToPath(new URL("../uwp/PrismUwp/PrismUwp.sln", import.meta.url));
export const appPackagesDir = fileURLToPath(new URL("../uwp/PrismUwp/AppPackages/", import.meta.url));

export function findMsBuild() {
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
