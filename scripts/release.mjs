// One-shot release build: bumps the version everywhere (version:set), then builds the
// Android App Bundle (android:bundle) and the Microsoft Store upload package (store:build),
// collects both into release/ at the repo root, and commits/tags/pushes the version bump
// and cuts a matching GitHub release - so the Play Console, Partner Center, and GitHub
// version markers all land on the same X.Y.Z. Run via `npm run release -- X.Y.Z`.
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
const tag = `v${versionArg}`;

// shell: true because npm is a .cmd shim - execFileSync can't exec it directly on Windows
// without going through a shell.
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: rootDir, stdio: "inherit", shell: true });
// git/gh are real .exe's, not .cmd shims - run them without a shell so multi-word args (like
// a commit message) reach them as single argv entries instead of being re-split on spaces by
// cmd.exe (shell:true does not quote array args on Windows).
const runGit = (args) => execFileSync("git", args, { cwd: rootDir, stdio: "inherit" });
const runGh = (args) => execFileSync("gh", args, { cwd: rootDir, stdio: "inherit" });
const runCaptureGit = (args) => execFileSync("git", args, { cwd: rootDir }).toString().trim();

// version:set touches these three files as part of the version-bump commit, so a dirty
// working tree (anything staged, unstaged, or untracked) would either get swept into that
// commit or block it outright - push or stash everything first.
const versionedFiles = ["package.json", "android/app/build.gradle", "uwp/PrismUwp/Package.appxmanifest"];
const dirtyFiles = runCaptureGit(["status", "--porcelain"]);
if (dirtyFiles) {
  console.error(
    `release: working tree is not clean:\n${dirtyFiles}\nPush or stash your changes before running a release.`
  );
  process.exit(1);
}

// Fail fast if this version was already tagged, before spending time on a build we can't ship.
const tagExists = runCaptureGit(["tag", "--list", tag]);
if (tagExists) {
  console.error(`release: tag ${tag} already exists. Bump to a new version or delete the tag first.`);
  process.exit(1);
}

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

console.log("release: committing version bump...");
runGit(["add", "--", ...versionedFiles]);
runGit(["commit", "-m", `chore(app): version bump to ${versionArg}`]);

console.log(`release: tagging ${tag}...`);
runGit(["tag", tag]);

console.log("release: pushing commit and tag...");
runGit(["push"]);
runGit(["push", "origin", tag]);

console.log(`release: creating GitHub release ${tag}...`);
runGh(["release", "create", tag, "--title", tag, "--generate-notes"]);

console.log(`release: done - collected in ${releaseDir}`);
console.log(`  ${aabDest}`);
console.log(`  ${msixuploadDest}`);
console.log(`  GitHub release: ${tag}`);
console.log("release: upload the .aab to Play Console and the .msixupload to Partner Center to finish.");
