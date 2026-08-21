# Phase 0 — Hardware Spike Procedure and Results

Four questions that gate Phase 2. Answer all of them on a real console before writing any of
the real bridge, and record the answers here.

**Status: all four PASS. Phase 2 is unblocked — but on Plex's progressive output, not HLS.**

| | Result |
| --- | --- |
| **S1** transparent WebView2 over native video | **PASS** — confirmed under sustained playback: video and all overlay markers visible together. Phase 2 reuses the JS chrome |
| **S2** native playback of a Plex stream | **PASS via `protocol=http` / `start.mp4`.** `MediaOpened: 1916x800`, `Playing`, position advancing in real time for the whole test. **FAIL via HLS/AdaptiveMediaSource** — see below for why, and why the primary path changed |
| **S3** JS timers/`fetch` survive native playback | **PASS** — confirmed under sustained native playback, `fetch=True` throughout. `/:/timeline` stays in JS |
| **S4** gamepad focus with a second XAML element | **PASS, for an unexpected reason** — gamepad input never reaches `CoreWindow.KeyDown` at all; the WebView2 owns it entirely |

## The result that matters: progressive playback works

```
Menu -> progressive MP4 test
decision -> 200
progressive GET -> 200, type=video/x-matroska
MediaOpened: 1916x800, duration 7366.2s
PlaybackState: Playing
pos=0.8s → 1.9 → 3.1 → 4.3 → 5.5 → 6.6 → 7.8 → 9.0 → 10.1 → 11.3 → 12.5 → 13.6 → 14.8
```

Position advances in real time, the heartbeat keeps reporting `fetch=True`, and video plus the overlay
markers were on screen simultaneously. That one run closes S1, S2 and S3.

**Two corrections to the plan fall out of it:**

1. **UWP/MediaFoundation plays `video/x-matroska` over HTTP.** Plex answered `start.mp4` with
   `Content-Type: video/x-matroska` and it played regardless. The plan asserted the opposite and used
   that to restrict direct play to MP4/MOV/M4V containers — empirically wrong, and the restriction
   should go. It matters: most HDR libraries are MKV, and "MKV can't direct-play" was the stated
   reason MKV HDR sources might force the ffmpeg + D3D11VA escape hatch. **That argument no longer
   holds.**
2. **`1916x800` is the source's own resolution**, not a 1920x1080 re-encode — the same
   `RESOLUTION=1916x800` the HLS master playlist advertised. With `directStream=1` set, Plex appears to
   be copying the video stream rather than transcoding it, which is exactly the mode that preserves
   HDR. That makes this a credible route to Phase 3's HDR10 goal rather than only an SDR stopgap.

Everything below is in the order it was learned, because several findings were only visible once an
earlier one was fixed. Five incidental discoveries constrain Phase 2 as much as the spikes
themselves: the **string message envelope**, the **`privateNetworkClientServer` capability**, the
**null `GetNamedString` default**, the **orphaned transcode sessions**, and the **AMS-prefetch vs
transcode-on-demand mismatch**. Each would have cost real time mid-Phase-2.

## Answered

### Root cause of the segment failures: Plex serves a 188-byte error document, not media

Pinned down with the web player stopped, so server contention is **ruled out** — the failure is
identical either way.

The chain, all confirmed from one run:

- `start.m3u8` (159B) is a **master** playlist: `#EXT-X-STREAM-INF` → `session/<id>/base/index.m3u8`.
- That media playlist (20,766B) lists segments as **bare filenames**: `00000.ts`, `00001.ts`, …
- Resolved, those become `/video/:/transcode/universal/session/<id>/base/00000.ts` — **with no
  `X-Plex-Token`**, because the playlist entry carries no query string.
- Fetching that URL returns **HTTP 200 with a constant 188-byte body**, unchanged across 40 attempts
  over 20 seconds. AMS receives the same 188 bytes and reports `ResourceParsingError 0x80070057`
  (E_INVALIDARG) — it is being handed an error document and asked to parse it as MPEG-TS.
