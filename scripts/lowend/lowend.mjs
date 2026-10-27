// Fire TV / Fire Stick emulation on the host: tuned Android AVDs plus a host-side CPU cap.
//   npm run lowend -- create <profile>
//   npm run lowend -- start <profile> [--cpu 0.3] [--gpu host|swiftshader_indirect] [--net edge|hsdpa|full]
//   npm run lowend -- install [--skip-build]
//   npm run lowend -- stats [--watch <seconds>]
//   npm run lowend -- throttle <profile> [--cpu 0.3]
//   npm run lowend -- stop
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { PROFILES } from "./profiles.mjs";

const PACKAGE = "com.mpotrykus.prism";
// A fixed console port keeps us off any other emulator or Fire Stick the user has attached.
const PORT = 5584;
const SERIAL = `emulator-${PORT}`;
const repo = fileURLToPath(new URL("../../", import.meta.url));
const sdk = process.env.ANDROID_HOME || join(process.env.LOCALAPPDATA, "Android", "Sdk");
const tool = (...p) => join(sdk, ...p);
const avdmanager = tool("cmdline-tools", "latest", "bin", "avdmanager.bat");
const emulator = tool("emulator", "emulator.exe");
const adb = tool("platform-tools", "adb.exe");
const throttleScript = fileURLToPath(new URL("./throttle.ps1", import.meta.url));

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const next = rest[i + 1];
    flags[rest[i].slice(2)] = next && !next.startsWith("--") ? rest[++i] : true;
  } else positional.push(rest[i]);
}

const fail = (msg) => {
  console.error(`lowend: ${msg}`);
  process.exit(1);
};
const sh = (file, args, opts = {}) =>
  execFileSync(file, args, { encoding: "utf8", shell: file.endsWith(".bat"), ...opts });
const adbShell = (...args) => sh(adb, ["-s", SERIAL, "shell", ...args]).replace(/\r/g, "");
const avdName = (p) => `prism-${p}`;
const avdDir = (p) => join(homedir(), ".android", "avd", `${avdName(p)}.avd`);

function profileArg() {
  const name = positional[0];
  if (!PROFILES[name]) fail(`unknown profile "${name}". Available: ${Object.keys(PROFILES).join(", ")}`);
  return [name, PROFILES[name]];
}

function patchConfig(file, values) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const map = new Map(lines.map((l) => [l.slice(0, l.indexOf("=")), l]));
  for (const [k, v] of Object.entries(values)) map.set(k, `${k}=${v}`);
  writeFileSync(file, [...map.values()].join("\n") + "\n");
}

function create() {
  const [name, p] = profileArg();
  console.log(`lowend: creating ${avdName(name)} (${p.label})...`);
  sh(avdmanager, ["create", "avd", "-n", avdName(name), "-k", p.image, "-d", p.device, "--force"], {
    input: "no\n",
    stdio: ["pipe", "inherit", "inherit"],
  });
  patchConfig(join(avdDir(name), "config.ini"), {
    "hw.ramSize": p.ramMb,
    "hw.cpu.ncore": p.cores,
    "hw.lcd.density": p.density,
    "hw.lcd.width": 1920,
    "hw.lcd.height": 1080,
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": p.gpu,
    "hw.keyboard": "yes",
    "hw.dPad": "yes",
    "hw.audioInput": "no",
    "disk.dataPartition.size": "4096M",
    "vm.heapSize": p.heapMb,
    "showDeviceFrame": "no",
    "fastboot.forceColdBoot": "yes",
  });
  console.log(`lowend: created. Start it with: npm run lowend -- start ${name}`);
}

function emulatorPids() {
  const out = sh("powershell", [
    "-NoProfile",
    "-Command",
    "(Get-CimInstance Win32_Process -Filter \"Name = 'qemu-system-x86_64.exe'\" | Where-Object { $_.CommandLine -match '-avd prism-' }).ProcessId -join ','",
  ]).trim();
  return out ? out.split(",").map(Number) : [];
}

function throttle(p) {
  const pids = emulatorPids();
  if (!pids.length) fail("no running emulator to throttle");
  const fraction = Number(flags.cpu ?? p.cpu);
  const logical = cpus().length;
  const cores = Math.min(p.cores, logical);
  const rate = Math.max(1, Math.round(10000 * Math.min(1, (cores / logical) * fraction)));
  for (const pid of pids) {
    console.log(
      sh("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", throttleScript,
        "-ProcessId", String(pid), "-Cores", String(cores), "-CpuRate", String(rate),
      ]).trim()
    );
  }
}

