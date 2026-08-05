# Player feature comparison: Plezy vs. Prism

Prompted by: could we run Prism's playback against [Plezy](https://github.com/edde746/plezy) (a
feature-rich Plex/Jellyfin client) instead of, or in addition to, our own player?

## Can we reuse Plezy's player directly?

No. Plezy is a standalone **Flutter app**, not a library, service, or embeddable component:

- Playback is handled by native engines linked directly into the Flutter binary — **mpv** on
  desktop/Android, **ExoPlayer** on Android, **MPVKit** on iOS, with **libass** for subtitle
  rendering. None of these are reachable from a browser, WebView2, or a plain Android WebView the
  way Prism is built.
- There is no server component and no web build exposing this feature set — nothing to "call into"
  from `plex-player.js`.
- Plezy is **GPLv3**-licensed. Vendoring any of its code into Prism (which currently has no stated
  license position) would carry copyleft obligations.

Architecturally, Plezy sits in the same spot Prism does — a client talking directly to the Plex
API, no backend — so it's a fair feature benchmark, just not something we can integrate with.

## Feature comparison

| Feature | Plezy | Prism (today) |
|---|---|---|
| Direct play + server transcode | Yes | Yes — `directStream=1` HLS remux (`plex-player.js` `_buildStreamUrl`) |
| Quality presets (240p–1080p, bitrate caps) | Yes | Yes — version + quality-cap picker in the title-info modal |
| Playback speed 0.25x–8x | Yes | Yes — player-chrome speed control (native `setPlaybackSpeed` on Android) |
| HEVC/AV1/VP9, HDR, Dolby Vision | Yes (native decoders) | Partial (browser/WebView2-codec-dependent; Plex transcodes the rest) |
| ASS/SSA subtitle rendering with styling | Yes (libass) | No — only what `<video>`/Media3 render natively |
| Online subtitle search/download | Yes | Yes — OpenSubtitles REST API (`opensubtitles.js`), login-gated downloads |
| Skip intro / skip credits | Yes | Yes — Plex `Marker` data, shared range-check between web pill and Android native button |
| Chapter navigation with thumbnails | Yes | Partial — chapter list with timestamps, no thumbnails (out of scope) |
| Multi-version file switching | Yes | Yes — quality picker's Version rows, `mediaIndex` on the transcode URL |
| Picture-in-Picture | Yes (Android/iOS/macOS) | No |
| Sleep timer | Yes | Yes — JS `setTimeout` on web/Xbox, native `Handler.postDelayed` on Android |
| Video zoom / pan | Yes | Yes — click-cycle + drag on web, pinch/drag via `ScaleGestureDetector` on Android |
| Refresh-rate matching | Yes (Windows/Android/tvOS) | No |
| Ambient lighting / GLSL shaders | Yes | No |
| External player handoff with progress sync | Yes | No |
| Watch-together / real-time sync | Yes | No |
| Audio passthrough / downmix + boost | Yes | No |
| Shader-based AI-style upscaling (Anime4K/RAVU-style) | Yes (mpv GLSL shaders) | Yes on Android — `ShaderUpscaleEffect`/`ShaderUpscaleShaderProgram` via Media3's Effect API, "Shader Upscaling..." dialog on the gear menu: Anime4K (line-art) or Live-Action/CAS (photographic content) with a continuous strength slider |

## Per-platform feasibility

✅ have it today &nbsp;·&nbsp; 🟡 feasible, not built &nbsp;·&nbsp; ⛔ not feasible on this platform