- AMS requests exactly the correct path (now logged in full), so this is not a base-URL
  resolution bug, and not a cold transcoder either.

**Not an authorisation problem.** Tested directly: the same segment fetched with and without
`X-Plex-Token` returns byte-identical `200 / 188B`. A `DownloadRequested` handler that re-added the
token to every request changed nothing.

**What the 188 bytes actually are.** The body begins `0x47` (`G`) — the MPEG-TS sync byte — and 188
bytes is exactly one MPEG-TS packet. Plex is returning a structurally valid but *empty*
single-packet segment, not an error document. The transcoder is producing no output at all for these
sessions, and never starts: 40 requests over 20 seconds all return the same empty packet.

**A second, independent AMS incompatibility.** Plex's media playlist carries
`#EXT-X-START:TIME-OFFSET=3919`, meaning the absolute position in the source media — but the playlist
*already* begins at that offset because `offset=3919` was passed to the transcoder. AMS honours the
tag as an offset into the playlist and seeks ~390 segments further in, which is why requests for
`00141.ts`/`00142.ts` appear. Even a healthy transcoder would be asked for segments that do not exist.

### Decision: stop debugging HLS, test the progressive-MP4 path instead

Five builds went into Plex-HLS-versus-AdaptiveMediaSource, and every failure has been in that
machinery — playlist semantics, segment production, transcoder liveness — never in decode. Decode
was proven early: `MediaOpened: 1920x1080` and a real rendered frame.

`spike-10` therefore tests Plex's **progressive output** (`protocol=http`, `start.mp4`) through a plain
`MediaSource.CreateFromUri`, on the **Menu** button, alongside the existing HLS test on **Y** so both
can be compared in one run. No playlist, no segments, no `EXT-X-START`, no transcoder-liveness
requirement — and MediaFoundation handles progressive MP4 over HTTP with byte-range seeking natively.

If progressive plays, it becomes the Phase 2 foundation and HLS drops to a fallback. That also moves
the plan's Phase 3 direct-play work forward, since direct play is the same shape: one HTTP URL handed
to `MediaSource`. The HLS findings above stay recorded either way — they are the evidence for *why*
the primary path changed.

Note how this reframes the earlier results: the run that reached `Playing` and rendered one frame was
not "nearly working". AMS was skipping every unparseable segment, eventually accepting something, and
then starving. Time-to-first-frame and the 404s were both symptoms of this, not separate problems.

### Ruled out: contention with the web player for one Raspberry Pi transcoder

Every run where native playback was attempted, the web player's hls.js began throwing
`fragLoadError` **within one second** of the native probe starting, and eventually went fatal. The
native side simultaneously got `ResourceParsingError` on segments that a direct GET could fetch
successfully, reached `Playing`, and then rendered only a single frame.

Both symptoms are consistent with one cause: **two concurrent 1080p transcode sessions of the same
title on a Raspberry Pi server.** The Pi cannot feed both, so both clients starve — the web player
visibly, and the native player as "playing but no new frames". Stopping the session afterwards
(`spike-6`) fixed the *orphaned* sessions but not the concurrency, because the web player is still
streaming while Y is pressed.

**Test procedure changed accordingly:** play a title once so the URL is captured, then **back out of
the player** so the web session ends, and only then press Y. The URL is already held natively, so
nothing is lost. Until that is tried, no conclusion about AMS's ability to sustain playback is safe —
this needs ruling out before any more effort goes into segment-parsing theories.

### S1 — transparent WebView2 over `MediaPlayerElement`: **PASS** (confirmed twice)

Re-confirmed independently: with native playback running, a video frame was visible on screen through
the transparent WebView2. Compositing, transparency and surface geometry all work; the problem is
that playback does not *sustain*, not that it isn't visible.

### S1 (original run) — transparent WebView2 over `MediaPlayerElement`: **PASS**

Native video was visible behind the translucent bar, with the green full-viewport outline and all
four corner blocks drawn on top of it. Transparency works on Xbox, the WebView2 surface covers
the frame, and its geometry is correct.

