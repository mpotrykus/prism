# Vendored upstream shaders

Consumed verbatim by `src/player/shader/mpv-user-shader.js`, which understands mpv's
user-shader directive format (`//!HOOK`, `//!BIND`, `//!SAVE`, `//!WIDTH`, …). **Do not
hand-edit these files** — the whole point of the loader is that a version bump is a
re-download and a diff against upstream, not a re-port. Tuning belongs in
`../../shaders.js`, not in here.

| File | Upstream | Version | License |
|---|---|---|---|
| `anime4k-restore-cnn-s.glsl` | [bloc97/Anime4K](https://github.com/bloc97/Anime4K) `glsl/Restore/Anime4K_Restore_CNN_S.glsl` | v4.0 | MIT (header retained in file) |
| `anime4k-upscale-cnn-x2-s.glsl` | [bloc97/Anime4K](https://github.com/bloc97/Anime4K) `glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl` | v3.2 | MIT (header retained in file) |
| `fsr1-easu-rcas.glsl` | [agyild's mpv port](https://gist.github.com/agyild/82219c545228d70c5604f865ce0b0ce5) of AMD FidelityFX Super Resolution | v1.0.2 | MIT (AMD header retained in file) |

## Why these two, in this order

This is Anime4K's own documented "Mode A" pairing: a Restore pass that undoes compression
and resampling damage, then a 2x CNN upscale. Running Upscale without Restore first
sharpens the artifacts along with the line art.

The `_S` (small) variants are the deliberate default. Anime4K ships S/M/L/VL/UL sizes; on
the GPU budget this player actually has — a phone, a browser tab, or an Xbox app-partition
process capped at 45% of GPU cycles — the larger variants do not sustain frame rate, and a
dropped-frame stutter is a worse picture than a slightly softer one. See the perf watchdog
in `../../perf-watchdog.js` for what happens when even this is too heavy.

## Fetched but deliberately not vendored

- **NVScaler** (`agyild`'s mpv port) and **ArtCNN** (`Artoriuz/ArtCNN`) are `//!COMPUTE`
  shaders. WebGL2 has no compute shaders at all, so the loader rejects them by design
  rather than half-running them. They are the natural first candidates for the WebGPU
  spike, where compute is available.
- **CAS** (`agyild`'s mpv port) is a sharpener, not an upscaler, and this player already has a
  CAS-inspired single-pass sharpen as the `live_action` family preset. FSR's own RCAS pass is a
  variant of CAS tuned to follow EASU, so it is already covered.

## Notes on FSR 1

It hooks `LUMA` and reads/writes only `.r` (`//!COMPONENTS 1`) - that port was deliberately
rewritten to operate on mpv's luma plane. This pipeline has no luma plane, so the preset wraps
it in `../luma-extract.frag.glsl` and `../luma-merge.frag.glsl`. Read those before touching it.

Its sharpness is a compile-time `#define SHARPNESS 0.2` rather than a uniform, so the preset is
`strengthless` and ships at upstream's default. Do not edit the define here to expose a slider -
inject an override in the loader preamble if that is ever wanted.

Its `textureGather` fast paths are guarded by `defined(HOOKED_gather)`, a macro the loader does
not emit, so it compiles down to the plain-tap path. Its `uintBitsToFloat`/`floatBitsToUint`
reciprocal approximations are valid GLSL ES 3.00 and confirmed compiling on ANGLE.
