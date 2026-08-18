// Cleans + rebuilds the Xbox UWP shell fresh, then sideloads it to a paired Xbox over the
// network via WinAppDeployCmd.exe (ships with the Windows SDK under
// Windows Kits\10\bin\<version>\x64\) - the same deployment mechanism Visual Studio's own
// "Remote Machine" target uses under the hood. Unlike a manual Device Portal upload, it
// resolves the Dependencies\x64\*.appx closure automatically from the AppPackages folder
// layout instead of needing every framework package uploaded by hand in one atomic request
// (see CLAUDE.md's Xbox deployment notes for why that manual path is finicky).
//
// Still builds Release, not Debug - same reason as xbox-build.mjs: Debug's framework
// dependencies are SDK-only redistributables that only Visual Studio's own deploy can
// provision, not WinAppDeployCmd. "Debug" here instead means streaming the running app's
// WebView2 console output back to this window (--logs), via the remote-debugging port
// already wired up in App.xaml.cs (ws://<ip>:9222) - there's no keyboard/mouse on the
// console to open WebView2's own DevTools locally.
//
// Usage: npm run xbox:deploy -- <xbox-ip> [pin]
//        npm run xbox:deploy:debug -- <xbox-ip> [pin]
// The pin is only needed the first time this machine pairs with that console through
// WinAppDeployCmd specifically (separate from the Device Portal cert-trust pairing already
// documented in CLAUDE.md) - get one from the console's Settings > System > Preferences >
// Devices & connections > Remote device pairing screen in Dev Mode.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { findMsBuild, projectDir, solutionPath, appPackagesDir } from "./xbox-msbuild.mjs";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const [ip, pin] = positional;
const withLogs = process.argv.includes("--logs");

if (!ip) {
  console.error("Usage: npm run xbox:deploy -- <xbox-ip> [pin]");
  process.exit(1);
}

const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });

console.log("xbox-deploy: building web app...");
run("npx", ["vite", "build"], { shell: true });

console.log("xbox-deploy: syncing dist/ -> xbox/PrismXbox/www/...");
run("node", ["scripts/xbox-sync.mjs"]);

const msbuild = findMsBuild();
console.log(`xbox-deploy: using ${msbuild}`);
const msbuildRun = (msArgs) => execFileSync(msbuild, msArgs, { cwd: projectDir, stdio: "inherit" });

console.log("xbox-deploy: cleaning previous build output...");
msbuildRun([solutionPath, "/t:Clean", "/p:Configuration=Release", "/p:Platform=x64", "/verbosity:minimal"]);

console.log("xbox-deploy: restoring NuGet packages...");
msbuildRun([solutionPath, "/t:Restore", "/verbosity:minimal"]);

console.log("xbox-deploy: building .msix (Release|x64, sideload)...");
msbuildRun([
  solutionPath,
  "/t:Build",
  "/p:Configuration=Release",
  "/p:Platform=x64",
  "/p:AppxBundlePlatforms=x64",
  "/p:AppxBundle=Always",
  "/p:UapAppxPackageBuildMode=SideloadOnly",
  "/verbosity:minimal",
]);

function findNewestBundle(dir) {
  let newest = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      const found = findNewestBundle(`${full}/`);
      if (found && (!newest || found.mtime > newest.mtime)) newest = found;
    } else if (entry.name.endsWith(".msixbundle")) {
      const mtime = statSync(full).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: full, mtime };
    }
  }
  return newest;
}

const bundle = findNewestBundle(appPackagesDir);
if (!bundle) {
  console.error(`xbox-deploy: no .msixbundle found under ${appPackagesDir}`);
  process.exit(1);
}
console.log(`xbox-deploy: deploying ${bundle.path}`);

// WinAppDeployCmd does NOT search the AppPackages folder's own Dependencies\x64\ subfolder
// by default (only the app root and SDK dirs) - the framework .appx packages sitting right
// next to the bundle have to be passed explicitly via -dependency, or install fails with
// "package depends on a framework that could not be found" even though it's right there.
const bundleDir = bundle.path.slice(0, bundle.path.lastIndexOf("/") + 1);
const dependenciesDir = `${bundleDir}Dependencies/x64/`;
const dependencyPaths = existsSync(dependenciesDir)
  ? readdirSync(dependenciesDir)
      .filter((f) => f.endsWith(".appx"))
      .map((f) => `${dependenciesDir}${f}`)
  : [];
if (dependencyPaths.length === 0) {
  console.error(`xbox-deploy: no .appx dependencies found under ${dependenciesDir}`);
  process.exit(1);
}