function waitForBoot() {
  process.stdout.write("lowend: waiting for boot");
  for (let i = 0; i < 180; i++) {
    if (!emulatorPids().length) fail("emulator exited during boot - see the log above");
    try {
      if (sh(adb, ["-s", SERIAL, "shell", "getprop", "sys.boot_completed"]).trim() === "1") {
        console.log(" ok");
        return;
      }
    } catch {}
    process.stdout.write(".");
    execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep 2"]);
  }
  fail("emulator did not finish booting");
}

function start() {
  const [name, p] = profileArg();
  if (!existsSync(avdDir(name))) fail(`AVD missing - run: npm run lowend -- create ${name}`);
  if (emulatorPids().length) fail("an emulator is already running - `npm run lowend -- stop` first");
  const gpu = flags.gpu ?? p.gpu;
  patchConfig(join(avdDir(name), "config.ini"), { "hw.gpu.mode": gpu });
  const args = ["-avd", avdName(name), "-no-snapshot", "-no-boot-anim", "-gpu", gpu, "-no-audio", "-port", String(PORT)];
  const net = flags.net ?? p.net;
  if (net) args.push("-netspeed", net, "-netdelay", net === "full" ? "none" : net);
  console.log(`lowend: starting ${avdName(name)} (${p.label}) gpu=${gpu}`);
  const logFile = join(tmpdir(), "prism-lowend-emulator.log");
  const log = openSync(logFile, "w");
  spawn(emulator, args, { detached: true, stdio: ["ignore", log, log] }).unref();
  closeSync(log);
  console.log(`lowend: emulator log: ${logFile}`);
  waitForBoot();
  try {
    sh(adb, ["-s", SERIAL, "root"]);
  } catch {}
  throttle(p);
}

function install() {
  const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (!flags["skip-build"]) {
    run("node", ["scripts/android-sync-shaders.mjs"], { cwd: repo });
    run("npx", ["vite", "build"], { cwd: repo });
    run("npx", ["cap", "sync", "android"], { cwd: repo });
    run(".\\gradlew.bat", ["assembleDebug"], { cwd: join(repo, "android") });
  }
  const apk = join(repo, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  sh(adb, ["-s", SERIAL, "install", "-r", apk], { stdio: "inherit" });
  sh(adb, ["-s", SERIAL, "shell", "am", "start", "-n", `${PACKAGE}/.MainActivity`], { stdio: "inherit" });
}

function sample() {
  const mem = adbShell("dumpsys", "meminfo", PACKAGE);
  const total = /TOTAL PSS:\s+(\d+)/.exec(mem)?.[1] ?? /TOTAL\s+(\d+)/.exec(mem)?.[1] ?? "?";
  const java = /Java Heap:\s+(\d+)/.exec(mem)?.[1] ?? "?";
  const gfx = adbShell("dumpsys", "gfxinfo", PACKAGE);
  const frames = /Total frames rendered:\s+(\d+)/.exec(gfx)?.[1] ?? "?";
  const janky = /Janky frames:\s+(\d+) \(([\d.]+)%\)/.exec(gfx);
  const p90 = /90th percentile:\s+(\d+)ms/.exec(gfx)?.[1] ?? "?";
  const sys = adbShell("cat", "/proc/meminfo");
  const free = Number(/MemAvailable:\s+(\d+)/.exec(sys)?.[1] ?? 0) / 1024;
  return {
    pssMb: total === "?" ? total : (Number(total) / 1024).toFixed(0),
    javaMb: java === "?" ? java : (Number(java) / 1024).toFixed(0),
    sysAvailMb: free.toFixed(0),
    frames,
    jankyPct: janky?.[2] ?? "?",
    p90ms: p90,
  };
}

function stats() {
  const every = flags.watch ? Number(flags.watch === true ? 5 : flags.watch) : 0;
  const show = () => console.log(new Date().toISOString().slice(11, 19), JSON.stringify(sample()));
  show();
  if (every) setInterval(show, every * 1000);
}

function stop() {
  try {
    sh(adb, ["-s", SERIAL, "emu", "kill"]);
  } catch {}
}

const commands = { create, start, install, stats, stop, throttle: () => throttle(profileArg()[1]) };
if (!commands[command]) {
  console.error(`Usage: npm run lowend -- <${Object.keys(commands).join("|")}> [profile] [flags]`);
  console.error(`Profiles: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}
commands[command]();