Phase 2 therefore proceeds as planned: **reuse the existing ~2,900 lines of JS chrome over native
video**, rather than re-implementing it in XAML the way Android had to. This also keeps WebView2
as the only focusable XAML control, which is the mitigation for the Xbox focus-trap bug.

### S2 — `AdaptiveMediaSource` with Plex's `start.m3u8`: **PASS**

`Probe OK`, then `MediaOpened` and `PlaybackState: Playing`. Plex's MPEG-TS HLS output is
ingestible by UWP's HLS stack, and hardware decode plays it.

**MediaPlayer + AdaptiveMediaSource is confirmed as the Phase 2 stack for the SDR path.** Note the
scope of this result: Plex is currently serving H.264 1080p SDR because of the client-capabilities
string in `core/stream-url.js`. It says nothing about HEVC-in-MPEG-TS, which is Phase 3's separate
question and the one where the `EXT-X-MAP`/fMP4 gap could still bite.

### `chrome.webview.postMessage` must send a STRING, not an object — CONFIRMED

Posting an object is what the WebView2 docs describe, and it silently never arrives on the Xbox
runtime: nothing reached `CoreWebView2.WebMessageReceived`, in either the app's own code or a probe
injected before any app module evaluated, with no error on either side. Switching the payload to
`JSON.stringify(...)` made every message arrive immediately.

**Phase 2's bridge must use a string envelope in the JS→native direction.** Native→JS
`PostWebMessageAsJson` worked throughout. This is the same class of bug as the Android
`partId`-arrives-as-null saga, one level up: the transport's own type fidelity rather than a
field's.

### `GetNamedString(name, null)` throws — a WinRT HSTRING cannot be null

With the channel fixed, every message then died inside the handler with
`ArgumentNullException: Value cannot be null`, because `null` was passed as the default to
`JsonObject.GetNamedString`. Each message was received, logged, and discarded. Use `""`. Worth
remembering for Phase 2's real dispatch, where the same call shape will be everywhere.

### Native code needs `privateNetworkClientServer` to reach a LAN Plex server

`AdaptiveMediaSource.CreateFromUriAsync` failed with `ManifestDownloadFailure / 0x80070005`
(`E_ACCESSDENIED`) against `https://192-168-0-224.<hash>.plex.direct:32400`, while the identical
URL played in the WebView. The manifest declared only `internetClient`.

WebView2 runs its own network stack in a separate process, outside the app container's network
isolation, which is why the browser leg never needed this. Native WinRT networking is inside the
container and is blocked on any private address without `privateNetworkClientServer`. Note
`plex.direct` is a public DNS name resolving to a private IP — the isolation applies to the
resolved address, not the name. moonlight-xbox declares the same capability for the same reason.

Added in `spike-5`, along with two things that make the next failure legible: a raw
`Windows.Web.Http` GET logged before the probe (a throw means the container blocked it; a status
code means Plex answered, so a 401/403 is a token/session problem instead), and a fresh `session`
GUID for the native request instead of reusing the one the web player is still streaming on.

### The heartbeat's `fetchOk` was measuring CORS, not reachability

Every tick reported `fetchOk=false`. The probe fetched Plex's `/identity` cross-origin from
`https://prismuwp.local`, and Plex sends no CORS headers for a tokenless endpoint, so a perfectly
healthy request rejected. Left as-is this would have been misread as the Android
network-suspension failure. Now a `mode: "no-cors"` request where *resolving at all* is the success
signal, since an opaque response has `ok === false` and `status === 0` even when it worked.

### How the outbound-channel failure was diagnosed

Worth keeping as a record of method, because both causes were invisible from the outside and one
masked the other.

