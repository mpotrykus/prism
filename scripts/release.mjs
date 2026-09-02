// One-shot release build: bumps the version everywhere (version:set), then builds the
// Android App Bundle (android:bundle) and the Microsoft Store upload package (store:build),
// and collects both into release/ at the repo root. Run via `npm run release -- X.Y.Z`.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const versionArg = process.argv[2];
if (!versionArg || !/^\d+\.\d+\.\d+$/.test(versionArg)) {
  console.error("Usage: npm run release -- X.Y.Z  (e.g. 1.2.3)");
  process.exit(1);
}

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const aabPath = fileURLToPath(
  new URL("../android/app/build/outputs/bundle/release/app-release.aab", import.meta.url)
);
// Matches set-version.mjs's UWP Identity Version scheme (X.Y.Z -> X.Y.Z.0) and
// store-build.mjs's AppxBundle=Always naming (MSBuild suffixes _x64_bundle.msixupload).
const msixuploadPath = fileURLToPath(
  new URL(`../uwp/PrismUwp/AppPackages/PrismUwp_${versionArg}.0_x64_bundle.msixupload`, import.meta.url)
);
const releaseDir = fileURLToPath(new URL("../release/", import.meta.url));

// shell: true because npm is a .cmd shim - execFileSync can't exec it directly on Windows
// without going through a shell.
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: rootDir, stdio: "inherit", shell: true });

console.log(`release: setting version to ${versionArg}...`);
run("npm", ["run", "version:set", "--", versionArg]);

console.log("release: building Android App Bundle...");
run("npm", ["run", "android:bundle"]);

console.log("release: building Microsoft Store upload package...");
run("npm", ["run", "store:build"]);

if (!existsSync(aabPath)) {
  console.error(`release: expected .aab not found at ${aabPath}`);
  process.exit(1);
}
if (!existsSync(msixuploadPath)) {
  console.error(`release: expected .msixupload not found at ${msixuploadPath}`);
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
const aabDest = fileURLToPath(new URL(`../release/prism-${versionArg}.aab`, import.meta.url));
const msixuploadDest = fileURLToPath(
  new URL(`../release/prism-${versionArg}.msixupload`, import.meta.url)
);
copyFileSync(aabPath, aabDest);
copyFileSync(msixuploadPath, msixuploadDest);

console.log(`release: done - collected in ${releaseDir}`);
console.log(`  ${aabDest}`);
console.log(`  ${msixuploadDest}`);
