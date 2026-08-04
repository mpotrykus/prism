// Builds the Android debug APK and sideloads it to a device over wireless adb.
// Run via `npm run android:deploy -- <ip>[:port]` (port defaults to 5555, adb's
// standard tcp/ip debugging port). The device must already have adb tcp/ip mode
// enabled once over USB (`adb tcpip 5555`) before this can connect wirelessly.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run android:deploy -- <device-ip>[:port]");
  process.exit(1);
}
const address = target.includes(":") ? target : `${target}:5555`;

const androidDir = fileURLToPath(new URL("../android/", import.meta.url));
const apkPath = fileURLToPath(
  new URL("../android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url)
);

// shell: true because npx/gradlew.bat are .cmd/.bat shims - execFileSync can't
// exec those directly on Windows without going through a shell.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", shell: true, ...opts });

console.log("android-deploy: building web app...");
run("npx", ["vite", "build"]);

console.log("android-deploy: syncing Capacitor + building debug APK...");
run("npx", ["cap", "sync", "android"]);
run(".\\gradlew.bat", ["assembleDebug"], { cwd: androidDir });

console.log(`android-deploy: connecting to ${address}...`);
run("adb", ["connect", address]);

console.log(`android-deploy: installing ${apkPath}...`);
run("adb", ["-s", address, "install", "-r", apkPath]);

console.log("android-deploy: launching app...");
run("adb", [
  "-s", address,
  "shell", "am", "start",
  "-n", "com.mpotrykus.streaming/.MainActivity",
]);

console.log(`android-deploy: done - installed and launched on ${address}.`);