function findWinAppDeployCmd() {
  const kitsBin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!existsSync(kitsBin)) {
    throw new Error(`Windows Kits not found at ${kitsBin} - is the Windows SDK installed?`);
  }
  const versions = readdirSync(kitsBin)
    .filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = `${kitsBin}\\${version}\\x64\\WinAppDeployCmd.exe`;
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`WinAppDeployCmd.exe not found under any SDK version in ${kitsBin}`);
}

const winAppDeployCmd = findWinAppDeployCmd();
const installArgs = ["install", "-file", bundle.path, "-dependency", ...dependencyPaths, "-ip", ip];
if (pin) installArgs.push("-pin", pin);

// Captures output (rather than inheriting it live) instead of printing it, so a failure's
// text can be inspected - e.g. to detect and recover from the "unpackaged version already
// installed" conflict below - without flooding the console with routine output (the `list`
// command alone dumps every package installed on the console, ~90 lines).
function runCapture(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8" });
  } catch (err) {
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    err.combinedOutput = output;
    throw err;
  }
}

// The app's own package identity (Package.appxmanifest's <Identity Name>), not the project
// name - WinAppDeployCmd's `list`/`uninstall` deal in package identities, not project names.
const packageIdentityName = "com.mpotrykus.prismxbox";

console.log(`xbox-deploy: installing to ${ip}...`);
try {
  try {
    runCapture(winAppDeployCmd, installArgs);
  } catch (err) {
    const conflict = /already installed an unpackaged version/i.test(err.combinedOutput ?? "");
    if (!conflict) throw err;

    // Visual Studio's own "Remote Machine" F5 deploy installs the app unpackaged (loose
    // files, not a signed .msixbundle) - Windows refuses to let a packaged WinAppDeployCmd
    // install silently replace that, so the conflicting copy has to be uninstalled first.
    console.log(
      "xbox-deploy: an unpackaged Visual Studio deploy of this app is already on the console " +
        "and blocks a packaged install - uninstalling it first..."
    );

    const listArgs = ["list", "-ip", ip];
    if (pin) listArgs.push("-pin", pin);
    const listOutput = runCapture(winAppDeployCmd, listArgs);
    const packageFullName = listOutput
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().startsWith(`${packageIdentityName}_`));

    if (!packageFullName) {
      console.log(listOutput);
      throw new Error(`could not find ${packageIdentityName}'s PackageFullName in \`list\` output to uninstall it.`);
    }

    console.log(`xbox-deploy: uninstalling ${packageFullName}...`);
    const uninstallArgs = ["uninstall", "-package", packageFullName, "-ip", ip];
    if (pin) uninstallArgs.push("-pin", pin);
    runCapture(winAppDeployCmd, uninstallArgs);

    console.log(`xbox-deploy: retrying install to ${ip}...`);
    runCapture(winAppDeployCmd, installArgs);
  }
} catch (err) {
  console.error(`xbox-deploy: install failed - ${err.combinedOutput ?? err.message}`);
  process.exit(1);
}

console.log(`xbox-deploy: done - installed on ${ip}.`);

if (withLogs) await streamLogs(ip);

async function streamLogs(host) {
  console.log(`\nxbox-deploy: waiting for WebView2 remote debugging on ${host}:9222...`);
  console.log("xbox-deploy: launch (or relaunch) Prism on the console now if it isn't already running.");

  let targets = null;
  for (let attempt = 0; attempt < 60 && !targets; attempt++) {
    try {
      const res = await fetch(`http://${host}:9222/json`);
      if (res.ok) targets = await res.json();
    } catch {
      // not up yet, keep polling
    }
    if (!targets) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!targets || targets.length === 0) {
    console.error(`xbox-deploy: gave up waiting for ${host}:9222 - is the app running and reachable?`);
    return;
  }

  const target = targets.find((t) => t.webSocketDebuggerUrl) ?? targets[0];
  console.log(`xbox-deploy: attached to "${target.title ?? target.url}" - streaming console output (Ctrl+C to stop)...\n`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: nextId++, method, params }));

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      send("Runtime.enable");
      send("Log.enable");
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data.toString());

      if (msg.method === "Runtime.consoleAPICalled") {
        const { type, args: callArgs, timestamp } = msg.params;
        const text = callArgs.map((a) => a.value ?? a.description ?? "").join(" ");
        console.log(`[${new Date(timestamp).toLocaleTimeString()}] console.${type}: ${text}`);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const { exceptionDetails } = msg.params;
        console.log(`[exception] ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ""}`);
      } else if (msg.method === "Log.entryAdded") {
        const { level, text, source } = msg.params.entry;
        console.log(`[${source}/${level}] ${text}`);
      }
    });

    ws.addEventListener("error", reject);
    ws.addEventListener("close", resolve);
  });
}
