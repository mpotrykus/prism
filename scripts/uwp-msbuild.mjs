// Shared MSBuild location/path helpers for the UWP shell, used by both xbox-build.mjs
// and xbox-deploy.mjs. Locates MSBuild via vswhere instead of a hardcoded Visual Studio
// path/edition/version, since that varies per machine. Not Xbox-specific itself - just the
// shared plumbing those two Xbox-sideload-specific scripts both need.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const projectDir = fileURLToPath(new URL("../uwp/PrismUwp/", import.meta.url));
export const solutionPath = fileURLToPath(new URL("../uwp/PrismUwp/PrismUwp.sln", import.meta.url));
export const appPackagesDir = fileURLToPath(new URL("../uwp/PrismUwp/AppPackages/", import.meta.url));

function scanForMsBuild() {
  const roots = ["C:\\Program Files\\Microsoft Visual Studio", "C:\\Program Files (x86)\\Microsoft Visual Studio"];
  const editions = ["Enterprise", "Professional", "Community", "BuildTools"];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const version of readdirSync(root)) {
      for (const edition of editions) {
        const exe = `${root}\\${version}\\${edition}\\MSBuild\\Current\\Bin\\MSBuild.exe`;
        if (existsSync(exe)) candidates.push({ version, exe });
      }
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return candidates[0]?.exe;
}

export function findMsBuild() {
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  let path;
  if (existsSync(vswhere)) {
    path = execFileSync(vswhere, [
      "-latest",
      "-prerelease",
      "-requires", "Microsoft.Component.MSBuild",
      "-find", "MSBuild\\**\\Bin\\MSBuild.exe",
    ])
      .toString()
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
  }
  // vswhere's instance registry can come back empty even with VS installed (stale/corrupt
  // setup state), so fall back to scanning the standard install directories.
  path ??= scanForMsBuild();
  if (!path) throw new Error("Could not locate MSBuild.exe via vswhere or the standard Visual Studio directories.");
  return path.trim();
}
