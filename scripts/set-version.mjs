// Single entry point for bumping the app version across every platform target:
// package.json, Android's build.gradle (versionName + versionCode), and the UWP
// Package.appxmanifest (Identity Version). Run via `npm run version:set -- X.Y.Z`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const versionArg = process.argv[2];
if (!versionArg || !/^\d+\.\d+\.\d+$/.test(versionArg)) {
  console.error("Usage: npm run version:set -- X.Y.Z  (e.g. 1.2.3)");
  process.exit(1);
}

const packageJsonPath = path.join(rootDir, "package.json");
const gradlePath = path.join(rootDir, "android/app/build.gradle");
const manifestPath = path.join(rootDir, "uwp/PrismUwp/Package.appxmanifest");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const previousVersion = packageJson.version;
packageJson.version = versionArg;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`package.json: ${previousVersion} -> ${versionArg}`);

let gradle = readFileSync(gradlePath, "utf8");
const versionCodeMatch = gradle.match(/versionCode\s+(\d+)/);
if (!versionCodeMatch) {
  console.error(`set-version: couldn't find versionCode in ${gradlePath}`);
  process.exit(1);
}
// Play Store requires versionCode to strictly increase on every upload; it has no required
// relationship to versionName, so it's just bumped independently of the semver argument.
const previousVersionCode = Number(versionCodeMatch[1]);
const nextVersionCode = previousVersionCode + 1;
gradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${nextVersionCode}`)
  .replace(/versionName\s+"[^"]*"/, `versionName "${versionArg}"`);
writeFileSync(gradlePath, gradle);
console.log(
  `android/app/build.gradle: versionName -> "${versionArg}", versionCode ${previousVersionCode} -> ${nextVersionCode}`
);

let manifest = readFileSync(manifestPath, "utf8");
const manifestVersionMatch = manifest.match(/^(\s*)Version="([\d.]+)"/m);
if (!manifestVersionMatch) {
  console.error(`set-version: couldn't find Identity Version in ${manifestPath}`);
  process.exit(1);
}
// UWP Identity Version is the 4-part Major.Minor.Build.Revision scheme; map semver straight
// across and reset Revision to 0 (bump it by hand instead if re-submitting the same X.Y.Z).
const nextManifestVersion = `${versionArg}.0`;
manifest = manifest.replace(
  /^(\s*)Version="[\d.]+"/m,
  `$1Version="${nextManifestVersion}"`
);
writeFileSync(manifestPath, manifest);
console.log(
  `uwp/PrismUwp/Package.appxmanifest: Version ${manifestVersionMatch[2]} -> ${nextManifestVersion}`
);