In `spike-3` nothing arrived at `CoreWebView2.WebMessageReceived` at all, with no error anywhere.
The deduction that narrowed it: S1's overlay *did* appear, and that overlay is only drawn by the JS
listener on receiving `spikePlaybackStarted` — so `initXboxSpike()` had run, its listener was
registered, and native→JS worked. Meanwhile the stream URL only ever arrived via the
`ExecuteScriptAsync` pull, which meant `reportStreamUrl` had run and its `window.chrome.webview`
guard had passed. So the page could receive but not send, and `IsWebMessageEnabled` was ruled out
because it gates both directions.

`spike-4` then addressed both remaining candidates at once — string envelope, and a try/catch around
the handler with the raw payload logged before parsing — which was the right call, because **both
were real**: the object envelope stopped delivery, and once delivery worked the null-default
`GetNamedString` threw on every message. Fixing only one would have looked like no progress.

### S3 — **PASS** (strongly indicated)

29 pushed heartbeats and 20 independently-pulled ones, throughout native playback attempts, all
reporting `fetch=True` at 10–40ms with ~1000ms gaps and pull ages well under one tick. JS timers and
network are **not** suspended when a native media element is playing in the same page.

This is architecturally unsurprising once stated: Android's failure came from `WebView.onPause()`
firing because `PlayerActivity` backgrounded the `BridgeActivity`. On Xbox there is no second
Activity or window — the `MediaPlayerElement` is a sibling in the same page — so nothing is ever
backgrounded. **Phase 2 keeps `/:/timeline` reporting in JS**, matching this codebase's normal
architecture, and does not need Android's native-side duplication.

Marked "strongly indicated" rather than flatly confirmed only because playback never reached
`Playing` in this run (see the segment-404 finding below); it was `Opening` and actively fetching.
Re-confirm opportunistically once playback sustains.

### S2's real obstacle: Plex transcode-on-demand versus AMS prefetch

`AdaptiveMediaSource` *creation* succeeds reliably (`Probe OK: live=False, bitrates=[2455000]`).
Playback then fails on segments: 496 × `ResourceNotFound` at `0x80190194` (**HTTP 404**), 483 ×
`ResourceParsingError` at `0x80070057` (E_INVALIDARG), and hundreds of `MediaSegmentSkipped` — never
reaching `Playing`.

The mechanism, and it matters for Phase 2: a **fresh** session id at a non-zero `offset` makes Plex
begin transcoding from that point, and AMS prefetches far faster than the server produces segments,
so it requests segments that do not exist yet, 404s, skips them, and races ahead. The earlier run
that reached `MediaOpened` + `Playing` was reusing the web player's **already-warmed** session, which
had segments on disk to serve. So the S2 pass was real but flattered by a warm session.