| Feature | Web | Android | Xbox |
|---|---|---|---|
| Direct play + server transcode | ✅ | ✅ | ✅ |
| Quality presets | 🟡 more `start.m3u8` query params | 🟡 same URL params | 🟡 same URL params (still on `<video>`+hls.js) |
| Playback speed 0.25x–8x | 🟡 `video.playbackRate` | 🟡 Media3 `PlaybackParameters` | 🟡 `video.playbackRate` |
| HEVC/AV1/VP9, HDR, Dolby Vision | ⛔ limited to whatever Chrome decodes | 🟡 native ExoPlayer already in place, just needs enabling/testing | ⛔ needs a new native `MediaPlayerElement` bridge (not started) |
| ASS/SSA subtitle rendering with styling | ⛔ no libass in a browser without a wasm port | 🟡 Media3 has partial SSA support — plugin-side work | ⛔ still `<video>`+hls.js, same limit as web |
| Online subtitle search/download | 🟡 client-side API call, same pattern as YouTube/OpenRouter | 🟡 same | 🟡 same |
| Skip intro / skip credits | 🟡 Plex `Marker` data + a button | 🟡 same | 🟡 same |
| Chapter navigation with thumbnails | 🟡 Plex already serves this data | 🟡 same | 🟡 same |
| Multi-version file switching | 🟡 Plex metadata's `Media` array + a picker UI | 🟡 same | 🟡 same |
| Picture-in-Picture | 🟡 `video.requestPictureInPicture()` | 🟡 standard Android PiP on `PlayerActivity` | ⛔ no PiP model for this kind of UWP app |
| Sleep timer | 🟡 plain `setTimeout` | 🟡 same | 🟡 same |
| Video zoom / pan | 🟡 CSS transform on `<video>` | 🟡 same (web fallback) or native `PlayerView` scale | 🟡 CSS transform |
| Refresh-rate matching | ⛔ not exposed to web content at all | 🟡 needs a native `Display.Mode` API added to `NativePlayerPlugin` | ⛔ no API surface via WebView2 today |
| Ambient lighting / GLSL shaders | 🟡 canvas + WebGL sampling the `<video>` element | ⛔ native playback renders in a separate Activity — frames aren't reachable from JS canvas | 🟡 still `<video>`+hls.js, same as web |
| External player handoff with progress sync | ⛔ no clean handoff from a browser tab | 🟡 Android `ACTION_VIEW` intent, existing `/:/timeline` reporting covers progress sync | ⛔ UWP process/app model doesn't support this |
| Watch-together / real-time sync | ⛔ needs a signaling backend | ⛔ needs a signaling backend | ⛔ needs a signaling backend |
| Audio passthrough / downmix + boost | ⛔ no passthrough from `<video>` | 🟡 Media3 audio processing | ⛔ still `<video>`, same limit as web |
| Shader-based AI-style upscaling | 🟡 WebGL canvas sampling `<video>` frames, same mechanism as ambient lighting — still a stretch goal | ✅ `ExoPlayer.setVideoEffects()` + a custom `GlShaderProgram` running inside ExoPlayer's own native pipeline, sidestepping the wall that blocks ambient lighting on this platform | 🟡 same WebGL approach as web; GPU/perf on real hardware unverified |

**Not achievable on any platform today:** watch-together / real-time sync — needs a signaling layer
between clients, which breaks Prism's "no backend" architecture invariant unless it can piggyback
on a Plex-native sync feature (unverified that one exists).

## Deferred features — detailed notes

The focused core set (speed, sleep timer, zoom/pan, skip intro/credits, chapters, quality picker,
subtitle search) shipped across `plex-player.js`, `plex-netflix-card.js`, `settings.js`,
`opensubtitles.js`, and the Android native plugin. Shader-based upscaling has since shipped on
Android too (see its own note below). The four items below remain explicitly scoped out and
unbuilt — kept here as the reference the moment any of them gets picked up again, since some of the
reasoning (especially the Android ambient-lighting/shader split) isn't obvious from the table cells
alone.

**Picture-in-Picture** — feasible on web (`video.requestPictureInPicture()`, a standard API against
the existing `<video>` element) and Android (standard `enterPictureInPictureMode`/
`onPictureInPictureModeChanged` lifecycle on `PlayerActivity`, same category of work as the
zoom/pan gesture handling already there). Not feasible on Xbox — no PiP model exists for this kind
of UWP app.

**Audio passthrough / downmix + boost** — not feasible on web or Xbox (no passthrough of compressed
audio bitstreams from a plain `<video>` element; Web Audio API can downmix/boost but not pass
through). Feasible on Android via Media3 audio processing (`AudioAttributes`/
`TrackSelectionParameters` on the `ExoPlayer.Builder` chain in `PlayerActivity.java`, which
currently sets nothing audio-related).

**Refresh-rate matching** — not exposed to web content at all, and no API surface via WebView2 on
Xbox today. Feasible on Android but needs genuinely new native work: a `Display.Mode` API added to
`PlayerActivity.java`/`NativePlayerPlugin.java`, with no existing hook point to extend. Of the
originally-deferred items, this is the largest net-new native surface — the other two at least have
adjacent code (PiP/zoom gestures, or an audio builder chain) to build from.

