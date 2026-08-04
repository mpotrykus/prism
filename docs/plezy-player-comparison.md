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
| Quality presets (240p–1080p, bitrate caps) | Yes | No — fixed transcode params |
| Playback speed 0.25x–8x | Yes | No |
| HEVC/AV1/VP9, HDR, Dolby Vision | Yes (native decoders) | Partial (browser/WebView2-codec-dependent; Plex transcodes the rest) |
| ASS/SSA subtitle rendering with styling | Yes (libass) | No — only what `<video>`/Media3 render natively |
| Online subtitle search/download | Yes | No |
| Skip intro / skip credits | Yes | No |
| Chapter navigation with thumbnails | Yes | No |
| Multi-version file switching | Yes | No — always plays `mediaIndex 0` |
| Picture-in-Picture | Yes (Android/iOS/macOS) | No |
| Sleep timer | Yes | No |
| Video zoom / pan | Yes | No |
| Refresh-rate matching | Yes (Windows/Android/tvOS) | No |
| Ambient lighting / GLSL shaders | Yes | No |
| External player handoff with progress sync | Yes | No |
| Watch-together / real-time sync | Yes | No |
| Audio passthrough / downmix + boost | Yes | No |

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

**Not achievable on any platform today:** watch-together / real-time sync — needs a signaling layer
between clients, which breaks Prism's "no backend" architecture invariant unless it can piggyback
on a Plex-native sync feature (unverified that one exists).

## Takeaway

Most of Plezy's UX-layer features — skip intro/credits, chapters, quality picker, multi-version
switching, playback speed, PiP, sleep timer, zoom — are ordinary additions to `plex-player.js`:
more Plex API calls plus UI, not blocked by Prism's architecture. The genuinely hard items are
tied to native decoder/OS capabilities (HDR/Dolby Vision, refresh-rate matching, audio passthrough,
libass rendering) and would require real native work in Prism's own `NativePlayerPlugin`, not
something achievable through the shared `<video>`+hls.js fallback.

**Suggested first pass:** skip intro/credits and quality selection — highest visible payoff for
the lowest implementation cost.
