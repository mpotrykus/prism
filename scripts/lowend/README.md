# Low-end device emulation (Fire TV / Fire Stick)

Tuned Android AVDs plus a host-side CPU cap, so memory/CPU/network-constrained behavior can be tuned on the dev machine before deploying to a real stick.

```
npm run lowend -- create <profile>
npm run lowend -- start <profile> [--cpu 0.3] [--gpu host|swiftshader_indirect] [--net full|hsdpa|edge]
npm run lowend -- install [--skip-build]
npm run lowend -- stats [--watch 5]
npm run lowend -- stop
```

Profiles live in `profiles.mjs`. The emulator is pinned to console port 5584 (`emulator-5584`), so it never collides with another emulator or a Fire Stick attached over adb.

## What is and isn't faithful

- RAM, core count, screen size/density and network speed come from the AVD config and match the device.
- CPU speed is approximated: `throttle.ps1` pins qemu to N host cores and applies a Windows Job Object hard cap. The `cpu` fraction in each profile is a guess. Calibrate it against a real stick (e.g. cold start to the sign-in screen) and change it with `--cpu`. A cap can't be loosened on a running emulator, so restart to retune.
- GPU defaults to SwiftShader (software) as a stand-in for the stick's weak Mali GPU. It is not representative for GL effects (AI upscaling, levels, ambient lighting).
- Video decode is not representative: the emulator has no Fire TV hardware decoder, so treat native playback results as unreliable.

## WebView version matters

The `android-28` image ships WebView 69, which can't parse the Vite bundle (`Unexpected token ?`), so the app renders a blank page. The `android-30` image ships WebView 83 and runs. Check what a real stick reports (`adb shell dumpsys webviewupdate`) before trusting a Fire OS 7 profile, and either upgrade the emulator WebView to match or lower the Vite `build.target`.