**Ambient lighting** (a glow effect derived from the video's own colors) — feasible on web and Xbox
via canvas + WebGL, sampling the `<video>` element's frames (`texImage2D` from the video element)
each frame to drive a color-extraction/blur effect. Xbox reaches this "for free" since its WebView2
shell has no native player bridge yet and still uses the same `<video>`+hls.js path as web — GPU/perf
on real Xbox hardware is unverified, though. **Blocked on Android**: native playback runs in a
separate `PlayerActivity`, entirely outside the WebView, so JS/canvas can never see those decoded
frames without a whole new native frame-sampling bridge (capture frames natively, relay bitmaps
across the Capacitor bridge to JS).

**Shader-based AI-style upscaling** (Anime4K/RAVU-style GLSL shaders) — raised when comparing
against Plezy's mpv-based "shader" feature. Plezy's shaders are mpv's GLSL shader ecosystem
(Anime4K, RAVU, nnedi3, FSR) — lightweight real-time upscaling filters that look like AI
super-resolution but are **not** full deep-CNN inference like an actual trained waifu2x/ESRGAN
model; a true deep-CNN model isn't realistically real-time-feasible on any of the three platforms
without dedicated ML acceleration (TFLite GPU delegate/NNAPI at best on Android), so that version
was treated as out of scope entirely from the start — only the lightweight-shader approach was
worth attempting.

**Shipped on Android**, as the best-candidate platform reasoned about above: `ShaderUpscaleEffect`
(`GlEffect`) + `ShaderUpscaleShaderProgram` (`BaseGlShaderProgram`), wired into `PlayerActivity` via
`ExoPlayer.setVideoEffects()` and configured from a "Shader Upscaling..." dialog on the gear menu
(off by default — it costs a GPU pass every frame). `GlShaderProgram`/`BaseGlShaderProgram`
(confirmed available since Media3 1.1.0; this project is on 1.10.1) runs inside ExoPlayer's own
native decode pipeline, never touching the WebView/JS layer — exactly why this sidesteps the wall
that blocks ambient lighting on Android. The shader itself is a single pass, not Anime4K's full
multi-pass CNN-approximation pipeline: hardware bilinear upscale to a display-capped resolution
(`ShaderUpscaleEffect` reads the device's own `DisplayMetrics`, capped since this activity is locked
`sensorLandscape`) combined with a Sobel-edge-gated unsharp mask, so only real line-art contours get
the crispness boost rather than amplifying flat-region noise or compression grain.
`ShaderUpscaleEffect.isNoOp()` skips the whole pass once the source already fills the display, so
it's a no-op cost on already-high-resolution direct-play sources.

One preset alone (the original "Lite" tuning) turned out too subtle to notice in practice, so
intensity became parameterized: scale factor, sharpen gain, edge-detection sampling radius
(`kernelScale` — wider sampling reads thicker line-art contours, the main thing that makes higher
intensities look like a distinctly more aggressive shader rather than just a bigger number on the
same effect), and a post-sharpen contrast/saturation lift, all tuned together as a unit. Compiled
clean via `android/gradlew :app:compileDebugJavaWithJavac`.

**Retuned after real-device feedback that the strongest tuning looked good but the lighter ones
barely showed a difference:** the whole ladder shifted up a rung — the middle tuning took over the
strongest tuning's old numbers, the lightest tuning took over the middle tuning's old numbers, and
the strongest tuning was pushed further (scale 2.4, sharpen gain 3.8, kernel scale 2.8, saturation
1.5, contrast 1.28) rather than just renamed. Every level is now stronger than its original tuning,
not just repositioned.

**A second shader variant was added for live-action content** — the Anime4K-style shader makes a
hard edge/no-edge decision (via the Sobel gradient), which looks great on anime's flat colors and
clean line-art but tends to ring/halo on live-action's soft photographic gradients and amplify
film grain/sensor noise, since there's no real "line" for the edge detector to lock onto. A second,
`ShaderType.LIVE_ACTION` tuning switches `ShaderUpscaleShaderProgram` to a second fragment shader
implementing the published Contrast Adaptive Sharpening idea AMD ships with FSR (our own
implementation of the concept, not a port of AMD's actual shader source): the sharpen weight comes
from the local *contrast range* of a cross-shaped neighborhood rather than a binary edge decision,
and — the anti-ringing guard that's the real difference — the result is clamped to that
neighborhood's own min/max, so it can't overshoot into a halo the way the anime shader's unsharp
mask can. Its tuning also leaves the saturation/contrast-boost uniforms unset (unused by this
shader variant) since exaggerating global contrast/saturation on already color-graded footage looks
wrong in a way it doesn't on anime's flat palette. Compiled clean via
`android/gradlew :app:compileDebugJavaWithJavac`; visual quality on real live-action footage is
unverified.

**UI reworked from fixed preset tiers to a shader-type choice plus a continuous strength slider,**
after feedback that discrete named tiers (Subtle/Medium/Bold, per shader type) were a clunkier way
to dial in intensity than a slider. `ShaderTuning` is now a plain value holder (scale factor,
sharpen gain, kernel scale, saturation/contrast boost); `ShaderType` (`OFF`/`ANIME4K`/`LIVE_ACTION`)
carries a `minTuning`/`maxTuning` pair per type — the old fixed tiers, now just the 0%/100% ends of
the slider — and `tuningAt(strength)` linearly interpolates every knob between them, so any
in-between strength is a genuine blend rather than a name. `PlayerActivity`'s gear menu now opens a
"Shader Upscaling..." dialog (`showShaderUpscaleDialog()`) with a `RadioGroup` for shader type and
a `SeekBar` for strength (0–100%), applying via `ExoPlayer.setVideoEffects()` rather than requiring
an Apply step — a plain `PopupMenu` item can't host a `SeekBar`, hence the move to a dialog.
`UpscalePreset.java` was deleted; its named-tier values now live as the `minTuning`/`maxTuning`
endpoints on `ShaderType`.

**Gotcha found on first real-device test of the slider:** the SeekBar's listener originally called
`applyVideoEffects()` from `onProgressChanged` (i.e. on every tick while dragging, potentially
dozens of times a second). Each call constructs a brand-new `ShaderUpscaleEffect`, which recompiles
and relinks a new GL shader program and tears down/rebuilds ExoPlayer's entire video-effects
pipeline via `setVideoEffects()` - doing that at drag frequency got the renderer stuck: playback
paused and wouldn't resume even after toggling play again. `setVideoEffects()` being callable
mid-playback is meant for occasional effect changes, not a continuous scrubber. Fixed by moving the
`applyVideoEffects()` call to `onStopTrackingTouch` (committed once on release) while
`onProgressChanged` only updates the strength label text during the drag itself.

**Gotcha found on first real-device test:** `configure()` originally clamped the scaled width and
height to the device's display bounds independently (`Math.min(scaledWidth, maxOutputWidth)` and
`Math.min(scaledHeight, maxOutputHeight)` as two separate calls). Since almost no device's screen
aspect ratio matches the video's, that clamped one axis more than the other, distorting the output
frame's aspect ratio — `PlayerView`'s aspect-ratio layout then just stretched that distorted shape
to fill the screen instead of upscaling in place. Fixed by computing a single scale factor bounded
by both axes (`Math.min(SCALE_FACTOR, min(maxW/inputW, maxH/inputH))`, floored at `1f`) and applying
it uniformly to both dimensions.

Web/Xbox remain a stretch goal, using the same WebGL-canvas-sampling mechanism as ambient lighting
above, with the same GPU-risk caveats — not attempted yet.

**Frame-rate / motion interpolation** (raised alongside shader upscaling, since both get pitched as
"AI-shader" video enhancement) — ruled out, not just deferred. `BaseGlShaderProgram`/`GlEffect`
processes one decoded frame at a time; true motion interpolation needs at least two sequential
frames simultaneously to estimate motion vectors (optical flow) and synthesize a new frame between
them — a temporal, multi-frame operation this single-frame shader API can't express. It also means
inserting new presentation timestamps into the stream, and `ExoPlayer.setVideoEffects()`'s own
javadoc states the mechanism is "incompatible with effects that modify frame timestamps" — the same
API `ShaderUpscaleEffect` relies on directly rules this out, not just as an effort question. Real
motion interpolation (TV "soap opera effect," SVP/RIFE-style software) runs actual optical-flow
neural networks per frame pair — the same class of infeasibility as the deep-CNN super-resolution
already ruled out above, applied to motion instead of detail. No OS-level hook exists either:
device-side MEMC is TV/panel firmware, not a public Android API. The only buildable approximation is
naive frame-blend/cross-dissolve between consecutive frames — real-time feasible but with visible
ghosting/smearing on fast motion, since there's no actual motion estimation — considered not worth
building given how much worse it looks than what "interpolation" implies.

## Takeaway

Most of Plezy's UX-layer features — skip intro/credits, chapters, quality picker, multi-version
switching, playback speed, sleep timer, zoom, subtitle search — have now shipped as ordinary
additions to `plex-player.js`: more Plex API calls plus UI, not blocked by Prism's architecture.
Shader-based AI-style upscaling has also shipped, on Android. The remaining gaps are tied to native
decoder/OS capabilities (HDR/Dolby Vision, PiP, audio passthrough, refresh-rate matching, ambient
lighting, libass rendering, web/Xbox shader upscaling) — see "Deferred features" above for the
detailed per-item breakdown.