This is a genuine property of Plex's transcode-on-demand HLS against AMS's prefetch behaviour, not a
transient. Phase 2 has to solve it — candidates: issue `/decision` first and wait for the session to
report ready before handing the URL to AMS; start at `offset=0` and seek after playback begins; or
intercept via `AdaptiveMediaSource.DownloadRequested` and hold/retry a 404 segment instead of letting
AMS skip it. `spike-6` adds the `/decision` call (which `core/stream-url.js` documents as the thing
that makes Plex's MDE actually honour a request, and which the native path had been skipping) and
logs the failing segment URI, which distinguishes "not produced yet" from "AMS built the wrong URL".

### Probing was starting orphaned transcode sessions on the server

Worth recording as a process mistake, not just a bug. `spike-5` auto-probed on every stream-URL
message on the theory that "probing does not start playback, so this can't disturb the web player".
That was wrong: requesting `start.m3u8` makes Plex spin up a real ffmpeg transcode. Three orphaned
sessions accumulated on a Raspberry Pi server and starved the web player's own session badly enough
to kill it with `fragLoadError` — so *neither* player worked, and the native failure looked worse
than it was.

`spike-6` probes only on an explicit button press, and calls
`/video/:/transcode/universal/stop?session=<id>` when stopping or before starting another. Any
future native work must own its session lifecycle the same way `web-fallback.js`'s `reloadWebSource`
already does.

### S2 — **PASS**, and the cold-start cost it exposed

With `/decision` called first and its own session, native playback reached
`MediaOpened: 1920x1080, duration 7367.0s` and then sustained `PlaybackState: Playing`. Plex's
MPEG-TS HLS is ingested and hardware-decoded. **MediaPlayer + AdaptiveMediaSource is confirmed as the
Phase 2 stack for the SDR path.**

The cost, which Phase 2 must handle: **18.5 seconds from button press to first frame** on a cold
session. The mechanism is now precisely identified — the eight early failures are
`ResourceParsingError 0x80070057` (E_INVALIDARG) on `00000.ts` through `00003.ts`, *not* 404. Plex
answers those requests with an empty or partial body while ffmpeg is still spinning up; AMS cannot
parse them, retries, and only recovers once real segments exist.

`spike-7` fixes this by polling the first segment URI (parsed out of the manifest) until it returns a
plausibly-sized body, and only then handing the URL to AMS. A real Phase 2 implementation needs the
same wait, and should surface it as a loading state rather than a black screen. Note the earlier
`ResourceNotFound` / 404 storm was the same root cause seen through a different failure mode, and
both disappear once the transcoder is given time.

### S4 — **PASS**, because gamepad input never reaches the XAML layer at all

Zero `key seen:` lines across two full runs, with D-pad presses made deliberately, and Y arriving
only via `Windows.Gaming.Input`. `OnCoreWindowKeyDown` does not fire for gamepad input in this app.
Navigation nonetheless works, so **WebView2 on Xbox delivers gamepad input to the page itself** — as
keyboard-equivalent events its focused content already understands.

Two consequences:

1. **There is no focus trap to mitigate here**, because XAML never sees the input to route. Adding
   `MediaPlayerElement` as a non-focusable sibling changed nothing, and Phase 2's plan is safe.
   `IsTabStop = false` stays anyway: it is what keeps the situation that way.
2. **`MapGamepadKey`'s synthetic-`KeyboardEvent` forwarding in `MainPage.xaml.cs` appears to be dead
   code.** The shell's own comment claims it feeds `focus-nav.js`; the evidence says the WebView2 was
   always doing that itself. Phase 5 should confirm and then delete it rather than extend it — and
   note that extending it would have created exactly the double-handling problem
   `feedback_double_handle_input_nav` warns about, with both paths live at once.

### Superseded: S4 — no data, and a question it raised

Zero `key seen:` lines were logged across the whole run, and Y only ever arrived via
`Windows.Gaming.Input`, never as a `CoreWindow.KeyDown`. So `OnCoreWindowKeyDown` did not fire for
any gamepad button — including the D-pad, which the user must have used to start playback.

That raises a real question for Phase 5: if `CoreWindow.KeyDown` never receives gamepad input in this
build, then `MapGamepadKey`'s synthetic-`KeyboardEvent` forwarding is dead code, and WebView2 on Xbox
must already be delivering gamepad-as-keyboard input to the page itself. If so that is a welcome
simplification — and also exactly the double-handling trap `feedback_double_handle_input_nav` warns
about, if both paths were ever live at once. Needs a deliberate test: press D-pad directions and see
whether any `key seen:` line appears at all.

### S3 — superseded (kept for the reasoning)

`spike-4` ticked steadily at ~1000ms for 63 consecutive heartbeats, but native video never started
(the probe failed on the network capability), so nothing was ever suspended. The heartbeat working
is not the test; the test is whether it keeps working *while native video is foregrounded*.
Re-test once `spike-5` gets playback running again.

## What was added (all temporary, all marked SPIKE)

| File | Role |
| --- | --- |
| `uwp/PrismUwp/Player/NativePlayerSpike.cs` | `MediaPlayer` + `MediaPlayerElement`, and the `AdaptiveMediaSource` probe that answers S2 |
| `uwp/PrismUwp/MainPage.xaml.cs` | Grid layout (video behind, WebView2 on top), the WebView2 message bridge, the on-screen diagnostic log, gamepad hooks |
| `uwp/PrismUwp/App.xaml.cs` | `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` changed `FF0A0A0C` → `00000000` |
| `src/player/xbox-spike.js` | Hands native a real tokened stream URL; draws the S1 test overlay; runs the S3 heartbeat |
| `app.js`, `plex-player.js` | One call each into the above; both no-op off the Xbox shell |

Deliberately **not** done yet: the platform marker `core/platform.js` looks for is not injected,
so `hasNativePlayer()` stays false and the existing `<video>`+hls.js player keeps working
underneath the spike. Injecting it would route playback into `native-bridge.js`'s Capacitor
plugin, which does not exist on Xbox.

Also not covered: HEVC and HDR. Plex transcodes everything to H.264 1080p SDR today because of
the client-capabilities string in `core/stream-url.js`, so this spike can only prove the
SDR-parity path. HEVC-in-MPEG-TS ingestion is a separate Phase 3 question that needs
`hevcPlayback` in the manifest plus that string widened before it can even be asked.

## Procedure

1. `npm run uwp:sync`, then deploy `PrismUwp.sln` to the paired console via Visual Studio's
   **Remote Machine** target (Debug|x64). Not a Device Portal sideload — see `CLAUDE.md`.
2. **Check the build actually deployed:** a green-on-black log panel must be visible at
   top-left immediately at launch, reading `spike-2 loaded`. If it isn't there, the console is
   running an older package and nothing below will do anything — redeploy before going on.
3. In the app, play any title once. The log should report `Stream URL received` followed
   immediately by the S2 probe result. **S2 needs no button press.**
4. Press **Y** to start native playback (S1, S3, S4 all become observable), **Y** again to stop.
   Press **X** to hide/show the log.

Controls: **Y** = start/stop native playback, **X** = toggle the log; the shoulder buttons work
as alternates for each. None are mapped in `MapGamepadKey`, so they collide with nothing the app
uses.

### Note from the first attempt (`spike-1`)

The first build appeared to do nothing at all when X and Y were pressed — including the log
toggle, which is pure native code with no JS involvement. Three changes address that, since
"our handler never ran" and "those keys never arrive" are indistinguishable from the outside:

- The log panel is now visible from launch and carries a build name, so a stale deployment is
  immediately obvious rather than looking like a code failure.
- Every **distinct** `VirtualKey` seen is logged once. This settles whether the console delivers
  `GamepadX`/`GamepadY` to `CoreWindow.KeyDown` at all — plausibly it does not, since Xbox
  synthesizes keyboard equivalents for D-pad/A/B (which is why the existing forwarding works)
  and X/Y have no keyboard equivalent. Worth capturing for the Phase 5 gamepad work either way.
- A `Windows.Gaming.Input` polling fallback reads X/Y straight off the pad, so the triggers work
  regardless of the answer. It disables itself the moment either button *does* arrive as a key
  event, so the two routes can't both act on one press.

Also fixed: the S1 overlay could not have worked as originally written. Transparent `html`/`body`
is not enough — the app's own content is opaque and, during playback, the web player's `<video>`
is `position:fixed; inset:0; background:#000` and covers the whole frame. The overlay now hides
every `<body>` child, so "no video visible" means transparency genuinely failed rather than
something still covering it. The native player is also muted, since the web player is often still
playing the same title.

## S1 — Does a transparent WebView2 composite over a `MediaPlayerElement`?

The whole chrome-reuse strategy depends on this. On native playback start, JS makes the page
transparent and draws: a green 2px full-viewport outline, four coloured corner blocks, and a
translucent black bar across the middle.

Look for, and record:

- Is the video visible behind the translucent bar? → transparency works.
- Do all four corner blocks and the full outline draw *on top* of the video? → the WebView2
  surface covers the whole frame and is correctly aligned.
- Markers visible but no video → WebView2 transparency is not working on Xbox. That invalidates
  the chrome-reuse plan; fall back to native XAML chrome (plan Phase 2, option 2) and revert the
  `App.xaml.cs` background to `FF0A0A0C`.
- Video visible but markers missing or offset/scaled → compositing works but the surface
  geometry doesn't; note exactly how it's wrong.
- Subjective but important: does the UI stay responsive with video playing behind it at 4K?
  This is the one cost the plan flags and cannot predict.

**Result:**

## S2 — Does `AdaptiveMediaSource` accept Plex's `start.m3u8`?

The load-bearing question. The documented HLS tag support lists `EXT-X-MAP` as unsupported,
which rules out fMP4/CMAF segments and leaves MPEG-TS only — and that table's last column is
Windows 10 1607, so it is too stale to trust either way.

The log reports the exact `AdaptiveMediaSourceCreationStatus`, not a pass/fail, because the
failure modes mean very different things:

- `Success` → then watch for `MediaOpened` (with real dimensions and duration) and
  `PlaybackState: Playing`. Creation succeeding but `MediaFailed` firing with an
  `MF_E_UNSUPPORTED_*` code means the manifest parsed but the container/codec didn't.
- `ManifestParseFailure` / `UnsupportedManifestProfile` / `UnsupportedManifestVersion` → a real
  format incompatibility. Capture any `AMS diagnostic` lines; they name the offending resource.
- `ManifestDownloadFailure` → not a format problem. Token, connectivity, or the transcode
  session having already been stopped. Re-run step 2 and retry.

A single entry in `bitrates=[…]` is expected and correct: Plex serves one fixed-bitrate
rendition per request rather than a multi-variant manifest.

**Result:**

## S3 — Do JS timers and `fetch` survive native playback?

On Android, `WebView.onPause()` suspended *all* network loading, not just timers, which silently
killed `/:/timeline` reporting for the entire duration of native playback and forced a native
Java reimplementation. WebView2 is a different engine in a different lifecycle model, so this
measures rather than assumes.

While native playback runs, the log prints one line per second:
`heartbeat #N gap=Xms fetch=True in Yms`.

- Ticks keep arriving with `gap≈1000ms` and `fetch=True` → JS and network are both alive. Phase 2
  can keep `/:/timeline` in JS, matching this codebase's normal architecture.
- Ticks stop entirely → JS is suspended. Phase 2 must push progress from native (like Android's
  `progress` event) and may need timeline reporting moved natively too.
- Ticks continue but `fetch=False`, or `fetch` times taking many seconds → the subtler and worse
  case: timers alive, network suspended. This is precisely what bit Android.

**Result:**

## S4 — Does gamepad focus still behave with a second XAML element in the tree?

`MainPage`'s existing gamepad comment rests on "there is exactly one focusable XAML control in
this whole app", which is what keeps the Xbox WebView2 XY-navigation focus trap
([WebView2Feedback #4284](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4284)) out of
reach. `MediaPlayerElement` is focusable by default, so it is created with `IsTabStop = false`
and `IsHitTestVisible = false` — the production configuration this is meant to validate.

While native playback runs, every direction/A/B press logs
`key <VirtualKey> -> <jsKey>, focus=<type>`.

- `focus=WebView2` on every press, and app navigation still moves → the mitigation holds.
- `focus=MediaPlayerElement` (or null) → XAML moved logical focus off the WebView2 and the trap
  risk is live. Phase 2 would then need native chrome instead of the transparent-WebView2 plan.

**Result:**

## Decision after these land

- S1 and S4 pass → Phase 2 proceeds as planned: JS chrome over native video.
- S2 passes → `MediaPlayer` + `AdaptiveMediaSource` is the Phase 2 stack.
- S2 fails on format grounds → the direct-play fork (plan Phase 3) becomes load-bearing rather
  than an optimisation, and if HEVC HDR later fails both HLS *and* direct play (MKV sources
  cannot direct-play: UWP does not support `video/x-matroska`), that is the documented trigger
  for the ffmpeg + D3D11VA escape hatch.
- S3's answer decides whether `/:/timeline` stays in JS or has to be pushed from native.
